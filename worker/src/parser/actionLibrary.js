"use strict";

/**
 * Character action cycles (`characters/<id>/actions/<action>.json`).
 * Project-local files override show/global the same way character.json does.
 */

const { ScriptError } = require("./errors");
const { HEAD_VIEWS } = require("./actionTag");
const assetLibrary = require("./assetLibrary");

const FACES = new Set(["left", "right"]);
const ACTION_ENDS = new Set(["restore", "hold"]);
const PROP_PLACEHOLDER = "{prop}";

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

function resolveActionDrawing(slotName, drawing, drawings) {
  const { resolveDrawingAlias } = require("../factoryStandard");
  const raw = String(drawing == null ? "" : drawing).trim();
  if (!raw || raw.toLowerCase() === "none") return raw || "";
  if (drawings && drawings.has(raw)) return raw;
  const aliased = resolveDrawingAlias(slotName, raw);
  if (aliased && drawings && drawings.has(aliased)) return aliased;
  return raw;
}

function _findSlot(config, slotName) {
  const { resolveSlotName } = require("../factoryStandard");
  const wanted = resolveSlotName(slotName, config);
  if (config.slots && config.slots[wanted]) {
    return config.slots[wanted];
  }
  if (config.slots && config.slots[slotName]) {
    return config.slots[slotName];
  }
  for (const child of config.children || []) {
    if (child.slots && child.slots[wanted]) return child.slots[wanted];
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
  let distance = null;
  if (action.distance_per_cycle != null && action.distance_per_cycle !== "") {
    distance = _asFiniteNumber(action.distance_per_cycle, `"${id}" distance_per_cycle`, lineNumber);
    if (!(distance > 0)) {
      throw new ScriptError(lineNumber, `Action "${id}" distance_per_cycle must be greater than 0.`);
    }
  }

  const view = action.view != null ? String(action.view) : "";
  if (view && !HEAD_VIEWS.includes(view)) {
    throw new ScriptError(
      lineNumber,
      `Action "${id}" view "${view}" is invalid. Expected: ${HEAD_VIEWS.join(", ")}.`
    );
  }
  let views = null;
  if (action.views != null) {
    if (!Array.isArray(action.views) || action.views.length !== frames) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" views length ${Array.isArray(action.views) ? action.views.length : 0} != frames ${frames}.`
      );
    }
    views = action.views.map((item, i) => {
      const v = String(item == null ? "" : item).trim().toLowerCase();
      if (!HEAD_VIEWS.includes(v)) {
        throw new ScriptError(
          lineNumber,
          `Action "${id}" views[${i}] "${item}" is invalid. Expected: ${HEAD_VIEWS.join(", ")}.`
        );
      }
      return v;
    });
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

  const groupAngles = action.groups && typeof action.groups === "object" ? action.groups : {};
  const charGroups = (config && config.groups && typeof config.groups === "object") ? config.groups : {};
  const availableGroups = Object.keys(charGroups).filter((g) => Array.isArray(charGroups[g]) && charGroups[g].length);
  for (const [groupName, angles] of Object.entries(groupAngles)) {
    const known = availableGroups.find((g) => g === groupName) || availableGroups.find((g) => g.toLowerCase() === String(groupName).toLowerCase());
    if (!known) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" group "${groupName}" is not a group on ${name}. Available: ${availableGroups.join(", ") || "(none)"}`
      );
    }
    if (!Array.isArray(angles) || angles.length !== frames) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" group "${groupName}" length ${Array.isArray(angles) ? angles.length : 0} != frames ${frames}.`
      );
    }
    for (let i = 0; i < angles.length; i++) {
      if (!Number.isFinite(Number(angles[i]))) {
        throw new ScriptError(lineNumber, `Action "${id}" group "${groupName}"[${i}] is not a number.`);
      }
    }
  }

  const setSlots = action.set_slots && typeof action.set_slots === "object" && !Array.isArray(action.set_slots)
    ? action.set_slots
    : {};
  for (const [slotName, drawing] of Object.entries(setSlots)) {
    const slotConfig = _findSlot(config, slotName);
    if (!slotConfig) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" set_slots "${slotName}" is not a slot on ${name}.`
      );
    }
    const drawings = slotDrawingNames(projectDir, globalAssetsDir, characterId, slotName, slotConfig);
    const drawingName = resolveActionDrawing(slotName, drawing, drawings);
    if (drawingName.toLowerCase() === "none") {
      setSlots[slotName] = "none";
      continue;
    }
    if (!drawingName || !drawings.has(drawingName)) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" set_slots ${slotName}="${drawingName || ""}" is not a drawing. Available: ${[...drawings].join(", ") || "(none)"}`
      );
    }
  }

  const endRaw = action.end != null && action.end !== "" ? String(action.end).trim().toLowerCase() : "restore";
  if (!ACTION_ENDS.has(endRaw)) {
    throw new ScriptError(
      lineNumber,
      `Action "${id}" end "${action.end}" is invalid. Expected: restore, hold.`
    );
  }

  let bodyRotation = null;
  if (action.body_rotation != null) {
    if (!Array.isArray(action.body_rotation) || action.body_rotation.length !== frames) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" body_rotation length ${Array.isArray(action.body_rotation) ? action.body_rotation.length : 0} != frames ${frames}.`
      );
    }
    bodyRotation = action.body_rotation.map((item, i) => {
      if (!Number.isFinite(Number(item))) {
        throw new ScriptError(lineNumber, `Action "${id}" body_rotation[${i}] is not a number.`);
      }
      return Number(item);
    });
  }

  let propEvents = [];
  if (action.prop_events != null) {
    if (!Array.isArray(action.prop_events)) {
      throw new ScriptError(lineNumber, `Action "${id}" prop_events must be an array.`);
    }
    propEvents = action.prop_events.map((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ScriptError(lineNumber, `Action "${id}" prop_events[${i}] must be an object.`);
      }
      const frame = Number(item.frame);
      if (!Number.isInteger(frame) || frame < 0 || frame >= frames) {
        throw new ScriptError(
          lineNumber,
          `Action "${id}" prop_events[${i}].frame must be an integer in 0..${frames - 1}.`
        );
      }
      const hasDrawing = item.drawing != null && String(item.drawing).trim() !== "";
      const hasZ = item.z != null && item.z !== "";
      if (!hasDrawing && !hasZ) {
        throw new ScriptError(
          lineNumber,
          `Action "${id}" prop_events[${i}] needs drawing= and/or z=.`
        );
      }
      const ev = { frame };
      if (item.prop != null && String(item.prop).trim() !== "") {
        ev.prop = String(item.prop).trim();
      }
      if (hasDrawing) ev.drawing = String(item.drawing).trim();
      if (hasZ) {
        const z = Number(item.z);
        if (!Number.isFinite(z)) {
          throw new ScriptError(lineNumber, `Action "${id}" prop_events[${i}].z is not a number.`);
        }
        ev.z = z;
      }
      return ev;
    });
  }

  let slotFrames = {};
  if (action.slot_frames != null) {
    if (typeof action.slot_frames !== "object" || Array.isArray(action.slot_frames)) {
      throw new ScriptError(
        lineNumber,
        `Action "${id}" slot_frames must be an object of slot name -> drawings array.`
      );
    }
    for (const [slotName, items] of Object.entries(action.slot_frames)) {
      const slotConfig = _findSlot(config, slotName);
      if (!slotConfig) {
        throw new ScriptError(
          lineNumber,
          `Action "${id}" slot_frames "${slotName}" is not a slot on ${name}.`
        );
      }
      if (!Array.isArray(items) || items.length !== frames) {
        throw new ScriptError(
          lineNumber,
          `Action "${id}" slot_frames "${slotName}" length ${Array.isArray(items) ? items.length : 0} != frames ${frames}.`
        );
      }
      const drawings = slotDrawingNames(projectDir, globalAssetsDir, characterId, slotName, slotConfig);
      const available = [...drawings].join(", ") || "(none)";
      slotFrames[slotName] = items.map((item, i) => {
        const drawingName = resolveActionDrawing(slotName, item, drawings);
        if (drawingName.toLowerCase() === "none") return "none";
        if (!drawingName || !drawings.has(drawingName)) {
          throw new ScriptError(
            lineNumber,
            `Action "${id}" slot_frames ${slotName}[${i}]="${drawingName || ""}" is not a drawing. Available: ${available}`
          );
        }
        return drawingName;
      });
    }
  }

  const groups = {};
  for (const [groupName, angles] of Object.entries(groupAngles)) {
    groups[groupName] = angles.map(Number);
  }

  return {
    id: action.id || id,
    view: view || null,
    views,
    faces,
    fps,
    frames,
    distance_per_cycle: distance,
    set_slots: setSlots,
    slot_frames: slotFrames,
    joints,
    groups,
    bob: Array.isArray(bob) ? bob.map(Number) : null,
    body_rotation: bodyRotation,
    prop_events: propEvents,
    hide_children: Boolean(action.hide_children),
    end: endRaw,
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
  ACTION_ENDS,
  PROP_PLACEHOLDER,
  _findChild,
  _findSlot,
  _validateChildGraph,
};

function _validateChildGraph(children, { lineNumber, name } = {}) {
  const list = Array.isArray(children) ? children : [];
  const ids = list.map((c) => c && c.id).filter(Boolean);
  const idSet = new Set(ids);
  const parents = new Map();
  for (const child of list) {
    if (!child || !child.parent) continue;
    const parent = String(child.parent);
    if (!idSet.has(parent)) {
      const err = new ScriptError(
        lineNumber,
        `${name || "Character"} child "${child.id}" parent "${parent}" does not exist.`
      );
      throw err;
    }
    if (parent === child.id) {
      throw new ScriptError(lineNumber, `${name || "Character"} child "${child.id}" cannot be its own parent.`);
    }
    parents.set(child.id, parent);
  }
  for (const childId of parents.keys()) {
    const seen = new Set();
    let current = childId;
    while (parents.has(current)) {
      if (seen.has(current)) {
        throw new ScriptError(lineNumber, `${name || "Character"} child "${childId}" parent chain cycles.`);
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  return true;
}
