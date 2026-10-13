"use strict";

/**
 * Standard rig v1 for the Character factory Assets page.
 * Expected folders follow <slot>_<view>/ (front may also use the bare slot folder).
 * Missing = listed here for the open view, but no file on disk.
 */

const FACTORY_VIEWS = ["front", "left_34", "right_34", "left_side", "right_side", "back"];

const VIEW_TAB_LABELS = {
  front: "Front",
  left_34: "L 3/4",
  right_34: "R 3/4",
  left_side: "Side L",
  right_side: "Side R",
  back: "Back",
};

const HEAD_OVERLAY_VIEWS = ["front", "left_34", "right_34", "left_side", "right_side"];

const STATUS_STATES = new Set(["ticked", "locked", "draft"]);
const STATUS_STATE_ALIASES = {
  ticked: "ticked",
  locked: "locked",
  draft: "draft",
  approved: "ticked",
  ok: "ticked",
  yes: "ticked",
  reviewed: "ticked",
  tick: "ticked",
  done: "ticked",
};

const STANDARD_SLOTS = [
  {
    slot: "head_base",
    aliases: ["head", "head_base"],
    label: "Head",
    drawings: ["neutral"],
    views: FACTORY_VIEWS,
  },
  {
    slot: "eyes",
    aliases: ["eyes"],
    label: "Eyes",
    drawings: ["open", "half", "closed", "surprised"],
    optional: ["look_left", "look_right", "down"],
    views: HEAD_OVERLAY_VIEWS,
  },
  {
    slot: "mouth",
    aliases: ["mouth"],
    label: "Mouth",
    drawings: ["A", "B", "C", "D", "E", "F", "G", "H", "X"],
    views: HEAD_OVERLAY_VIEWS,
  },
  {
    slot: "torso",
    aliases: ["torso", "body"],
    label: "Torso",
    drawings: ["neutral", "walk", "armless_L", "armless_R"],
    views: FACTORY_VIEWS,
  },
  {
    slot: "legs",
    aliases: ["legs"],
    label: "Legs",
    drawings: ["none", "L_forward", "R_forward", "passing", "lift_screenL", "lift_screenR"],
    views: ["front", "back"],
  },
  {
    slot: "hand",
    aliases: ["hand", "hands", "right_hand", "left_hand", "hand_L", "hand_R"],
    label: "Hands",
    drawings: ["open", "palm", "point", "fist", "mic"],
    views: ["front"],
  },
];

const FRONT_ARM_PIECES = ["arm_upper", "arm_lower", "overlay"];

function normalizeView(view) {
  const id = String(view || "front")
    .trim()
    .toLowerCase();
  return FACTORY_VIEWS.includes(id) ? id : "front";
}

function viewTabLabel(view) {
  const id = normalizeView(view);
  return VIEW_TAB_LABELS[id] || id;
}

function stripViewSuffix(dir) {
  const raw = String(dir || "");
  for (const view of FACTORY_VIEWS) {
    const suffix = `_${view}`;
    if (raw.endsWith(suffix)) return raw.slice(0, -suffix.length);
  }
  if (raw.endsWith("_front")) return raw.slice(0, -6);
  return raw;
}

function standardForSlot(slotName) {
  const name = String(slotName || "").toLowerCase();
  return (
    STANDARD_SLOTS.find((spec) => spec.slot === name || spec.aliases.includes(name)) ||
    STANDARD_SLOTS.find((spec) => name.startsWith(`${spec.slot}_`)) ||
    null
  );
}

function expectedDrawings(slotName, view, { includeOptional = true } = {}) {
  const spec = standardForSlot(slotName);
  if (!spec) return [];
  const id = normalizeView(view);
  if (!spec.views.includes(id)) return [];
  const names = [...spec.drawings];
  if (includeOptional && spec.optional) names.push(...spec.optional);
  return names;
}

function expectedDrawingsDir(slotName, view, baseDir) {
  const prefix = stripViewSuffix(baseDir || slotName);
  const id = normalizeView(view);
  if (id === "front") return prefix;
  return `${prefix}_${id}`;
}

function candidateDrawingsDirs(slotName, view, baseDir) {
  const prefix = stripViewSuffix(baseDir || slotName);
  const id = normalizeView(view);
  if (id === "front") return [prefix, `${prefix}_front`];
  return [`${prefix}_${id}`];
}

function statusKey(slotOrDir, drawing) {
  return `${String(slotOrDir || "").replace(/\\/g, "/")}/${String(drawing || "")}`;
}

function stripDrawingExt(name) {
  return String(name || "").replace(/\.(png|webp|jpe?g|gif)$/i, "");
}

function parseStatusKey(key) {
  const raw = String(key || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const drawing = stripDrawingExt(parts[parts.length - 1]);
  if (!drawing) return null;
  let slot = parts.slice(0, -1).join("/");
  if (slot.startsWith("characters/")) {
    const rest = slot.split("/").slice(2).join("/");
    if (rest) slot = rest;
  }
  return { slot, drawing };
}

function isStatusState(value) {
  return STATUS_STATES.has(value);
}

function normalizeStatusState(value) {
  if (value === true) return "ticked";
  if (typeof value !== "string") return null;
  const mapped = STATUS_STATE_ALIASES[value.trim().toLowerCase()];
  return mapped || null;
}

function statusKeyAliases(key) {
  const parsed = parseStatusKey(key);
  const out = new Set();
  const raw = String(key || "").replace(/\\/g, "/");
  if (raw) out.add(raw);
  if (!parsed) return [...out];
  const drawing = parsed.drawing;
  const slot = parsed.slot;
  const base = stripViewSuffix(slot);
  out.add(`${slot}/${drawing}`);
  out.add(`${base}/${drawing}`);
  for (const view of FACTORY_VIEWS) {
    out.add(`${base}_${view}/${drawing}`);
    out.add(`${base}/${view}/${drawing}`);
  }
  return [...out];
}

function lookupStatusState(statusMap, key) {
  if (!statusMap || !key) return null;
  if (isStatusState(statusMap[key])) return statusMap[key];
  for (const alias of statusKeyAliases(key)) {
    const raw = statusMap[alias];
    if (isStatusState(raw)) return raw;
    const normalized = normalizeStatusState(raw);
    if (normalized) return normalized;
  }
  const parsed = parseStatusKey(key);
  if (!parsed) return null;
  const base = stripViewSuffix(parsed.slot);
  for (const [stored, value] of Object.entries(statusMap)) {
    const hit = parseStatusKey(stored);
    if (!hit || hit.drawing !== parsed.drawing) continue;
    if (stripViewSuffix(hit.slot) !== base) continue;
    const state = isStatusState(value) ? value : normalizeStatusState(value);
    if (state) return state;
  }
  return null;
}

function drawingBadge(statusMap, key, hasFile, expected) {
  if (!hasFile) return expected ? "missing" : null;
  const raw = lookupStatusState(statusMap, key);
  if (isStatusState(raw)) return raw;
  return "draft";
}

function childText(child) {
  return `${(child && child.id) || ""} ${(child && child.asset) || ""}`.toLowerCase();
}

function childSideSuffix(child) {
  const id = String((child && child.id) || "").toLowerCase();
  if (/(?:^|_)l(?:_|$)|left/.test(id)) return " L";
  if (/(?:^|_)r(?:_|$)|right/.test(id)) return " R";
  return "";
}

function isClothingOverlay(text) {
  return /shirt|shorts|clothing|tie|belt|cape|skirt|jacket|vest/.test(text);
}

function isOverlayPiece(child) {
  const text = childText(child);
  if (/arm|hand|leg|sleeve|shoulder|thigh|shin/.test(text)) return false;
  return /torso_rig|ov_|overlay|cape/.test(text) || isClothingOverlay(text);
}

function childRowLabel(child) {
  const text = childText(child);
  const side = childSideSuffix(child);
  if (/hand/.test(text) && !/arm/.test(text)) return "Hands";
  if (/leg|thigh|shin|boot/.test(text) && !/arm/.test(text)) return `Legs${side}`.trimEnd();
  if (isOverlayPiece(child)) return "Overlays";
  if (/torso_rig|\btorso\b|\bbody\b/.test(text) && !/arm|hand|leg/.test(text)) return "Torso";
  if (/arm|forearm|sleeve|shoulder/.test(text)) return `Arm rig${side}`.trimEnd();
  if (/head/.test(text)) return "Head";
  return (child && (child.id || child.asset)) || "Piece";
}

function isFaceOverlaySlot(slotName) {
  const spec = standardForSlot(slotName);
  return Boolean(spec && (spec.slot === "eyes" || spec.slot === "mouth"));
}

function rowGroupLabel(slotName, owner) {
  const spec = standardForSlot(slotName);
  if (spec) return spec.label;
  return slotRowLabel(slotName, owner);
}

function slotRowLabel(slotName, owner) {
  const spec = standardForSlot(slotName);
  if (spec) return spec.label;
  if (owner) return `${slotName}`;
  return slotName;
}

function countBadges(drawings) {
  const counts = { ticked: 0, locked: 0, draft: 0, missing: 0 };
  for (const drawing of drawings || []) {
    const badge = drawing.badge || drawing.state;
    if (badge && counts[badge] != null) counts[badge] += 1;
  }
  return counts;
}

function sumCounts(rows) {
  const counts = { ticked: 0, locked: 0, draft: 0, missing: 0 };
  for (const row of rows || []) {
    const next = countBadges(row.drawings);
    for (const key of Object.keys(counts)) counts[key] += next[key];
  }
  return counts;
}

function namedPivotPoint(pivot, canvas) {
  const w = (canvas && canvas.w) || 1024;
  const h = (canvas && canvas.h) || 1024;
  if (pivot && typeof pivot === "object" && Number.isFinite(Number(pivot.x)) && Number.isFinite(Number(pivot.y))) {
    return { x: Number(pivot.x), y: Number(pivot.y) };
  }
  const name = String(pivot || "center")
    .toLowerCase()
    .replace(/centre/g, "center");
  const x = name.includes("left") ? 0 : name.includes("right") ? w : w / 2;
  const y = name.includes("top") ? 0 : name.includes("bottom") ? h : h / 2;
  return { x, y };
}

function defaultFactoryCanvas(character) {
  const slots = (character && character.slots) || {};
  for (const spec of Object.values(slots)) {
    if (spec && spec.canvas && spec.canvas.w && spec.canvas.h) {
      const pivot = (spec.canvas.pivot && namedPivotPoint(spec.canvas.pivot, spec.canvas)) || {
        x: 509,
        y: 457,
      };
      return { w: Number(spec.canvas.w), h: Number(spec.canvas.h), pivot };
    }
  }
  return { w: 1024, h: 1024, pivot: { x: 509, y: 457 } };
}

module.exports = {
  FACTORY_VIEWS,
  VIEW_TAB_LABELS,
  HEAD_OVERLAY_VIEWS,
  STANDARD_SLOTS,
  FRONT_ARM_PIECES,
  STATUS_STATES,
  STATUS_STATE_ALIASES,
  normalizeView,
  viewTabLabel,
  stripViewSuffix,
  standardForSlot,
  expectedDrawings,
  expectedDrawingsDir,
  candidateDrawingsDirs,
  statusKey,
  parseStatusKey,
  isStatusState,
  normalizeStatusState,
  statusKeyAliases,
  lookupStatusState,
  drawingBadge,
  isOverlayPiece,
  childRowLabel,
  isFaceOverlaySlot,
  rowGroupLabel,
  slotRowLabel,
  countBadges,
  sumCounts,
  namedPivotPoint,
  defaultFactoryCanvas,
};
