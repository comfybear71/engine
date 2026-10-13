"use strict";

/**
 * Cached looping MP4s for Studio Action Shot tiles.
 * Parse a short [Do:] script, compose with the CLI, crop to the character.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { parseProjectToTemp } = require("./parser");
const { loadAction, loadCharacter, listKnownLocations, loadStaging } = require("./parser/assetLibrary");
const { encodeRgbaPng } = require("./pngFlip");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

const SIZE = 256;
const CACHE_VERSION = "v4-poster-whole-arm";
const inFlight = new Map();

function actionPreviewSeconds(frames, fps) {
  const cycle = Math.max(1, Number(frames) || 1) / Math.max(1, Number(fps) || 12);
  const loops = Math.max(1, Math.round(2 / cycle));
  return Math.min(3, Math.max(1, Number((loops * cycle).toFixed(1))));
}

function cacheDir() {
  const dir = path.join(os.tmpdir(), "engine-studio-action-previews");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function existingFiles(paths) {
  return paths.filter((file) => file && fs.existsSync(file));
}

function fingerprintFiles(files) {
  const parts = [];
  for (const file of existingFiles(files).sort()) {
    const stat = fs.statSync(file);
    parts.push(`${path.basename(file)}|${stat.mtimeMs}|${stat.size}`);
  }
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}

function rigFiles(projectDir, globalAssetsDir, characterId, actionId) {
  const files = [];
  const roots = [projectDir];
  if (globalAssetsDir) roots.push(globalAssetsDir);
  for (const root of roots) {
    const charDir = path.join(root, "characters", characterId);
    files.push(path.join(charDir, "character.json"));
    files.push(path.join(charDir, "actions", `${actionId}.json`));
    const partsDir = path.join(charDir, "parts");
    if (fs.existsSync(partsDir) && fs.statSync(partsDir).isDirectory()) {
      for (const name of fs.readdirSync(partsDir)) {
        files.push(path.join(partsDir, name));
      }
    }
  }
  const action = loadAction(projectDir, globalAssetsDir, characterId, actionId);
  function addSlotFiles(map) {
    if (!map || typeof map !== "object") return;
    for (const [slot, drawing] of Object.entries(map)) {
      const names = Array.isArray(drawing) ? drawing : [drawing];
      for (const name of names) {
        for (const root of roots) {
          files.push(path.join(root, "characters", characterId, slot, `${name}.png`));
          files.push(path.join(root, "characters", characterId, "arm", `${name}.png`));
        }
      }
    }
  }
  if (action) {
    addSlotFiles(action.set_slots);
    addSlotFiles(action.slot_frames);
  }
  return files;
}

function actionPreviewFingerprint(projectDir, globalAssetsDir, characterId, actionId) {
  const files = fingerprintFiles(rigFiles(projectDir, globalAssetsDir, characterId, actionId));
  return crypto.createHash("sha1").update(`${CACHE_VERSION}\n${files}`).digest("hex");
}

function actionNeedsBoundProp(action) {
  return (action && Array.isArray(action.prop_events)
    ? action.prop_events
    : []
  ).some((event) => String((event && event.prop) || "").trim() === "{prop}");
}

function firstLocationProp(projectDir, globalAssetsDir, locationId, options) {
  if (!locationId) return null;
  const staging = loadStaging(projectDir, globalAssetsDir, locationId, options);
  const names = Object.keys((staging && staging.props) || {});
  return names[0] || null;
}

function pickPreviewStage(projectDir, globalAssetsDir, action, options = {}) {
  const locations = listKnownLocations(projectDir, globalAssetsDir, options);
  const needsProp = actionNeedsBoundProp(action);
  for (const locationId of locations) {
    const prop = firstLocationProp(projectDir, globalAssetsDir, locationId, options);
    if (!needsProp || prop) return { locationId, prop };
  }
  return { locationId: locations[0] || null, prop: null };
}

function buildActionPreviewScript(displayName, locationId, actionId, seconds, options = {}) {
  const prop = options && options.prop ? String(options.prop).trim() : "";
  const doLine = prop
    ? `[Do: ${displayName} ${actionId} prop=${prop} for=${seconds}s wait=false]`
    : `[Do: ${displayName} ${actionId} for=${seconds}s wait=false]`;
  return [
    "[Scene: ActionPreview]",
    `[Location: ${locationId}]`,
    `[Cast: ${displayName}]`,
    `[Action: ${displayName} at=centre]`,
    doLine,
    "",
  ].join("\n");
}

function buildStandingPreviewScript(displayName, locationId) {
  return [
    "[Scene: ActionPreview]",
    `[Location: ${locationId}]`,
    `[Cast: ${displayName}]`,
    `[Action: ${displayName} at=centre]`,
    "",
  ].join("\n");
}

function stripNonCharacterLayers(timeline, characterId) {
  for (const scene of timeline.scenes || []) {
    scene.layers = (scene.layers || []).filter((layer) => layer && layer.character_id === characterId);
  }
  return timeline;
}

function writeBlackPng(dest) {
  const rgba = Buffer.alloc(8 * 8 * 4);
  fs.writeFileSync(dest, encodeRgbaPng(8, 8, rgba));
}

function spawnActionPreview(timelinePath, projectDir, outputPath, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = [
    "-m",
    "compositor.action_preview",
    "--timeline",
    path.resolve(timelinePath),
    "--project-dir",
    path.resolve(projectDir),
    "--output",
    path.resolve(outputPath),
    "--size",
    String(options.size || SIZE),
  ];
  if (options.aspect) args.push("--aspect", String(options.aspect));
  if (options.previewWidth) args.push("--width", String(options.previewWidth));
  if (options.previewHeight) args.push("--height", String(options.previewHeight));
  if (options.sampleFps) args.push("--sample-fps", String(options.sampleFps));
  if (options.cycleFrames) args.push("--cycle-frames", String(options.cycleFrames));
  if (options.dumpFramesDir) args.push("--dump-frames", path.resolve(options.dumpFramesDir));
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      cwd: PYTHON_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to spawn action preview (${pythonBin}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
        return;
      }
      reject(new Error(stderr.trim() || `action preview exited ${code}`));
    });
  });
}

async function composePreviewTimeline(projectDir, globalAssetsDir, scriptText, characterId, dest, options = {}) {
  const parsed = await parseProjectToTemp(projectDir, {
    scriptText,
    skipValidate: true,
    globalAssetsDir,
  });
  try {
    const black = path.join(parsed.tmpDir, "black.png");
    writeBlackPng(black);
    const timeline = JSON.parse(fs.readFileSync(parsed.timelinePath, "utf8"));
    stripNonCharacterLayers(timeline, characterId);
    for (const scene of timeline.scenes || []) {
      scene.background = { asset: black, fit: "cover" };
    }
    fs.writeFileSync(parsed.timelinePath, `${JSON.stringify(timeline)}\n`);
    const tmp = `${dest}.${process.pid}.tmp.mp4`;
    await spawnActionPreview(parsed.timelinePath, projectDir, tmp, options);
    fs.renameSync(tmp, dest);
    return dest;
  } finally {
    fs.rmSync(parsed.tmpDir, { recursive: true, force: true });
  }
}

async function renderActionPreview(projectDir, globalAssetsDir, characterId, actionId, dest, options = {}) {
  const action = loadAction(projectDir, globalAssetsDir, characterId, actionId, options);
  if (!action) throw new Error(`Unknown action ${characterId}/${actionId}`);
  const character = loadCharacter(projectDir, globalAssetsDir, characterId, options);
  if (!character) throw new Error(`Unknown character ${characterId}`);
  const stage = pickPreviewStage(projectDir, globalAssetsDir, action, options);
  if (!stage.locationId) throw new Error("No location to stage an action preview");
  const seconds =
    Number(options.seconds) > 0 ? Number(options.seconds) : actionPreviewSeconds(action.frames, action.fps);
  const displayName = character.display_name || characterId;
  const bindProp = actionNeedsBoundProp(action) ? stage.prop : null;
  const scripts = [
    buildActionPreviewScript(displayName, stage.locationId, actionId, seconds, { prop: bindProp }),
    buildStandingPreviewScript(displayName, stage.locationId),
  ];
  let lastError = null;
  for (const scriptText of scripts) {
    try {
      return await composePreviewTimeline(projectDir, globalAssetsDir, scriptText, characterId, dest, options);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Could not render action preview ${characterId}/${actionId}`);
}

function posterPathFor(mp4Path) {
  return String(mp4Path || "").replace(/\.mp4$/i, ".jpg");
}

async function ensureActionPreview(projectDir, globalAssetsDir, characterId, actionId, options = {}) {
  const key = actionPreviewFingerprint(projectDir, globalAssetsDir, characterId, actionId);
  const dest = path.join(cacheDir(), `${key}.mp4`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  if (inFlight.has(dest)) return inFlight.get(dest);
  const job = renderActionPreview(projectDir, globalAssetsDir, characterId, actionId, dest, options).finally(() => {
    inFlight.delete(dest);
  });
  inFlight.set(dest, job);
  return job;
}

async function ensureActionPoster(projectDir, globalAssetsDir, characterId, actionId, options = {}) {
  const mp4 = await ensureActionPreview(projectDir, globalAssetsDir, characterId, actionId, options);
  const poster = posterPathFor(mp4);
  if (fs.existsSync(poster) && fs.statSync(poster).size > 0) return poster;
  return mp4;
}

module.exports = {
  SIZE,
  CACHE_VERSION,
  actionPreviewSeconds,
  actionPreviewFingerprint,
  actionNeedsBoundProp,
  pickPreviewStage,
  buildActionPreviewScript,
  buildStandingPreviewScript,
  stripNonCharacterLayers,
  contentFiles: rigFiles,
  ensureActionPreview,
  ensureActionPoster,
  posterPathFor,
  renderActionPreview,
};
