"use strict";

/**
 * Per-character factory review state. Studio writes only
 * characters/<id>/status.json in the project folder:
 *   { "<slot>/<drawing>": "ticked|locked|draft", "_redos": { "<slot>/<drawing>": "note" } }
 * Missing is not stored — it is computed from the standard rig vs files on disk.
 */

const fs = require("fs");
const path = require("path");

const { loadCharacter, scanDrawingsDir, resolveAsset, listActionIds, listKnownCharacterIds } = require("./parser/assetLibrary");
const { isSafeFolderName } = require("./studioProjects");
const { characterDir } = require("./characterLocal");
const { discoverSlotViews } = require("./assetEditor");
const {
  FACTORY_VIEWS,
  normalizeView,
  viewTabLabel,
  expectedDrawings,
  candidateDrawingsDirs,
  statusKey,
  parseStatusKey,
  isStatusState,
  drawingBadge,
  childRowLabel,
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

function parseStatusFile(raw) {
  const drawings = {};
  const redos = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { drawings, redos };
  const extraRedos = raw[REDOS_KEY] && typeof raw[REDOS_KEY] === "object" ? raw[REDOS_KEY] : {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === REDOS_KEY) continue;
    if (isStatusState(value) && parseStatusKey(key)) drawings[key] = value;
  }
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

function readStatus(projectDir, characterId) {
  assertCharacterId(characterId);
  const abs = statusPath(projectDir, characterId);
  if (!fs.existsSync(abs)) return emptyStatus();
  try {
    return parseStatusFile(JSON.parse(fs.readFileSync(abs, "utf8")));
  } catch {
    return emptyStatus();
  }
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

function makePiece({ name, key, rel, drawingsDir, statusMap, expected, optional, mtime }) {
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
  };
}

function buildSlotRow(projectDir, globalAssetsDir, characterId, slotName, spec, owner, view, statusMap, options) {
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

function childAssetRel(projectDir, globalAssetsDir, characterId, child, options) {
  if (!child || !child.asset) return null;
  const rel = posixJoin("characters", characterId, String(child.asset).replace(/\\/g, "/"));
  if (!resolveAsset(projectDir, globalAssetsDir, rel, options)) return null;
  return rel;
}

function buildChildRows(projectDir, globalAssetsDir, characterId, character, view, statusMap, options) {
  const groups = new Map();
  for (const child of character.children || []) {
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
  const order = ["Head", "Eyes", "Mouth", "Torso", "Arm rig", "Arm rig L", "Arm rig R", "Hands", "Legs", "Legs L", "Legs R"];
  const i = order.indexOf(row.label);
  return i >= 0 ? i : 50 + row.label.localeCompare("z");
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

function describeFactoryCharacter(projectDir, globalAssetsDir, characterId, viewId, options = {}) {
  assertCharacterId(characterId);
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw statusError(`Unknown character: ${characterId}`, "ENOTFOUND");
  const view = normalizeView(viewId);
  const status = readStatus(projectDir, characterId);
  const rows = [];
  const seenSlots = new Set();

  function addSlot(name, spec, owner) {
    if (!name || seenSlots.has(name)) return;
    seenSlots.add(name);
    const standard = expectedDrawings(name, view, { includeOptional: true });
    const row = buildSlotRow(projectDir, globalAssetsDir, characterId, name, spec, owner, view, status.drawings, options);
    if (row.drawings.length === 0 && standard.length === 0) return;
    rows.push(row);
  }

  for (const [name, spec] of Object.entries(character.slots || {})) addSlot(name, spec, null);
  for (const child of character.children || []) {
    for (const [name, spec] of Object.entries(child.slots || {})) addSlot(name, spec, child.id);
  }
  rows.push(...buildChildRows(projectDir, globalAssetsDir, characterId, character, view, status.drawings, options));
  rows.sort((a, b) => rowSortKey(a) - rowSortKey(b) || a.label.localeCompare(b.label));

  const canvas = defaultFactoryCanvas(character);
  const counts = sumCounts(rows);
  return {
    ok: true,
    characterId,
    displayName: character.display_name || characterId,
    view,
    views: FACTORY_VIEWS.map((id) => ({ id, label: viewTabLabel(id) })),
    status: status.drawings,
    redos: status.redos,
    counts,
    canvas,
    default_scale: character.default_scale == null ? 1 : character.default_scale,
    groups: character.groups || null,
    children: describeChildren(projectDir, globalAssetsDir, characterId, character, options),
    rows,
  };
}

function inspectorForPiece(factory, key) {
  const k = String(key || "");
  for (const row of factory.rows || []) {
    const piece = (row.drawings || []).find((item) => item.key === k);
    if (!piece) continue;
    const child = (factory.children || []).find((item) => item.id === row.slot || item.id === piece.drawingsDir);
    const slotCanvas = factory.canvas || { w: 1024, h: 1024, pivot: { x: 509, y: 457 } };
    const pivot = child ? namedPivotPoint(child.pivot, slotCanvas) : slotCanvas.pivot;
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
      anchor: child && child.pivot && typeof child.pivot === "string" ? String(child.pivot) : "pivot + offset",
      redo: (factory.redos && factory.redos[piece.key]) || "",
    };
  }
  return null;
}

function listProjectActions(projectDir, globalAssetsDir, options = {}) {
  const actions = [];
  const seen = new Set();

  function add(label, id, characterId, source, rel) {
    if (!id || seen.has(label)) return;
    seen.add(label);
    actions.push({ id, characterId: characterId || null, label, source, rel });
  }

  const roots = [];
  if (projectDir) roots.push({ dir: projectDir, source: "project" });
  if (globalAssetsDir) roots.push({ dir: globalAssetsDir, source: "global" });
  for (const root of roots) {
    const dir = path.join(root.dir, "actions");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (path.extname(file).toLowerCase() !== ".json") continue;
      const id = path.basename(file, ".json");
      if (!isSafeFolderName(id)) continue;
      add(`shared/${id}`, id, null, root.source, `actions/${file}`);
    }
  }

  for (const characterId of listKnownCharacterIds(projectDir, globalAssetsDir, options)) {
    for (const id of listActionIds(projectDir, globalAssetsDir, characterId, options)) {
      add(`${characterId}/${id}`, id, characterId, "character", `characters/${characterId}/actions/${id}.json`);
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
