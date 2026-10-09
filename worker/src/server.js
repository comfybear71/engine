"use strict";

/**
 * Express server for the Studio app. Binds to 127.0.0.1 only and reads /
 * writes the user's project files on this machine. The browser talks to
 * this process directly (CORS for http://localhost:3000 plus optional
 * STUDIO_ORIGIN). Voices / ElevenLabs stay CLI-only -- this file must
 * never import worker/src/voices.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });

const fs = require("fs");
const path = require("path");
const express = require("express");

const { renderProject, parseEstimatedSilent } = require("./render");
const { parseProjectToFiles, ScriptError } = require("./parser");

const DEFAULT_PROJECTS_DIR = path.resolve(__dirname, "..", "..", "projects");
const DEFAULT_STUDIO_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROJECT_NAMES = new Set(["_global_assets"]);

function isSafeProjectName(name) {
  return typeof name === "string" && SAFE_PROJECT_NAME.test(name) && !RESERVED_PROJECT_NAMES.has(name);
}

function resolveProjectDir(projectsDir, name) {
  if (!isSafeProjectName(name)) return null;
  const root = path.resolve(projectsDir);
  const resolved = path.resolve(root, name);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function allowedOrigins() {
  const origins = new Set(DEFAULT_STUDIO_ORIGINS);
  const extra = (process.env.STUDIO_ORIGIN || "").trim();
  if (extra) origins.add(extra.replace(/\/$/, ""));
  return origins;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function lintIssueFromText(text, level) {
  const raw = String(text);
  const match = raw.match(/^Line (\d+):\s*([\s\S]*)$/);
  if (match) return { level, line: Number(match[1]), message: match[2] };
  return { level, line: null, message: raw };
}

function lintFromResult(result, parseError) {
  const errors = [];
  const warnings = [];

  if (parseError instanceof ScriptError) {
    errors.push({
      level: "error",
      line: parseError.lineNumber == null ? null : parseError.lineNumber,
      message: parseError.message.replace(/^Line \d+:\s*/, ""),
    });
  } else if (parseError) {
    errors.push({ level: "error", line: null, message: parseError.message });
  }

  if (result) {
    for (const warning of result.warnings || []) warnings.push(lintIssueFromText(warning, "warning"));
    for (const error of result.errors || []) errors.push(lintIssueFromText(error, "error"));
    if (result.validation && result.validation.ok === false && result.validation.message) {
      errors.push({ level: "error", line: null, message: result.validation.message });
    }
  }

  return { errors, warnings };
}

function summarizeTimeline(timeline) {
  if (!timeline) return null;
  const scenes = (timeline.scenes || []).map((scene) => ({
    id: scene.id,
    layerCount: (scene.layers || []).length,
    dialogueCount: (scene.layers || []).reduce((n, layer) => n + ((layer.dialogue && layer.dialogue.length) || 0), 0),
  }));
  return {
    series: timeline.series,
    episode: timeline.episode,
    fps: timeline.fps,
    sceneCount: scenes.length,
    scenes,
  };
}

function summarizeLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return {
    total: list.length,
    missing: list.filter((line) => line.status === "missing").length,
    ok: list.filter((line) => line.status === "ok").length,
    lines: list.map((line) => ({
      scene_id: line.scene_id,
      line_number: line.line_number,
      character: line.character,
      text: line.text,
      status: line.status,
    })),
  };
}

function estimatedSilentFromLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const estimated = list.filter((line) => line.status === "missing").length;
  const total = list.length;
  if (total === 0) return { estimated: 0, total: 0, message: "0 of 0 lines are estimated/silent" };
  return {
    estimated,
    total,
    message: `${estimated} of ${total} lines are estimated/silent`,
  };
}

function createApp(options = {}) {
  const projectsDir = path.resolve(options.projectsDir || process.env.ENGINE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR);
  const skipValidate = options.skipValidate === true;
  const app = express();
  let renderInProgress = false;

  app.use((req, res, next) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json());

  function projectFromRequest(req, res) {
    const projectDir = resolveProjectDir(projectsDir, req.params.name);
    if (!projectDir) {
      res.status(400).json({ error: "Invalid project name" });
      return null;
    }
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      res.status(404).json({ error: `Project not found: ${req.params.name}` });
      return null;
    }
    return projectDir;
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/projects", (_req, res) => {
    if (!fs.existsSync(projectsDir)) {
      return res.json({ projects: [] });
    }
    const names = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeProjectName(entry.name))
      .map((entry) => entry.name)
      .sort();
    res.json({ projects: names.map((name) => ({ name })) });
  });

  app.get("/api/projects/:name/script", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptPath = path.join(projectDir, "script.txt");
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: "script.txt not found" });
    }
    res.type("text/plain").send(fs.readFileSync(scriptPath, "utf8"));
  });

  app.put("/api/projects/:name/script", express.text({ type: "*/*", limit: "2mb" }), async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;

    const scriptText = typeof req.body === "string" ? req.body : "";
    const scriptPath = path.join(projectDir, "script.txt");
    fs.writeFileSync(scriptPath, scriptText);

    let result = null;
    let parseError = null;
    try {
      result = await parseProjectToFiles(projectDir, { skipValidate });
    } catch (err) {
      parseError = err;
    }

    const lint = lintFromResult(result, parseError);
    res.json({
      ok: lint.errors.length === 0,
      saved: true,
      lint,
      timeline: summarizeTimeline(result && result.timeline),
      lines: result ? summarizeLines(result.lines) : null,
    });
  });

  app.get("/api/projects/:name/timeline", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const timelinePath = path.join(projectDir, "timeline.json");
    if (!fs.existsSync(timelinePath)) {
      return res.status(404).json({ error: "timeline.json not found" });
    }
    res.json(JSON.parse(fs.readFileSync(timelinePath, "utf8")));
  });

  app.post("/api/projects/:name/render", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    if (renderInProgress) {
      return res.status(409).json({ error: "A render is already in progress" });
    }

    renderInProgress = true;
    const outputPath = path.join(projectDir, "renders", "output.mp4");
    try {
      let result;
      try {
        result = await parseProjectToFiles(projectDir, { skipValidate });
      } catch (err) {
        const lint = lintFromResult(null, err);
        return res.status(400).json({ error: err.message, lint });
      }
      if (result.validation && result.validation.ok === false) {
        return res.status(400).json({
          error: result.validation.message || "timeline validation failed",
          lint: lintFromResult(result, null),
        });
      }

      const rendered = await renderProject(projectDir, { codec: "h264", output: outputPath });
      const estimatedSilent =
        rendered.estimatedSilent ||
        parseEstimatedSilent(`${rendered.stdout}\n${rendered.stderr}`) ||
        estimatedSilentFromLines(result.lines);

      res.json({
        ok: true,
        outputPath,
        estimatedSilent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      renderInProgress = false;
    }
  });

  app.get("/api/projects/:name/renders/output.mp4", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const outputPath = path.join(projectDir, "renders", "output.mp4");
    if (!fs.existsSync(outputPath)) {
      return res.status(404).json({ error: "No render yet. Use the Render button first." });
    }
    res.sendFile(outputPath, { headers: { "Content-Type": "video/mp4" } });
  });

  // Kept for the original CLI-oriented contract. Same in-progress lock.
  app.post("/render", async (req, res) => {
    const { projectDir, codec, output } = req.body || {};
    if (!projectDir) {
      return res.status(400).json({ error: "projectDir is required" });
    }
    if (renderInProgress) {
      return res.status(409).json({ error: "A render is already in progress" });
    }
    renderInProgress = true;
    try {
      await renderProject(projectDir, { codec, output });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      renderInProgress = false;
    }
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.WORKER_PORT || 4100);
  app.listen(port, "127.0.0.1", () => {
    console.log(`Render worker listening on http://127.0.0.1:${port} (localhost only)`);
  });
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.isSafeProjectName = isSafeProjectName;
module.exports.resolveProjectDir = resolveProjectDir;
