"use strict";

/**
 * Per-character factory review state. Studio writes only
 * characters/<id>/status.json in the project folder:
 *   { "<slot>/<drawing>": "ticked|locked|draft", "_redos": { "<slot>/<drawing>": "note" } }
 * Missing is not stored — it is computed from the standard rig vs files on disk.
 */

const fs = require("fs");
const path = require("path");

const {
  loadCharacter,
  loadAction,
  scanDrawingsDir,
  resolveAsset,
  listActionIds,
  listKnownCharacterIds,
  isProjectIndependent,
} = require("./parser/assetLibrary");
const { isSafeFolderName } = require("./studioProjects");
const { characterDir } = require("./characterLocal");
const { discoverSlotViews, findDrawingUsages } = require("./assetEditor");
const { decodeRgbaFile, alphaBounds } = require("./factoryThumb");
const {
  FACTORY_VIEWS,
  normalizeView,
  viewTabLabel,
  expectedDrawings,
  candidateDrawingsDirs,
  statusKey,
  parseStatusKey,
  isStatusState,
  normalizeStatusState,
  lookupStatusState,
  drawingBadge,
  childRowLabel,
  isFaceOverlaySlot,
  slotRowLabel,
  sumCounts,
  namedPivotPoint,
  defaultFactoryCanvas,
  FRONT_ARM_PIECES,
} = require("./factoryStandard");

const STATUS_FILENAME = "status.json";
const REDOS_KEY = "_redos";
const STATUS_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

function statusError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function assertCharacterId(characterId) {
  if (!isSafeFolderName(characterId)) throw statusError("Invalid character id");
  return characterId;
}

function assertStatusKey(key) {
  const raw = String(key || "").replace(/\\/g, "/");
  if (!STATUS_KEY.test(raw) || !parseStatusKey(raw)) throw statusError("Invalid status key");
  return raw;
}

function statusPath(projectDir, characterId) {
  return path.join(characterDir(projectDir, characterId), STATUS_FILENAME);
}

function emptyStatus() {
  return { drawings: {}, redos: {} };
}

function addStatusEntry(drawings, key, value) {
  const state = isStatusState(value) ? value : normalizeStatusState(value);
  const parsed = parseStatusKey(key);
  if (!state || !parsed) return;
  const canonical = statusKey(parsed.slot, parsed.drawing);
  if (!drawings[canonical]) drawings[canonical] = state;
  if (!drawings[key]) drawings[key] = state;
}

function collectStatusMap(raw, drawings, redos, prefix) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const [key, value] of Object.entries(raw)) {
    if (key === REDOS_KEY || key === "drawings" || key === "status" || key === "ticks") {
      if (value && typeof value === "object" && !Array.isArray(value)) collectStatusMap(value, drawings, redos, prefix);
      continue;
    }
    if (key === "redos" && value && typeof value === "object") {
      for (const [redoKey, note] of Object.entries(value)) {
        if (typeof note === "string" && parseStatusKey(redoKey)) redos[redoKey] = note;
      }
      continue;
    }
    const nextKey = prefix ? `${prefix}/${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nestedState = normalizeStatusState(value.state || value.status || value.badge);
      if (nestedState) addStatusEntry(drawings, nextKey, nestedState);
      else collectStatusMap(value, drawings, redos, nextKey);
      continue;
    }
    addStatusEntry(drawings, nextKey, value);
  }
}

function parseStatusFile(raw) {
  const drawings = {};
  const redos = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { drawings, redos };
  const extraRedos = raw[REDOS_KEY] && typeof raw[REDOS_KEY] === "object" ? raw[REDOS_KEY] : {};
  collectStatusMap(raw, drawings, redos, "");
  for (const [key, value] of Object.entries(extraRedos)) {
    if (typeof value === "string" && parseStatusKey(key)) redos[key] = value;
  }
  return { drawings, redos };
}

function serializeStatus(data) {
  const out = {};
  const drawings = (data && data.drawings) || {};
  const redos = (data && data.redos) || {};
  for (const [key, value] of Object.entries(drawings)) {
    if (isStatusState(value)) out[key] = value;
  }
  if (Object.keys(redos).length) out[REDOS_KEY] = { ...redos };
  return out;
}

function readJsonIfPresent(abs) {
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function mergeStatusData(into, extra) {
  if (!extra) return into;
  for (const [key, value] of Object.entries(extra.drawings || {})) {
    if (!into.drawings[key] && isStatusState(value)) into.drawings[key] = value;
  }
  for (const [key, value] of Object.entries(extra.redos || {})) {
    if (!into.redos[key] && typeof value === "string") into.redos[key] = value;
  }
  return into;
}

function readCharacterJsonTicks(projectDir, characterId) {
  const abs = path.join(characterDir(projectDir, characterId), "character.json");
  const raw = readJsonIfPresent(abs);
  const out = emptyStatus();
  if (!raw || typeof raw !== "object") return out;
  const slots = raw.slots && typeof raw.slots === "object" ? raw.slots : {};
  for (const [slotName, spec] of Object.entries(slots)) {
    const drawings = spec && spec.drawings && typeof spec.drawings === "object" ? spec.drawings : {};
    for (const [drawingName, meta] of Object.entries(drawings)) {
      if (!meta || typeof meta !== "object") continue;
      const state =
        normalizeStatusState(meta.status || meta.state || meta.badge) ||
        (meta.approved === true || meta.ticked === true ? "ticked" : null);
      if (state) addStatusEntry(out.drawings, statusKey(slotName, drawingName), state);
    }
  }
  return out;
}

function readStatus(projectDir, characterId) {
  assertCharacterId(characterId);
  const dir = characterDir(projectDir, characterId);
  const merged = emptyStatus();
  const files = [
    path.join(dir, STATUS_FILENAME),
    path.join(dir, "review.json"),
    path.join(dir, "approved.json"),
    path.join(dir, "ticks.json"),
    path.join(dir, "_review.json"),
    path.join(dir, "_review", "status.json"),
  ];
  for (const abs of files) {
    mergeStatusData(merged, parseStatusFile(readJsonIfPresent(abs)));
  }
  mergeStatusData(merged, readCharacterJsonTicks(projectDir, characterId));
  return merged;
}

function writeStatus(projectDir, characterId, data) {
  assertCharacterId(characterId);
  const dir = characterDir(projectDir, characterId);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(serializeStatus(data), null, 2)}\n`;
  fs.writeFileSync(statusPath(projectDir, characterId), body);
  return readStatus(projectDir, characterId);
}

function setDrawingState(projectDir, characterId, key, state) {
  const k = assertStatusKey(key);
  if (!isStatusState(state)) throw statusError("state must be ticked, locked, or draft");
  const current = readStatus(projectDir, characterId);
  current.drawings[k] = state;
  return writeStatus(projectDir, characterId, current);
}

function setRedoNote(projectDir, characterId, key, note) {
  const k = assertStatusKey(key);
  const text = String(note || "").trim();
  if (text.length > 500) throw statusError("Redo note is too long");
  const current = readStatus(projectDir, characterId);
  if (text) current.redos[k] = text;
  else delete current.redos[k];
  if (!current.drawings[k] || current.drawings[k] === "ticked") current.drawings[k] = "draft";
  return writeStatus(projectDir, characterId, current);
}

function applyStatusBody(projectDir, characterId, body) {
  if (!body || typeof body !== "object") throw statusError("JSON body required");
  const key = body.key;
  if (body.redo != null && body.redo !== false) {
    return setRedoNote(projectDir, characterId, key, body.redo);
  }
  if (body.state) return setDrawingState(projectDir, characterId, key, body.state);
  throw statusError("Provide state or redo");
}

function posixJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\\/g, "/");
}

function fileStem(rel) {
  return path.posix.basename(String(rel || "").replace(/\\/g, "/")).replace(/\.[^.]+$/, "");
}

function lookupDrawing(projectDir, globalAssetsDir, characterId, dirs, drawingName, options) {
  for (const dir of dirs) {
    if (!dir) continue;
    const relDir = posixJoin("characters", characterId, dir);
    const scanned = scanDrawingsDir(projectDir, globalAssetsDir, relDir, options);
    const hit = scanned.get(drawingName);
    if (!hit) continue;
    const rel = posixJoin(relDir, path.basename(hit.absPath));
    return { name: drawingName, rel, drawingsDir: dir, source: hit.source };
  }
  return null;
}

function presentDrawings(projectDir, globalAssetsDir, characterId, dirs, options) {
  const byName = new Map();
  for (const dir of dirs) {
    if (!dir) continue;
    const relDir = posixJoin("characters", characterId, dir);
    for (const [name, file] of scanDrawingsDir(projectDir, globalAssetsDir, relDir, options)) {
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        rel: posixJoin(relDir, path.basename(file.absPath)),
        drawingsDir: dir,
        source: file.source,
      });
    }
  }
  return byName;
}

function headBaseRelForView(projectDir, globalAssetsDir, characterId, view, options) {
  const dirs = [
    ...candidateDrawingsDirs("head_base", view, "head_base"),
    ...candidateDrawingsDirs("head", view, "head"),
  ];
  const seen = [];
  for (const dir of dirs) {
    if (!seen.includes(dir)) seen.push(dir);
  }
  return (
    lookupDrawing(projectDir, globalAssetsDir, characterId, seen, "neutral", options) ||
    lookupDrawing(projectDir, globalAssetsDir, characterId, seen, "head_base", options)
  );
}

function mtimeForRel(projectDir, globalAssetsDir, rel, options) {
  if (!rel) return null;
  const resolved = resolveAsset(projectDir, globalAssetsDir, rel, options);
  if (!resolved) return null;
  try {
    return Math.round(fs.statSync(resolved.absPath).mtimeMs);
  } catch {
    return null;
  }
}

function makePiece({ name, key, rel, drawingsDir, statusMap, expected, optional, mtime, compositeRel, faceGroup }) {
  const hasFile = Boolean(rel);
  const badge = drawingBadge(statusMap, key, hasFile, expected);
  return {
    name,
    key,
    rel: rel || null,
    drawingsDir: drawingsDir || null,
    expected: Boolean(expected),
    optional: Boolean(optional),
    missing: badge === "missing",
    badge,
    mtime: mtime || null,
    compositeRel: compositeRel || null,
    faceGroup: faceGroup || null,
  };
}

function buildSlotRow(projectDir, globalAssetsDir, characterId, slotName, spec, owner, view, statusMap, options, headBaseRel) {
  const baseDir = (spec && spec.drawings_dir) || slotName;
  const views = discoverSlotViews(projectDir, globalAssetsDir, characterId, slotName, spec || { drawings_dir: baseDir });
  const viewHit = views.find((item) => item.id === view);
  const dirs = [];
  if (viewHit) dirs.push(viewHit.drawingsDir);
  for (const dir of candidateDrawingsDirs(slotName, view, baseDir)) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  const found = presentDrawings(projectDir, globalAssetsDir, characterId, dirs, options);
  const standard = expectedDrawings(slotName, view, { includeOptional: true });
  const required = new Set(expectedDrawings(slotName, view, { includeOptional: false }));
  const optional = new Set(standard.filter((name) => !required.has(name)));
  const names = [];
  const seen = new Set();
  for (const name of standard) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  for (const name of [...found.keys()].sort()) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const preferredDir =
    ([...found.values()][0] && [...found.values()][0].drawingsDir) ||
    (viewHit && viewHit.drawingsDir) ||
    dirs[0] ||
    baseDir;
  const faceGroup = isFaceOverlaySlot(slotName) ? standardForFace(slotName) : null;
  const drawings = names.map((name) => {
    const file = found.get(name);
    const dir = (file && file.drawingsDir) || preferredDir;
    const expected = required.has(name) || optional.has(name);
    return makePiece({
      name,
      key: statusKey(dir, name),
      rel: file ? file.rel : null,
      drawingsDir: dir,
      statusMap,
      expected,
      optional: optional.has(name),
      mtime: file ? mtimeForRel(projectDir, globalAssetsDir, file.rel, options) : null,
      compositeRel: faceGroup ? headBaseRel || null : null,
      faceGroup,
    });
  });
  return {
    id: owner ? `${owner}:${slotName}` : slotName,
    label: slotRowLabel(slotName, owner),
    slot: slotName,
    owner: owner || null,
    kind: "slot",
    drawings,
  };
}

function standardForFace(slotName) {
  const name = String(slotName || "").toLowerCase();
  if (name.startsWith("eyes")) return "eyes";
  if (name.startsWith("mouth")) return "mouth";
  return null;
}

function childAssetRel(projectDir, globalAssetsDir, characterId, child, options) {
  if (!child || !child.asset) return null;
  const rel = posixJoin("characters", characterId, String(child.asset).replace(/\\/g, "/"));
  if (!resolveAsset(projectDir, globalAssetsDir, rel, options)) return null;
  return rel;
}

function childAllowedOnView(child, view) {
  const text = `${(child && child.id) || ""} ${(child && child.asset) || ""}`.toLowerCase();
  if (view === "front") return true;
  if (view === "back") return /torso|body|shirt|shorts|clothing|leg|cape/.test(text);
  return /_(left_34|right_34|left_side|right_side|back)$/.test(text);
}

function buildChildRows(projectDir, globalAssetsDir, characterId, character, view, statusMap, options) {
  const groups = new Map();
  for (const child of character.children || []) {
    if (!childAllowedOnView(child, view)) continue;
    const label = childRowLabel(child);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(child);
  }
  const rows = [];
  for (const [label, children] of groups) {
    const drawings = [];
    const seen = new Set();
    for (const child of children) {
      const rel = childAssetRel(projectDir, globalAssetsDir, characterId, child, options);
      const name = fileStem(child.asset) || child.id;
      const key = statusKey(child.id, name);
      if (seen.has(key)) continue;
      seen.add(key);
      drawings.push(
        makePiece({
          name,
          key,
          rel,
          drawingsDir: child.id,
          statusMap,
          expected: true,
          mtime: mtimeForRel(projectDir, globalAssetsDir, rel, options),
        })
      );
    }
    if (label.startsWith("Arm rig") && view === "front") {
      for (const piece of FRONT_ARM_PIECES) {
        if (drawings.some((d) => d.name === piece || d.drawingsDir === piece)) continue;
        const hit = lookupDrawing(projectDir, globalAssetsDir, characterId, [piece, `parts/${piece}`], piece, options);
        if (hit) {
          drawings.push(
            makePiece({
              name: piece,
              key: statusKey(hit.drawingsDir, piece),
              rel: hit.rel,
              drawingsDir: hit.drawingsDir,
              statusMap,
              expected: true,
              mtime: mtimeForRel(projectDir, globalAssetsDir, hit.rel, options),
            })
          );
        } else if (!drawings.some((d) => d.name === piece)) {
          drawings.push(
            makePiece({
              name: piece,
              key: statusKey(piece, piece),
              rel: null,
              drawingsDir: piece,
              statusMap,
              expected: true,
            })
          );
        }
      }
    }
    if (drawings.length === 0) continue;
    rows.push({
      id: `child:${label}`,
      label,
      slot: children[0].id,
      owner: null,
      kind: "child",
      drawings,
    });
  }
  return rows;
}

function rowSortKey(row) {
  const order = [
    "Head",
    "Eyes",
    "Mouth",
    "Torso",
    "Overlays",
    "Arm rig",
    "Arm rig L",
    "Arm rig R",
    "Hands",
    "Legs",
    "Legs L",
    "Legs R",
  ];
  const i = order.indexOf(row.label);
  return i >= 0 ? i : 50 + row.label.localeCompare("z");
}

const CANONICAL_SLOT = {
  Head: "head_base",
  Eyes: "eyes",
  Mouth: "mouth",
  Torso: "torso",
  Overlays: "overlay",
  "Arm rig": "arm",
  "Arm rig L": "arm_L",
  "Arm rig R": "arm_R",
  Hands: "hand",
  Legs: "legs",
  "Legs L": "legs_L",
  "Legs R": "legs_R",
};

function mergeNamedPiece(existing, piece) {
  const prior = existing.drawings.find((item) => item.name === piece.name);
  if (prior) {
    if (!prior.rel && piece.rel) {
      const idx = existing.drawings.indexOf(prior);
      existing.drawings[idx] = piece;
    }
    return;
  }
  if (existing.drawings.some((item) => item.key === piece.key)) return;
  existing.drawings.push(piece);
}

function mergeFactoryRows(rows) {
  const byLabel = new Map();
  for (const row of rows || []) {
    const existing = byLabel.get(row.label);
    if (!existing) {
      const starter = {
        ...row,
        id: `group:${row.label}`,
        slot: CANONICAL_SLOT[row.label] || row.slot,
        drawings: [],
      };
      for (const piece of row.drawings || []) mergeNamedPiece(starter, piece);
      byLabel.set(row.label, starter);
      continue;
    }
    for (const piece of row.drawings || []) mergeNamedPiece(existing, piece);
  }
  return [...byLabel.values()];
}

function presentCount(rows) {
  let n = 0;
  for (const row of rows || []) {
    for (const piece of row.drawings || []) {
      if (piece.rel) n += 1;
    }
  }
  return n;
}

function listReplacedHistory(projectDir, characterId, rel) {
  const folder = path.join(characterDir(projectDir, characterId), "_replaced");
  if (!rel || !fs.existsSync(folder)) return [];
  const tail = String(rel).replace(/^characters\/[^/]+\//, "").replace(/\\/g, "/");
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const posix = abs.replace(/\\/g, "/");
      if (!posix.endsWith(`/${tail}`)) continue;
      out.push({
        rel: path.relative(projectDir, abs).replace(/\\/g, "/"),
        mtime: Math.round(fs.statSync(abs).mtimeMs),
      });
    }
  }
  walk(folder);
  return out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 8);
}

function boundsForRel(projectDir, globalAssetsDir, rel, options) {
  if (!rel) return null;
  const resolved = resolveAsset(projectDir, globalAssetsDir, rel, options);
  if (!resolved) return null;
  try {
    const decoded = decodeRgbaFile(resolved.absPath);
    const box = alphaBounds(decoded.rgba, decoded.width, decoded.height);
    return { x: box.x, y: box.y, w: box.w, h: box.h, empty: Boolean(box.empty) };
  } catch {
    return null;
  }
}

function usagesForPiece(projectDir, globalAssetsDir, characterId, slotName, drawingName) {
  try {
    return (findDrawingUsages(projectDir, globalAssetsDir, characterId, slotName, drawingName) || []).map((item) => ({
      kind: item.kind || "script",
      script: item.script || null,
      line: item.line == null ? null : item.line,
      text: item.text || "",
    }));
  } catch {
    return [];
  }
}

function describeChildren(projectDir, globalAssetsDir, characterId, character, options) {
  return (character.children || []).map((child) => {
    const rel = childAssetRel(projectDir, globalAssetsDir, characterId, child, options);
    const offset = child.offset || {};
    return {
      id: child.id,
      asset: child.asset || null,
      rel,
      pivot: child.pivot == null ? null : child.pivot,
      parent: child.parent || null,
      z: child.z == null ? 0 : child.z,
      offset: { x: offset.x == null ? 0 : offset.x, y: offset.y == null ? 0 : offset.y },
      mtime: mtimeForRel(projectDir, globalAssetsDir, rel, options),
    };
  });
}

function collectFactoryRows(projectDir, globalAssetsDir, character, characterId, view, statusMap, options) {
  const rows = [];
  const seenSlots = new Set();
  const headHit = headBaseRelForView(projectDir, globalAssetsDir, characterId, view, options);
  const headBaseRel = headHit ? headHit.rel : null;

  function addSlot(name, spec, owner) {
    if (!name || seenSlots.has(name)) return;
    seenSlots.add(name);
    const standard = expectedDrawings(name, view, { includeOptional: true });
    const row = buildSlotRow(
      projectDir,
      globalAssetsDir,
      characterId,
      name,
      spec,
      owner,
      view,
      statusMap,
      options,
      headBaseRel
    );
    if (row.drawings.length === 0 && standard.length === 0) return;
    rows.push(row);
  }

  for (const [name, spec] of Object.entries(character.slots || {})) addSlot(name, spec, null);
  for (const child of character.children || []) {
    for (const [name, spec] of Object.entries(child.slots || {})) addSlot(name, spec, child.id);
  }
  rows.push(...buildChildRows(projectDir, globalAssetsDir, characterId, character, view, statusMap, options));
  const merged = mergeFactoryRows(rows);
  merged.sort((a, b) => rowSortKey(a) - rowSortKey(b) || a.label.localeCompare(b.label));
  return merged;
}

function describeFactoryCharacter(projectDir, globalAssetsDir, characterId, viewId, options = {}) {
  assertCharacterId(characterId);
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw statusError(`Unknown character: ${characterId}`, "ENOTFOUND");
  const view = normalizeView(viewId);
  const status = readStatus(projectDir, characterId);
  const rows = collectFactoryRows(
    projectDir,
    globalAssetsDir,
    character,
    characterId,
    view,
    status.drawings,
    options
  );
  const views = FACTORY_VIEWS.map((id) => {
    const viewRows =
      id === view
        ? rows
        : collectFactoryRows(projectDir, globalAssetsDir, character, characterId, id, status.drawings, options);
    return { id, label: viewTabLabel(id), count: presentCount(viewRows) };
  });

  const canvas = defaultFactoryCanvas(character);
  const migrated = migrateStatusOntoRows(projectDir, characterId, rows, status);
  const counts = sumCounts(rows);
  return {
    ok: true,
    characterId,
    displayName: character.display_name || characterId,
    view,
    views,
    status: migrated.drawings,
    redos: migrated.redos,
    counts,
    canvas,
    default_scale: character.default_scale == null ? 1 : character.default_scale,
    groups: character.groups || null,
    children: describeChildren(projectDir, globalAssetsDir, characterId, character, options),
    rows,
  };
}

function migrateStatusOntoRows(projectDir, characterId, rows, status) {
  let changed = false;
  for (const row of rows || []) {
    for (const piece of row.drawings || []) {
      if (!piece.rel || !piece.key) continue;
      if (status.drawings[piece.key]) continue;
      const found = lookupStatusState(status.drawings, piece.key);
      if (!found) continue;
      status.drawings[piece.key] = found;
      changed = true;
    }
  }
  if (changed) writeStatus(projectDir, characterId, status);
  return status;
}

function inspectorForPiece(factory, key, ctx) {
  const k = String(key || "");
  for (const row of factory.rows || []) {
    const piece = (row.drawings || []).find((item) => item.key === k);
    if (!piece) continue;
    const child = (factory.children || []).find((item) => item.id === row.slot || item.id === piece.drawingsDir);
    const slotCanvas = factory.canvas || { w: 1024, h: 1024, pivot: { x: 509, y: 457 } };
    const pivot = child ? namedPivotPoint(child.pivot, slotCanvas) : slotCanvas.pivot;
    const projectDir = ctx && ctx.projectDir;
    const globalAssetsDir = ctx && ctx.globalAssetsDir;
    const options = (ctx && ctx.options) || {};
    return {
      key: piece.key,
      slot: row.slot,
      label: row.label,
      drawing: piece.name,
      view: factory.view,
      rel: piece.rel,
      badge: piece.badge,
      missing: piece.missing,
      canvas: slotCanvas,
      pivot,
      offset: child ? child.offset : { x: 0, y: 0 },
      anchor: child && child.pivot && typeof child.pivot === "string" ? String(child.pivot) : "canvas pivot + offset",
      redo: (factory.redos && factory.redos[piece.key]) || "",
      compositeRel: piece.compositeRel || null,
      faceGroup: piece.faceGroup || null,
      bounds: projectDir ? boundsForRel(projectDir, globalAssetsDir, piece.rel, options) : null,
      usages: projectDir
        ? usagesForPiece(projectDir, globalAssetsDir, factory.characterId, row.slot, piece.name)
        : [],
      history: projectDir ? listReplacedHistory(projectDir, factory.characterId, piece.rel) : [],
    };
  }
  return null;
}

function actionThumbRel(projectDir, globalAssetsDir, characterId, actionId, options) {
  if (!characterId) return null;
  const action = loadAction(projectDir, globalAssetsDir, characterId, actionId, options);
  const view = action && action.view ? action.view : "front";
  if (action && action.set_slots && typeof action.set_slots === "object") {
    for (const [slotName, drawingName] of Object.entries(action.set_slots)) {
      const dirs = candidateDrawingsDirs(slotName, view, slotName);
      if (!dirs.includes(slotName)) dirs.push(slotName);
      const hit = lookupDrawing(projectDir, globalAssetsDir, characterId, dirs, String(drawingName), options);
      if (hit) return hit.rel;
    }
  }
  const torsoDirs = [...candidateDrawingsDirs("torso", view, "torso"), "torso"];
  const torso = lookupDrawing(
    projectDir,
    globalAssetsDir,
    characterId,
    torsoDirs,
    "neutral",
    options
  );
  if (torso) return torso.rel;
  const bodyDirs = [...candidateDrawingsDirs("body", view, "body"), "body"];
  const body = lookupDrawing(
    projectDir,
    globalAssetsDir,
    characterId,
    bodyDirs,
    "walk",
    options
  );
  if (body) return body.rel;
  const head = lookupDrawing(
    projectDir,
    globalAssetsDir,
    characterId,
    candidateDrawingsDirs("head_base", view, "head_base"),
    "neutral",
    options
  );
  return head ? head.rel : null;
}

function listProjectActions(projectDir, globalAssetsDir, options = {}) {
  const actions = [];
  const seen = new Set();
  const includeGlobal = options.includeGlobal === true || !isProjectIndependent(projectDir);

  function add(label, id, characterId, source, rel, thumbRel) {
    if (!id || seen.has(label)) return;
    seen.add(label);
    actions.push({
      id,
      characterId: characterId || null,
      label,
      name: id,
      source,
      rel,
      thumbRel: thumbRel || null,
    });
  }

  const roots = [];
  if (projectDir) roots.push({ dir: projectDir, source: "project" });
  if (includeGlobal && globalAssetsDir) roots.push({ dir: globalAssetsDir, source: "global" });
  for (const root of roots) {
    const dir = path.join(root.dir, "actions");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (path.extname(file).toLowerCase() !== ".json") continue;
      const id = path.basename(file, ".json");
      if (!isSafeFolderName(id)) continue;
      add(`shared/${id}`, id, null, root.source, `actions/${file}`, null);
    }
  }

  for (const characterId of listKnownCharacterIds(projectDir, globalAssetsDir, options)) {
    for (const id of listActionIds(projectDir, globalAssetsDir, characterId, options)) {
      add(
        `${characterId}/${id}`,
        id,
        characterId,
        "character",
        `characters/${characterId}/actions/${id}.json`,
        actionThumbRel(projectDir, globalAssetsDir, characterId, id, options)
      );
    }
  }
  actions.sort((a, b) => a.label.localeCompare(b.label));
  return actions;
}

module.exports = {
  STATUS_FILENAME,
  REDOS_KEY,
  readStatus,
  writeStatus,
  setDrawingState,
  setRedoNote,
  applyStatusBody,
  describeFactoryCharacter,
  inspectorForPiece,
  listProjectActions,
  parseStatusFile,
  serializeStatus,
};
