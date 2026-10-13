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
const { loadAction, loadCharacter, listKnownLocations } = require("./parser/assetLibrary");
const { encodeRgbaPng } = require("./pngFlip");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

const SIZE = 256;
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
  if (action && action.set_slots && typeof action.set_slots === "object") {
    for (const [slot, drawing] of Object.entries(action.set_slots)) {
      for (const root of roots) {
        files.push(path.join(root, "characters", characterId, slot, `${drawing}.png`));
      }
    }
  }
  return files;
}

function actionPreviewFingerprint(projectDir, globalAssetsDir, characterId, actionId) {
  return fingerprintFiles(rigFiles(projectDir, globalAssetsDir, characterId, actionId));
}

function buildActionPreviewScript(displayName, locationId, actionId, seconds) {
  return [
    "[Scene: ActionPreview]",
    `[Location: ${locationId}]`,
    `[Cast: ${displayName}]`,
    `[Action: ${displayName} at=centre]`,
    `[Do: ${displayName} ${actionId} for=${seconds}s wait=false]`,
    "",
  ].join("\n");
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

async function renderActionPreview(projectDir, globalAssetsDir, characterId, actionId, dest, options = {}) {
  const action = loadAction(projectDir, globalAssetsDir, characterId, actionId, options);
  if (!action) throw new Error(`Unknown action ${characterId}/${actionId}`);
  const character = loadCharacter(projectDir, globalAssetsDir, characterId, options);
  if (!character) throw new Error(`Unknown character ${characterId}`);
  const locations = listKnownLocations(projectDir, globalAssetsDir, options);
  if (!locations.length) throw new Error("No location to stage an action preview");
  const seconds = actionPreviewSeconds(action.frames, action.fps);
  const displayName = character.display_name || characterId;
  const parsed = await parseProjectToTemp(projectDir, {
    scriptText: buildActionPreviewScript(displayName, locations[0], actionId, seconds),
    skipValidate: true,
    globalAssetsDir,
  });
  try {
    const black = path.join(parsed.tmpDir, "black.png");
    writeBlackPng(black);
    const timeline = JSON.parse(fs.readFileSync(parsed.timelinePath, "utf8"));
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

module.exports = {
  SIZE,
  actionPreviewSeconds,
  actionPreviewFingerprint,
  buildActionPreviewScript,
  contentFiles: rigFiles,
  ensureActionPreview,
  renderActionPreview,
};
