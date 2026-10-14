"use strict";

/**
 * Per-character action pack dictionary: imported clips live in
 * characters/<id>/library/<clip>/frames + index.json.
 */

const fs = require("fs");
const path = require("path");

const { characterDir, findSlotSpec, readWritableCharacter, writeCharacterJson } = require("./characterLocal");
const { isSafeFolderName } = require("./studioProjects");
const { uniqueWriteTarget } = require("./assetIngest");
const { setDrawingState } = require("./characterStatus");
const { factoryError, findCharacter } = require("./factoryJob");
const factoryJob = require("./factoryJob");

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
  readActionJson,
  writeActionJson,
};
