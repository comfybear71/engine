"use strict";

/**
 * Express server for the Studio app. Binds to 127.0.0.1 only and reads
 * project files on this machine. The browser talks to this process directly
 * (CORS for localhost:3000 / :3001 plus optional STUDIO_ORIGIN). Voices TTS
 * stays CLI-only. Studio **Import audio** posts
 * `/api/projects/:name/import-audio` (ElevenLabs Speech-to-Text + Rhubarb).
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const { renderProject, previewFrame, parseEstimatedSilent } = require("./render");
const { parseProjectToTemp, resolveGlobalAssetsDir, ScriptError } = require("./parser");
const { getCachedParse } = require("./parser/parseCache");
const { validateTimelineFile } = require("./parser/validateTimelineFile");
const { resolveAsset } = require("./parser/assetLibrary");
const { getCachedPreview, storePreview } = require("./previewCache");
const { listCharacters, listGlobalCharacters, listStaging, summarizeStage } = require("./studioLibrary");
const { listProjectAudio } = require("./studioAudio");
const { buildLaneBlocks, clampFrame } = require("./studioLanes");
const {
  DEFAULT_SCRIPT,
  renderOutputName,
  previewOutputName,
  resolveScriptName,
  listScriptFiles,
  collectUsedAssets,
  summarizeProjectCached,
  describeProjectContents,
  moveProjectToTrash,
  listTrash,
  restoreFromTrash,
  emptyTrash,
  renameProject,
  duplicateProject,
  createEmptyProject,
  addLibraryCharacter,
  readLibrary,
  isSafeFolderName,
} = require("./studioProjects");
const { cachedBackgroundThumb } = require("./studioThumbs");
const { streamProjectZip } = require("./studioZip");
const { previewIngest, confirmIngest, cancelIngest } = require("./assetIngest");
const { saveCharacterStyle, saveCharacterReference, saveSlotAlignment, SLOT_NAME } = require("./characterLocal");
const {
  PROXY_SIZE,
  isSafeAudioRel,
  resolveProjectAudio,
  describePlayback,
} = require("./studioPlayback");
const { runImportAudio, readImportAudioRequest, VoicesFatalError } = require("./importAudio");
const {
  collectDialogueTargets,
  syncDialogueLines,
  readStudioSettings,
  writeStudioSettings,
  patchMouthCue,
  clearDialogueLipSync,
} = require("./voices/lipSync");
const { snapshotScriptWrite, listScriptHistory, restoreScriptSnapshot } = require("./scriptHistory");
const { describeEngineSettings, saveXaiApiKey } = require("./engineSettings");
const { generateProjectImage, GenerateImageError } = require("./generateImage");
const { listPackSummaries, packForCharacter, getPack } = require("./promptPacks");
const {
  isSafeShowId,
  resolveEpisodeDir,
  assertShow,
  listShows,
  summarizeShow,
  createShow,
  duplicateShow,
  renameShow,
  createEpisode,
  duplicateEpisode,
  renameEpisode,
  moveProjectIntoShow,
  moveEpisodeToExperiments,
  describeShowAssets,
  describeShowContents,
  readFinalCut,
  writeFinalCut,
  planFinalCut,
  renderFinalCut,
  readShowJson,
} = require("./studioShows");

const DEFAULT_PROJECTS_DIR = path.resolve(__dirname, "..", "..", "projects");
const DEFAULT_SHOWS_DIR = path.resolve(__dirname, "..", "..", "shows");
const DEFAULT_STUDIO_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROJECT_NAMES = new Set(["_global_assets", "_trash"]);
const SAFE_REL_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const SAFE_RENDER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(mp4|mov)$/;

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
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Expose-Headers", [
      "X-Engine-Frame",
      "X-Engine-Total-Frames",
      "X-Engine-Fps",
      "X-Engine-Canvas-Width",
      "X-Engine-Canvas-Height",
      "X-Engine-Scene-Id",
      "Content-Disposition",
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

function scriptFromRequest(req, res) {
  const raw = req.query && req.query.script;
  const scriptName = resolveScriptName(raw);
  if (!scriptName) {
    res.status(400).json({ error: "Invalid script name" });
    return null;
  }
  return scriptName;
}

function parseOpts(skipValidate, scriptName) {
  return { skipValidate, script: scriptName || DEFAULT_SCRIPT };
}

function cleanupTempParse(result) {
  if (result && result.tmpDir && !result.cached) {
    fs.rmSync(result.tmpDir, { recursive: true, force: true });
  }
}

async function parseForRead(projectDir, scriptName) {
  return getCachedParse(projectDir, { script: scriptName || DEFAULT_SCRIPT });
}

async function parseForWrite(projectDir, opts) {
  if (opts.scriptText != null) {
    return parseProjectToTemp(projectDir, opts);
  }
  const cached = await getCachedParse(projectDir, { script: opts.script || DEFAULT_SCRIPT });
  if (opts.skipValidate) return cached;
  const validation = await validateTimelineFile(cached.timelinePath, { projectDir });
  return { ...cached, validation };
}

function setAssetCacheControl(req, res, absPath) {
  let mtime = 0;
  try {
    mtime = Math.round(fs.statSync(absPath).mtimeMs);
  } catch {
    mtime = 0;
  }
  const v = req.query && req.query.v;
  if (v != null && String(v) === String(mtime)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "public, max-age=86400");
  }
}

function createApp(options = {}) {
  const projectsDir = path.resolve(options.projectsDir || process.env.ENGINE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR);
  const showsDir = path.resolve(options.showsDir || process.env.ENGINE_SHOWS_DIR || DEFAULT_SHOWS_DIR);
  const skipValidate = options.skipValidate === true;
  const envPath = options.envPath;
  const fetchFn = options.fetchFn;
  const app = express();
  let renderInProgress = false;

  app.use((req, res, next) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "20mb" }));
  app.use(express.text({ type: "text/plain", limit: "2mb" }));

  function queryShowId(req, res) {
    const raw = req.query && (Array.isArray(req.query.show) ? req.query.show[0] : req.query.show);
    if (raw == null || raw === "") return null;
    if (!isSafeShowId(raw)) {
      res.status(400).json({ error: "Invalid show name" });
      return false;
    }
    return raw;
  }

  function projectFromRequest(req, res) {
    const showId = queryShowId(req, res);
    if (showId === false) return null;
    if (showId) {
      const projectDir = resolveEpisodeDir(showsDir, showId, req.params.name);
      if (!projectDir) {
        res.status(400).json({ error: "Invalid project name" });
        return null;
      }
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        res.status(404).json({ error: `Episode not found: ${req.params.name}` });
        return null;
      }
      return projectDir;
    }
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

  function showFromRequest(req, res) {
    const showId = req.params.showId;
    if (!isSafeShowId(showId)) {
      res.status(400).json({ error: "Invalid show name" });
      return null;
    }
    try {
      return { showId, showDir: assertShow(showsDir, showId) };
    } catch (err) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: err.message });
        return null;
      }
      res.status(400).json({ error: err.message });
      return null;
    }
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  function sendGenerateError(res, err) {
    if (err instanceof GenerateImageError) {
      const status = err.status === 401 ? 401 : err.status === 429 ? 429 : err.code === "ENOTFOUND" ? 404 : err.code === "EAUTH" ? 400 : 400;
      const mapped = err.code === "EXAI" && err.status && err.status >= 500 ? 502 : status;
      return res.status(mapped).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }

  app.get("/api/engine/settings", (_req, res) => {
    const settings = describeEngineSettings(process.env, envPath ? { envPath } : {});
    res.json({
      xaiKeyConfigured: settings.xaiKeyConfigured,
      xaiImageModel: settings.xaiImageModel,
    });
  });

  app.put("/api/engine/settings", (req, res) => {
    const key = req.body && req.body.xaiApiKey;
    if (typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "Paste an xAI API key. It is stored in the engine .env on this PC and never shown back." });
    }
    try {
      saveXaiApiKey(key, envPath ? { envPath } : {});
      res.json({ ok: true, xaiKeyConfigured: true });
    } catch (err) {
      if (err.code === "EINVAL") return res.status(400).json({ error: err.message });
      return res.status(500).json({ error: "Could not save the key to the engine .env file." });
    }
  });

  app.get("/api/prompt-packs", (req, res) => {
    const characterId = typeof req.query.character === "string" ? req.query.character : "";
    const packs = listPackSummaries();
    if (!characterId) return res.json({ packs });
    const match = packForCharacter({ id: characterId, display_name: req.query.name });
    res.json({ packs, pack: match ? packs.find((item) => item.id === match.id) || null : null });
  });

  app.get("/api/prompt-packs/:id", (req, res) => {
    const pack = getPack(req.params.id);
    if (!pack) return res.status(404).json({ error: "Unknown prompt pack" });
    res.json({ pack });
  });

  app.post("/api/generate-image", async (req, res) => {
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    const projectName = req.body && req.body.project;
    const showId = req.body && req.body.showId;
    let projectDir = null;
    if (showId) {
      if (!isSafeShowId(showId)) return res.status(400).json({ error: "Invalid show name" });
      projectDir = resolveEpisodeDir(showsDir, showId, projectName);
    } else {
      projectDir = resolveProjectDir(projectsDir, projectName);
    }
    if (!projectDir) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return res.status(404).json({ error: `Project not found: ${projectName}` });
    }
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      const result = await generateProjectImage(projectDir, globalAssetsDir, req.body || {}, {
        fetchFn,
      });
      res.json(result);
    } catch (err) {
      sendGenerateError(res, err);
    }
  });

  async function summarized(projectDir, name) {
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    return summarizeProjectCached(projectDir, name, globalAssetsDir);
  }

  function sendLifecycleError(res, err) {
    if (err.code === "EINVAL") return res.status(400).json({ error: err.message });
    if (err.code === "ENOENT") return res.status(404).json({ error: err.message });
    if (err.code === "EEXIST") return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }

  app.get("/api/projects", async (_req, res) => {
    if (!fs.existsSync(projectsDir)) {
      return res.json({ projects: [] });
    }
    const names = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeProjectName(entry.name))
      .map((entry) => entry.name)
      .sort();
    try {
      const projects = await Promise.all(
        names.map((name) => summarized(path.join(projectsDir, name), name))
      );
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/projects", async (req, res) => {
    const name = req.body && req.body.name;
    if (!isSafeProjectName(name)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    try {
      const projectDir = createEmptyProject(projectsDir, name);
      res.status(201).json({ ok: true, project: await summarized(projectDir, name) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/trash", (_req, res) => {
    res.json({ trash: listTrash(projectsDir) });
  });

  app.post("/api/trash/empty", (req, res) => {
    const confirm = req.body && req.body.confirm;
    if (confirm !== "empty") {
      return res.status(400).json({ error: 'Type "empty" to confirm emptying trash' });
    }
    try {
      res.json({ ok: true, ...emptyTrash(projectsDir) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/trash/:id/restore", async (req, res) => {
    const id = req.params.id;
    try {
      const restored = restoreFromTrash(projectsDir, id, { showsDir });
      if (restored.kind === "show") {
        res.json({ ok: true, show: await summarizeShow(showsDir, restored.name) });
        return;
      }
      res.json({
        ok: true,
        project: await summarized(restored.projectDir, restored.name),
        showId: restored.showId || null,
      });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/projects/:name/contents", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    res.json({ name: req.params.name, contents: describeProjectContents(projectDir) });
  });

  app.post("/api/projects/:name/trash", (req, res) => {
    const name = req.params.name;
    if (!isSafeProjectName(name)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    const confirmName = req.body && req.body.confirmName;
    if (confirmName !== name) {
      return res.status(400).json({ error: "Type the project name to confirm" });
    }
    try {
      const showId = queryShowId(req, res);
      if (showId === false) return;
      if (showId) {
        const episodeDir = resolveEpisodeDir(showsDir, showId, name);
        if (!episodeDir || !fs.existsSync(episodeDir)) {
          return res.status(404).json({ error: `Episode not found: ${name}` });
        }
        res.json({
          ok: true,
          trash: moveProjectToTrash(projectsDir, name, {
            parentDir: path.join(showsDir, showId, "episodes"),
            meta: { kind: "episode", showId, originalName: name },
          }),
        });
        return;
      }
      res.json({ ok: true, trash: moveProjectToTrash(projectsDir, name) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/projects/:name/rename", async (req, res) => {
    const name = req.params.name;
    if (!isSafeProjectName(name)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    const newName = req.body && req.body.name;
    if (!isSafeProjectName(newName)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    try {
      const showId = queryShowId(req, res);
      if (showId === false) return;
      const parent = showId ? path.join(showsDir, showId, "episodes") : projectsDir;
      const renamed = showId ? renameEpisode(showsDir, showId, name, newName) : renameProject(parent, name, newName);
      res.json({ ok: true, project: await summarized(renamed.projectDir, renamed.name || renamed.id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/projects/:name/duplicate", async (req, res) => {
    const name = req.params.name;
    if (!isSafeProjectName(name)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    try {
      const showId = queryShowId(req, res);
      if (showId === false) return;
      const copied = showId
        ? duplicateEpisode(showsDir, showId, name)
        : duplicateProject(projectsDir, name);
      res.status(201).json({ ok: true, project: await summarized(copied.projectDir, copied.name || copied.id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/projects/:name/move-to-show", async (req, res) => {
    const name = req.params.name;
    if (!isSafeProjectName(name)) {
      return res.status(400).json({ error: "Invalid project name" });
    }
    const showId = req.body && (req.body.showId || req.body.id);
    const displayName = req.body && req.body.displayName;
    const create = !!(req.body && req.body.create);
    if (!showId || !isSafeShowId(showId)) {
      return res.status(400).json({ error: "Invalid show name" });
    }
    try {
      const moved = moveProjectIntoShow(projectsDir, showsDir, name, showId, { create, displayName });
      const show = await summarizeShow(showsDir, moved.showId);
      const episode = await summarized(moved.projectDir, moved.episodeId);
      res.json({ ok: true, show, episode });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows", async (_req, res) => {
    try {
      res.json({ shows: await listShows(showsDir) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/shows", async (req, res) => {
    const rawName = req.body && (req.body.name || req.body.id);
    if (!rawName) return res.status(400).json({ error: "Show name is required" });
    try {
      const created = createShow(showsDir, rawName, {
        displayName: req.body.displayName || req.body.name,
        description: req.body.description || "",
        id: req.body.id,
      });
      res.status(201).json({ ok: true, show: await summarizeShow(showsDir, created.id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    try {
      const show = await summarizeShow(showsDir, found.showId);
      res.json({
        show,
        assets: describeShowAssets(found.showDir),
        finalCut: readFinalCut(found.showDir),
        library: {
          added: readLibrary(found.showDir).characters,
        },
      });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId/contents", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    res.json({ name: found.showId, contents: describeShowContents(found.showDir) });
  });

  app.post("/api/shows/:showId/trash", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const confirmName = req.body && req.body.confirmName;
    if (confirmName !== found.showId && confirmName !== (readShowJson(found.showDir) || {}).name) {
      return res.status(400).json({ error: "Type the show name to confirm" });
    }
    try {
      const { moveFolderToTrash } = require("./studioProjects");
      res.json({
        ok: true,
        trash: moveFolderToTrash(projectsDir, found.showDir, found.showId, {
          kind: "show",
          originalName: found.showId,
        }),
      });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/shows/:showId/rename", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const newId = req.body && req.body.id;
    const displayName = req.body && (req.body.displayName || req.body.name);
    if (newId && !isSafeShowId(newId)) {
      return res.status(400).json({ error: "Invalid show name" });
    }
    try {
      const renamed = renameShow(showsDir, found.showId, newId || found.showId, { displayName });
      res.json({ ok: true, show: await summarizeShow(showsDir, renamed.id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/shows/:showId/duplicate", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    try {
      const copied = duplicateShow(showsDir, found.showId);
      res.status(201).json({ ok: true, show: await summarizeShow(showsDir, copied.id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId/download", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    streamProjectZip(found.showDir, found.showId, res);
  });

  app.get("/api/shows/:showId/assets", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    res.json(describeShowAssets(found.showDir));
  });

  app.get("/api/shows/:showId/library", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const globalAssetsDir = resolveGlobalAssetsDir(found.showDir);
    res.json({
      characters: listGlobalCharacters(found.showDir, globalAssetsDir),
      added: readLibrary(found.showDir).characters,
    });
  });

  app.post("/api/shows/:showId/library", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const characterId = req.body && req.body.characterId;
    try {
      const globalAssetsDir = resolveGlobalAssetsDir(found.showDir);
      const library = addLibraryCharacter(found.showDir, globalAssetsDir, characterId);
      res.json({ ok: true, library });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId/asset", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const rel = typeof req.query.rel === "string" ? req.query.rel : "";
    if (!isSafeRelPath(rel)) {
      return res.status(400).json({ error: "Invalid asset path" });
    }
    const globalAssetsDir = resolveGlobalAssetsDir(found.showDir);
    const resolved = resolveAsset(found.showDir, globalAssetsDir, rel);
    if (!resolved) {
      return res.status(404).json({ error: `Asset not found: ${rel}` });
    }
    const ext = path.extname(resolved.absPath).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) {
      return res.status(400).json({ error: "Unsupported asset type" });
    }
    const wantThumb = req.query.thumb === "1" || req.query.thumb === "true";
    if (wantThumb) {
      cachedBackgroundThumb(resolved.absPath)
        .then((thumbPath) => {
          const file = thumbPath || resolved.absPath;
          const sendType = thumbPath ? "image/jpeg" : type;
          setAssetCacheControl(req, res, resolved.absPath);
          res.type(sendType).sendFile(file);
        })
        .catch((err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
        });
      return;
    }
    setAssetCacheControl(req, res, resolved.absPath);
    res.type(type).sendFile(resolved.absPath);
  });

  app.post("/api/shows/:showId/episodes", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const episodeId = req.body && req.body.name;
    const duplicateFrom = req.body && req.body.duplicateFrom;
    if (!isSafeProjectName(episodeId)) {
      return res.status(400).json({ error: "Invalid episode name" });
    }
    try {
      const created = duplicateFrom
        ? duplicateEpisode(showsDir, found.showId, duplicateFrom)
        : createEpisode(showsDir, found.showId, episodeId);
      const id = created.id || created.name || episodeId;
      // Duplicate uses source name-copy; if they asked for a specific name, rename.
      if (duplicateFrom && episodeId && id !== episodeId) {
        const renamed = renameEpisode(showsDir, found.showId, id, episodeId);
        res.status(201).json({ ok: true, episode: await summarized(renamed.projectDir, renamed.id) });
        return;
      }
      res.status(201).json({ ok: true, episode: await summarized(created.projectDir, id) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/shows/:showId/episodes/:episodeId/move-to-experiments", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const episodeId = req.params.episodeId;
    if (!isSafeProjectName(episodeId)) {
      return res.status(400).json({ error: "Invalid episode name" });
    }
    try {
      const moved = moveEpisodeToExperiments(projectsDir, showsDir, found.showId, episodeId);
      res.json({ ok: true, project: await summarized(moved.projectDir, moved.name) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId/final-cut", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    res.json({ cut: readFinalCut(found.showDir) });
  });

  app.put("/api/shows/:showId/final-cut", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const body = req.body || {};
    try {
      res.json({ ok: true, cut: writeFinalCut(found.showDir, body.cut || body) });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.get("/api/shows/:showId/final-cut/plan", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    try {
      res.json(await planFinalCut(showsDir, found.showId));
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  app.post("/api/shows/:showId/final-cut/render", async (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    if (renderInProgress) {
      return res.status(409).json({ error: "A render is already in progress" });
    }
    renderInProgress = true;
    try {
      let plan = await planFinalCut(showsDir, found.showId);
      if (plan.items.length === 0) {
        return res.status(400).json({ error: "Final cut is empty. Add episodes first." });
      }
      if (plan.missingCount > 0) {
        return res.status(400).json({ error: "Final cut points at a missing episode." });
      }
      for (const item of plan.items) {
        if (!item.willRender) continue;
        const projectDir = resolveEpisodeDir(showsDir, found.showId, item.episodeId);
        const parsed = await parseForWrite(projectDir, parseOpts(skipValidate, item.script));
        if (parsed.validation && parsed.validation.ok === false) {
          cleanupTempParse(parsed);
          return res.status(400).json({ error: parsed.validation.message || `Render failed for ${item.episodeId}` });
        }
        const outputFile = renderOutputName(item.script);
        const outputPath = path.join(projectDir, "renders", outputFile);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        try {
          await renderProject(projectDir, {
            codec: "h264",
            output: outputPath,
            timeline: parsed.timelinePath,
            ...(options.pythonBin ? { pythonBin: options.pythonBin } : {}),
          });
        } finally {
          cleanupTempParse(parsed);
        }
      }
      const result = await renderFinalCut(showsDir, found.showId, {
        name: req.body && req.body.name,
        allowStale: true,
      });
      res.json({
        ok: true,
        outputPath: result.outputPath,
        file: result.file,
        url: `/api/shows/${encodeURIComponent(found.showId)}/final/${encodeURIComponent(result.file)}`,
        plan: result.plan,
        note: plan.note,
      });
    } catch (err) {
      sendLifecycleError(res, err);
    } finally {
      renderInProgress = false;
    }
  });

  app.get("/api/shows/:showId/final/:file", (req, res) => {
    const found = showFromRequest(req, res);
    if (!found) return;
    const file = path.basename(String(req.params.file || ""));
    if (!SAFE_RENDER_FILE.test(file)) {
      return res.status(400).json({ error: "Invalid final-cut filename" });
    }
    const outputPath = path.join(found.showDir, "final", file);
    if (!fs.existsSync(outputPath)) {
      return res.status(404).json({ error: "No final cut yet. Use Render final first." });
    }
    res.sendFile(outputPath, { headers: { "Content-Type": "video/mp4" } });
  });

  app.get("/api/projects/:name/download", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    streamProjectZip(projectDir, req.params.name, res);
  });

  app.get("/api/projects/:name/scripts", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    res.json({ scripts: listScriptFiles(projectDir), default: DEFAULT_SCRIPT });
  });

  app.get("/api/projects/:name/characters", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    const used = collectUsedAssets(projectDir, globalAssetsDir);
    res.json({ characters: listCharacters(projectDir, globalAssetsDir, { ids: used.characterIds }) });
  });

  app.get("/api/projects/:name/library", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    const used = collectUsedAssets(projectDir, globalAssetsDir);
    res.json({
      characters: listGlobalCharacters(projectDir, globalAssetsDir),
      added: used.library.characters,
    });
  });

  function sendIngestError(res, err) {
    if (err.code === "EINVAL") return res.status(400).json({ error: err.message });
    if (err.code === "ENOENT" || err.code === "ENOTFOUND") return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }

  function characterIdFromRequest(req, res) {
    const characterId = req.params.characterId;
    if (!isSafeFolderName(characterId)) {
      res.status(400).json({ error: "Invalid character id" });
      return null;
    }
    return characterId;
  }

  app.put("/api/projects/:name/characters/:characterId", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      const style = req.body && req.body.style;
      res.json(saveCharacterStyle(projectDir, globalAssetsDir, characterId, style));
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.post("/api/projects/:name/characters/:characterId/reference", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      res.json(saveCharacterReference(projectDir, globalAssetsDir, characterId, req.body || {}));
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.put("/api/projects/:name/characters/:characterId/slots/:slotName", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    const slotName = req.params.slotName;
    if (!SLOT_NAME.test(String(slotName || ""))) {
      return res.status(400).json({ error: "Invalid slot name" });
    }
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      res.json(saveSlotAlignment(projectDir, globalAssetsDir, characterId, slotName, req.body || {}));
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.post("/api/projects/:name/characters/:characterId/ingest", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      const ingestOpts = options.pythonBin ? { pythonBin: options.pythonBin } : {};
      const result = await previewIngest(projectDir, globalAssetsDir, characterId, req.body || {}, ingestOpts);
      res.json(result);
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.post("/api/projects/:name/characters/:characterId/ingest/confirm", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    try {
      res.json(confirmIngest(projectDir, globalAssetsDir, characterId, req.body || {}));
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.post("/api/projects/:name/characters/:characterId/ingest/cancel", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const characterId = characterIdFromRequest(req, res);
    if (!characterId) return;
    try {
      res.json(cancelIngest(projectDir, characterId, req.body || {}));
    } catch (err) {
      sendIngestError(res, err);
    }
  });

  app.post("/api/projects/:name/library", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    const characterId = req.body && req.body.characterId;
    try {
      const library = addLibraryCharacter(projectDir, globalAssetsDir, characterId);
      res.json({ ok: true, library });
    } catch (err) {
      if (err.code === "EINVAL") return res.status(400).json({ error: err.message });
      if (err.code === "ENOTFOUND") return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/projects/:name/staging", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    const used = collectUsedAssets(projectDir, globalAssetsDir);
    res.json(listStaging(projectDir, globalAssetsDir, { locationIds: used.locationIds }));
  });

  app.get("/api/projects/:name/audio", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    res.json({ files: listProjectAudio(projectDir, globalAssetsDir) });
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
    const wantThumb = req.query.thumb === "1" || req.query.thumb === "true";
    if (wantThumb) {
      cachedBackgroundThumb(resolved.absPath)
        .then((thumbPath) => {
          const file = thumbPath || resolved.absPath;
          const sendType = thumbPath ? "image/jpeg" : type;
          setAssetCacheControl(req, res, resolved.absPath);
          res.type(sendType).sendFile(file);
        })
        .catch((err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
        });
      return;
    }
    setAssetCacheControl(req, res, resolved.absPath);
    res.type(type).sendFile(resolved.absPath);
  });

  app.get("/api/projects/:name/script", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const scriptPath = path.join(projectDir, scriptName);
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: `${scriptName} not found` });
    }
    res.type("text/plain").send(fs.readFileSync(scriptPath, "utf8"));
  });

  app.get("/api/projects/:name/script-history", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    res.json({ script: scriptName, snapshots: listScriptHistory(projectDir, scriptName) });
  });

  app.post("/api/projects/:name/script-history/restore", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const id = typeof body.id === "string" ? body.id : "";
    const restored = restoreScriptSnapshot(projectDir, scriptName, id);
    if (!restored.ok) return res.status(404).json({ error: restored.error || "Snapshot not found" });

    let result;
    let parseError = null;
    try {
      result = await parseForWrite(projectDir, parseOpts(skipValidate, scriptName));
    } catch (err) {
      parseError = err;
    }
    const lint = lintFromResult(result, parseError);
    try {
      res.json({
        ok: lint.errors.length === 0,
        saved: true,
        restored: true,
        id: restored.id,
        text: restored.text,
        lint,
      });
    } finally {
      cleanupTempParse(result);
    }
  });

  app.put("/api/projects/:name/script", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const scriptText = readScriptBody(req);
    snapshotScriptWrite(projectDir, scriptName, scriptText);
    fs.writeFileSync(path.join(projectDir, scriptName), scriptText);

    let result;
    let parseError = null;
    try {
      result = await parseForWrite(projectDir, parseOpts(skipValidate, scriptName));
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
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const opts = parseOpts(skipValidate, scriptName);
    if (req.body && typeof req.body === "object" && typeof req.body.text === "string") {
      opts.scriptText = req.body.text;
    } else if (typeof req.body === "string") {
      opts.scriptText = req.body;
    }

    let result;
    let parseError = null;
    try {
      result = await parseForWrite(projectDir, opts);
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

  app.get("/api/projects/:name/settings", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    res.json(readStudioSettings(projectDir));
  });

  app.put("/api/projects/:name/settings", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const patch = {};
    if (body.lipSync === "auto" || body.lipSync === "manual") patch.lipSync = body.lipSync;
    res.json(writeStudioSettings(projectDir, patch));
  });

  app.post("/api/projects/:name/lipsync", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const force = body.force === true;
    const clear = body.clear === true;
    let result;
    try {
      result = await parseForRead(projectDir, scriptName);
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
      let targets = collectDialogueTargets(result.laneEvents);
      if (body.all === true) {
        if (!force && !clear) targets = targets.filter((item) => item.sync !== "synced");
      } else {
        const lines = new Set();
        if (Number.isInteger(body.scriptLine) && body.scriptLine > 0) lines.add(body.scriptLine);
        if (Array.isArray(body.scriptLines)) {
          for (const line of body.scriptLines) {
            if (Number.isInteger(line) && line > 0) lines.add(line);
          }
        }
        if (lines.size === 0) {
          return res.status(400).json({ error: "Pass scriptLine, scriptLines, or all: true." });
        }
        targets = targets.filter((item) => lines.has(item.scriptLine));
        if (targets.length === 0) {
          return res.status(404).json({ error: "No dialogue line to sync on that script line." });
        }
      }
      const synced = clear
        ? clearDialogueLipSync({ projectDir, targets })
        : await syncDialogueLines({
            projectDir,
            targets,
            force,
            runRhubarb: options.runRhubarb,
          });
      res.json({
        ok: synced.ok,
        lipSync: readStudioSettings(projectDir).lipSync,
        results: synced.results,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      cleanupTempParse(result);
    }
  });

  app.put("/api/projects/:name/cues", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = patchMouthCue(projectDir, body);
    if (!result.ok) return res.status(400).json({ error: result.error || "Cue save failed" });
    res.json(result);
  });

  app.get("/api/projects/:name/lanes", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    let result;
    try {
      result = await parseForRead(projectDir, scriptName);
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
      res.json(buildLaneBlocks(result));
    } finally {
      cleanupTempParse(result);
    }
  });

  app.get("/api/projects/:name/stage", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
    let result;
    try {
      result = await parseForRead(projectDir, scriptName);
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
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
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;

    let result;
    try {
      result = await parseForRead(projectDir, scriptName);
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
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
    const lanes = buildLaneBlocks(result);
    const playableFrames = lanes.totalFrames;
    frame = clampFrame(frame, playableFrames);
    const format = body.format === "png" ? "png" : "jpeg";
    const quality = 85;

    function sendPreview(type, buffer, meta) {
      const totalFrames =
        Number(meta.totalFrames) > 0 ? Number(meta.totalFrames) : playableFrames;
      const servedFrame = clampFrame(meta.frame != null ? meta.frame : frame, totalFrames);
      res.setHeader("X-Engine-Frame", String(servedFrame));
      res.setHeader("X-Engine-Total-Frames", String(totalFrames));
      if (meta.fps != null) res.setHeader("X-Engine-Fps", String(meta.fps));
      if (meta.canvas && meta.canvas.width) res.setHeader("X-Engine-Canvas-Width", String(meta.canvas.width));
      if (meta.canvas && meta.canvas.height) res.setHeader("X-Engine-Canvas-Height", String(meta.canvas.height));
      if (meta.sceneId) res.setHeader("X-Engine-Scene-Id", String(meta.sceneId));
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.type(type).send(buffer);
    }

    const cached = getCachedPreview(projectDir, scriptName, frame, format, quality);
    if (!cached.miss) {
      sendPreview(cached.type, cached.buffer, cached.meta || {});
      cleanupTempParse(result);
      return;
    }

    const ext = format === "png" ? "png" : "jpg";
    const tmp = path.join(
      os.tmpdir(),
      `engine-preview-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
    );
    try {
      const previewOpts = options.pythonBin ? { pythonBin: options.pythonBin } : {};
      previewOpts.timeline = result.timelinePath;
      previewOpts.format = format;
      previewOpts.quality = quality;
      const preview = await previewFrame(projectDir, frame, tmp, previewOpts);
      const meta = preview.meta || {};
      const buffer = fs.readFileSync(tmp);
      const type = format === "png" ? "image/png" : "image/jpeg";
      storePreview(cached.key, type, buffer, meta);
      sendPreview(type, buffer, meta);
    } catch (err) {
      const status = /past the end|must be >= 0/.test(err.message) ? 400 : 500;
      if (!res.headersSent) res.status(status).json({ error: err.message });
    } finally {
      fs.unlink(tmp, () => {});
      cleanupTempParse(result);
    }
  });

  app.get("/api/projects/:name/playback", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    let result;
    try {
      result = await parseForRead(projectDir, scriptName);
    } catch (err) {
      return res.status(400).json(parseErrorPayload(err));
    }
    try {
      res.json(describePlayback(projectDir, scriptName, buildLaneBlocks(result)));
    } finally {
      cleanupTempParse(result);
    }
  });

  app.get("/api/projects/:name/media", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const rel = typeof req.query.rel === "string" ? req.query.rel : "";
    if (!isSafeAudioRel(rel)) {
      return res.status(400).json({ error: "Invalid audio path" });
    }
    const abs = resolveProjectAudio(projectDir, rel);
    if (!abs) {
      return res.status(404).json({ error: `Audio not found: ${rel}` });
    }
    res.type("audio/wav").sendFile(abs);
  });

  app.post("/api/projects/:name/import-audio", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    let parsed;
    try {
      parsed = await readImportAudioRequest(req);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!parsed.character) {
      if (parsed.cleanup) parsed.cleanup();
      return res.status(400).json({ error: "character is required" });
    }
    if (!parsed.sourcePath) {
      if (parsed.cleanup) parsed.cleanup();
      return res.status(400).json({ error: "path (or multipart file) is required" });
    }
    try {
      const result = await runImportAudio(projectDir, parsed.sourcePath, {
        character: parsed.character,
        name: parsed.name,
        dryRun: parsed.dryRun,
        noTranscribe: parsed.noTranscribe,
      });
      res.json({
        ok: result.ok,
        dryRun: result.dryRun,
        noTranscribe: result.noTranscribe,
        label: result.label,
        character: result.character,
        durationSeconds: result.durationSeconds,
        creditNote: result.creditNote,
        wavPath: result.wavPath,
        cuesPath: result.cuesPath,
        wordsPath: result.wordsPath,
        transcribed: result.transcribed,
        tag: `[Audio: ${result.character} file=${result.label}]`,
      });
    } catch (err) {
      const status =
        err.status ||
        (err instanceof VoicesFatalError
          ? 400
          : /not found|required|Unknown character|Unsupported|empty|Invalid import|Project folder not found/i.test(
              err.message
            )
            ? 400
            : 500);
      res.status(status).json({ error: err.message });
    } finally {
      if (parsed && parsed.cleanup) parsed.cleanup();
    }
  });

  app.post("/api/projects/:name/render", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    if (renderInProgress) {
      return res.status(409).json({ error: "A render is already in progress" });
    }

    renderInProgress = true;
    // Same flags as `node src/cli.js render <dir> --from-script --script <file> --output renders/<stem>.mp4`.
    // Parse to a temp timeline so Studio Render never overwrites timeline.json.
    const outputFile = renderOutputName(scriptName);
    const outputPath = path.join(projectDir, "renders", outputFile);
    let parsed;
    try {
      try {
        parsed = await parseForWrite(projectDir, parseOpts(skipValidate, scriptName));
      } catch (err) {
        return res.status(400).json(parseErrorPayload(err));
      }
      if (parsed.validation && parsed.validation.ok === false) {
        return res.status(400).json({ error: parsed.validation.message || "timeline validation failed" });
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const renderOpts = { codec: "h264", output: outputPath, timeline: parsed.timelinePath };
      if (options.pythonBin) renderOpts.pythonBin = options.pythonBin;
      const rendered = await renderProject(projectDir, renderOpts);
      const estimatedSilent =
        rendered.estimatedSilent ||
        parseEstimatedSilent(`${rendered.stdout}\n${rendered.stderr}`) ||
        estimatedSilentFromLines(parsed.lines);

      res.json({
        ok: true,
        outputPath,
        script: scriptName,
        url: `/api/projects/${encodeURIComponent(req.params.name)}/renders/${encodeURIComponent(outputFile)}`,
        estimatedSilent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      cleanupTempParse(parsed);
      renderInProgress = false;
    }
  });

  app.post("/api/projects/:name/preview-render", async (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const scriptName = scriptFromRequest(req, res);
    if (!scriptName) return;
    if (renderInProgress) {
      return res.status(409).json({ error: "A render is already in progress" });
    }

    renderInProgress = true;
    const outputFile = previewOutputName(scriptName);
    const outputPath = path.join(projectDir, "renders", outputFile);
    let parsed;
    try {
      try {
        parsed = await parseForWrite(projectDir, parseOpts(skipValidate, scriptName));
      } catch (err) {
        return res.status(400).json(parseErrorPayload(err));
      }
      if (parsed.validation && parsed.validation.ok === false) {
        return res.status(400).json({ error: parsed.validation.message || "timeline validation failed" });
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const renderOpts = {
        codec: "h264",
        output: outputPath,
        timeline: parsed.timelinePath,
        width: PROXY_SIZE.width,
        height: PROXY_SIZE.height,
      };
      if (options.pythonBin) renderOpts.pythonBin = options.pythonBin;
      await renderProject(projectDir, renderOpts);
      res.json({
        ok: true,
        outputPath,
        script: scriptName,
        proxy: true,
        url: `/api/projects/${encodeURIComponent(req.params.name)}/renders/${encodeURIComponent(outputFile)}`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      cleanupTempParse(parsed);
      renderInProgress = false;
    }
  });

  app.get("/api/projects/:name/renders/:file", (req, res) => {
    const projectDir = projectFromRequest(req, res);
    if (!projectDir) return;
    const file = path.basename(String(req.params.file || ""));
    if (!SAFE_RENDER_FILE.test(file)) {
      return res.status(400).json({ error: "Invalid render filename" });
    }
    const outputPath = path.join(projectDir, "renders", file);
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
module.exports.renderOutputName = renderOutputName;
module.exports.resolveScriptName = resolveScriptName;
