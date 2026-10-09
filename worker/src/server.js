"use strict";

/**
 * Express server for the Studio app. Binds to 127.0.0.1 only and reads
 * project files on this machine. The browser talks to this process directly
 * (CORS for localhost:3000 / :3001 plus optional STUDIO_ORIGIN). Voices /
 * ElevenLabs stay CLI-only -- this file must never import worker/src/voices.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const { renderProject, previewFrame, parseEstimatedSilent } = require("./render");
const { parseProjectToFiles, parseProjectToTemp, resolveGlobalAssetsDir, ScriptError } = require("./parser");
const { resolveAsset } = require("./parser/assetLibrary");
const { listCharacters, listStaging, summarizeStage } = require("./studioLibrary");
const { buildLaneBlocks } = require("./studioLanes");

const DEFAULT_PROJECTS_DIR = path.resolve(__dirname, "..", "..", "projects");
const DEFAULT_STUDIO_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROJECT_NAMES = new Set(["_global_assets"]);
const SAFE_REL_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function isSafeProjectName(name) {
  return typeof name === "string" && SAFE_PROJECT_NAME.test(name) && !RESERVED_PROJECT_NAMES.has(name);
}

function isSafeRelPath(rel) {
  if (typeof rel !== "string" || !rel) return false;
  const posix = rel.replace(/\\/g, "/");
  if (posix.includes("..") || posix.startsWith("/") || posix.includes("//")) return false;
  return SAFE_REL_PATH.test(posix);
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
    res.setHeader("Access-Control-Expose-Headers", [
      "X-Engine-Frame",
      "X-Engine-Total-Frames",
      "X-Engine-Fps",
      "X-Engine-Canvas-Width",
      "X-Engine-Canvas-Height",
      "X-Engine-Scene-Id",
    ].join(", "));
  }
}

function parseErrorPayload(err) {
  if (err instanceof ScriptError) {
    return {
      error: err.message,
      line: err.lineNumber == null ? null : err.lineNumber,
    };
  }
  return { error: err.message };
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

function readScriptBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body.text === "string") return req.body.text;
  return "";
}

function estimatedSilentFromLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const estimated = list.filter((line) => line.status === "missing").length;
  const total = list.length;
  return {
    estimated,
    total,
    message: `${estimated} of ${total} lines are estimated/silent`,
  };
}

async function parseOrFail(projectDir, skipValidate) {
  return parseProjectToFiles(projectDir, { skipValidate });
}

function cleanupTempParse(result) {
  if (result && result.tmpDir) {
    fs.rmSync(result.tmpDir, { recursive: true, force: true });
  }
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

  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: "text/plain", limit: "2mb" }));

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

  app.get("/api/projects/:name/characters", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    res.json({ characters: listCharacters(projectDir, globalAssetsDir) });
  });

  app.get("/api/projects/:name/staging", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    res.json(listStaging(projectDir, globalAssetsDir));
  });

  app.get("/api/projects/:name/asset", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const rel = typeof req.query.rel === "string" ? req.query.rel : "";
    if (!isSafeRelPath(rel)) {
      return res.status(400).json({ error: "Invalid asset path" });
    }
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    const resolved = resolveAsset(projectDir, globalAssetsDir, rel);
    if (!resolved) {
      return res.status(404).json({ error: `Asset not found: ${rel}` });
    }
    const ext = path.extname(resolved.absPath).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) {
      return res.status(400).json({ error: "Unsupported asset type" });
    }
    res.type(type).sendFile(resolved.absPath);
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

  app.put("/api/projects/:name/script", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptText = readScriptBody(req);
    fs.writeFileSync(path.join(projectDir, "script.txt"), scriptText);

    let result;
    let parseError = null;
    try {
      result = await parseProjectToTemp(projectDir, { skipValidate });
    } catch (err) {
      parseError = err;
    }
    const lint = lintFromResult(result, parseError);
    try {
      res.json({
        ok: lint.errors.length === 0,
        saved: true,
        lint,
      });
    } finally {
      cleanupTempParse(result);
    }
  });

  app.post("/api/projects/:name/lint", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const opts = { skipValidate };
    if (req.body && typeof req.body === "object" && typeof req.body.text === "string") {
      opts.scriptText = req.body.text;
    } else if (typeof req.body === "string") {
      opts.scriptText = req.body;
    }

    let result;
    let parseError = null;
    try {
      result = await parseProjectToTemp(projectDir, opts);
    } catch (err) {
      parseError = err;
    }
    const lint = lintFromResult(result, parseError);
    try {
      res.json({ ok: lint.errors.length === 0, lint });
    } finally {
      cleanupTempParse(result);
    }
  });

  app.get("/api/projects/:name/lanes", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    let result;
    try {
      result = await parseProjectToTemp(projectDir, { skipValidate });
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
      if (result.validation && result.validation.ok === false) {
        return res.status(400).json({ error: result.validation.message || "timeline validation failed" });
      }
      res.json(buildLaneBlocks(result));
    } finally {
      cleanupTempParse(result);
    }
  });

  app.get("/api/projects/:name/stage", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    let result;
    try {
      result = await parseProjectToTemp(projectDir, { skipValidate });
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
      if (result.validation && result.validation.ok === false) {
        return res.status(400).json({ error: result.validation.message || "timeline validation failed" });
      }
      const staging = listStaging(projectDir, globalAssetsDir);
      res.json({
        ...summarizeStage(result.timeline),
        marksByLocation: staging.marksByLocation,
      });
    } finally {
      cleanupTempParse(result);
    }
  });

  app.post("/api/projects/:name/preview-frame", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;

    let result;
    try {
      result = await parseProjectToTemp(projectDir, { skipValidate });
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    if (result.validation && result.validation.ok === false) {
      cleanupTempParse(result);
      return res.status(400).json({ error: result.validation.message || "timeline validation failed" });
    }

    const fps = (result.timeline && result.timeline.fps) || 24;
    const body = req.body || {};
    let frame = body.frame;
    if (frame == null && body.time != null) {
      frame = Math.round(Number(body.time) * fps);
    }
    if (frame == null) frame = 0;
    frame = Number(frame);
    if (!Number.isFinite(frame) || frame < 0) {
      cleanupTempParse(result);
      return res.status(400).json({ error: "frame must be a non-negative number (or pass time in seconds)" });
    }
    frame = Math.floor(frame);

    const tmp = path.join(
      os.tmpdir(),
      `engine-preview-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
    );
    try {
      const previewOpts = options.pythonBin ? { pythonBin: options.pythonBin } : {};
      previewOpts.timeline = result.timelinePath;
      const preview = await previewFrame(projectDir, frame, tmp, previewOpts);
      const meta = preview.meta || {};
      if (meta.frame != null) res.setHeader("X-Engine-Frame", String(meta.frame));
      if (meta.totalFrames != null) res.setHeader("X-Engine-Total-Frames", String(meta.totalFrames));
      if (meta.fps != null) res.setHeader("X-Engine-Fps", String(meta.fps));
      if (meta.canvas && meta.canvas.width) res.setHeader("X-Engine-Canvas-Width", String(meta.canvas.width));
      if (meta.canvas && meta.canvas.height) res.setHeader("X-Engine-Canvas-Height", String(meta.canvas.height));
      if (meta.sceneId) res.setHeader("X-Engine-Scene-Id", String(meta.sceneId));
      res.type("image/png");
      res.sendFile(tmp, (err) => {
        fs.unlink(tmp, () => {});
        if (err && !res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      });
    } catch (err) {
      fs.unlink(tmp, () => {});
      const status = /past the end|must be >= 0/.test(err.message) ? 400 : 500;
      res.status(status).json({ error: err.message });
    } finally {
      cleanupTempParse(result);
    }
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
        result = await parseOrFail(projectDir, skipValidate);
      } catch (err) {
        return res.status(400).json(parseErrorPayload(err));
      }
      if (result.validation && result.validation.ok === false) {
        return res.status(400).json({ error: result.validation.message || "timeline validation failed" });
      }

      const rendered = await renderProject(projectDir, { codec: "h264", output: outputPath });
      const estimatedSilent =
        rendered.estimatedSilent ||
        parseEstimatedSilent(`${rendered.stdout}\n${rendered.stderr}`) ||
        estimatedSilentFromLines(result.lines);

      res.json({
        ok: true,
        outputPath,
        url: `/api/projects/${encodeURIComponent(req.params.name)}/renders/output.mp4`,
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
module.exports.isSafeRelPath = isSafeRelPath;
