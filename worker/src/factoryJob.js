"use strict";

/**
 * Factory v1: plain prompt → green-screen sheet → cut-out → align to
 * existing slots → looping preview. Nothing is written into the character
 * library until Tick. Redo throws the draft away and generates again.
 *
 * Live xAI calls reuse generateProjectImage. Tests pass a fixture PNG
 * (imageBase64) so the VM does not need a key.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { listCharacters } = require("./studioLibrary");
const { isSafeFolderName } = require("./studioProjects");
const { characterDir, readWritableCharacter, writeCharacterJson, findSlotSpec } = require("./characterLocal");
const { setDrawingState } = require("./characterStatus");
const {
  runCutout,
  ensureSlot,
  mergeCycles,
  uniqueWriteTarget,
  pngDataUrl,
  posixJoin,
} = require("./assetIngest");
const { generateProjectImage, GenerateImageError, collectReferences } = require("./generateImage");
const {
  clampFactoryFrames,
  factoryGrid,
  buildFactoryPack,
  inferFactoryIntent,
} = require("./factoryPrompt");
const { renderActionPreview } = require("./actionPreview");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { encodeRgbaPng } = require("./pngFlip");

const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function factoryError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function factoryRoot(projectDir, characterId) {
  return path.join(characterDir(projectDir, characterId), "_factory");
}

function jobDir(projectDir, characterId, jobId) {
  return path.join(factoryRoot(projectDir, characterId), jobId);
}

function stampJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function findCharacter(projectDir, globalAssetsDir, characterId) {
  if (!isSafeFolderName(characterId)) throw factoryError("Invalid character id");
  const characters = listCharacters(projectDir, globalAssetsDir);
  const character = characters.find((item) => item.id === characterId);
  if (!character) throw factoryError(`Unknown character: ${characterId}`, "ENOTFOUND");
  return character;
}

function decodeImage(body) {
  if (!body || typeof body.imageBase64 !== "string" || !body.imageBase64) return null;
  const stripped = body.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  const buf = Buffer.from(stripped, "base64");
  if (buf.length < 8) throw factoryError("image is empty");
  return buf;
}

function collectSlotNames(character) {
  const names = new Set();
  for (const name of Object.keys((character && character.slots) || {})) names.add(name);
  for (const child of (character && character.children) || []) {
    for (const name of Object.keys((child && child.slots) || {})) names.add(name);
  }
  return names;
}

function resolveActionDest(character, intent) {
  const names = collectSlotNames(character);
  const view = (intent && intent.view) || "right_side";
  if (intent && intent.kind === "walk") {
    if (names.has("legs_side")) {
      const spec = findSlotSpec(character, "legs_side");
      return { kind: "slot", slot: "legs_side", drawings_dir: (spec && spec.drawings_dir) || "legs_side" };
    }
    if (names.has("legs")) {
      return {
        kind: "slot",
        slot: "legs",
        drawings_dir: view === "left_side" ? "legs_left_side" : "legs_right_side",
      };
    }
    if (names.has("body")) {
      const spec = findSlotSpec(character, "body");
      return { kind: "slot", slot: "body", drawings_dir: (spec && spec.drawings_dir) || "body" };
    }
    return { kind: "slot", slot: "legs", drawings_dir: "legs_side" };
  }
  if (names.has("body")) {
    const spec = findSlotSpec(character, "body");
    return { kind: "slot", slot: "body", drawings_dir: (spec && spec.drawings_dir) || "body" };
  }
  return { kind: "slot", slot: "torso", drawings_dir: "torso" };
}

function uniqueActionId(projectDir, characterId, base) {
  const safe = String(base || "action")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "action";
  const dir = path.join(characterDir(projectDir, characterId), "actions");
  if (!fs.existsSync(path.join(dir, `${safe}.json`))) return safe;
  let n = 2;
  while (fs.existsSync(path.join(dir, `${safe}_${n}.json`))) n += 1;
  return `${safe}_${n}`;
}

function walkBob(frames) {
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const phase = (i / Math.max(1, frames)) * Math.PI * 2;
    out.push(Math.round((1 - Math.cos(phase * 2)) * 2));
  }
  return out;
}

function drawingNames(actionId, frames) {
  const names = [];
  for (let i = 1; i <= frames; i += 1) {
    names.push(`${actionId}_${String(i).padStart(2, "0")}`);
  }
  return names;
}

function readManifest(projectDir, characterId, jobId) {
  if (!JOB_NAME.test(String(jobId || ""))) throw factoryError("Invalid job");
  const manifestPath = path.join(jobDir(projectDir, characterId, jobId), "manifest.json");
  if (!fs.existsSync(manifestPath)) throw factoryError("Factory job not found", "ENOENT");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function findAlignRef(projectDir, characterId, dest) {
  if (!dest || dest.kind !== "slot") return null;
  const dir = path.join(characterDir(projectDir, characterId), dest.drawings_dir || dest.slot);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const names = fs.readdirSync(dir).filter((name) => /\.png$/i.test(name)).sort();
  return names[0] ? path.join(dir, names[0]) : null;
}

function slotCanvas(character, dest) {
  const spec = dest && dest.slot ? findSlotSpec(character, dest.slot) : null;
  if (spec && spec.canvas && spec.canvas.w && spec.canvas.h) {
    return { w: Number(spec.canvas.w), h: Number(spec.canvas.h) };
  }
  const slots = (character && character.slots) || {};
  for (const item of Object.values(slots)) {
    if (item && item.canvas && item.canvas.w && item.canvas.h) {
      return { w: Number(item.canvas.w), h: Number(item.canvas.h) };
    }
  }
  return { w: 1024, h: 1024 };
}

function isOverlayDest(dest) {
  const slot = String((dest && dest.slot) || "").toLowerCase();
  return slot === "eyes" || slot === "mouth";
}

function runFactoryFit(args, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-m", "compositor.factory_fit", ...args], {
      cwd: PYTHON_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to spawn factory fit (${pythonBin}): ${err.message}`));
    });
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      let parsed = null;
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split("\n").pop());
        } catch {
          parsed = null;
        }
      }
      if (code !== 0 || !parsed || parsed.ok === false) {
        const detail =
          (parsed && parsed.error) || (stderr || stdout).trim().split("\n").pop() || `exited ${code}`;
        reject(new Error(`Factory fit failed: ${detail}`));
        return;
      }
      resolve(parsed);
    });
  });
}

function skipCopy(src) {
  const parts = src.split(path.sep);
  return parts.some((part) => part === "_library" || part === "_trash" || part === "_factory" || part === "_replaced");
}

function copyCharacterForPreview(srcDir, destDir, options = {}) {
  const replaceDirs = new Set(options.replaceDirs || []);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      if (skipCopy(src)) return false;
      if (!replaceDirs.size) return true;
      const rel = path.relative(srcDir, src);
      if (!rel || rel === ".") return true;
      const top = rel.split(path.sep)[0];
      if (!replaceDirs.has(top)) return true;
      // Keep the folder, drop existing drawings so new legs replace old ones.
      return rel === top;
    },
  });
}

function listPngNames(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.png$/i.test(name))
    .map((name) => name.replace(/\.png$/i, ""))
    .sort();
}

function pickSideTorsoDrawing(projectDir, characterId, view) {
  const skip = /^(walk|run|approach)/i;
  const preferred = ["neutral", "stand", "rig", "idle", "torso"];
  const dirs = [`torso_${view}`, "torso"];
  const root = characterDir(projectDir, characterId);
  for (const dir of dirs) {
    const names = listPngNames(path.join(root, dir)).filter((name) => !skip.test(name));
    for (const want of preferred) {
      if (names.includes(want)) return want;
    }
    if (names[0]) return names[0];
  }
  return null;
}

function walkSetSlots(character, projectDir, characterId, view) {
  const names = collectSlotNames(character);
  const setSlots = {};
  if (names.has("body")) setSlots.body = "none";
  const torso = pickSideTorsoDrawing(projectDir, characterId, view);
  if (torso && names.has("torso")) setSlots.torso = torso;
  return setSlots;
}

async function renderJobPreview(projectDir, globalAssetsDir, character, job, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-factory-"));
  try {
    const tmpChar = path.join(tmp, "characters", character.id);
    const replaceDirs = [];
    if (job.dest && job.dest.drawings_dir) replaceDirs.push(job.dest.drawings_dir);
    copyCharacterForPreview(characterDir(projectDir, character.id), tmpChar, { replaceDirs });
    const destDir = path.join(tmpChar, job.dest.drawings_dir);
    fs.mkdirSync(destDir, { recursive: true });
    for (const drawing of job.drawings || []) {
      if (!drawing.path || !fs.existsSync(drawing.path)) continue;
      fs.copyFileSync(drawing.path, path.join(destDir, `${drawing.name}.png`));
    }
    const characterJson = readWritableCharacter(projectDir, globalAssetsDir, character.id);
    ensureSlot(characterJson, job.dest);
    if (job.dest.slot === "body" && job.cycle) {
      const spec = findSlotSpec(characterJson, "body");
      mergeCycles(spec, { [job.cycle.name]: job.cycle });
    }
    fs.writeFileSync(path.join(tmpChar, "character.json"), `${JSON.stringify(characterJson, null, 2)}\n`);
    fs.mkdirSync(path.join(tmpChar, "actions"), { recursive: true });
    fs.writeFileSync(path.join(tmpChar, "actions", `${job.actionId}.json`), `${JSON.stringify(job.action, null, 2)}\n`);
    fs.writeFileSync(path.join(tmp, "studio.json"), `${JSON.stringify({ independent: true }, null, 2)}\n`);
    const bgDir = path.join(tmp, "backgrounds", "factory_preview");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, "bg.png"), encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4)));
    fs.writeFileSync(
      path.join(bgDir, "staging.json"),
      `${JSON.stringify({ marks: { centre: { x: 960, y: 1080, scale: 1 } }, auto_order: ["centre"] }, null, 2)}\n`
    );
    const dest = path.join(jobDir(projectDir, character.id, job.id), "preview.mp4");
    await renderActionPreview(tmp, null, character.id, job.actionId, dest, options);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function summarizeJob(job, characterId) {
  return {
    ok: true,
    jobId: job.id,
    characterId,
    actionId: job.actionId,
    prompt: job.userPrompt,
    hiddenPrompt: job.hiddenPrompt,
    frames: job.frames,
    grid: job.grid,
    dest: job.dest,
    action: job.action || null,
    drawings: (job.drawings || []).map((item) => ({
      name: item.name,
      imageBase64: item.path && fs.existsSync(item.path) ? pngDataUrl(item.path) : null,
      problems: item.problems || [],
    })),
    warnings: job.warnings || [],
    previewRel: job.previewRel || null,
    ticked: Boolean(job.ticked),
    usedFixture: Boolean(job.usedFixture),
    styleBlock: job.styleBlock,
    rigRules: job.rigRules,
    greenScreen: job.greenScreen,
  };
}

async function runFactoryJob(projectDir, globalAssetsDir, body, options = {}) {
  const characterId = body && body.characterId;
  const character = findCharacter(projectDir, globalAssetsDir, characterId);
  const frames = clampFactoryFrames(body && body.frames);
  const userPrompt = String((body && body.prompt) || "").trim();
  if (!userPrompt) throw factoryError("Type a short prompt, e.g. Rodney walking long stride.");

  const writable = readWritableCharacter(projectDir, globalAssetsDir, character.id);
  const intent = inferFactoryIntent(userPrompt);
  const dest = resolveActionDest(writable, intent);
  const refs = collectReferences(projectDir, globalAssetsDir, character);
  const pack = buildFactoryPack({
    character,
    userPrompt,
    frames,
    advancedPrompt: body && body.advancedPrompt,
    references: refs.map((ref) => ({ kind: ref.kind, rel: ref.rel })),
  });

  if (body && body.dryRun) {
    return {
      ok: true,
      dryRun: true,
      pack,
      dest,
      characterId: character.id,
    };
  }

  const fixture = decodeImage(body);
  let sheetBuf = fixture;
  let usedFixture = Boolean(fixture);
  if (!sheetBuf) {
    const generated = await generateProjectImage(
      projectDir,
      globalAssetsDir,
      {
        characterId: character.id,
        needId: "factory_action",
        n: 1,
        prompt: pack.hiddenPrompt,
        frames,
      },
      options
    );
    const first = generated.images && generated.images[0];
    if (!first || !first.imageBase64) throw factoryError("xAI returned no image.", "EXAI");
    sheetBuf = decodeImage({ imageBase64: first.imageBase64 });
    usedFixture = false;
  }

  const jobId = stampJobId();
  const dir = jobDir(projectDir, character.id, jobId);
  fs.mkdirSync(path.join(dir, "cells"), { recursive: true });
  const sheetPath = path.join(dir, "sheet.png");
  fs.writeFileSync(sheetPath, sheetBuf);

  const cut = await runCutout(
    ["--input", sheetPath, "--out-dir", path.join(dir, "cells"), "--grid", `${pack.grid.cols}x${pack.grid.rows}`, "--detect-gaps"],
    options
  );

  const canvas = slotCanvas(writable, dest);
  const refAbs = findAlignRef(projectDir, character.id, dest);
  const alignedDir = path.join(dir, "aligned");
  fs.mkdirSync(alignedDir, { recursive: true });
  const fitArgs = [
    "--src-dir",
    path.join(dir, "cells"),
    "--out-dir",
    alignedDir,
    "--canvas-w",
    String(canvas.w),
    "--canvas-h",
    String(canvas.h),
  ];
  if (refAbs) fitArgs.push("--ref", refAbs);
  if (isOverlayDest(dest)) fitArgs.push("--check-head");
  if (intent.kind === "walk") {
    fitArgs.push("--extract-legs", "--validate-walk", "--expect-face", intent.view === "left_side" ? "left" : "right");
  }
  const fitted = await runFactoryFit(fitArgs, options);

  const actionId = uniqueActionId(projectDir, character.id, pack.actionId);
  const names = drawingNames(actionId, frames);
  const drawings = [];
  const warnings = [...(cut.warnings || []), ...((fitted && fitted.warnings) || [])];
  for (let i = 0; i < frames; i += 1) {
    const cell = (cut.cells || [])[i];
    const alignedName = cell ? path.basename(cell.path) : `cell_${String(i).padStart(2, "0")}.png`;
    const alignedPath = path.join(alignedDir, alignedName);
    const row = (fitted.written || []).find((item) => path.basename(item.src) === alignedName);
    if (!cell || cell.empty || !fs.existsSync(alignedPath)) {
      warnings.push(`Frame ${i + 1} was empty after cut-out.`);
      continue;
    }
    if (isOverlayDest(dest) && (fitted.warnings || []).some((line) => line.includes(alignedName))) {
      throw factoryError("Eyes and mouths must be overlays, never full heads.", "EINVAL");
    }
    const problems = (row && row.problems) || [];
    const rejected = problems.some((line) => /too many boots|facing /.test(String(line)));
    if (rejected) {
      warnings.push(`Frame ${i + 1} rejected: ${problems.join("; ")}`);
      continue;
    }
    drawings.push({
      name: names[i],
      path: alignedPath,
      problems,
    });
  }
  if (drawings.length < 2) throw factoryError("Cut-out did not produce enough frames. Try Redo.", "EINVAL");

  const cycleName = intent.kind === "walk" ? (intent.view === "left_side" ? "walk_left_side" : "walk_side") : actionId;
  const setSlots = intent.kind === "walk" ? walkSetSlots(writable, projectDir, character.id, intent.view) : {};
  const action = {
    id: actionId,
    view: intent.view,
    faces: intent.view === "left_side" ? "left" : "right",
    fps: 12,
    frames: drawings.length,
    distance_per_cycle: intent.kind === "walk" ? 96 : undefined,
    slot_frames: { [dest.slot]: drawings.map((item) => item.name) },
    bob: walkBob(drawings.length),
  };
  if (Object.keys(setSlots).length) action.set_slots = setSlots;
  if (!action.distance_per_cycle) delete action.distance_per_cycle;

  const job = {
    id: jobId,
    characterId: character.id,
    userPrompt,
    hiddenPrompt: pack.hiddenPrompt,
    styleBlock: pack.styleBlock,
    rigRules: pack.rigRules,
    greenScreen: pack.greenScreen,
    frames: drawings.length,
    grid: pack.grid,
    dest,
    actionId,
    action,
    cycle: dest.slot === "body" ? { name: cycleName, drawings: drawings.map((item) => item.name), fps: 12 } : null,
    drawings,
    warnings,
    usedFixture,
    ticked: false,
    createdAt: new Date().toISOString(),
  };

  writeManifest(dir, job);
  try {
    await renderJobPreview(projectDir, globalAssetsDir, character, job, options);
    job.previewRel = posixJoin("characters", character.id, "_factory", jobId, "preview.mp4");
    writeManifest(dir, job);
  } catch (err) {
    job.warnings.push(err.message || "Preview clip failed");
    writeManifest(dir, job);
  }
  return summarizeJob(job, character.id);
}

function describeFactoryJob(projectDir, characterId, jobId) {
  const job = readManifest(projectDir, characterId, jobId);
  return summarizeJob(job, characterId);
}

function resolveFactoryPreview(projectDir, characterId, jobId) {
  const job = readManifest(projectDir, characterId, jobId);
  const file = path.join(jobDir(projectDir, characterId, jobId), "preview.mp4");
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw factoryError("Preview clip is not ready.", "ENOENT");
  }
  return file;
}

function tickFactoryJob(projectDir, globalAssetsDir, characterId, jobId) {
  const job = readManifest(projectDir, characterId, jobId);
  if (job.ticked) return summarizeJob(job, characterId);

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  ensureSlot(character, job.dest);
  if (job.cycle && job.dest.slot === "body") {
    mergeCycles(findSlotSpec(character, "body"), { [job.cycle.name]: job.cycle });
  }
  writeCharacterJson(projectDir, characterId, character);

  const taken = new Set();
  for (const drawing of job.drawings || []) {
    const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, job.dest, drawing.name, taken);
    taken.add(target.rel);
    const abs = path.join(projectDir, target.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(drawing.path, abs);
    setDrawingState(projectDir, characterId, `${job.dest.drawings_dir}/${target.name}`, "ticked");
    drawing.writtenName = target.name;
    drawing.writtenRel = target.rel;
  }

  const action = { ...job.action, slot_frames: { [job.dest.slot]: (job.drawings || []).map((item) => item.writtenName || item.name) } };
  const actionPath = path.join(characterDir(projectDir, characterId), "actions", `${job.actionId}.json`);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(actionPath, `${JSON.stringify(action, null, 2)}\n`);

  job.ticked = true;
  job.tickedAt = new Date().toISOString();
  writeManifest(jobDir(projectDir, characterId, jobId), job);
  return summarizeJob(job, characterId);
}

async function redoFactoryJob(projectDir, globalAssetsDir, characterId, jobId, body, options = {}) {
  const previous = readManifest(projectDir, characterId, jobId);
  if (previous.ticked) throw factoryError("This one is already ticked. Type a new prompt to make another.");
  fs.rmSync(jobDir(projectDir, characterId, jobId), { recursive: true, force: true });
  return runFactoryJob(
    projectDir,
    globalAssetsDir,
    {
      characterId,
      prompt: (body && body.prompt) || previous.userPrompt,
      frames: (body && body.frames) || previous.frames,
      advancedPrompt: body && body.advancedPrompt,
      imageBase64: body && body.imageBase64,
    },
    options
  );
}

function factoryPreviewUrl(project, characterId, jobId) {
  return `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/preview`;
}

module.exports = {
  factoryError,
  findCharacter,
  resolveActionDest,
  uniqueActionId,
  walkBob,
  drawingNames,
  pickSideTorsoDrawing,
  walkSetSlots,
  runFactoryJob,
  describeFactoryJob,
  resolveFactoryPreview,
  tickFactoryJob,
  redoFactoryJob,
  factoryPreviewUrl,
  GenerateImageError,
};
