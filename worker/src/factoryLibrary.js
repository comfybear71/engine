"use strict";

/**
 * Per-character action pack dictionary: imported clips live in
 * characters/<id>/library/<clip>/frames + index.json.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { characterDir, findSlotSpec, readWritableCharacter, writeCharacterJson } = require("./characterLocal");
const { isSafeFolderName } = require("./studioProjects");
const { uniqueWriteTarget, ensureSlot } = require("./assetIngest");
const { setDrawingState } = require("./characterStatus");
const {
  factoryError,
  findCharacter,
  uniqueActionId,
  drawingNames,
  findTorsoRef,
  findLegsRef,
  slotCanvas,
  walkSetSlots,
  walkBob,
  findHeadBaseAbs,
} = require("./factoryJob");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const {
  armSideFromName,
  resolveDrawingAlias,
  resolveSlotName,
  standardForSlot,
  expectedDrawingsDir,
  candidateDrawingsDirs,
  normalizeView,
} = require("./factoryStandard");

const DEFAULT_CATEGORIES = [
  { id: "walks", label: "Walks" },
  { id: "turns_looks", label: "Turns/Looks" },
  { id: "head_moves", label: "Head moves" },
  { id: "mic", label: "Mic" },
  { id: "arms_gestures", label: "Arms/Gestures" },
  { id: "expressions", label: "Expressions" },
  { id: "idle_stand", label: "Idle/Stand" },
  { id: "inserts", label: "Inserts" },
  { id: "other", label: "Other" },
];

function libraryRoot(projectDir, characterId) {
  return path.join(characterDir(projectDir, characterId), "library");
}

function clipDir(projectDir, characterId, clipId) {
  if (!isSafeFolderName(clipId)) throw factoryError("Invalid clip id");
  return path.join(libraryRoot(projectDir, characterId), clipId);
}

function slugClipId(filename) {
  return path
    .basename(String(filename || ""), path.extname(String(filename || "")))
    .toLowerCase()
    .replace(/^generated_video_?/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "clip";
}

function uniqueClipId(projectDir, characterId, base) {
  const safe = slugClipId(base);
  const root = libraryRoot(projectDir, characterId);
  if (!fs.existsSync(path.join(root, safe, "index.json"))) return safe;
  let n = 2;
  while (fs.existsSync(path.join(root, `${safe}_${n}`, "index.json"))) n += 1;
  return `${safe}_${n}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function categoriesPath(projectDir, characterId) {
  return path.join(libraryRoot(projectDir, characterId), "categories.json");
}

function listCategories(projectDir, characterId) {
  const stored = readJson(categoriesPath(projectDir, characterId), null);
  const extra = stored && Array.isArray(stored.categories) ? stored.categories : [];
  const seen = new Set();
  const out = [];
  for (const item of [...DEFAULT_CATEGORIES, ...extra]) {
    const id = String(item.id || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(item.label || id).trim() || id });
  }
  return out;
}

function addCategory(projectDir, characterId, label) {
  const id = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!id) throw factoryError("Name the category.", "EINVAL");
  const current = listCategories(projectDir, characterId);
  if (current.some((item) => item.id === id)) return current;
  const stored = readJson(categoriesPath(projectDir, characterId), { categories: [] });
  stored.categories = [...(stored.categories || []), { id, label: String(label).trim() || id }];
  writeJson(categoriesPath(projectDir, characterId), stored);
  return listCategories(projectDir, characterId);
}

function readClipIndex(projectDir, characterId, clipId) {
  const file = path.join(clipDir(projectDir, characterId, clipId), "index.json");
  if (!fs.existsSync(file)) throw factoryError("Clip not found", "ENOENT");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeClipIndex(projectDir, characterId, clipId, index) {
  writeJson(path.join(clipDir(projectDir, characterId, clipId), "index.json"), index);
  return index;
}

function listLibraryClips(projectDir, characterId) {
  const root = libraryRoot(projectDir, characterId);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { characterId, categories: listCategories(projectDir, characterId), clips: [] };
  }
  const clips = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!isSafeFolderName(name) || name === "categories") continue;
    const indexPath = path.join(root, name, "index.json");
    if (!fs.existsSync(indexPath)) continue;
    const index = readJson(indexPath, null);
    if (!index) continue;
    const frames = Array.isArray(index.frames) ? index.frames : [];
    clips.push({
      id: name,
      filename: index.filename || name,
      kind: index.kind || "body",
      action: index.action || "",
      category: index.category || "other",
      background: index.background || "black",
      frameCount: frames.length || Number(index.frameCount) || 0,
      view: frames[0] && frames[0].view,
      warnings: index.warnings || [],
      issues: [...new Set(frames.flatMap((item) => item.issues || []))],
      frames: frames.map((item) => ({
        index: item.index,
        rel: `characters/${characterId}/library/${name}/${item.file}`,
        thumbRel: item.rel ? `characters/${characterId}/library/${name}/${item.rel}` : null,
        kind: item.kind,
        view: item.view,
        yaw: item.yaw,
        action: item.action,
        phase: item.phase,
        quality: item.quality,
        issues: item.issues || [],
      })),
      ticked: Boolean(index.ticked),
      actionId: index.actionId || null,
    });
  }
  return { characterId, categories: listCategories(projectDir, characterId), clips };
}

function resolveLibraryFile(projectDir, characterId, clipId, rel) {
  const safe = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!safe || safe.includes("..")) throw factoryError("Invalid frame", "EINVAL");
  const abs = path.join(clipDir(projectDir, characterId, clipId), safe);
  if (!fs.existsSync(abs)) throw factoryError("Frame not found", "ENOENT");
  return abs;
}

function collectHeadFrames(projectDir, characterId) {
  const { clips } = listLibraryClips(projectDir, characterId);
  const heads = [];
  for (const clip of clips.filter((item) => item.kind === "head")) {
    for (const frame of clip.frames || []) {
      heads.push({
        clipId: clip.id,
        index: frame.index,
        yaw: Number(frame.yaw) || 0,
        path: resolveLibraryFile(projectDir, characterId, clip.id, `frames/frame_${String(frame.index).padStart(4, "0")}.png`),
      });
    }
  }
  return heads;
}

function patchClipCategory(projectDir, characterId, clipId, category) {
  const index = readClipIndex(projectDir, characterId, clipId);
  index.category = String(category || "other");
  writeClipIndex(projectDir, characterId, clipId, index);
  return index;
}

function inferCategoryFromAction(action) {
  if (action && action.category) return action.category;
  const text = `${(action && action.id) || ""} ${(action && action.view) || ""}`.toLowerCase();
  if (/walk|stride|gait/.test(text)) return "walks";
  if (/mic/.test(text)) return "mic";
  if (/head/.test(text)) return "head_moves";
  if (/turn|look/.test(text)) return "turns_looks";
  if (/idle|stand/.test(text)) return "idle_stand";
  if (/arm|gesture/.test(text)) return "arms_gestures";
  if (/insert/.test(text)) return "inserts";
  return "other";
}

function actionJsonPath(projectDir, characterId, actionId) {
  return path.join(characterDir(projectDir, characterId), "actions", `${actionId}.json`);
}

function readActionJson(projectDir, characterId, actionId) {
  const file = actionJsonPath(projectDir, characterId, actionId);
  if (!fs.existsSync(file)) throw factoryError("Action not found", "ENOENT");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeActionJson(projectDir, characterId, actionId, action) {
  writeJson(actionJsonPath(projectDir, characterId, actionId), action);
  return action;
}

function patchActionCategory(projectDir, characterId, actionId, category) {
  const action = readActionJson(projectDir, characterId, actionId);
  action.category = String(category || "other");
  writeActionJson(projectDir, characterId, actionId, action);
  return action;
}

function findActionDrawing(root, destSlot, destDir, name) {
  const fileName = `${name}.png`;
  const guesses = [destDir, destSlot];
  const stripped = String(destSlot || "").replace(/_[LR]$/, "");
  if (stripped && stripped !== destSlot) guesses.push(stripped);
  for (const dir of guesses) {
    if (!dir) continue;
    const abs = path.join(root, dir, fileName);
    if (fs.existsSync(abs)) return abs;
  }
  if (fs.existsSync(root)) {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name === "library" || ent.name === "_factory") continue;
      const abs = path.join(root, ent.name, fileName);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return path.join(root, destDir || destSlot || "", fileName);
}

function actionFrameList(projectDir, characterId, actionId) {
  const action = readActionJson(projectDir, characterId, actionId);
  const flags = action.frame_flags || {};
  const slotFrames = action.slot_frames || {};
  const destSlot = Object.keys(slotFrames)[0] || "torso";
  const names = slotFrames[destSlot] || [];
  const destDir = action.drawings_dir || `${destSlot}${action.view && action.view !== "front" ? `_${action.view}` : ""}`;
  const root = characterDir(projectDir, characterId);
  const frames = names.map((name, index) => {
    const abs = findActionDrawing(root, destSlot, destDir, name);
    const rel = path.relative(projectDir, abs).replace(/\\/g, "/");
    return {
      index,
      number: index + 1,
      name,
      slot: destSlot,
      rel: fs.existsSync(abs) ? rel : null,
      issues: flags[String(index)] || flags[name] || [],
    };
  });
  return {
    actionId,
    characterId,
    category: inferCategoryFromAction(action),
    view: action.view || null,
    frames: frames.length,
    still: frames.length <= 1,
    warnings: action.warnings || [],
    libraryClip: action.libraryClip || null,
    drawings: frames,
  };
}

function flagActionFrame(projectDir, characterId, actionId, index, issue) {
  const action = readActionJson(projectDir, characterId, actionId);
  const key = String(index);
  const flags = { ...(action.frame_flags || {}) };
  const current = new Set(flags[key] || []);
  const name = String(issue || "").trim() || "flagged";
  if (current.has(name)) current.delete(name);
  else current.add(name);
  flags[key] = [...current];
  action.frame_flags = flags;
  const any = Object.values(flags).some((list) => list && list.length);
  action.warnings = any ? [...new Set([...(action.warnings || []).filter((item) => !item.startsWith("flagged ")), `flagged ${name}`])] : action.warnings || [];
  writeActionJson(projectDir, characterId, actionId, action);
  return actionFrameList(projectDir, characterId, actionId);
}

function deleteActionFrame(projectDir, characterId, actionId, index) {
  const action = readActionJson(projectDir, characterId, actionId);
  const slotFrames = action.slot_frames || {};
  const destSlot = Object.keys(slotFrames)[0];
  if (!destSlot) throw factoryError("No frames on this action.", "EINVAL");
  const names = [...(slotFrames[destSlot] || [])];
  if (names.length <= 1) throw factoryError("Keep at least one frame.", "EINVAL");
  if (index < 0 || index >= names.length) throw factoryError("Frame not found", "ENOENT");
  names.splice(index, 1);
  action.slot_frames[destSlot] = names;
  action.frames = names.length;
  const flags = {};
  for (const [key, value] of Object.entries(action.frame_flags || {})) {
    const n = Number(key);
    if (!Number.isFinite(n)) continue;
    if (n === index) continue;
    flags[String(n > index ? n - 1 : n)] = value;
  }
  action.frame_flags = flags;
  writeActionJson(projectDir, characterId, actionId, action);
  return actionFrameList(projectDir, characterId, actionId);
}

function saveFrameToSlot(projectDir, globalAssetsDir, characterId, actionId, index, slot, view) {
  const detail = actionFrameList(projectDir, characterId, actionId);
  const frame = detail.drawings[index];
  if (!frame || !frame.rel) throw factoryError("Frame not found", "ENOENT");
  const abs = path.join(projectDir, frame.rel);
  if (!fs.existsSync(abs)) throw factoryError("Frame file missing", "ENOENT");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const spec = findSlotSpec(character, slot);
  const base = (spec && spec.drawings_dir) || slot;
  const dest = {
    kind: "slot",
    slot,
    drawings_dir: view && view !== "front" ? `${base}_${view}` : base,
  };
  const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, dest, frame.name, new Set());
  const destAbs = path.join(projectDir, target.rel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(abs, destAbs);
  setDrawingState(projectDir, characterId, `${dest.drawings_dir}/${target.name}`, "draft");
  if (spec && dest.drawings_dir !== spec.drawings_dir && /_(left_side|right_side|left_34|right_34|back)$/.test(dest.drawings_dir)) {
    spec.views = true;
    writeCharacterJson(projectDir, characterId, character);
  }
  return { ok: true, rel: target.rel, name: target.name, slot, state: "draft" };
}

function spawnCmd(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
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
    child.on("error", (err) => reject(new Error(`Failed to spawn ${bin}: ${err.message}`)));
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runPythonModule(moduleName, args, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return spawnCmd(pythonBin, ["-m", moduleName, ...args], { cwd: PYTHON_DIR }).then(({ code, stdout, stderr }) => {
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
      const detail = (parsed && parsed.error) || (stderr || stdout).trim().split("\n").pop() || `exited ${code}`;
      throw factoryError(detail, "EINVAL");
    }
    return parsed;
  });
}

function libraryFrameAbs(projectDir, characterId, clipId, index) {
  const info = readClipIndex(projectDir, characterId, clipId);
  const frames = Array.isArray(info.frames) ? info.frames : [];
  const frame = frames.find((item) => Number(item.index) === Number(index)) || frames[index];
  if (!frame) throw factoryError("Frame not found", "ENOENT");
  const rel = frame.file || `frames/frame_${String(frame.index).padStart(4, "0")}.png`;
  return { info, frame, abs: resolveLibraryFile(projectDir, characterId, clipId, rel) };
}

function resolveSaveSlot(character, slot) {
  const raw = String(slot || "torso").trim();
  if (findSlotSpec(character, raw)) return raw;
  const aliased = resolveSlotName(raw, character);
  if (findSlotSpec(character, aliased)) return aliased;
  const standard = standardForSlot(raw) || standardForSlot(aliased);
  if (standard && findSlotSpec(character, standard.slot)) return standard.slot;
  if (standard && standard.slot === "arm") {
    if (findSlotSpec(character, "hand")) return "hand";
    return "arm";
  }
  if (standard && standard.slot === "head_base") return "head_base";
  if (standard && standard.slot === "torso") {
    if (findSlotSpec(character, "torso")) return "torso";
    if (findSlotSpec(character, "body")) return "body";
  }
  return (standard && standard.slot) || aliased || raw;
}

function overlayDrawingsDir(projectDir, characterId, slot, view) {
  const vid = normalizeView(view);
  const prefix = slot === "mouth" ? "mouth" : slot === "eyes" ? "eyes" : slot;
  const root = characterDir(projectDir, characterId);
  for (const dir of candidateDrawingsDirs(slot, vid, prefix)) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return dir;
  }
  if (slot === "mouth" && vid === "front") return "mouth_front";
  if (slot === "eyes" && vid === "front") return "eyes_front";
  return expectedDrawingsDir(slot, vid, prefix);
}

function resolveLibraryDest(projectDir, character, characterId, slot, view) {
  const resolved = resolveSaveSlot(character, slot);
  const spec = findSlotSpec(character, resolved);
  const standard = standardForSlot(resolved) || standardForSlot(slot);
  const canonical = (standard && standard.slot) || resolved;
  const vid = normalizeView(view);
  let drawingsDir;
  if (canonical === "eyes" || canonical === "mouth") {
    drawingsDir = overlayDrawingsDir(projectDir, characterId, canonical, vid);
  } else {
    const base = (spec && spec.drawings_dir) || canonical;
    drawingsDir = expectedDrawingsDir(canonical === "arm" ? resolved : canonical, vid, base);
  }
  return { kind: "slot", slot: resolved, drawings_dir: drawingsDir, canonical };
}

function slugDrawingName(name, fallback) {
  const raw = String(name || fallback || "frame")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return raw || fallback || "frame";
}

function armDrawingName(slot, name, side) {
  let drawing = slugDrawingName(name, "arm");
  const forced = String(side || "").toUpperCase() === "R" ? "R" : String(side || "").toUpperCase() === "L" ? "L" : null;
  if (forced && !/_[LR]$/i.test(drawing)) drawing = `${drawing}_${forced}`;
  drawing = resolveDrawingAlias(slot, drawing);
  if (!/_[LR]$/.test(drawing)) {
    const fromName = armSideFromName(drawing, slot) || forced || "L";
    drawing = `${drawing}_${fromName}`;
  }
  return drawing.replace(/_l$/, "_L").replace(/_r$/, "_R");
}

async function fitLibrarySource(srcAbs, destAbs, dest, canvas, refs, options = {}) {
  const args = [
    "fit-slot",
    "--src",
    srcAbs,
    "--out",
    destAbs,
    "--slot",
    dest.canonical || dest.slot,
    "--canvas-w",
    String(canvas.w || 1024),
    "--canvas-h",
    String(canvas.h || 1024),
    "--check-head",
  ];
  if (refs.head) args.push("--head-ref", refs.head);
  if (refs.torso) args.push("--torso-ref", refs.torso);
  if (refs.legs) args.push("--legs-ref", refs.legs);
  if (refs.align) args.push("--ref", refs.align);
  if (Number.isFinite(refs.neckY)) args.push("--neck-y", String(refs.neckY));
  return runPythonModule("compositor.factory_extract_face", args, options);
}

async function saveLibraryFrameToSlot(
  projectDir,
  globalAssetsDir,
  characterId,
  clipId,
  index,
  slot,
  view,
  name,
  side,
  options = {}
) {
  const { frame, abs } = libraryFrameAbs(projectDir, characterId, clipId, index);
  if (!fs.existsSync(abs)) throw factoryError("Frame file missing", "ENOENT");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const vid = normalizeView(view || frame.view || "front");
  const dest = resolveLibraryDest(projectDir, character, characterId, slot, vid);
  const overlay = dest.canonical === "eyes" || dest.canonical === "mouth";
  const arm = (standardForSlot(dest.slot) || standardForSlot(dest.canonical) || {}).slot === "arm" || dest.slot === "hand";
  let drawingName = slugDrawingName(name, overlay ? (dest.canonical === "eyes" ? "open" : "X") : `frame_${String(frame.index).padStart(2, "0")}`);
  if (arm) drawingName = armDrawingName(dest.slot, name || drawingName, side);
  const canvas = slotCanvas(character, dest);
  const tmpDir = path.join(clipDir(projectDir, characterId, clipId), "_fit");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpOut = path.join(tmpDir, `${drawingName}.png`);
  const head = overlay || dest.canonical === "head_base" ? findHeadBaseAbs(projectDir, globalAssetsDir, characterId, vid) : null;
  const refs = {
    head: head && head.abs,
    torso: dest.canonical === "torso" || dest.canonical === "body" ? findTorsoRef(projectDir, characterId, vid) : null,
    legs: dest.canonical === "torso" || dest.canonical === "body" ? findLegsRef(projectDir, characterId, vid) : null,
    align: dest.canonical === "arm" || dest.slot === "hand" ? findTorsoRef(projectDir, characterId, vid) : null,
    neckY: 457,
  };
  try {
    await fitLibrarySource(abs, tmpOut, dest, canvas, refs, options);
  } catch (err) {
    if (/full head/i.test(String(err.message || err))) {
      throw factoryError("Eyes and mouths must be overlays, never full heads.", "EINVAL");
    }
    throw err;
  }
  if (!fs.existsSync(tmpOut)) throw factoryError("Fit did not write a drawing.", "EINVAL");
  ensureSlot(character, dest);
  if (dest.drawings_dir && /_(left_side|right_side|left_34|right_34|back)$/.test(dest.drawings_dir)) {
    const spec = findSlotSpec(character, dest.slot);
    if (spec) spec.views = true;
  }
  writeCharacterJson(projectDir, characterId, character);
  const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, dest, drawingName, new Set());
  const destAbs = path.join(projectDir, target.rel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(tmpOut, destAbs);
  setDrawingState(projectDir, characterId, `${dest.drawings_dir}/${target.name}`, "draft");
  return { ok: true, rel: target.rel, name: target.name, slot: dest.slot, view: vid, state: "draft" };
}

async function extractFaceFromClip(projectDir, globalAssetsDir, characterId, clipId, kind, options = {}) {
  const info = readClipIndex(projectDir, characterId, clipId);
  const want = String(kind || "mouth").toLowerCase() === "eyes" ? "eyes" : "mouth";
  const framesDir = path.join(clipDir(projectDir, characterId, clipId), "frames");
  if (!fs.existsSync(framesDir)) throw factoryError("Clip has no frames", "ENOENT");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const view = normalizeView((info.frames && info.frames[0] && info.frames[0].view) || "front");
  const dest = resolveLibraryDest(projectDir, character, characterId, want, view);
  const canvas = slotCanvas(character, dest);
  const head = findHeadBaseAbs(projectDir, globalAssetsDir, characterId, view);
  const outDir = path.join(clipDir(projectDir, characterId, clipId), `extract_${want}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  const args = [
    "extract-face",
    "--frames-dir",
    framesDir,
    "--out-dir",
    outDir,
    "--kind",
    want,
    "--canvas-w",
    String(canvas.w || 1024),
    "--canvas-h",
    String(canvas.h || 1024),
    "--index-json",
    path.join(clipDir(projectDir, characterId, clipId), "index.json"),
  ];
  if (head) args.push("--head-ref", head.abs);
  const extracted = await runPythonModule("compositor.factory_extract_face", args, options);
  const drawings = [];
  ensureSlot(character, dest);
  writeCharacterJson(projectDir, characterId, character);
  for (const item of extracted.drawings || []) {
    const src = path.join(outDir, item.rel);
    if (!fs.existsSync(src)) continue;
    const viewDest = resolveLibraryDest(projectDir, character, characterId, want, item.view || view);
    if (viewDest.drawings_dir && /_(left_side|right_side|left_34|right_34|back)$/.test(viewDest.drawings_dir)) {
      const spec = findSlotSpec(character, viewDest.slot);
      if (spec) spec.views = true;
    }
    const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, viewDest, item.name, new Set());
    const destAbs = path.join(projectDir, target.rel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(src, destAbs);
    setDrawingState(projectDir, characterId, `${viewDest.drawings_dir}/${target.name}`, "draft");
    drawings.push({
      view: item.view,
      name: target.name,
      rel: target.rel,
      score: item.score,
      index: item.index,
      state: "draft",
    });
  }
  writeCharacterJson(projectDir, characterId, character);
  return {
    ok: true,
    kind: want,
    drawings,
    missing: extracted.missing || [],
    scanned: extracted.scanned || 0,
    state: "draft",
  };
}

function neckYFromCharacter(character) {
  for (const name of ["head_base", "head", "torso"]) {
    const spec = character ? findSlotSpec(character, name) : null;
    const pivot = spec && spec.canvas && spec.canvas.pivot;
    if (pivot && Number.isFinite(Number(pivot.y))) return Math.round(Number(pivot.y));
  }
  return 457;
}

async function tickLibraryClip(projectDir, globalAssetsDir, characterId, clipId, options = {}) {
  const info = readClipIndex(projectDir, characterId, clipId);
  if (info.ticked && info.actionId) {
    return { ok: true, actionId: info.actionId, frames: info.frameCount || (info.frames || []).length, already: true };
  }
  const frames = Array.isArray(info.frames) ? info.frames : [];
  if (!frames.length) throw factoryError("Clip has no frames.", "EINVAL");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const kind = info.kind === "head" ? "head" : "body";
  const view = normalizeView((frames[0] && frames[0].view) || info.view || "front");
  const dest =
    kind === "head"
      ? resolveLibraryDest(projectDir, character, characterId, "head_base", view)
      : resolveLibraryDest(
          projectDir,
          character,
          characterId,
          findSlotSpec(character, "body") ? "body" : "torso",
          view
        );
  const canvas = slotCanvas(character, dest);
  const indices = frames.map((item) => Number(item.index)).filter((n) => Number.isFinite(n));
  const framesDir = path.join(clipDir(projectDir, characterId, clipId), "frames");
  const alignedDir = path.join(clipDir(projectDir, characterId, clipId), "aligned");
  fs.rmSync(alignedDir, { recursive: true, force: true });
  fs.mkdirSync(alignedDir, { recursive: true });
  const actionBase = `${slugClipId(info.filename || clipId)}_${kind === "head" ? "head" : "shot"}`.replace(/^(walk|run)_/, "act_");
  const actionId = uniqueActionId(projectDir, characterId, actionBase);
  const names = drawingNames(actionId, indices.length);
  const drawings = [];
  const problems = [];

  if (kind === "body" && indices.length >= 2) {
    const args = [
      "build",
      "--keyed-dir",
      framesDir,
      "--out-dir",
      alignedDir,
      "--indices",
      indices.join(","),
      "--canvas-w",
      String(canvas.w || 1024),
      "--canvas-h",
      String(canvas.h || 1024),
      "--neck-y",
      String(neckYFromCharacter(character)),
    ];
    const torsoRef = findTorsoRef(projectDir, characterId, view);
    const legsRef = findLegsRef(projectDir, characterId, view);
    if (torsoRef) args.push("--torso-ref", torsoRef);
    if (legsRef) args.push("--legs-ref", legsRef);
    const heads = collectHeadFrames(projectDir, characterId);
    if (heads.length) {
      const clipHeads = heads.filter((item) => item.clipId === heads[0].clipId);
      args.push("--head-dir", path.dirname(clipHeads[0].path));
      args.push("--head-indices", clipHeads.map((item) => item.index).join(","));
      args.push("--head-yaws", clipHeads.map((item) => item.yaw).join(","));
    }
    const built = await runPythonModule("compositor.factory_import_mp4", args, options);
    problems.push(...(built.problems || []));
    for (let i = 0; i < indices.length; i += 1) {
      const row = (built.written || [])[i];
      if (!row || !row.src || !fs.existsSync(row.src)) continue;
      drawings.push({ name: names[i], path: row.src });
    }
  } else {
    const head = kind === "head" ? findHeadBaseAbs(projectDir, globalAssetsDir, characterId, view) : null;
    const refs = {
      head: head && head.abs,
      torso: kind === "body" ? findTorsoRef(projectDir, characterId, view) : null,
      legs: kind === "body" ? findLegsRef(projectDir, characterId, view) : null,
      align: head && head.abs,
      neckY: neckYFromCharacter(character),
    };
    for (let i = 0; i < indices.length; i += 1) {
      const src = path.join(framesDir, `frame_${String(indices[i]).padStart(4, "0")}.png`);
      if (!fs.existsSync(src)) continue;
      const out = path.join(alignedDir, `${names[i]}.png`);
      const fitDest = { ...dest, canonical: kind === "head" ? "head_base" : dest.canonical || dest.slot };
      await fitLibrarySource(src, out, fitDest, canvas, refs, options);
      if (fs.existsSync(out)) drawings.push({ name: names[i], path: out });
    }
  }
  if (!drawings.length) throw factoryError("Could not fit frames from this clip.", "EINVAL");

  ensureSlot(character, dest);
  writeCharacterJson(projectDir, characterId, character);
  const taken = new Set();
  const writtenNames = [];
  for (const drawing of drawings) {
    const target = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, dest, drawing.name, taken);
    taken.add(target.rel);
    const abs = path.join(projectDir, target.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(drawing.path, abs);
    setDrawingState(projectDir, characterId, `${dest.drawings_dir}/${target.name}`, "draft");
    writtenNames.push(target.name);
  }

  const isHead = kind === "head";
  const setSlots = isHead ? {} : walkSetSlots(character, dest, { keepHead: true });
  const action = {
    id: actionId,
    view,
    fps: 12,
    frames: writtenNames.length,
    slot_frames: { [dest.slot]: writtenNames },
    hide_children: !isHead,
    category: info.category || inferCategoryFromAction({ id: actionId }),
    libraryClip: clipId,
    warnings: [...new Set([...(info.warnings || []), ...problems])],
  };
  if (!isHead) {
    action.bob = walkBob(writtenNames.length);
    action.distance_per_cycle = 96;
    action.faces = view === "left_side" ? "left" : "right";
  }
  if (Object.keys(setSlots).length) action.set_slots = setSlots;
  writeActionJson(projectDir, characterId, actionId, action);
  writeClipIndex(projectDir, characterId, clipId, {
    ...info,
    ticked: true,
    actionId,
    tickedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    actionId,
    frames: writtenNames.length,
    still: writtenNames.length <= 1,
    category: action.category,
    drawings: writtenNames,
    state: "draft",
  };
}

function describeLibrary(projectDir, globalAssetsDir, characterId) {
  findCharacter(projectDir, globalAssetsDir, characterId);
  return listLibraryClips(projectDir, characterId);
}

module.exports = {
  DEFAULT_CATEGORIES,
  slugClipId,
  uniqueClipId,
  libraryRoot,
  clipDir,
  listCategories,
  addCategory,
  listLibraryClips,
  describeLibrary,
  readClipIndex,
  writeClipIndex,
  patchClipCategory,
  collectHeadFrames,
  resolveLibraryFile,
  inferCategoryFromAction,
  patchActionCategory,
  actionFrameList,
  flagActionFrame,
  deleteActionFrame,
  saveFrameToSlot,
  saveLibraryFrameToSlot,
  extractFaceFromClip,
  tickLibraryClip,
  readActionJson,
  writeActionJson,
};
