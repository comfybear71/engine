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
const { isSafeFolderName, readLibrary, writeLibrary } = require("./studioProjects");
const { characterDir, readWritableCharacter, writeCharacterJson, findSlotSpec } = require("./characterLocal");
const { setDrawingState } = require("./characterStatus");
const {
  runCutout,
  runAlign,
  ensureSlot,
  mergeCycles,
  uniqueWriteTarget,
  pngDataUrl,
  posixJoin,
} = require("./assetIngest");
const { generateProjectImage, GenerateImageError, collectReferences } = require("./generateImage");
const { importStill } = require("./importStill");
const { listKnownLocations, listKnownCharacterIds, resolveAsset } = require("./parser/assetLibrary");
const {
  clampFactoryFrames,
  buildFactoryPack,
  inferFactoryIntent,
  walkPhases,
  assembleWalkPhasePrompt,
  normalizeFactoryMode,
  PROJECT_OWNER,
  slugFactoryId,
  isOverlaySlot,
  factoryModeTitle,
} = require("./factoryPrompt");
const {
  candidateDrawingsDirs,
  expectedDrawingsDir,
  defaultFactoryCanvas,
  normalizeView,
  standardForSlot,
  armSideFromName,
} = require("./factoryStandard");
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
  if (characterId === PROJECT_OWNER) return path.join(projectDir, "_factory");
  return path.join(characterDir(projectDir, characterId), "_factory");
}

function jobDir(projectDir, characterId, jobId) {
  return path.join(factoryRoot(projectDir, characterId), jobId);
}

function ownerIdFor(mode, characterId) {
  if (mode === "prop" || mode === "background" || mode === "new-character") return PROJECT_OWNER;
  return characterId;
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
  if (intent && intent.kind === "walk") {
    // Whole-body walk frames on the SIDE view, like walk_side_01..08.
    // Never dest to legs or the front torso folder.
    const view = (intent && intent.view) || "right_side";
    if (names.has("torso")) {
      const spec = findSlotSpec(character, "torso");
      const base = (spec && spec.drawings_dir) || "torso";
      return { kind: "slot", slot: "torso", drawings_dir: expectedDrawingsDir("torso", view, base) };
    }
    if (names.has("body")) {
      const spec = findSlotSpec(character, "body");
      const base = (spec && spec.drawings_dir) || "body";
      return { kind: "slot", slot: "body", drawings_dir: expectedDrawingsDir("body", view, base) };
    }
    return { kind: "slot", slot: "torso", drawings_dir: expectedDrawingsDir("torso", view, "torso") };
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
  const root = characterDir(projectDir, characterId);
  const dirs = [];
  const add = (name) => {
    if (name && !dirs.includes(name)) dirs.push(name);
  };
  add(dest.drawings_dir || dest.slot);
  add(dest.slot);
  if (dest.slot === "legs") {
    add("legs_right_side");
    add("legs_left_side");
    add("legs");
  }
  for (const dirName of dirs) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const names = fs
      .readdirSync(dir)
      .filter((name) => /\.png$/i.test(name))
      .sort();
    const preferred = names.filter((name) => !/^none\.png$/i.test(name));
    const pick = preferred[0] || names[0];
    if (pick) return path.join(dir, pick);
  }
  return null;
}

function findTorsoRef(projectDir, characterId, view) {
  const name = pickSideTorsoDrawing(projectDir, characterId, view);
  if (!name) return null;
  const root = characterDir(projectDir, characterId);
  for (const dir of [`torso_${view || "right_side"}`, "torso"]) {
    const abs = path.join(root, dir, `${name}.png`);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function findFirstPng(root, dirs, options = {}) {
  const skipWalk = Boolean(options.skipWalk);
  const skipNone = options.skipNone !== false;
  for (const dirName of dirs) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    let names = fs
      .readdirSync(dir)
      .filter((name) => /\.png$/i.test(name))
      .sort();
    if (skipNone) names = names.filter((name) => !/^none\.png$/i.test(name));
    if (skipWalk) names = names.filter((name) => !/^(walk|run|approach)/i.test(name.replace(/\.png$/i, "")));
    const pick = names[0];
    if (pick) return path.join(dir, pick);
  }
  return null;
}

function findLegsRef(projectDir, characterId, view) {
  const root = characterDir(projectDir, characterId);
  const side = view === "left_side" ? "left_side" : "right_side";
  return (
    findFirstPng(root, [`legs_${side}`, "legs", "legs_side"], { skipWalk: true, skipNone: true }) ||
    findFirstPng(root, [`legs_${side}`, "legs", "legs_side"], { skipWalk: false, skipNone: true })
  );
}

function isWalkValidationFailure(err) {
  return /extra figures|zoomed crop|giant legs|too many boots|scale mismatch|ground line|near-identical|duplicated|rig base|more than one head|rig layers|preview frames|Factory fit failed/i.test(
    String((err && err.message) || "")
  );
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
      // Keep the folder, drop existing drawings so new walk frames replace old ones.
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

function walkSetSlots(character, dest) {
  const names = collectSlotNames(character);
  const setSlots = {};
  const destSlot = dest && dest.slot;
  for (const name of names) {
    if (name === destSlot) continue;
    setSlots[name] = "none";
  }
  return setSlots;
}

function projectRelFromAbs(projectDir, abs) {
  const rel = path.relative(projectDir, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function findWalkPoseGuides(projectDir, characterId, view, count) {
  const root = characterDir(projectDir, characterId);
  const found = [];
  for (const dir of [`torso_${view}`, "torso", `legs_${view}`, "legs_right_side"]) {
    for (let i = 1; i <= 16; i += 1) {
      const abs = path.join(root, dir, `walk_side_${String(i).padStart(2, "0")}.png`);
      if (fs.existsSync(abs)) found[i - 1] = abs;
    }
  }
  const available = found.filter(Boolean);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (found[i]) out.push(found[i]);
    else if (available.length) out.push(available[i % available.length]);
    else out.push(null);
  }
  return out;
}

function findSideReferenceAbs(projectDir, characterId, view) {
  const root = characterDir(projectDir, characterId);
  const side = view === "left_side" ? "left_side" : "right_side";
  const candidates = [
    path.join(root, "_reference", "side.png"),
    path.join(root, `torso_${side}`, "neutral.png"),
    path.join(root, `torso_${side}`, "stand.png"),
    path.join(root, "torso", "walk_side_02.png"),
    path.join(root, "torso", "walk_side_01.png"),
    path.join(root, "_reference", "full.png"),
    path.join(root, "torso", "neutral.png"),
  ];
  return candidates.find((abs) => fs.existsSync(abs)) || null;
}

async function generateWalkPhaseCells(projectDir, globalAssetsDir, character, userPrompt, frames, view, dir, options) {
  const phases = walkPhases(frames);
  const guides = findWalkPoseGuides(projectDir, character.id, view, frames);
  const sideAbs = findSideReferenceAbs(projectDir, character.id, view);
  const cellsDir = path.join(dir, "cells");
  fs.mkdirSync(cellsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  const cells = [];
  const warnings = [];
  for (let i = 0; i < frames; i += 1) {
    const prompt = assembleWalkPhasePrompt({
      character,
      userPrompt,
      frames,
      phase: phases[i],
      index: i,
      projectStyle: readProjectStyle(projectDir),
    });
    const referenceRels = [];
    if (sideAbs) {
      const rel = projectRelFromAbs(projectDir, sideAbs);
      if (rel) referenceRels.push({ kind: "reference", rel });
    }
    if (guides[i]) {
      const rel = projectRelFromAbs(projectDir, guides[i]);
      if (rel && !referenceRels.some((item) => item.rel === rel)) {
        referenceRels.push({ kind: "body", rel });
      }
    }
    const generated = await generateProjectImage(
      projectDir,
      globalAssetsDir,
      {
        characterId: character.id,
        needId: "factory_action",
        n: 1,
        prompt,
        frames: 1,
        referenceRels: referenceRels.length ? referenceRels : undefined,
        skipReferences: true,
      },
      options
    );
    const first = generated.images && generated.images[0];
    if (!first || !first.imageBase64) throw factoryError("xAI returned no image.", "EXAI");
    const buf = decodeImage({ imageBase64: first.imageBase64 });
    const rawPath = path.join(dir, "raw", `phase_${String(i + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(rawPath, buf);
    const phaseDir = path.join(dir, "phase_cells", String(i + 1).padStart(2, "0"));
    fs.mkdirSync(phaseDir, { recursive: true });
    const cut = await runCutout(
      ["--input", rawPath, "--out-dir", phaseDir, "--grid", "1x1", "--detect-gaps", "--keep-extras"],
      options
    );
    const cell = (cut.cells || []).find((item) => item && !item.empty && item.path && fs.existsSync(item.path));
    if (!cell) {
      warnings.push(`Phase ${i + 1} (${phases[i].id}) was empty after cut-out.`);
      continue;
    }
    const destName = `cell_${String(i).padStart(2, "0")}.png`;
    const destPath = path.join(cellsDir, destName);
    fs.copyFileSync(cell.path, destPath);
    cells.push({ path: destPath, empty: false, warnings: cut.warnings || [] });
  }
  return { cells, warnings };
}

async function validateWalkPreview(alignedDir, dumpDir, options = {}) {
  if (!dumpDir || !fs.existsSync(dumpDir)) {
    throw factoryError("Walk preview frames were not dumped for validation.", "EINVAL");
  }
  const args = [
    "--validate-preview",
    "--preview-frames",
    dumpDir,
    "--cell-dir",
    alignedDir,
  ];
  return runFactoryFit(args, options);
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
    const spec = findSlotSpec(characterJson, job.dest.slot);
    if (spec && job.dest.drawings_dir) {
      spec.drawings_dir = job.dest.drawings_dir;
      if (/_(left_side|right_side|left_34|right_34|back)$/.test(job.dest.drawings_dir)) {
        spec.views = true;
      }
    }
    const walk = Boolean(job.action && job.action.hide_children);
    if (walk) {
      characterJson.children = [];
      for (const [name, slotSpec] of Object.entries(characterJson.slots || {})) {
        if (name === job.dest.slot) continue;
        slotSpec.default_drawing = "none";
      }
    }
    if (job.dest.slot === "body" && job.cycle) {
      const bodySpec = findSlotSpec(characterJson, "body");
      mergeCycles(bodySpec, { [job.cycle.name]: job.cycle });
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
      `${JSON.stringify({ marks: { centre: { x: 960, y: 760, scale: 0.7 } }, auto_order: ["centre"] }, null, 2)}\n`
    );
    const dest = path.join(jobDir(projectDir, character.id, job.id), "preview.mp4");
    const dumpDir = path.join(jobDir(projectDir, character.id, job.id), "preview_frames");
    const cycleFrames = Math.max(2, (job.drawings || []).length || (job.action && job.action.frames) || 8);
    const previewOpts = {
      ...options,
      aspect: "16:9",
      previewWidth: 854,
      previewHeight: 480,
      seconds: Number((cycleFrames / 12).toFixed(3)),
      sampleFps: 12,
      cycleFrames,
      dumpFramesDir: dumpDir,
      allowStandingFallback: false,
    };
    await renderActionPreview(tmp, null, character.id, job.actionId, dest, previewOpts);
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
    mode: job.mode || "character",
    slot: job.slot || null,
    view: job.view || null,
    name: job.displayName || job.name || null,
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
    previewKind: job.previewKind || (job.previewRel && /\.png$/i.test(job.previewRel) ? "image" : "video"),
    title: job.title || null,
    ticked: Boolean(job.ticked),
    usedFixture: Boolean(job.usedFixture),
    styleBlock: job.styleBlock,
    rigRules: job.rigRules,
    greenScreen: job.greenScreen,
    written: job.written || null,
  };
}

function readProjectStyle(projectDir) {
  try {
    const studio = JSON.parse(fs.readFileSync(path.join(projectDir, "studio.json"), "utf8"));
    if (studio && typeof studio.style === "string" && studio.style.trim()) return studio.style.trim();
  } catch {
    /* ignore */
  }
  return "";
}

function styleCharacter(projectDir, globalAssetsDir, character) {
  if (character) return character;
  const chars = listCharacters(projectDir, globalAssetsDir);
  return chars[0] || null;
}

function uniqueFolderId(existing, base) {
  const set = existing instanceof Set ? existing : new Set(existing || []);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function resolveSlotDest(projectDir, character, characterId, slot, view) {
  const spec = findSlotSpec(character, slot) || { drawings_dir: slot };
  const vid = normalizeView(view);
  const candidates = candidateDrawingsDirs(slot, vid, spec.drawings_dir || slot);
  for (const dir of candidates) {
    const abs = path.join(characterDir(projectDir, characterId), dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    if (fs.readdirSync(abs).some((name) => /\.png$/i.test(name))) {
      return { kind: "slot", slot, drawings_dir: dir };
    }
  }
  return { kind: "slot", slot, drawings_dir: expectedDrawingsDir(slot, vid, spec.drawings_dir || slot) };
}

function findHeadBaseAbs(projectDir, globalAssetsDir, characterId, view) {
  const dirs = [
    ...candidateDrawingsDirs("head_base", view, "head_base"),
    ...candidateDrawingsDirs("head", view, "head"),
  ];
  for (const dir of dirs) {
    for (const name of ["neutral", "head_base", "head"]) {
      const rel = posixJoin("characters", characterId, dir, `${name}.png`);
      const resolved = resolveAsset(projectDir, globalAssetsDir, rel);
      if (resolved && resolved.absPath) return { abs: resolved.absPath, rel };
    }
  }
  return null;
}

function writeStillPreview(dir, srcPath) {
  const dest = path.join(dir, "preview.png");
  fs.copyFileSync(srcPath, dest);
  return dest;
}

async function generateOrFixture(projectDir, globalAssetsDir, body, pack, character, options) {
  const fixture = decodeImage(body);
  if (fixture) return { buf: fixture, usedFixture: true };
  const generated = await generateProjectImage(
    projectDir,
    globalAssetsDir,
    {
      characterId: character && character.id,
      needId: pack.mode === "background" ? "background" : "factory_action",
      n: 1,
      prompt: pack.hiddenPrompt,
      skipReferences: pack.skipReferences || pack.attachHeadBase || !character,
      referenceRels: pack.references,
      aspectRatio: pack.aspectRatio,
    },
    options
  );
  const first = generated.images && generated.images[0];
  if (!first || !first.imageBase64) throw factoryError("xAI returned no image.", "EXAI");
  return { buf: decodeImage({ imageBase64: first.imageBase64 }), usedFixture: false };
}

async function cutStill(sheetPath, outDir, { key = true, trim = true } = {}, options = {}) {
  const args = ["--input", sheetPath, "--out-dir", outDir, "--grid", "1x1"];
  if (!key) args.push("--no-key");
  if (!trim) args.push("--no-trim");
  return runCutout(args, options);
}

async function runContextFactoryJob(projectDir, globalAssetsDir, body, mode, options = {}) {
  const userPrompt = String((body && body.prompt) || "").trim();
  if (!userPrompt) {
    const hint =
      mode === "prop"
        ? "Type the prop you want (e.g. guitar, bar stool)"
        : mode === "background"
          ? "Type the scene you want"
          : mode === "new-character"
            ? "Describe a new character (e.g. grumpy old barman)"
            : "Type what you want.";
    throw factoryError(hint);
  }
  const view = normalizeView(body && body.view);
  const slot = body && body.slot ? String(body.slot) : null;
  const overlay = mode === "slot" && isOverlaySlot(slot, body && body.label);
  let character = null;
  if (mode === "slot" || mode === "character") {
    character = findCharacter(projectDir, globalAssetsDir, body && body.characterId);
  } else {
    character = styleCharacter(projectDir, globalAssetsDir, null);
  }
  const projectStyle = readProjectStyle(projectDir);
  const refs = [];
  if (mode === "slot" && overlay && character) {
    const head = findHeadBaseAbs(projectDir, globalAssetsDir, character.id, view);
    if (head) refs.push({ kind: "reference", rel: head.rel });
  }
  const pack = buildFactoryPack({
    mode,
    character,
    userPrompt,
    frames: 1,
    advancedPrompt: body && body.advancedPrompt,
    references: refs,
    slot,
    view,
    label: body && body.label,
    name: body && body.name,
    projectStyle,
  });
  const ownerId = ownerIdFor(mode, character && character.id);
  let dest = { kind: mode };
  if (mode === "slot") {
    const writable = readWritableCharacter(projectDir, globalAssetsDir, character.id);
    dest = resolveSlotDest(projectDir, writable, character.id, slot, view);
  }
  if (body && body.dryRun) {
    return { ok: true, dryRun: true, pack, dest, characterId: ownerId, mode, slot, view };
  }

  const { buf: sheetBuf, usedFixture } = await generateOrFixture(
    projectDir,
    globalAssetsDir,
    body,
    pack,
    mode === "slot" ? character : pack.skipReferences ? null : character,
    options
  );
  const jobId = stampJobId();
  const dir = jobDir(projectDir, ownerId, jobId);
  fs.mkdirSync(path.join(dir, "cells"), { recursive: true });
  const sheetPath = path.join(dir, "sheet.png");
  fs.writeFileSync(sheetPath, sheetBuf);

  const key = mode !== "background";
  const trim = mode !== "background" && !overlay;
  const cut = await cutStill(sheetPath, path.join(dir, "cells"), { key, trim }, options);
  const cell = (cut.cells || [])[0];
  if (!cell || cell.empty || !cell.path || !fs.existsSync(cell.path)) {
    throw factoryError("Cut-out did not produce a drawing. Try Redo.", "EINVAL");
  }

  let drawingPath = cell.path;
  const warnings = [...(cut.warnings || [])];
  let drawingName = slugFactoryId(userPrompt, mode === "slot" ? slot || "drawing" : mode);
  if (mode === "slot" && dest.slot && standardForSlot(dest.slot) && standardForSlot(dest.slot).slot === "arm") {
    drawingName = drawingName.replace(/_l$/i, "_L").replace(/_r$/i, "_R");
    const side =
      armSideFromName(drawingName, dest.slot) ||
      (/\bright\b/i.test(userPrompt) && !/\bleft\b/i.test(userPrompt) ? "R" : "L");
    if (!/_[LR]$/.test(drawingName)) drawingName = `${drawingName}_${side}`;
  }

  if (mode === "slot") {
    const writable = readWritableCharacter(projectDir, globalAssetsDir, character.id);
    const canvas = slotCanvas(writable, dest);
    const alignedDir = path.join(dir, "aligned");
    fs.mkdirSync(alignedDir, { recursive: true });
    const fitArgs = [
      "--src",
      cell.path,
      "--out",
      path.join(alignedDir, path.basename(cell.path)),
      "--canvas-w",
      String(canvas.w || 1024),
      "--canvas-h",
      String(canvas.h || 1024),
    ];
    if (overlay) {
      fitArgs.push("--keep-canvas", "--check-head");
      const head = findHeadBaseAbs(projectDir, globalAssetsDir, character.id, view);
      if (head) fitArgs.push("--head-ref", head.abs);
    } else {
      const refAbs = findAlignRef(projectDir, character.id, dest);
      if (refAbs) fitArgs.push("--ref", refAbs);
    }
    const fitted = await runFactoryFit(fitArgs, options);
    warnings.push(...((fitted && fitted.warnings) || []));
    if (overlay && (fitted.warnings || []).some((line) => /full head/i.test(String(line)))) {
      throw factoryError("Eyes and mouths must be overlays, never full heads.", "EINVAL");
    }
    const alignedPath = path.join(alignedDir, path.basename(cell.path));
    if (fs.existsSync(alignedPath)) drawingPath = alignedPath;
    const refAbs = overlay ? findAlignRef(projectDir, character.id, dest) : null;
    if (overlay && refAbs && fs.existsSync(drawingPath)) {
      const alignedOnce = `${drawingPath}.once.png`;
      await runAlign(["--src", drawingPath, "--ref", refAbs, "--out", alignedOnce, "--no-crop-to-head"], options);
      if (fs.existsSync(alignedOnce)) {
        fs.copyFileSync(alignedOnce, drawingPath);
      }
    }
    const row = (fitted.written || [])[0];
    if (row && row.problems && row.problems.length) warnings.push(...row.problems);
  }

  writeStillPreview(dir, drawingPath);
  const previewRel =
    ownerId === PROJECT_OWNER
      ? posixJoin("_factory", jobId, "preview.png")
      : posixJoin("characters", ownerId, "_factory", jobId, "preview.png");
  const job = {
    id: jobId,
    mode,
    characterId: ownerId,
    slot,
    view,
    displayName: String((body && body.name) || "").trim() || null,
    userPrompt,
    hiddenPrompt: pack.hiddenPrompt,
    styleBlock: pack.styleBlock,
    rigRules: pack.rigRules,
    greenScreen: pack.greenScreen,
    frames: 1,
    grid: pack.grid,
    dest,
    actionId: drawingName,
    action: null,
    drawings: [{ name: drawingName, path: drawingPath, problems: [] }],
    warnings,
    usedFixture,
    ticked: false,
    previewRel,
    previewKind: "image",
    title: factoryModeTitle({ mode, character, slot, view, label: body && body.label }),
    createdAt: new Date().toISOString(),
  };
  writeManifest(dir, job);
  return summarizeJob(job, ownerId);
}

function tickStillJob(projectDir, globalAssetsDir, job) {
  const drawing = (job.drawings || [])[0];
  if (!drawing || !drawing.path || !fs.existsSync(drawing.path)) {
    throw factoryError("Nothing to save. Try Generate again.");
  }
  const buf = fs.readFileSync(drawing.path);
  if (job.mode === "prop") {
    let locations = listKnownLocations(projectDir, globalAssetsDir);
    if (!locations.length) {
      const bgDir = path.join(projectDir, "backgrounds", "studio");
      fs.mkdirSync(bgDir, { recursive: true });
      fs.writeFileSync(path.join(bgDir, "bg.png"), encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4)));
      fs.writeFileSync(
        path.join(bgDir, "staging.json"),
        `${JSON.stringify({ marks: { centre: { x: 960, y: 1080, scale: 1 } }, auto_order: ["centre"], props: {} }, null, 2)}\n`
      );
      locations = ["studio"];
    }
    const saved = importStill(projectDir, globalAssetsDir, {
      kind: "prop",
      name: drawing.name,
      location: locations[0],
      imageBase64: `data:image/png;base64,${buf.toString("base64")}`,
    });
    job.written = saved;
    return job;
  }
  if (job.mode === "background") {
    const saved = importStill(projectDir, globalAssetsDir, {
      kind: "background",
      name: drawing.name,
      imageBase64: `data:image/png;base64,${buf.toString("base64")}`,
    });
    job.written = saved;
    return job;
  }
  if (job.mode === "new-character") {
    const display = String(job.displayName || job.userPrompt || "character").trim();
    const ids = new Set(listKnownCharacterIds(projectDir, globalAssetsDir));
    const id = uniqueFolderId(ids, slugFactoryId(display, "character"));
    if (!isSafeFolderName(id)) throw factoryError("Invalid character name");
    const dir = characterDir(projectDir, id);
    fs.mkdirSync(path.join(dir, "_reference"), { recursive: true });
    fs.writeFileSync(path.join(dir, "_reference", "full.png"), buf);
    writeCharacterJson(projectDir, id, {
      id,
      display_name: display,
      aliases: [display],
      z: 10,
      asset: "_reference/full.png",
      reference: "_reference/full.png",
      slots: {},
    });
    const library = readLibrary(projectDir);
    if (!library.characters.includes(id)) {
      library.characters.push(id);
      writeLibrary(projectDir, library);
    }
    job.written = { kind: "character", id, rel: posixJoin("characters", id, "_reference", "full.png") };
    job.actionId = id;
    return job;
  }
  if (job.mode === "slot") {
    const characterId = job.characterId;
    const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
    ensureSlot(character, job.dest);
    writeCharacterJson(projectDir, characterId, character);
    const taken = new Set();
    const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, job.dest, drawing.name, taken);
    const abs = path.join(projectDir, target.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(drawing.path, abs);
    setDrawingState(projectDir, characterId, `${job.dest.drawings_dir}/${target.name}`, "draft");
    drawing.writtenName = target.name;
    drawing.writtenRel = target.rel;
    job.written = { kind: "slot", rel: target.rel, name: target.name };
    return job;
  }
  throw factoryError(`Unknown factory mode: ${job.mode}`);
}

async function runFactoryJob(projectDir, globalAssetsDir, body, options = {}) {
  const mode = normalizeFactoryMode((body && body.mode) || ((body && body.slot) ? "slot" : "character"));
  if (body && body.walkSet && !body._walkFrame) {
    const jobs = [];
    for (const frames of [8, 12, 16]) {
      jobs.push(
        await runFactoryJob(
          projectDir,
          globalAssetsDir,
          { ...body, frames, walkSet: true, _walkFrame: frames, mode: "character" },
          options
        )
      );
    }
    return { ok: true, walkSet: true, jobs };
  }
  if (mode !== "character") {
    return runContextFactoryJob(projectDir, globalAssetsDir, body, mode, options);
  }
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
  const jobId = stampJobId();
  const dir = jobDir(projectDir, character.id, jobId);
  const canvas = slotCanvas(writable, dest);
  const refAbs = findAlignRef(projectDir, character.id, dest);
  const torsoRefAbs = intent.kind === "walk" ? findTorsoRef(projectDir, character.id, intent.view) : null;
  const legsRefAbs = intent.kind === "walk" ? findLegsRef(projectDir, character.id, intent.view) : null;
  const maxAttempts = fixture || options.skipWalkRetry ? 1 : intent.kind === "walk" ? 2 : 1;
  let cut = null;
  let fitted = null;
  let usedFixture = Boolean(fixture);
  let lastWalkError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "cells"), { recursive: true });
      let sheetBuf = fixture;
      usedFixture = Boolean(fixture);
      if (intent.kind === "walk" && !sheetBuf) {
        const generated = await generateWalkPhaseCells(
          projectDir,
          globalAssetsDir,
          character,
          userPrompt,
          frames,
          intent.view,
          dir,
          options
        );
        cut = { cells: generated.cells, warnings: generated.warnings || [] };
        usedFixture = false;
      } else {
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
        const sheetPath = path.join(dir, "sheet.png");
        fs.writeFileSync(sheetPath, sheetBuf);

        const cutArgs = [
          "--input",
          sheetPath,
          "--out-dir",
          path.join(dir, "cells"),
          "--grid",
          `${pack.grid.cols}x${pack.grid.rows}`,
          "--detect-gaps",
        ];
        if (intent.kind === "walk") cutArgs.push("--keep-extras");
        cut = await runCutout(cutArgs, options);
      }

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
      if (intent.kind === "walk") {
        if (legsRefAbs) fitArgs.push("--ref", legsRefAbs);
        else if (refAbs) fitArgs.push("--ref", refAbs);
        if (torsoRefAbs) fitArgs.push("--torso-ref", torsoRefAbs);
        fitArgs.push(
          "--validate-walk",
          "--fail-closed",
          "--expect-face",
          intent.view === "left_side" ? "left" : "right"
        );
      } else {
        if (refAbs) fitArgs.push("--ref", refAbs);
        if (isOverlayDest(dest)) fitArgs.push("--check-head");
      }
      fitted = await runFactoryFit(fitArgs, options);
      lastWalkError = null;
      break;
    } catch (err) {
      lastWalkError = err;
      const retryable = intent.kind === "walk" && !fixture && isWalkValidationFailure(err);
      if (!retryable || attempt + 1 >= maxAttempts) {
        if (intent.kind === "walk" && isWalkValidationFailure(err)) {
          throw factoryError(
            `Walk sheet failed validation (${String(err.message || err).replace(/^Factory fit failed: /, "")}). Extra figures, cropped legs, identical poses, and scale mismatches are rejected automatically — hit Redo.`,
            err.code || "EINVAL"
          );
        }
        throw err;
      }
    }
  }
  if (!cut || !fitted) {
    throw lastWalkError || factoryError("Walk sheet failed validation. Hit Redo.", "EINVAL");
  }

  const alignedDir = path.join(dir, "aligned");
  const actionBase =
    intent.kind === "walk" && body._walkFrame ? `${pack.actionId}_${frames}` : pack.actionId;
  const actionId = uniqueActionId(projectDir, character.id, actionBase);
  const names = drawingNames(actionId, frames);
  const drawings = [];
  const warnings = [...(cut.warnings || []), ...((fitted && fitted.warnings) || [])];
  const fatalWalk = [];
  for (let i = 0; i < frames; i += 1) {
    const cell = (cut.cells || [])[i];
    const alignedName = cell ? path.basename(cell.path) : `cell_${String(i).padStart(2, "0")}.png`;
    const alignedPath = path.join(alignedDir, alignedName);
    const row = (fitted.written || []).find((item) => path.basename(item.src) === alignedName);
    if (!cell || cell.empty || !fs.existsSync(alignedPath)) {
      warnings.push(`Frame ${i + 1} was empty after cut-out.`);
      if (intent.kind === "walk") fatalWalk.push(`Frame ${i + 1} empty`);
      continue;
    }
    if (isOverlayDest(dest) && (fitted.warnings || []).some((line) => line.includes(alignedName))) {
      throw factoryError("Eyes and mouths must be overlays, never full heads.", "EINVAL");
    }
    const problems = (row && row.problems) || [];
    const rejected = problems.some((line) =>
      /too many boots|facing |extra figures|zoomed crop|giant legs|scale mismatch|ground line|near-identical|duplicated|rig base|more than one head|rig layers/.test(
        String(line)
      )
    );
    if (rejected) {
      warnings.push(`Frame ${i + 1} rejected: ${problems.join("; ")}`);
      fatalWalk.push(`Frame ${i + 1}: ${problems.join("; ")}`);
      continue;
    }
    drawings.push({
      name: names[i],
      path: alignedPath,
      problems,
    });
  }
  if (intent.kind === "walk" && fatalWalk.length) {
    throw factoryError(
      `Walk sheet failed validation (${fatalWalk.slice(0, 4).join("; ")}). Extra figures, cropped legs, identical poses, and scale mismatches are rejected automatically — hit Redo.`,
      "EINVAL"
    );
  }
  if (drawings.length < 2) throw factoryError("Cut-out did not produce enough frames. Try Redo.", "EINVAL");
  if (intent.kind === "walk" && drawings.length < frames) {
    throw factoryError(
      `Walk sheet lost ${frames - drawings.length} frame(s) after validation. Hit Redo.`,
      "EINVAL"
    );
  }

  const cycleName = intent.kind === "walk" ? (intent.view === "left_side" ? "walk_left_side" : "walk_side") : actionId;
  const setSlots = intent.kind === "walk" ? walkSetSlots(writable, dest) : {};
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
  if (intent.kind === "walk") action.hide_children = true;
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
    if (intent.kind === "walk") {
      const dumpDir = path.join(dir, "preview_frames");
      await validateWalkPreview(alignedDir, dumpDir, options);
    }
  } catch (err) {
    if (intent.kind === "walk" && isWalkValidationFailure(err)) {
      throw factoryError(
        `Walk preview failed validation (${String(err.message || err).replace(/^Factory fit failed: /, "")}). Extra heads, frozen frames, and rig overlays are rejected — hit Redo.`,
        err.code || "EINVAL"
      );
    }
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
  const dir = jobDir(projectDir, characterId, jobId);
  const candidates = [
    path.join(dir, "preview.png"),
    path.join(dir, "preview.jpg"),
    path.join(dir, "preview.mp4"),
  ];
  const file = candidates.find((item) => fs.existsSync(item) && fs.statSync(item).size > 0);
  if (!file) throw factoryError("Preview clip is not ready.", "ENOENT");
  return file;
}

function tickFactoryJob(projectDir, globalAssetsDir, characterId, jobId) {
  const job = readManifest(projectDir, characterId, jobId);
  if (job.ticked) return summarizeJob(job, characterId);
  if (job.mode && job.mode !== "character") {
    tickStillJob(projectDir, globalAssetsDir, job);
    job.ticked = true;
    job.tickedAt = new Date().toISOString();
    writeManifest(jobDir(projectDir, characterId, jobId), job);
    return summarizeJob(job, characterId);
  }

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  ensureSlot(character, job.dest);
  if (job.dest && job.dest.slot && /_(left_side|right_side|left_34|right_34|back)$/.test(String(job.dest.drawings_dir || ""))) {
    const spec = findSlotSpec(character, job.dest.slot);
    if (spec) {
      spec.views = true;
      const base = String(job.dest.drawings_dir).replace(
        /_(left_side|right_side|left_34|right_34|back)$/,
        ""
      );
      if (base && spec.drawings_dir !== base) spec.drawings_dir = spec.drawings_dir || base;
    }
  }
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
    const asDraft = Boolean((job.action && /walk/.test(String(job.actionId || ""))) || job.walkSet);
    setDrawingState(projectDir, characterId, `${job.dest.drawings_dir}/${target.name}`, asDraft ? "draft" : "ticked");
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
      mode: previous.mode || "character",
      characterId: previous.mode && previous.mode !== "character" ? previous.characterId : characterId,
      slot: previous.slot,
      view: previous.view,
      name: previous.displayName,
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
  findTorsoRef,
  findLegsRef,
  walkSetSlots,
  findSideReferenceAbs,
  runFactoryJob,
  describeFactoryJob,
  resolveFactoryPreview,
  tickFactoryJob,
  redoFactoryJob,
  factoryPreviewUrl,
  GenerateImageError,
};
