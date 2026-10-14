"use strict";

/**
 * Action Shots – make clips with Grok in-app, import MP4s, capture every frame.
 *
 * Routes are mounted under /api/projects/:name/characters/:characterId/shots
 * in server.js.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { characterDir } = require("./characterLocal");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { parseMultipartBuffer, collectRawBody } = require("./importAudio");
const { inferCategoryFromAction, writeActionJson, slugClipId } = require("./factoryLibrary");
const { isSafeFolderName } = require("./studioProjects");

const VIDEO_MODEL = "grok-imagine-video-1.5";
const VIDEO_GENERATIONS_URL = "https://api.x.ai/v1/videos/generations";
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 10 * 60 * 1000;
const BG_PROMPT_SUFFIX = {
  green: "plain solid green background, character stays fully in frame, same character, no text",
  black: "plain solid black background, character stays fully in frame, same character, no text",
};

function shotError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function shotsDir(projectDir, characterId) {
  return path.join(characterDir(projectDir, characterId), "shots");
}

function shotDir(projectDir, characterId, shotId) {
  if (!isSafeFolderName(shotId)) throw shotError("Invalid shot id");
  return path.join(shotsDir(projectDir, characterId), shotId);
}

function readShotJson(dir) {
  const file = path.join(dir, "shot.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeShotJson(dir, data) {
  fs.writeFileSync(path.join(dir, "shot.json"), JSON.stringify(data, null, 2));
}

// ── Slug + unique ID ────────────────────────────────────────────────

function slugName(text) {
  return String(text || "shot")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "shot";
}

function uniqueShotId(projectDir, characterId, base) {
  const dir = shotsDir(projectDir, characterId);
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let i = 2; i < 999; i++) {
    const candidate = `${base}_${i}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base}_${Date.now()}`;
}

// ── Category inference from prompt ──────────────────────────────────

function inferCategory(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/walk|stride|gait|step/.test(text)) return "walks";
  if (/turn|look/.test(text)) return "turns_looks";
  if (/head/.test(text)) return "head_moves";
  if (/mic|micro/.test(text)) return "mic";
  if (/arm|gesture|point|wave|clap/.test(text)) return "arms_gestures";
  if (/mouth|tongue|lip|smile|frown|expression|face/.test(text)) return "expressions";
  if (/idle|stand/.test(text)) return "idle_stand";
  if (/insert/.test(text)) return "inserts";
  return "other";
}

// ── Spawn helper ────────────────────────────────────────────────────

function spawnCmd(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => reject(new Error(`Failed to spawn ${bin}: ${err.message}`)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ── Python shot capture ─────────────────────────────────────────────

async function runShotCapture(videoPath, outDir, meta = {}, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = [
    "-m", "compositor.shot_capture",
    "--video", videoPath,
    "--out-dir", outDir,
  ];
  if (meta.name) args.push("--name", meta.name);
  if (meta.prompt) args.push("--prompt", meta.prompt);
  if (meta.refImage) args.push("--ref-image", meta.refImage);
  if (meta.background) args.push("--background", meta.background);
  if (meta.category) args.push("--category", meta.category);

  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  const trimmed = stdout.trim();
  let parsed = null;
  if (trimmed) {
    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1];
    try { parsed = JSON.parse(lastLine); } catch {}
  }
  if (code !== 0 || !parsed) {
    const msg = (stderr || "").trim().split("\n").pop() || "Shot capture failed";
    throw shotError(msg);
  }
  if (parsed.error) throw shotError(parsed.error);
  return parsed;
}

// ── xAI Video API ───────────────────────────────────────────────────

function resolveApiKey(env = process.env) {
  return (env.XAI_API_KEY || "").trim();
}

async function startGrokVideo(prompt, imageBase64, duration, fetchFn) {
  const apiKey = resolveApiKey();
  if (!apiKey) throw shotError("XAI_API_KEY is not configured. Add it in Engine Settings.", "ENOKEY");

  const fetchImpl = fetchFn || globalThis.fetch;
  const body = {
    model: process.env.XAI_VIDEO_MODEL || VIDEO_MODEL,
    prompt,
    duration: duration || 6,
    resolution: "720p",
  };
  if (imageBase64) {
    body.image = { url: `data:image/png;base64,${imageBase64}` };
  }

  const response = await fetchImpl(VIDEO_GENERATIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const msg = text.slice(0, 200) || `xAI returned ${response.status}`;
    throw shotError(msg, "EXAI");
  }

  const json = await response.json();
  return json.request_id || json.id;
}

async function pollGrokVideo(requestId, fetchFn) {
  const apiKey = resolveApiKey();
  const fetchImpl = fetchFn || globalThis.fetch;
  const url = `https://api.x.ai/v1/videos/${requestId}`;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) continue;
    const json = await response.json();
    if (json.status === "done" || json.status === "completed") {
      const videoUrl = json.video?.url || json.url || json.video_url;
      if (!videoUrl) throw shotError("xAI returned done but no video URL", "EXAI");
      return videoUrl;
    }
    if (json.status === "failed" || json.status === "error") {
      throw shotError(json.error || json.message || "Grok video generation failed", "EXAI");
    }
  }
  throw shotError("Grok video generation timed out after 10 minutes", "ETIMEOUT");
}

async function downloadVideo(url, destPath, fetchFn) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const response = await fetchImpl(url);
  if (!response.ok) throw shotError("Could not download video from xAI", "EXAI");
  const buf = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// ── In-progress jobs tracking ───────────────────────────────────────

const activeJobs = new Map();

// ── Public API ──────────────────────────────────────────────────────

/**
 * List all shots for a character.
 */
function listShots(projectDir, characterId) {
  const dir = shotsDir(projectDir, characterId);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const shots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    const info = readShotJson(path.join(dir, entry.name));
    if (info) {
      // Add frame list info
      const thumbDir = path.join(dir, entry.name, "thumb");
      if (fs.existsSync(thumbDir)) {
        info._thumbCount = fs.readdirSync(thumbDir).filter((n) => n.endsWith(".jpg")).length;
      }
      shots.push(info);
    }
  }
  return shots.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Get a single shot with its frame list.
 */
function getShot(projectDir, characterId, shotId) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");

  // Build frame list
  const thumbDir = path.join(dir, "thumb");
  const cutDir = path.join(dir, "cut");
  const frames = [];
  if (fs.existsSync(thumbDir)) {
    const files = fs.readdirSync(thumbDir).filter((n) => n.endsWith(".jpg")).sort();
    for (const f of files) {
      const match = f.match(/f_(\d+)/);
      if (!match) continue;
      const n = parseInt(match[1], 10);
      frames.push({
        n,
        thumb: `thumb/${f}`,
        cut: `cut/f_${String(n).padStart(4, "0")}.png`,
        deleted: !fs.existsSync(path.join(cutDir, `f_${String(n).padStart(4, "0")}.png`)),
      });
    }
  }
  return { ...info, frames };
}

/**
 * Start making a shot with Grok – returns immediately, processes in background.
 */
async function makeShot(projectDir, characterId, body, options = {}) {
  const { prompt, background, duration, refRel, refBase64 } = body;
  if (!prompt) throw shotError("Enter a prompt.");

  const bg = background || "green";
  const fullPrompt = `${prompt}, ${BG_PROMPT_SUFFIX[bg] || BG_PROMPT_SUFFIX.green}`;
  const dur = [4, 6, 8, 10].includes(Number(duration)) ? Number(duration) : 6;

  // Resolve reference image
  let imageBase64 = refBase64 || null;
  if (!imageBase64 && refRel) {
    const refPath = path.join(projectDir, refRel);
    if (fs.existsSync(refPath)) {
      imageBase64 = fs.readFileSync(refPath).toString("base64");
    }
  }

  // Create shot directory
  const shotName = slugName(prompt);
  const shotId = uniqueShotId(projectDir, characterId, shotName);
  const dir = shotDir(projectDir, characterId, shotId);
  fs.mkdirSync(dir, { recursive: true });

  // Write initial shot.json with "making" status
  const info = {
    id: shotId,
    name: shotName,
    filename: "",
    prompt,
    refImage: refRel || "",
    background: bg,
    fps: 0,
    frameCount: 0,
    in: 1,
    out: 0,
    category: inferCategory(prompt),
    createdAt: new Date().toISOString(),
    status: "making",
  };
  writeShotJson(dir, info);

  // Start the Grok job in the background
  const jobKey = `${characterId}/${shotId}`;
  activeJobs.set(jobKey, { status: "making", startedAt: Date.now() });

  (async () => {
    try {
      const requestId = await startGrokVideo(fullPrompt, imageBase64, dur, options.fetchFn);
      activeJobs.set(jobKey, { status: "making", requestId, startedAt: Date.now() });
      info.requestId = requestId;
      writeShotJson(dir, info);

      const videoUrl = await pollGrokVideo(requestId, options.fetchFn);
      const sourcePath = path.join(dir, "source.mp4");
      await downloadVideo(videoUrl, sourcePath, options.fetchFn);
      info.filename = "source.mp4";
      writeShotJson(dir, info);

      // Run shot capture
      const result = await runShotCapture(sourcePath, dir, {
        name: shotName,
        prompt,
        refImage: refRel || "",
        background: bg,
        category: inferCategory(prompt),
      }, options);

      // Update shot.json with results
      info.fps = result.fps;
      info.frameCount = result.frameCount;
      info.out = result.frameCount;
      info.status = "ready";
      delete info.requestId;
      writeShotJson(dir, info);
      activeJobs.delete(jobKey);
    } catch (err) {
      info.status = "error";
      info.error = err.message;
      writeShotJson(dir, info);
      activeJobs.set(jobKey, { status: "error", error: err.message });
    }
  })();

  return { shotId, status: "making" };
}

/**
 * Import an existing MP4 – same pipeline from step 2.
 */
async function importShot(projectDir, characterId, req, options = {}) {
  const ctype = String(req.headers["content-type"] || "");
  let videoBuffer = null;
  let filename = "import.mp4";

  if (ctype.includes("multipart/form-data")) {
    const buffer = await collectRawBody(req, 250 * 1024 * 1024);
    const parts = parseMultipartBuffer(buffer, ctype);
    for (const part of parts) {
      if (part.filename) {
        videoBuffer = part.data;
        filename = part.filename;
      }
    }
  }

  if (!videoBuffer || !videoBuffer.length) {
    throw shotError("No MP4 file uploaded.");
  }

  // Create shot directory – name = original filename
  const shotName = slugName(path.basename(filename, path.extname(filename)));
  const shotId = uniqueShotId(projectDir, characterId, shotName);
  const dir = shotDir(projectDir, characterId, shotId);
  fs.mkdirSync(dir, { recursive: true });

  // Write the video file
  const sourcePath = path.join(dir, "source.mp4");
  fs.writeFileSync(sourcePath, videoBuffer);

  // Run shot capture
  const result = await runShotCapture(sourcePath, dir, {
    name: shotName,
    category: inferCategory(shotName),
  }, options);

  const info = readShotJson(dir);
  return { shotId, ...info };
}

/**
 * Edit shot metadata.
 */
function patchShot(projectDir, characterId, shotId, body) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");

  if (body.name != null) info.name = String(body.name).trim() || info.name;
  if (body.category != null) info.category = String(body.category).trim() || info.category;
  if (body.in != null) info.in = Math.max(1, Math.min(Number(body.in) || 1, info.frameCount));
  if (body.out != null) info.out = Math.max(1, Math.min(Number(body.out) || info.frameCount, info.frameCount));

  writeShotJson(dir, info);
  return { ok: true, shot: info };
}

/**
 * Delete a single frame (move to _deleted/).
 */
function deleteFrame(projectDir, characterId, shotId, frameN) {
  const dir = shotDir(projectDir, characterId, shotId);
  const n = Number(frameN);
  if (!Number.isFinite(n) || n < 1) throw shotError("Invalid frame number");

  const pad = String(n).padStart(4, "0");
  const deletedDir = path.join(dir, "_deleted");
  fs.mkdirSync(deletedDir, { recursive: true });

  for (const sub of ["cut", "thumb", "raw"]) {
    const ext = sub === "thumb" ? ".jpg" : ".png";
    const src = path.join(dir, sub, `f_${pad}${ext}`);
    if (fs.existsSync(src)) {
      fs.renameSync(src, path.join(deletedDir, `${sub}_f_${pad}${ext}`));
    }
  }
  return { ok: true, frame: n };
}

/**
 * Save a frame to a slot as a draft drawing.
 */
function saveFrameToSlot(projectDir, characterId, shotId, frameN, slot, view) {
  const dir = shotDir(projectDir, characterId, shotId);
  const n = Number(frameN);
  const pad = String(n).padStart(4, "0");
  const cutPath = path.join(dir, "cut", `f_${pad}.png`);
  if (!fs.existsSync(cutPath)) throw shotError("Frame not found", "ENOENT");

  const info = readShotJson(dir);
  const drawingName = `${info.id || shotId}_f${n}`;
  const drawingsDir = path.join(characterDir(projectDir, characterId), "drawings", slot || "body", view || "front");
  fs.mkdirSync(drawingsDir, { recursive: true });
  const dest = path.join(drawingsDir, `${drawingName}.png`);
  fs.copyFileSync(cutPath, dest);

  return { ok: true, drawing: drawingName, path: dest };
}

/**
 * "Use as Action Shot" – write an action JSON with the in→out cut frames.
 */
function useAsActionShot(projectDir, characterId, shotId) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");

  const inFrame = info.in || 1;
  const outFrame = info.out || info.frameCount;
  const cutDir = path.join(dir, "cut");
  if (!fs.existsSync(cutDir)) throw shotError("No cut frames found");

  // Collect frame files in the in→out range
  const frameNames = [];
  for (let i = inFrame; i <= outFrame; i++) {
    const pad = String(i).padStart(4, "0");
    const file = `f_${pad}.png`;
    if (fs.existsSync(path.join(cutDir, file))) {
      frameNames.push(file);
    }
  }
  if (!frameNames.length) throw shotError("No frames in the selected range");

  // Copy frames to the actions drawings directory
  const actionId = slugName(info.name || info.id || shotId);
  const actionBase = uniqueActionId(projectDir, characterId, actionId);
  const drawingsDir = path.join(characterDir(projectDir, characterId), "actions", actionBase);
  fs.mkdirSync(drawingsDir, { recursive: true });

  const writtenNames = [];
  for (const fname of frameNames) {
    const dest = path.join(drawingsDir, fname);
    fs.copyFileSync(path.join(cutDir, fname), dest);
    writtenNames.push(fname);
  }

  // Write action JSON
  const action = {
    id: actionBase,
    view: "front",
    fps: info.fps || 24,
    frames: writtenNames.length,
    slot_frames: { body: writtenNames },
    hide_children: true,
    category: info.category || inferCategory(info.prompt || info.name || ""),
    shotId: info.id,
    drawingsDir: `actions/${actionBase}`,
  };

  const actionsDir = path.join(characterDir(projectDir, characterId), "actions");
  fs.mkdirSync(actionsDir, { recursive: true });
  fs.writeFileSync(path.join(actionsDir, `${actionBase}.json`), JSON.stringify(action, null, 2));

  // Mark the shot as used
  info.actionId = actionBase;
  info.usedAt = new Date().toISOString();
  writeShotJson(dir, info);

  return { ok: true, actionId: actionBase, frames: writtenNames.length, category: action.category };
}

function uniqueActionId(projectDir, characterId, base) {
  const actionsDir = path.join(characterDir(projectDir, characterId), "actions");
  if (!fs.existsSync(actionsDir)) return base;
  if (!fs.existsSync(path.join(actionsDir, `${base}.json`))) return base;
  for (let i = 2; i < 999; i++) {
    if (!fs.existsSync(path.join(actionsDir, `${base}_${i}.json`))) return `${base}_${i}`;
  }
  return `${base}_${Date.now()}`;
}

/**
 * Retry a failed make.
 */
async function retryShot(projectDir, characterId, shotId, options = {}) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");
  if (info.status !== "error") throw shotError("Shot is not in error state");

  // If we have a source.mp4 already, just re-run capture
  const sourcePath = path.join(dir, "source.mp4");
  if (fs.existsSync(sourcePath)) {
    info.status = "making";
    info.error = undefined;
    writeShotJson(dir, info);

    const result = await runShotCapture(sourcePath, dir, {
      name: info.name,
      prompt: info.prompt,
      refImage: info.refImage,
      background: info.background,
      category: info.category,
    }, options);

    info.fps = result.fps;
    info.frameCount = result.frameCount;
    info.out = result.frameCount;
    info.status = "ready";
    writeShotJson(dir, info);
    return { ok: true, shotId, status: "ready" };
  }

  // Otherwise restart the whole Grok job
  info.status = "making";
  info.error = undefined;
  writeShotJson(dir, info);
  return makeShot(projectDir, characterId, {
    prompt: info.prompt,
    background: info.background,
    duration: 6,
    refRel: info.refImage,
  }, options);
}

/**
 * Serve media files (mp4/jpg/png) with Range support.
 */
function serveMedia(projectDir, characterId, req, res) {
  const rel = String(req.query.rel || "");
  if (!rel || rel.includes("..") || rel.startsWith("/")) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const filePath = path.join(shotsDir(projectDir, characterId), rel);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  // Set cache headers
  res.setHeader("Cache-Control", "public, max-age=3600");

  // Determine content type
  const ext = path.extname(filePath).toLowerCase();
  const types = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
  if (types[ext]) res.setHeader("Content-Type", types[ext]);

  res.sendFile(filePath);
}

module.exports = {
  listShots,
  getShot,
  makeShot,
  importShot,
  patchShot,
  deleteFrame,
  saveFrameToSlot,
  useAsActionShot,
  retryShot,
  serveMedia,
};
