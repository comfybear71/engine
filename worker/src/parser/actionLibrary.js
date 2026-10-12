"use strict";

/**
 * Character action cycles (`characters/<id>/actions/<action>.json`).
 * Project-local files override show/global the same way character.json does.
 */

const { ScriptError } = require("./errors");
const { HEAD_VIEWS } = require("./actionTag");
const assetLibrary = require("./assetLibrary");

const FACES = new Set(["left", "right"]);

function loadAction(projectDir, globalAssetsDir, characterId, actionId, options) {
  return assetLibrary.loadAction(projectDir, globalAssetsDir, characterId, actionId, options);
}

function listActionIds(projectDir, globalAssetsDir, characterId, options) {
  return assetLibrary.listActionIds(projectDir, globalAssetsDir, characterId, options);
}

function _childIds(config) {
  return ((config && config.children) || []).map((c) => c.id);
}

function _findChild(config, id) {
  const children = (config && config.children) || [];
  return (
    children.find((c) => c.id === id) ||
    children.find((c) => c.id.toLowerCase() === String(id).toLowerCase()) ||
    null
  );
}

function _findSlot(config, slotName) {
  if (config.slots && config.slots[slotName]) {
    return config.slots[slotName];
  }
  for (const child of config.children || []) {
    if (child.slots && child.slots[slotName]) return child.slots[slotName];
  }
  return null;
}

function _viewFolderPrefix(drawingsDir, slotName) {
  const dir = String(drawingsDir || slotName || "");
  for (const view of HEAD_VIEWS) {
    const suffix = `_${view}`;
    if (dir.endsWith(suffix)) return dir.slice(0, -suffix.length);
  }
  return dir || slotName;
}

/**
 * Drawing names on a slot, including views:true folders (`<slot>_<view>/`).
 * Same lookup the parser uses when scanning images_by_view.
 */
function slotDrawingNames(projectDir, globalAssetsDir, characterId, slotName, slotConfig) {
  const names = new Set();
  const addDir = (relDir) => {
    if (!relDir) return;
    const scanned = assetLibrary.scanDrawingsDir(
      projectDir,
      globalAssetsDir,
      `characters/${characterId}/${relDir}`
    );
    for (const name of scanned.keys()) names.add(name);
  };
  const baseDir = (slotConfig && slotConfig.drawings_dir) || slotName;
  const prefix = _viewFolderPrefix(baseDir, slotName);
  addDir(baseDir);
  addDir(`${prefix}_front`);
  for (const view of HEAD_VIEWS) {
    if (view === "front") continue;
    addDir(`${prefix}_${view}`);
  }
  return names;
}

function _asFiniteNumber(value, label, lineNumber) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ScriptError(lineNumber, `Action ${label} must be a number.`);
  }
  return n;
}

/**
 * Validate a loaded action against the character's children and slot drawings.
 * Errors cite ``lineNumber`` (the script line that named the action).
 */
function validateAction(action, { characterId, config, lineNumber, projectDir, globalAssetsDir, actionId }) {
  const name = (config && (config.display_name || config.id)) || characterId;
  const id = actionId || (action && action.id) || "action";

  if (!action || typeof action !== "object") {
    throw new ScriptError(lineNumber, `Unknown action "${id}" on ${name}.`);
  }

  const frames = _asFiniteNumber(action.frames, `"${id}" frames`, lineNumber);
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new ScriptError(lineNumber, `Action "${id}" frames must be an integer greater than 0.`);
  }
  const fps = _asFiniteNumber(action.fps, `"${id}" fps`, lineNumber);
  if (!(fps > 0)) {
    throw new ScriptError(lineNumber, `Action "${id}" fps must be greater than 0.`);
  }
  const distance = _asFiniteNumber(action.distance_per_cycle, `"${id}" distance_per_cycle`, lineNumber);
  if (!(distance > 0)) {
    throw new ScriptError(lineNumber, `Action "${id}" distance_per_cycle must be greater than 0.`);
  }

  const view = action.view != null ? String(action.view) : "";
  if (view && !HEAD_VIEWS.includes(view)) {
    throw new ScriptError(
      lineNumber,
      `Action "${id}" view "${view}" is invalid. Expected: ${HEAD_VIEWS.join(", ")}.`
    );
  }
  const faces = action.faces != null ? String(action.faces).toLowerCase() : "right";
  if (!FACES.has(faces)) {
    throw new ScriptError(lineNumber, `Action "${id}" faces must be "left" or "right".`);
  }

  const joints = action.joints && typeof action.joints === "object" ? action.joints : {};
  const available = _childIds(config);
  for (const [jointId, angles] of Object.entries(joints)) {
    if (!_findChild(config, jointId)) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" joint "${jointId}" is not a child on ${name}. Available: ${available.join(", ") || "(none)"}`
      );
    }
    if (!Array.isArray(angles) || angles.length !== frames) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" joint "${jointId}" length ${Array.isArray(angles) ? angles.length : 0} != frames ${frames}.`
      );
    }
    for (let i = 0; i < angles.length; i++) {
      if (!Number.isFinite(Number(angles[i]))) {
        throw new ScriptError(lineNumber, `Action "${id}" joint "${jointId}"[${i}] is not a number.`);
      }
    }
  }

  const bob = action.bob;
  if (bob != null) {
    if (!Array.isArray(bob) || bob.length !== frames) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" bob length ${Array.isArray(bob) ? bob.length : 0} != frames ${frames}.`
      );
    }
    for (let i = 0; i < bob.length; i++) {
      if (!Number.isFinite(Number(bob[i]))) {
        throw new ScriptError(lineNumber, `Action "${id}" bob[${i}] is not a number.`);
      }
    }
  }

  const setSlots = action.set_slots && typeof action.set_slots === "object" ? action.set_slots : {};
  for (const [slotName, drawing] of Object.entries(setSlots)) {
    const slotConfig = _findSlot(config, slotName);
    if (!slotConfig) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" set_slots "${slotName}" is not a slot on ${name}.`
      );
    }
    const drawings = slotDrawingNames(projectDir, globalAssetsDir, characterId, slotName, slotConfig);
    const drawingName = String(drawing == null ? "" : drawing).trim();
    if (!drawingName || !drawings.has(drawingName)) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" set_slots ${slotName}="${drawingName || ""}" is not a drawing. Available: ${[...drawings].join(", ") || "(none)"}`
      );
    }
  }

  return {
    id: action.id || id,
    view: view || null,
    faces,
    fps,
    frames,
    distance_per_cycle: distance,
    set_slots: setSlots,
    joints,
    bob: Array.isArray(bob) ? bob.map(Number) : null,
  };
}

function loadAndValidateAction(projectDir, globalAssetsDir, characterId, actionId, extras) {
  const raw = loadAction(projectDir, globalAssetsDir, characterId, actionId);
  if (!raw) {
    const known = listActionIds(projectDir, globalAssetsDir, characterId);
    const name = (extras.config && (extras.config.display_name || extras.config.id)) || characterId;
    throw new ScriptError(
      extras.lineNumber,
      `Unknown action "${actionId}" on ${name}. Available: ${known.join(", ") || "(none)"}`
    );
  }
  return validateAction(raw, { ...extras, characterId, actionId, projectDir, globalAssetsDir });
}

module.exports = {
  loadAction,
  listActionIds,
  validateAction,
  loadAndValidateAction,
  slotDrawingNames,
  FACES,
  _findChild,
  _findSlot,
};
