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
const comfyCloud = require("./comfyCloud");

const VIDEO_MODEL = "grok-imagine-video-1.5";
const VIDEO_GENERATIONS_URL = "https://api.x.ai/v1/videos/generations";
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 10 * 60 * 1000;
const BG_PROMPT_SUFFIX = {
  green: "the background is pure solid flat chroma-key green (#00FF00), evenly lit studio lighting with no shadows, no gradient, no vignette, no dark corners, no other colors in the background; character stays fully in frame, same character, no text, no watermark, no logo",
  black: "the background is pure solid flat matte black, evenly lit with no shadows, no gradient, no vignette, no dark-grey or brown tint, no other colors in the background; character stays fully in frame, same character, no text, no watermark, no logo",
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
  if (meta.keyMode) args.push("--key-mode", meta.keyMode);
  if (Number(meta.headSizeTarget) > 0) args.push("--head-size-target", String(meta.headSizeTarget));
  else if (meta.lockHeadSize) args.push("--lock-head-size");

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

function throwIfCancelled(isCancelled) {
  if (typeof isCancelled === "function" && isCancelled()) throw shotError("Stopped", "ECANCEL");
}

async function pollGrokVideo(requestId, fetchFn, intervalMs, isCancelled) {
  const apiKey = resolveApiKey();
  const fetchImpl = fetchFn || globalThis.fetch;
  const url = `https://api.x.ai/v1/videos/${requestId}`;
  const start = Date.now();
  const interval = Number.isFinite(intervalMs) ? intervalMs : POLL_INTERVAL;

  while (Date.now() - start < POLL_TIMEOUT) {
    await new Promise((r) => setTimeout(r, interval));
    throwIfCancelled(isCancelled);
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

/**
 * Fit an image inside 1280x720 with black bars (never crop or stretch).
 * LTX's own resize centre-crops anything that is not 16:9, which would cut
 * the top of a hat or the chin off a head shot.
 */
async function padImageTo16x9(inputPath, outPng) {
  const { FRAME_WIDTH: w, FRAME_HEIGHT: h } = comfyCloud;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  const { code, stderr } = await spawnCmd("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-vf", vf, "-frames:v", "1", outPng]);
  if (code !== 0 || !fs.existsSync(outPng)) throw shotError(`Could not prepare the start image for LTX: ${stderr.trim().split("\n").pop() || "ffmpeg failed"}`);
  return outPng;
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
    const shotPath = path.join(dir, entry.name);
    // Skip if deleted marker exists (fallback for when shot.json was locked)
    if (fs.existsSync(path.join(shotPath, "._deleted"))) continue;
    const info = readShotJson(shotPath);
    if (info && info.status !== "deleted") {
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
 * Run one Grok generation for an already-created shot folder: start the job,
 * poll, download source.mp4, capture frames and write the final shot.json.
 * Never throws -- failures are recorded on the shot (status "error").
 * Resolves with the (mutated) info once the shot is ready or failed.
 */
async function encodeAudioMp3(inputPath, outMp3) {
  const { code, stderr } = await spawnCmd("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", outMp3]);
  if (code !== 0 || !fs.existsSync(outMp3)) throw shotError(`Could not encode audio for LTX: ${String(stderr || "").trim().slice(-300)}`);
  return outMp3;
}

async function runGrokShot(dir, info, job) {
  const { fullPrompt, imageBase64, dur, jobKey, options = {} } = job;
  activeJobs.set(jobKey, { status: "making", startedAt: Date.now() });
  try {
    throwIfCancelled(options.isCancelled);
    const sourcePath = path.join(dir, "source.mp4");
    if (job.engine === "ltx") {
      const runLtx = async (resumePromptId) => {
        let imageBytes = Buffer.alloc(0);
        let audioBytes = Buffer.alloc(0);
        if (!resumePromptId) {
          const startPng = path.join(dir, "ltx_start.png");
          const padInput = path.join(dir, "ltx_start_in.png");
          fs.writeFileSync(padInput, Buffer.from(imageBase64, "base64"));
          await (options.padImage || padImageTo16x9)(padInput, startPng);
          fs.rmSync(padInput, { force: true });
          imageBytes = fs.readFileSync(startPng);
          const wavPath = path.join(dir, job.audioFile || "audio.wav");
          const mp3Path = path.join(dir, "ltx_audio.mp3");
          await (options.encodeAudio || encodeAudioMp3)(wavPath, mp3Path);
          audioBytes = fs.readFileSync(mp3Path);
        }
        return comfyCloud.generateLtxVideo({
          resumePromptId,
          imageBytes,
          audioBytes,
          prompt: fullPrompt,
          durationSec: job.durationSec,
          destPath: sourcePath,
          onSubmitted: (id) => {
            activeJobs.set(jobKey, { status: "making", requestId: id, startedAt: Date.now() });
            info.requestId = id;
            writeShotJson(dir, info);
          },
          options,
        });
      };
      const previousJob = info.engine === "ltx" && typeof info.requestId === "string" ? info.requestId : "";
      let outcome;
      try {
        outcome = await runLtx(previousJob);
      } catch (err) {
        // The earlier job was cancelled, failed or expired on Comfy's side: start a fresh one now.
        if (!previousJob || (err.code !== "EJOBFAILED" && err.code !== "ENOJOB")) throw err;
        delete info.requestId;
        outcome = await runLtx("");
      }
      const { promptId } = outcome;
      info.requestId = promptId;
    } else {
      const requestId = await startGrokVideo(fullPrompt, imageBase64, dur, options.fetchFn);
      activeJobs.set(jobKey, { status: "making", requestId, startedAt: Date.now() });
      info.requestId = requestId;
      writeShotJson(dir, info);

      const videoUrl = await pollGrokVideo(requestId, options.fetchFn, options.pollIntervalMs, options.isCancelled);
      await downloadVideo(videoUrl, sourcePath, options.fetchFn);
    }
    throwIfCancelled(options.isCancelled);
    info.filename = "source.mp4";
    writeShotJson(dir, info);

    const capture = options.captureFn || runShotCapture;
    const result = await capture(sourcePath, dir, {
      name: info.name,
      prompt: info.prompt,
      refImage: info.refImage || "",
      background: info.background,
      category: info.category,
      keyMode: info.keyMode || "",
      headSizeTarget: job.headSizeTarget || 0,
      lockHeadSize: job.lockHeadSize === true,
    }, options);

    if (Number(result.headSize) > 0) info.headSizeTarget = result.headSize;
    info.fps = result.fps;
    info.frameCount = result.frameCount;
    info.out = result.frameCount;
    if (typeof job.finalize === "function") job.finalize(info);
    info.status = "ready";
    delete info.requestId;
    delete info.error;
    writeShotJson(dir, info);
    activeJobs.delete(jobKey);
  } catch (err) {
    info.status = "error";
    info.error = err.message;
    if (job.engine === "ltx" && (err.code === "EJOBFAILED" || err.code === "ENOJOB" || err.code === "ECANCEL")) delete info.requestId;
    try {
      writeShotJson(dir, info);
    } catch {
      /* the shot folder was removed while the job was running */
    }
    activeJobs.set(jobKey, { status: "error", error: err.message });
  }
  return info;
}

/**
 * Base64 of the last frame of an existing shot, so a new clip can continue
 * where it ends. Prefers the untouched Grok video (same look Grok produced),
 * honours the shot's trimmed out point, and falls back to saved frames for
 * shots that have no source video (baked/combined shots).
 */
async function lastFrameBase64(projectDir, characterId, shotId, options = {}) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info || info.status === "deleted") throw shotError("The shot to continue from was not found", "ENOENT");
  if (info.status === "making" || info.status === "queued") throw shotError("The shot to continue from is still being made");
  const frameCount = Number(info.frameCount) || 0;
  const out = Number(info.out) > 0 ? Math.min(Number(info.out), frameCount || Number(info.out)) : frameCount;
  const pad = String(out).padStart(4, "0");

  const sourcePath = path.join(dir, "source.mp4");
  if (fs.existsSync(sourcePath)) {
    const tmp = path.join(dir, "._continue_frame.png");
    const extract = options.extractFrame || (async (video, png, seconds) => {
      const attempt = async (args) => {
        fs.rmSync(png, { force: true });
        const { code } = await spawnCmd("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, "-i", video, "-frames:v", "1", png]);
        return code === 0 && fs.existsSync(png) && fs.statSync(png).size > 0;
      };
      if (seconds > 0 && (await attempt(["-ss", String(seconds)]))) return true;
      return attempt(["-sseof", "-0.1"]);
    });
    const fps = Number(info.fps) || 0;
    const seconds = fps > 0 && out > 1 && out < frameCount ? (out - 1) / fps : 0;
    try {
      if (await extract(sourcePath, tmp, seconds)) return fs.readFileSync(tmp).toString("base64");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  for (const [sub, ext] of [["raw", ".png"], ["cut", ".png"], ["thumb", ".jpg"]]) {
    const exact = path.join(dir, sub, `f_${pad}${ext}`);
    if (fs.existsSync(exact)) return fs.readFileSync(exact).toString("base64");
    const sub_dir = path.join(dir, sub);
    if (!fs.existsSync(sub_dir)) continue;
    const files = fs.readdirSync(sub_dir).filter((n) => n.endsWith(ext)).sort();
    if (files.length) return fs.readFileSync(path.join(sub_dir, files[files.length - 1])).toString("base64");
  }
  throw shotError("Could not read the last frame of that shot");
}

/**
 * Start making a shot with Grok – returns immediately, processes in background.
 */
async function makeShot(projectDir, characterId, body, options = {}) {
  const { prompt, background, duration, refRel, refBase64, shotType, continueShotId } = body;
  if (!prompt) throw shotError("Enter a prompt.");

  const bg = background || "green";
  const fullPrompt = `${prompt}, ${BG_PROMPT_SUFFIX[bg] || BG_PROMPT_SUFFIX.green}`;
  const dur = [4, 6, 8, 10].includes(Number(duration)) ? Number(duration) : 6;

  // Resolve reference image
  let imageBase64 = null;
  if (continueShotId) {
    imageBase64 = await lastFrameBase64(projectDir, characterId, String(continueShotId), options);
  }
  if (!imageBase64) imageBase64 = refBase64 || null;
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
    ...(continueShotId ? { continuesShot: String(continueShotId) } : {}),
    background: bg,
    fps: 0,
    frameCount: 0,
    in: 1,
    out: 0,
    category: inferCategory(prompt),
    shotType: shotType || "",
    createdAt: new Date().toISOString(),
    status: "making",
  };
  writeShotJson(dir, info);

  const jobKey = `${characterId}/${shotId}`;
  void runGrokShot(dir, info, { fullPrompt, imageBase64, dur, jobKey, options });

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
  if (body.shotType != null) info.shotType = String(body.shotType).trim();
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
 * Re-key an existing shot's already-extracted raw/ frames in place, without
 * re-running ffmpeg extraction or calling Grok again. Use this to repair
 * shots that were captured before a background-keying fix landed (e.g.
 * dark "cinematic" backdrops that weren't fully transparent) — it's fast
 * and free since it never touches the Grok API.
 */
async function reprocessShot(projectDir, characterId, shotId, options = {}) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");
  if (!fs.existsSync(path.join(dir, "raw"))) {
    throw shotError("This shot has no raw/ frames to reprocess (it may be a baked/combined shot).");
  }

  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = ["-m", "compositor.shot_capture", "--reprocess", "--out-dir", dir];
  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  const trimmed = stdout.trim();
  let parsed = null;
  if (trimmed) {
    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1];
    try { parsed = JSON.parse(lastLine); } catch {}
  }
  if (code !== 0 || !parsed) {
    const msg = (stderr || "").trim().split("\n").pop() || "Reprocess failed";
    throw shotError(msg);
  }
  if (parsed.error) throw shotError(parsed.error);

  info.fps = parsed.fps;
  info.frameCount = parsed.frameCount;
  if (!info.out || info.out > parsed.frameCount) info.out = parsed.frameCount;
  writeShotJson(dir, info);

  return { ok: true, shotId, fps: info.fps, frameCount: info.frameCount };
}

/**
 * Re-key every shot for a character that has raw/ frames (skips baked/
 * combined shots, which have no raw/ dir). Returns per-shot results.
 */
async function reprocessAllShots(projectDir, characterId, options = {}) {
  const dir = shotsDir(projectDir, characterId);
  if (!fs.existsSync(dir)) return { ok: true, results: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    if (!fs.existsSync(path.join(dir, entry.name, "raw"))) continue;
    try {
      const result = await reprocessShot(projectDir, characterId, entry.name, options);
      results.push({ shotId: entry.name, ok: true, ...result });
    } catch (err) {
      results.push({ shotId: entry.name, ok: false, error: err.message });
    }
  }
  return { ok: true, results };
}

/**
 * Serve media files (mp4/jpg/png) with Range support.
 */
const ERASE_MASK_MAX_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function listErasedFrames(projectDir, characterId, shotId) {
  const dir = shotDir(projectDir, characterId, shotId);
  if (!fs.existsSync(dir)) throw shotError("Shot not found", "ENOENT");
  const eraseDir = path.join(dir, "erase");
  if (!fs.existsSync(eraseDir)) return [];
  const frames = [];
  for (const name of fs.readdirSync(eraseDir)) {
    const m = /^f_(\d+)\.png$/.exec(name);
    if (m) frames.push(Number(m[1]));
  }
  return frames.sort((a, b) => a - b);
}

function eraseFrameNumbers(raw, dir) {
  if (!Array.isArray(raw) || raw.length === 0) throw shotError("frames must be a list of frame numbers");
  if (raw.length > 2000) throw shotError("Too many frames at once");
  const out = [...new Set(raw.map((n) => Number(n)))].sort((a, b) => a - b);
  for (const n of out) {
    if (!Number.isInteger(n) || n < 1) throw shotError("Frame numbers must be whole numbers from 1");
    if (!fs.existsSync(path.join(dir, "cut", `f_${String(n).padStart(4, "0")}.png`))) {
      throw shotError(`Frame ${n} does not exist in this shot`);
    }
  }
  return out;
}

async function runEraseTool(dir, command, frames, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = ["-m", "compositor.shot_erase", command, "--out-dir", dir];
  if (frames && frames.length) args.push("--frames", frames.join(","));
  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  let parsed = null;
  const last = stdout.trim().split("\n").pop();
  try { parsed = JSON.parse(last); } catch { /* reported below */ }
  if (code !== 0 || !parsed || parsed.error) {
    throw shotError((parsed && parsed.error) || stderr.trim().split("\n").pop() || "Erase failed");
  }
  return parsed;
}

/**
 * Save the same erase mask (PNG, white = erase) for each listed frame and apply it
 * to that frame's keyed picture. A mask with nothing painted puts the frame back.
 */
async function eraseShotFrames(projectDir, characterId, shotId, body, options = {}) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");
  const frames = eraseFrameNumbers(body && body.frames, dir);
  const b64 = String((body && body.mask) || "").replace(/^data:image\/png;base64,/, "");
  const png = Buffer.from(b64, "base64");
  if (png.length < 16 || png.length > ERASE_MASK_MAX_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw shotError("mask must be a PNG image");
  }
  const eraseDir = path.join(dir, "erase");
  fs.mkdirSync(eraseDir, { recursive: true });
  for (const n of frames) fs.writeFileSync(path.join(eraseDir, `f_${String(n).padStart(4, "0")}.png`), png);
  await runEraseTool(dir, "apply", frames, options);
  return { ok: true, frames: listErasedFrames(projectDir, characterId, shotId) };
}

/** Undo erases: the listed frames, or every erased frame when none are listed. */
async function restoreShotFrames(projectDir, characterId, shotId, body, options = {}) {
  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");
  const wanted = body && Array.isArray(body.frames) && body.frames.length ? eraseFrameNumbers(body.frames, dir) : null;
  if (!wanted && listErasedFrames(projectDir, characterId, shotId).length === 0 && !fs.existsSync(path.join(dir, "cut_orig"))) {
    return { ok: true, frames: [] };
  }
  await runEraseTool(dir, "restore", wanted, options);
  return { ok: true, frames: listErasedFrames(projectDir, characterId, shotId) };
}

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
  const types = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".wav": "audio/wav" };
  if (types[ext]) res.setHeader("Content-Type", types[ext]);

  res.sendFile(filePath);
}

function deleteShot(projectDir, characterId, shotId) {
  const dir = shotDir(projectDir, characterId, shotId);
  if (!fs.existsSync(dir)) throw shotError("Shot not found", "ENOENT");

  // Try to move to _deleted/ — if rename fails (Windows file locking),
  // fall back to marking deleted in shot.json so listShots skips it.
  const parent = shotsDir(projectDir, characterId);
  const delDir = path.join(parent, "_deleted");
  fs.mkdirSync(delDir, { recursive: true });
  const stamp = Date.now();
  const dest = path.join(delDir, fs.existsSync(path.join(delDir, shotId)) ? `${shotId}_${stamp}` : shotId);

  try {
    fs.renameSync(dir, dest);
  } catch (renameErr) {
    // Rename failed (likely EPERM on Windows — files locked by browser).
    // Mark as deleted in shot.json so it won't appear in the list.
    try {
      const info = readShotJson(dir) || {};
      info.status = "deleted";
      info.deletedAt = new Date().toISOString();
      writeShotJson(dir, info);
    } catch (_writeErr) {
      // shot.json also locked — write a separate marker file as last resort.
      try {
        fs.writeFileSync(path.join(dir, "._deleted"), stamp.toString());
      } catch (_markerErr) {
        throw shotError(`Could not delete shot: ${renameErr.message}`, "EPERM");
      }
    }
  }
  return { deleted: shotId };
}

// ── Combine head + body shots ──────────────────────────────────────

async function combineShots(projectDir, characterId, opts = {}) {
  const { bodyId, headId, anchorX = 0.5, anchorY = 0.15,
          headScale = 1.0, bodyIn = 1, bodyOut = 0,
          headIn = 1, headOut = 0, fps = 24, name = "" } = opts;

  if (!bodyId) throw shotError("bodyId is required");
  if (!headId) throw shotError("headId is required");

  const bodyDir = path.join(shotDir(projectDir, characterId, bodyId), "cut");
  const headDir = path.join(shotDir(projectDir, characterId, headId), "cut");
  if (!fs.existsSync(bodyDir)) throw shotError("Body shot cut/ not found");
  if (!fs.existsSync(headDir)) throw shotError("Head shot cut/ not found");

  // Build combined shot name
  const baseName = slugName(name || `combined_${bodyId}_${headId}`);
  const combinedId = uniqueShotId(projectDir, characterId, baseName);
  const outDir = shotDir(projectDir, characterId, combinedId);
  fs.mkdirSync(outDir, { recursive: true });

  const pythonBin = resolvePythonBin();
  const args = [
    "-m", "compositor.shot_combine",
    "--body-dir", bodyDir,
    "--head-dir", headDir,
    "--out-dir", outDir,
    "--anchor-x", String(anchorX),
    "--anchor-y", String(anchorY),
    "--head-scale", String(headScale),
    "--body-in", String(bodyIn),
    "--body-out", String(bodyOut),
    "--head-in", String(headIn),
    "--head-out", String(headOut),
    "--fps", String(fps),
    "--name", name || `${bodyId} + ${headId}`,
  ];

  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  const trimmed = stdout.trim();
  let parsed = null;
  if (trimmed) {
    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1];
    try { parsed = JSON.parse(lastLine); } catch {}
  }
  if (code !== 0 || !parsed) {
    // Clean up empty folder on failure
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    const msg = (stderr || "").trim().split("\n").pop() || "Combine failed";
    throw shotError(msg);
  }
  if (parsed.error) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    throw shotError(parsed.error);
  }

  // Update shot.json with combine metadata
  const info = readShotJson(outDir) || {};
  info.shotType = "combined";
  info.sourceBody = bodyId;
  info.sourceHead = headId;
  info.anchorX = anchorX;
  info.anchorY = anchorY;
  info.headScale = headScale;
  writeShotJson(outDir, info);

  return { id: combinedId, ...parsed };
}

/**
 * Resize head portion of a shot's frames.
 * Splits at neckY (0-1 from top), scales head by headScale, overwrites frames.
 */
async function resizeHead(projectDir, characterId, shotIdStr, opts = {}) {
  const { neckY = 0.35, headScale = 0.7 } = opts;
  if (neckY < 0.05 || neckY > 0.95) throw shotError("neckY must be between 0.05 and 0.95");
  if (headScale < 0.1 || headScale > 3.0) throw shotError("headScale must be between 0.1 and 3.0");

  const dir = shotDir(projectDir, characterId, shotIdStr);
  const info = readShotJson(dir);
  if (!info) throw shotError("Shot not found", "ENOENT");

  const pythonBin = resolvePythonBin();
  const args = [
    "-m", "compositor.shot_resize_head",
    "--shot-dir", dir,
    "--neck-y", String(neckY),
    "--head-scale", String(headScale),
    "--fps", String(info.fps || 24),
  ];

  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  const trimmed = stdout.trim();
  let parsed = null;
  if (trimmed) {
    const lines = trimmed.split("\n");
    try { parsed = JSON.parse(lines[lines.length - 1]); } catch {}
  }
  if (code !== 0 || !parsed) {
    const msg = stderr.trim() || "Resize head failed";
    throw shotError(msg);
  }

  // Update shot.json
  info.headResized = true;
  info.resizeNeckY = neckY;
  info.resizeHeadScale = headScale;
  writeShotJson(dir, info);

  return { ok: true, ...parsed };
}

// ── Multi-segment timeline bake ─────────────────────────────────────

/**
 * Validate + normalize one segment entry from the client.
 * Looks up the referenced shot so we can bound inFrame/outFrame against
 * its real frameCount and resolve its cut/ directory.
 */
function normalizeSegment(projectDir, characterId, raw, isHead) {
  if (!raw || typeof raw !== "object") throw shotError("Invalid segment");
  const shotId = String(raw.shotId || "").trim();
  if (!shotId) throw shotError("Segment is missing shotId");

  const dir = shotDir(projectDir, characterId, shotId);
  const info = readShotJson(dir);
  if (!info) throw shotError(`Segment references missing shot "${shotId}"`, "ENOENT");
  const cutDir = path.join(dir, "cut");
  if (!fs.existsSync(cutDir)) throw shotError(`Shot "${shotId}" has no frames`);

  const frameCount = Number(info.frameCount) || 0;
  const inFrame = Math.max(1, Math.min(Number(raw.inFrame) || 1, frameCount || 1));
  const outFrame = Math.max(inFrame, Math.min(Number(raw.outFrame) || frameCount || inFrame, frameCount || inFrame));
  const start = Math.max(1, Number(raw.start) || 1);

  const seg = { shotId, cutDir, inFrame, outFrame, start };
  const speed = Number(raw.speed);
  if (Number.isFinite(speed) && speed > 0) {
    const clamped = Math.max(0.1, Math.min(8, Math.round(speed * 1000) / 1000));
    if (Math.abs(clamped - 1) > 1e-6) seg.speed = clamped;
  }
  if (raw.reverse === true) seg.reverse = true;
  if (!isHead && raw.bodyInFront === true) seg.bodyInFront = true;
  if (!isHead) {
    const bodyScale = Number(raw.bodyScale);
    if (Number.isFinite(bodyScale) && bodyScale > 0) {
      const clamped = Math.max(0.3, Math.min(2.5, Math.round(bodyScale * 1000) / 1000));
      if (Math.abs(clamped - 1) > 1e-6) {
        seg.bodyScale = clamped;
        for (const key of ["bodyPivotX", "bodyPivotY"]) {
          const value = Number(raw[key]);
          if (raw[key] != null && Number.isFinite(value)) seg[key] = Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
        }
      }
    }
  }
  if (!isHead) {
    for (const key of ["bodyOffsetX", "bodyOffsetY"]) {
      const value = Number(raw[key]);
      if (raw[key] != null && Number.isFinite(value)) {
        const clamped = Math.max(-1, Math.min(1, Math.round(value * 1000) / 1000));
        if (Math.abs(clamped) > 1e-6) seg[key] = clamped;
      }
    }
  }
  if (isHead) {
    seg.anchorX = Math.max(0, Math.min(1, Number(raw.anchorX) ?? 0.5));
    seg.anchorY = Math.max(0, Math.min(1, Number(raw.anchorY) ?? 0.15));
    seg.headScale = Math.max(0.1, Math.min(3.0, Number(raw.headScale) || 1.0));
  }
  return seg;
}

/**
 * Bake a multi-segment body/head timeline (the Character-page "scratch
 * board") into one new combined shot. Segments reference existing shots
 * by id + frame range; the source shots are never modified or consumed,
 * so the same recipe can be re-baked later after edits.
 */
async function bakeTimeline(projectDir, characterId, opts = {}) {
  const rawBody = Array.isArray(opts.bodySegments) ? opts.bodySegments : [];
  const rawHead = Array.isArray(opts.headSegments) ? opts.headSegments : [];
  if (!rawBody.length && !rawHead.length) throw shotError("Add at least one segment before baking.");

  const bodySegments = rawBody.map((s) => normalizeSegment(projectDir, characterId, s, false));
  const headSegments = rawHead.map((s) => normalizeSegment(projectDir, characterId, s, true));

  const fps = Number(opts.fps) || 24;
  const name = opts.name || "";

  const baseName = slugName(name || "timeline");
  const combinedId = uniqueShotId(projectDir, characterId, baseName);
  const outDir = shotDir(projectDir, characterId, combinedId);
  fs.mkdirSync(outDir, { recursive: true });

  const specPath = path.join(outDir, "_bake_spec.json");
  fs.writeFileSync(specPath, JSON.stringify({
    bodySegments: bodySegments.map((s) => ({ cutDir: s.cutDir, inFrame: s.inFrame, outFrame: s.outFrame, start: s.start, speed: s.speed, reverse: s.reverse, bodyScale: s.bodyScale, bodyPivotX: s.bodyPivotX, bodyPivotY: s.bodyPivotY, bodyOffsetX: s.bodyOffsetX, bodyOffsetY: s.bodyOffsetY, bodyInFront: s.bodyInFront })),
    headSegments: headSegments.map((s) => ({ cutDir: s.cutDir, inFrame: s.inFrame, outFrame: s.outFrame, start: s.start, speed: s.speed, reverse: s.reverse, anchorX: s.anchorX, anchorY: s.anchorY, headScale: s.headScale })),
    fps,
  }));

  const pythonBin = resolvePythonBin();
  const args = [
    "-m", "compositor.shot_timeline_bake",
    "--spec", specPath,
    "--out-dir", outDir,
    "--fps", String(fps),
  ];

  const { code, stdout, stderr } = await spawnCmd(pythonBin, args, { cwd: PYTHON_DIR });
  const trimmed = stdout.trim();
  let parsed = null;
  if (trimmed) {
    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1];
    try { parsed = JSON.parse(lastLine); } catch {}
  }
  try { fs.unlinkSync(specPath); } catch {}

  if (code !== 0 || !parsed) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    const msg = (stderr || "").trim().split("\n").pop() || "Bake failed";
    throw shotError(msg);
  }
  if (parsed.error) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    throw shotError(parsed.error);
  }

  // The python baker only writes frames/preview/poster -- write shot.json
  // ourselves so we can also persist the editable segment recipe.
  const info = {
    id: combinedId,
    name: name || combinedId,
    filename: "",
    prompt: "timeline bake",
    refImage: "",
    background: "auto",
    fps: parsed.fps || fps,
    frameCount: parsed.frameCount,
    in: 1,
    out: parsed.frameCount,
    category: inferCategory(name),
    shotType: "combined",
    createdAt: new Date().toISOString(),
    status: "ready",
    // Editable recipe: lets the Character-page timeline reload this exact
    // bake and keep adjusting it, since the source shots are untouched.
    timeline: {
      bodySegments: rawBody.map((s, i) => ({ ...s, ...bodySegments[i], cutDir: undefined })),
      headSegments: rawHead.map((s, i) => ({ ...s, ...headSegments[i], cutDir: undefined })),
      fps,
    },
  };
  writeShotJson(outDir, info);

  return { id: combinedId, fps: info.fps, frameCount: info.frameCount, poster: parsed.poster, preview: parsed.preview };
}

module.exports = {
  listShots,
  getShot,
  makeShot,
  importShot,
  patchShot,
  deleteFrame,
  deleteShot,
  saveFrameToSlot,
  useAsActionShot,
  retryShot,
  reprocessShot,
  reprocessAllShots,
  serveMedia,
  listErasedFrames,
  eraseShotFrames,
  restoreShotFrames,
  combineShots,
  resizeHead,
  bakeTimeline,
  internals: {
    lastFrameBase64,
    runGrokShot,
    padImageTo16x9,
    encodeAudioMp3,
    shotsDir,
    shotDir,
    readShotJson,
    writeShotJson,
    uniqueShotId,
    slugName,
    shotError,
    spawnCmd,
    BG_PROMPT_SUFFIX,
  },
};
