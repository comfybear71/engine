"use strict";

/**
 * Studio Assets viewer/editor: inspect, replace, add, rename, and delete
 * drawings under a project's characters/<id>/ folders. Never writes into
 * _global_assets. Replaced files go to _replaced/; deletes go to _trash/.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { loadCharacter, scanDrawingsDir, resolveAsset } = require("./parser/assetLibrary");
const { tokenize } = require("./parser/tokenizer");
const { parseActionTag, HEAD_VIEWS } = require("./parser/actionTag");
const { listScriptFiles, isSafeFolderName } = require("./studioProjects");
const { listProjectAudio } = require("./studioAudio");
const {
  characterDir,
  readWritableCharacter,
  writeCharacterJson,
  findSlotSpec,
  SLOT_NAME,
} = require("./characterLocal");
const {
  DRAWING_NAME,
  SAFE_SESSION,
  runCutout,
  decodeImageBuffer,
  previewDir,
  sessionId,
  stamp,
  safeBasename,
  pngDataUrl,
  absFromProjectRel,
  posixJoin,
} = require("./assetIngest");

const RHUBARB_SHAPES = ["X", "A", "B", "C", "D", "E", "F", "G", "H"];
const MOUTH_SOUNDS = {
  X: "rest",
  A: "closed M/B/P",
  B: "slightly open EE",
  C: "open EH",
  D: "wide AH",
  E: "round OH",
  F: "pursed OO",
  G: "teeth-on-lip F/V",
  H: "tongue L",
};
const VIEW_IDS = [...HEAD_VIEWS, "loud"];
const VIEW_NAME = /^(front|left_34|left_side|right_34|right_side|up|down|loud)$/;
const HISTORY_DIRS = new Set(["_replaced", "_trash", "_backup", "_library", "_reference", "_preview"]);
const ACTION_TAGS = new Set(["action", "move", "pose", "swing"]);

const LIPSYNC_SAMPLES = [
  {
    id: "hello",
    label: "Hello there, my friends.",
    cues: [
      { shape: "X", start: 0, end: 0.08 },
      { shape: "D", start: 0.08, end: 0.22 },
      { shape: "B", start: 0.22, end: 0.38 },
      { shape: "C", start: 0.38, end: 0.55 },
      { shape: "A", start: 0.55, end: 0.64 },
      { shape: "B", start: 0.64, end: 0.78 },
      { shape: "G", start: 0.78, end: 0.92 },
      { shape: "C", start: 0.92, end: 1.15 },
      { shape: "X", start: 1.15, end: 1.45 },
    ],
  },
  {
    id: "please",
    label: "Mmm, please pass the butter.",
    cues: [
      { shape: "A", start: 0, end: 0.28 },
      { shape: "B", start: 0.28, end: 0.42 },
      { shape: "E", start: 0.42, end: 0.58 },
      { shape: "A", start: 0.58, end: 0.72 },
      { shape: "B", start: 0.72, end: 0.88 },
      { shape: "A", start: 0.88, end: 1.02 },
      { shape: "C", start: 1.02, end: 1.18 },
      { shape: "A", start: 1.18, end: 1.32 },
      { shape: "D", start: 1.32, end: 1.55 },
      { shape: "X", start: 1.55, end: 1.85 },
    ],
  },
  {
    id: "shapes",
    label: "Cycle every shape",
    cues: RHUBARB_SHAPES.map((shape, i) => ({
      shape,
      start: i * 0.28,
      end: (i + 1) * 0.28,
    })),
  },
];

function editorError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function assertCharacterId(characterId) {
  if (!isSafeFolderName(characterId)) throw editorError("Invalid character id");
  return characterId;
}

function assertSlotName(slotName) {
  if (!SLOT_NAME.test(String(slotName || ""))) throw editorError("Invalid slot name");
  return String(slotName);
}

function assertDrawingName(name) {
  if (!DRAWING_NAME.test(String(name || ""))) throw editorError("Invalid drawing name");
  return String(name);
}

function normalizeView(view) {
  if (view == null || view === "") return "front";
  const id = String(view).trim().toLowerCase();
  if (!VIEW_NAME.test(id)) throw editorError("Invalid view");
  return id;
}

function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function isMouthSlot(slotName, drawingsDir) {
  const name = String(slotName || "").toLowerCase();
  const dir = String(drawingsDir || "").toLowerCase();
  return name === "mouth" || name.startsWith("mouth_") || dir === "mouth" || dir.startsWith("mouth_");
}

function listCharacterSubdirs(projectDir, globalAssetsDir, characterId) {
  const names = new Set();
  for (const root of [globalAssetsDir, projectDir]) {
    const dir = path.join(root, "characters", characterId);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (HISTORY_DIRS.has(entry.name) || entry.name.startsWith("_")) continue;
      names.add(entry.name);
    }
  }
  return names;
}

function discoverSlotViews(projectDir, globalAssetsDir, characterId, slotName, slotSpec) {
  const baseDir = (slotSpec && slotSpec.drawings_dir) || slotName;
  const views = [];
  const seen = new Set();

  function addView(id, drawingsDir) {
    if (seen.has(id)) return;
    const relDir = `characters/${characterId}/${drawingsDir}`;
    const scanned = scanDrawingsDir(projectDir, globalAssetsDir, relDir);
    if (scanned.size === 0 && id !== "front") return;
    seen.add(id);
    views.push({ id, drawingsDir, relDir });
  }

  const frontAlt = `mouth_front`;
  const useFrontAlt =
    isMouthSlot(slotName, baseDir) &&
    scanDrawingsDir(projectDir, globalAssetsDir, `characters/${characterId}/${frontAlt}`).size > 0;
  addView("front", useFrontAlt ? frontAlt : baseDir);

  const siblingPrefix = isMouthSlot(slotName, baseDir) ? "mouth_" : `${baseDir}_`;
  const siblings = listCharacterSubdirs(projectDir, globalAssetsDir, characterId);
  for (const id of VIEW_IDS) {
    if (id === "front") continue;
    const dir = `${siblingPrefix.replace(/_$/, "")}_${id}`;
    if (siblings.has(dir)) addView(id, dir);
  }
  if (siblings.has(`${baseDir}_loud`) && !seen.has("loud")) addView("loud", `${baseDir}_loud`);
  if (siblings.has("mouth_loud") && isMouthSlot(slotName, baseDir) && !seen.has("loud")) {
    addView("loud", "mouth_loud");
  }
  return views;
}

function describeDrawingFile(projectDir, globalAssetsDir, characterId, drawingsDir, drawingName) {
  const rel = posixJoin("characters", characterId, drawingsDir, `${drawingName}.png`);
  let resolved = resolveAsset(projectDir, globalAssetsDir, rel);
  if (!resolved) {
    const scanned = scanDrawingsDir(projectDir, globalAssetsDir, `characters/${characterId}/${drawingsDir}`);
    const hit = scanned.get(drawingName);
    if (!hit) return null;
    resolved = {
      absPath: hit.absPath,
      source: path.resolve(hit.absPath).startsWith(path.resolve(projectDir)) ? "project" : "global",
    };
    const ext = path.extname(hit.absPath) || ".png";
    return finishDrawing(projectDir, drawingName, posixJoin("characters", characterId, drawingsDir, `${drawingName}${ext}`), resolved);
  }
  return finishDrawing(projectDir, drawingName, rel, resolved);
}

function finishDrawing(projectDir, drawingName, rel, resolved) {
  const buf = fs.readFileSync(resolved.absPath);
  const size = pngSize(buf) || { width: null, height: null };
  let mtime = null;
  try {
    mtime = Math.round(fs.statSync(resolved.absPath).mtimeMs);
  } catch {
    mtime = null;
  }
  const bytes = buf.length;
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const source =
    resolved.source ||
    (path.resolve(resolved.absPath).startsWith(path.resolve(projectDir)) ? "project" : "global");
  return {
    name: drawingName,
    rel,
    mtime,
    width: size.width,
    height: size.height,
    bytes,
    hash,
    source,
    loud: /_loud$/i.test(drawingName),
    shape: rhubarbShapeOf(drawingName),
  };
}

function rhubarbShapeOf(name) {
  const base = String(name || "").replace(/_loud$/i, "");
  return RHUBARB_SHAPES.includes(base) ? base : null;
}

function markDuplicates(drawings) {
  const byHash = new Map();
  for (const drawing of drawings) {
    if (!drawing.hash) continue;
    const list = byHash.get(drawing.hash) || [];
    list.push(drawing.name);
    byHash.set(drawing.hash, list);
  }
  return drawings.map((drawing) => {
    const twins = (byHash.get(drawing.hash) || []).filter((name) => name !== drawing.name);
    return {
      ...drawing,
      duplicateOf: twins.length ? twins[0] : null,
      duplicates: twins,
    };
  });
}

function missingMouthShapes(drawings) {
  const present = new Set(drawings.map((d) => rhubarbShapeOf(d.name)).filter(Boolean));
  return RHUBARB_SHAPES.filter((shape) => !present.has(shape));
}

function characterAliases(character) {
  const names = new Set();
  if (!character) return names;
  names.add(String(character.id || "").toLowerCase());
  names.add(String(character.display_name || "").toLowerCase());
  for (const alias of character.aliases || []) names.add(String(alias).toLowerCase());
  names.delete("");
  return names;
}

function namesMatch(aliases, raw) {
  return aliases.has(String(raw || "").trim().toLowerCase());
}

function findDrawingUsages(projectDir, globalAssetsDir, characterId, slotName, drawingName) {
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw editorError(`Unknown character: ${characterId}`, "ENOTFOUND");
  const aliases = characterAliases(character);
  const spec = findSlotSpec(character, slotName);
  const usages = [];
  const cycles = (spec && spec.cycles) || {};
  for (const [cycleName, cycle] of Object.entries(cycles)) {
    if ((cycle.drawings || []).includes(drawingName)) {
      usages.push({
        kind: "cycle",
        cycle: cycleName,
        slot: slotName,
        script: null,
        line: null,
        text: `${slotName} cycle ${cycleName}`,
      });
    }
  }
  if (spec && spec.default_drawing === drawingName) {
    usages.push({
      kind: "default",
      slot: slotName,
      script: null,
      line: null,
      text: `${slotName} default drawing`,
    });
  }

  const mouth = isMouthSlot(slotName, spec && spec.drawings_dir);
  for (const script of listScriptFiles(projectDir)) {
    const abs = path.join(projectDir, script);
    let tokens;
    try {
      tokens = tokenize(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const token of tokens) {
      if (mouth && (token.kind === "dialogue" || token.kind === "audio" || token.kind === "view")) {
        const who =
          token.kind === "dialogue"
            ? token.character
            : parseActionTag(token.body || "", { bareFlags: ["hide", "show"] }).character;
        if (namesMatch(aliases, who)) {
          usages.push({
            kind: token.kind,
            script,
            line: token.lineNumber,
            text: String(token.raw || "").trim(),
          });
        }
        continue;
      }
      if (!ACTION_TAGS.has(token.kind)) continue;
      const parsed = parseActionTag(token.body || "", { bareFlags: ["hide", "show", "flip"] });
      if (!namesMatch(aliases, parsed.character)) continue;
      const assigned = parsed.kv[slotName.toLowerCase()];
      if (!assigned) continue;
      if (assigned === drawingName) {
        usages.push({
          kind: "action",
          script,
          line: token.lineNumber,
          text: String(token.raw || "").trim(),
        });
        continue;
      }
      const cycle = cycles[assigned];
      if (cycle && (cycle.drawings || []).includes(drawingName)) {
        usages.push({
          kind: "cycle",
          cycle: assigned,
          script,
          line: token.lineNumber,
          text: String(token.raw || "").trim(),
        });
      }
    }
  }
  return usages;
}

function loadSlotContext(projectDir, globalAssetsDir, characterId, slotName) {
  assertCharacterId(characterId);
  assertSlotName(slotName);
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw editorError(`Unknown character: ${characterId}`, "ENOTFOUND");
  const spec = findSlotSpec(character, slotName);
  if (!spec) throw editorError(`Unknown slot: ${slotName}`, "ENOTFOUND");
  return { character, spec };
}

function drawingsForView(projectDir, globalAssetsDir, characterId, view) {
  const scanned = scanDrawingsDir(projectDir, globalAssetsDir, view.relDir);
  const drawings = [];
  for (const [name] of scanned) {
    const described = describeDrawingFile(projectDir, globalAssetsDir, characterId, view.drawingsDir, name);
    if (described) drawings.push({ ...described, view: view.id });
  }
  drawings.sort((a, b) => a.name.localeCompare(b.name));
  return markDuplicates(drawings);
}

function describeSlot(projectDir, globalAssetsDir, characterId, slotName, viewId) {
  const { character, spec } = loadSlotContext(projectDir, globalAssetsDir, characterId, slotName);
  const views = discoverSlotViews(projectDir, globalAssetsDir, characterId, slotName, spec);
  const wanted = normalizeView(viewId);
  const view = views.find((item) => item.id === wanted) || views[0];
  if (!view) throw editorError(`No drawings folder for slot ${slotName}`, "ENOTFOUND");
  const drawings = drawingsForView(projectDir, globalAssetsDir, characterId, view);
  const mouth = isMouthSlot(slotName, spec.drawings_dir);
  const offset = spec.offset || { x: 0, y: 0 };
  return {
    ok: true,
    characterId,
    displayName: character.display_name || characterId,
    slot: slotName,
    owner: ownerOfSlot(character, slotName),
    drawingsDir: view.drawingsDir,
    view: view.id,
    views: views.map((item) => ({
      id: item.id,
      drawingsDir: item.drawingsDir,
      count: scanDrawingsDir(projectDir, globalAssetsDir, item.relDir).size,
    })),
    offset: { x: offset.x == null ? 0 : offset.x, y: offset.y == null ? 0 : offset.y },
    scale: spec.scale == null ? 1 : spec.scale,
    rotation: spec.rotation == null ? 0 : spec.rotation,
    defaultDrawing: spec.default_drawing || null,
    cycles: spec.cycles || {},
    mouth,
    shapes: mouth
      ? RHUBARB_SHAPES.map((shape) => ({
          shape,
          sound: MOUTH_SOUNDS[shape],
          present: drawings.some((d) => d.shape === shape && !d.loud),
          loud: drawings.some((d) => d.shape === shape && d.loud),
        }))
      : [],
    missingShapes: mouth ? missingMouthShapes(drawings.filter((d) => !d.loud)) : [],
    drawings,
  };
}

function ownerOfSlot(character, slotName) {
  if (character.slots && character.slots[slotName]) return null;
  for (const child of character.children || []) {
    if (child.slots && child.slots[slotName]) return child.id;
  }
  return null;
}

function describeDrawing(projectDir, globalAssetsDir, characterId, slotName, drawingName, viewId) {
  const slot = describeSlot(projectDir, globalAssetsDir, characterId, slotName, viewId);
  const drawing = slot.drawings.find((item) => item.name === drawingName);
  if (!drawing) throw editorError(`Unknown drawing: ${drawingName}`, "ENOTFOUND");
  const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, slotName, drawingName);
  const names = slot.drawings.map((item) => item.name);
  const index = names.indexOf(drawingName);
  return {
    ok: true,
    ...slot,
    drawing,
    usages,
    prev: index > 0 ? names[index - 1] : names[names.length - 1] || null,
    next: index >= 0 && index < names.length - 1 ? names[index + 1] : names[0] || null,
  };
}

function resolveViewDir(projectDir, globalAssetsDir, characterId, slotName, spec, viewId) {
  const views = discoverSlotViews(projectDir, globalAssetsDir, characterId, slotName, spec);
  const wanted = normalizeView(viewId);
  const hit = views.find((item) => item.id === wanted);
  if (hit) return hit;
  if (wanted === "front") {
    return {
      id: "front",
      drawingsDir: (spec && spec.drawings_dir) || slotName,
      relDir: `characters/${characterId}/${(spec && spec.drawings_dir) || slotName}`,
    };
  }
  const drawingsDir = isMouthSlot(slotName, spec && spec.drawings_dir)
    ? `mouth_${wanted}`
    : `${(spec && spec.drawings_dir) || slotName}_${wanted}`;
  return { id: wanted, drawingsDir, relDir: `characters/${characterId}/${drawingsDir}` };
}

function assertInsideCharacterAssets(projectDir, characterId, rel) {
  const posix = String(rel || "").replace(/\\/g, "/");
  const prefix = `characters/${characterId}/`;
  if (!posix.startsWith(prefix) || posix.includes("..") || posix.startsWith("/")) {
    throw editorError("Path is outside the character assets folder");
  }
  const rest = posix.slice(prefix.length);
  const first = rest.split("/")[0];
  if (!first || first === ".." || (first.startsWith("_") && !HISTORY_DIRS.has(first) && first !== "_library")) {
    // allow slot dirs and known history / library folders only
  }
  const abs = absFromProjectRel(projectDir, posix);
  const root = path.resolve(characterDir(projectDir, characterId));
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw editorError("Path is outside the character assets folder");
  }
  return { posix, abs };
}

function writeHistoryCopy(projectDir, characterId, kind, rel, absSource) {
  if (!absSource || !fs.existsSync(absSource)) return null;
  const folder = kind === "trash" ? "_trash" : "_replaced";
  const destRel = posixJoin("characters", characterId, folder, stamp(), rel.replace(/^characters\/[^/]+\//, ""));
  const destAbs = absFromProjectRel(projectDir, destRel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(absSource, destAbs);
  return destRel;
}

function writeEditManifest(projectDir, characterId, manifest) {
  const sid = manifest.sessionId;
  const dir = previewDir(projectDir, characterId, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

function readEditManifest(projectDir, characterId, sid) {
  if (!SAFE_SESSION.test(String(sid || ""))) throw editorError("Invalid session");
  const manifestPath = path.join(previewDir(projectDir, characterId, sid), "manifest.json");
  if (!fs.existsSync(manifestPath)) throw editorError("Edit preview not found", "ENOENT");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function removeEditSession(projectDir, characterId, sid) {
  if (!SAFE_SESSION.test(String(sid || ""))) throw editorError("Invalid session");
  const root = previewDir(projectDir, characterId, sid);
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true };
}

async function runSingleCutout(originalAbs, cellsDir, options = {}) {
  fs.mkdirSync(cellsDir, { recursive: true });
  const args = ["--input", originalAbs, "--out-dir", cellsDir, "--grid", "1x1"];
  return runCutout(args, options);
}

function firstCell(result) {
  const cells = (result && result.cells) || [];
  const live = cells.find((cell) => !cell.empty) || cells[0];
  if (!live || !live.path || !fs.existsSync(live.path)) {
    throw editorError("Cut-out pipeline returned no cells");
  }
  return live;
}

async function previewReplace(projectDir, globalAssetsDir, characterId, slotName, drawingName, body, options = {}) {
  const { spec } = loadSlotContext(projectDir, globalAssetsDir, characterId, slotName);
  assertDrawingName(drawingName);
  const view = resolveViewDir(projectDir, globalAssetsDir, characterId, slotName, spec, body && body.view);
  const current = describeDrawingFile(projectDir, globalAssetsDir, characterId, view.drawingsDir, drawingName);
  if (!current) throw editorError(`Unknown drawing: ${drawingName}`, "ENOTFOUND");
  const image = decodeImageBuffer(body);
  const sid = sessionId();
  const libDir = path.join(characterDir(projectDir, characterId), "_library");
  fs.mkdirSync(libDir, { recursive: true });
  const originalName = safeBasename(body && body.filename, `${drawingName}.png`);
  const originalRel = posixJoin("characters", characterId, "_library", `${stamp()}_replace_${originalName}`);
  const originalAbs = absFromProjectRel(projectDir, originalRel);
  fs.writeFileSync(originalAbs, image);
  const cellsDir = path.join(previewDir(projectDir, characterId, sid), "cells");
  const result = await runSingleCutout(originalAbs, cellsDir, options);
  const cell = firstCell(result);
  const destRel = posixJoin("characters", characterId, view.drawingsDir, `${drawingName}.png`);
  assertInsideCharacterAssets(projectDir, characterId, destRel);
  const beforeResolved = resolveAsset(projectDir, globalAssetsDir, current.rel);
  writeEditManifest(projectDir, characterId, {
    kind: "replace",
    sessionId: sid,
    characterId,
    slot: slotName,
    drawing: drawingName,
    view: view.id,
    drawingsDir: view.drawingsDir,
    destRel,
    originalRel,
    cellPath: cell.path,
    width: cell.width,
    height: cell.height,
  });
  return {
    ok: true,
    sessionId: sid,
    kind: "replace",
    drawing: drawingName,
    slot: slotName,
    view: view.id,
    before: {
      rel: current.rel,
      width: current.width,
      height: current.height,
      pngBase64: beforeResolved ? pngDataUrl(beforeResolved.absPath) : null,
    },
    after: { width: cell.width, height: cell.height, pngBase64: pngDataUrl(cell.path) },
  };
}

function confirmReplace(projectDir, globalAssetsDir, characterId, body) {
  assertCharacterId(characterId);
  const manifest = readEditManifest(projectDir, characterId, body && body.sessionId);
  if (manifest.kind !== "replace") throw editorError("Not a replace preview");
  if (manifest.characterId !== characterId) throw editorError("Session character mismatch");
  assertInsideCharacterAssets(projectDir, characterId, manifest.destRel);
  const destAbs = absFromProjectRel(projectDir, manifest.destRel);
  const existing = resolveAsset(projectDir, globalAssetsDir, manifest.destRel);
  const historyRel = writeHistoryCopy(
    projectDir,
    characterId,
    "replaced",
    manifest.destRel,
    existing ? existing.absPath : fs.existsSync(destAbs) ? destAbs : null
  );
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(manifest.cellPath, destAbs);
  removeEditSession(projectDir, characterId, manifest.sessionId);
  return { ok: true, rel: manifest.destRel, replaced: historyRel, drawing: manifest.drawing };
}

async function previewAdd(projectDir, globalAssetsDir, characterId, slotName, body, options = {}) {
  const { spec } = loadSlotContext(projectDir, globalAssetsDir, characterId, slotName);
  const suggested = String((body && body.name) || "").trim() || "drawing";
  if (body && body.name) assertDrawingName(body.name);
  const view = resolveViewDir(projectDir, globalAssetsDir, characterId, slotName, spec, body && body.view);
  const image = decodeImageBuffer(body);
  const sid = sessionId();
  const originalName = safeBasename(body && body.filename, `${suggested}.png`);
  const originalRel = posixJoin("characters", characterId, "_library", `${stamp()}_add_${originalName}`);
  const originalAbs = absFromProjectRel(projectDir, originalRel);
  fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
  fs.writeFileSync(originalAbs, image);
  const cellsDir = path.join(previewDir(projectDir, characterId, sid), "cells");
  const result = await runSingleCutout(originalAbs, cellsDir, options);
  const cell = firstCell(result);
  writeEditManifest(projectDir, characterId, {
    kind: "add",
    sessionId: sid,
    characterId,
    slot: slotName,
    name: DRAWING_NAME.test(suggested) ? suggested : "",
    view: view.id,
    drawingsDir: view.drawingsDir,
    originalRel,
    cellPath: cell.path,
    width: cell.width,
    height: cell.height,
  });
  return {
    ok: true,
    sessionId: sid,
    kind: "add",
    slot: slotName,
    view: view.id,
    suggestedName: DRAWING_NAME.test(suggested) ? suggested : "",
    after: { width: cell.width, height: cell.height, pngBase64: pngDataUrl(cell.path) },
  };
}

function confirmAdd(projectDir, globalAssetsDir, characterId, body) {
  assertCharacterId(characterId);
  const manifest = readEditManifest(projectDir, characterId, body && body.sessionId);
  if (manifest.kind !== "add") throw editorError("Not an add preview");
  if (manifest.characterId !== characterId) throw editorError("Session character mismatch");
  const name = assertDrawingName((body && body.name) || manifest.name);
  const destRel = posixJoin("characters", characterId, manifest.drawingsDir, `${name}.png`);
  assertInsideCharacterAssets(projectDir, characterId, destRel);
  const destAbs = absFromProjectRel(projectDir, destRel);
  if (fs.existsSync(destAbs) || resolveAsset(projectDir, globalAssetsDir, destRel)) {
    throw editorError(`Drawing "${name}" already exists`);
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(manifest.cellPath, destAbs);
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const spec = findSlotSpec(character, manifest.slot);
  if (!spec) {
    character.slots = character.slots || {};
    character.slots[manifest.slot] = {
      offset: { x: 0, y: 0 },
      drawings_dir: manifest.drawingsDir,
    };
    writeCharacterJson(projectDir, characterId, character, null);
  }
  removeEditSession(projectDir, characterId, manifest.sessionId);
  return { ok: true, rel: destRel, drawing: name, slot: manifest.slot, view: manifest.view };
}

function cancelEdit(projectDir, characterId, body) {
  return removeEditSession(projectDir, characterId, body && body.sessionId);
}

function renameDrawing(projectDir, globalAssetsDir, characterId, slotName, drawingName, body) {
  const { spec } = loadSlotContext(projectDir, globalAssetsDir, characterId, slotName);
  assertDrawingName(drawingName);
  const next = assertDrawingName(body && body.name);
  if (next === drawingName) return { ok: true, drawing: next, renamed: false };
  const view = resolveViewDir(projectDir, globalAssetsDir, characterId, slotName, spec, body && body.view);
  const current = describeDrawingFile(projectDir, globalAssetsDir, characterId, view.drawingsDir, drawingName);
  if (!current) throw editorError(`Unknown drawing: ${drawingName}`, "ENOTFOUND");
  if (current.source !== "project") {
    throw editorError("This drawing is from the shared library and can't be renamed from this project.");
  }
  const destRel = posixJoin("characters", characterId, view.drawingsDir, `${next}${path.extname(current.rel) || ".png"}`);
  assertInsideCharacterAssets(projectDir, characterId, current.rel);
  assertInsideCharacterAssets(projectDir, characterId, destRel);
  if (resolveAsset(projectDir, globalAssetsDir, destRel)) {
    throw editorError(`Drawing "${next}" already exists`);
  }
  const srcAbs = absFromProjectRel(projectDir, current.rel);
  const destAbs = absFromProjectRel(projectDir, destRel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(srcAbs, destAbs);

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const live = findSlotSpec(character, slotName);
  let jsonDirty = false;
  if (live) {
    if (live.default_drawing === drawingName) {
      live.default_drawing = next;
      jsonDirty = true;
    }
    if (live.cycles) {
      for (const cycle of Object.values(live.cycles)) {
        if (!Array.isArray(cycle.drawings)) continue;
        let changed = false;
        cycle.drawings = cycle.drawings.map((item) => {
          if (item === drawingName) {
            changed = true;
            return next;
          }
          return item;
        });
        if (changed) jsonDirty = true;
      }
    }
  }
  if (jsonDirty) writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, drawing: next, rel: destRel, renamed: true };
}

function deleteDrawing(projectDir, globalAssetsDir, characterId, slotName, drawingName, body) {
  const { spec } = loadSlotContext(projectDir, globalAssetsDir, characterId, slotName);
  assertDrawingName(drawingName);
  if (!(body && body.confirm === true)) {
    throw editorError("Delete needs confirm: true");
  }
  const view = resolveViewDir(projectDir, globalAssetsDir, characterId, slotName, spec, body && body.view);
  const current = describeDrawingFile(projectDir, globalAssetsDir, characterId, view.drawingsDir, drawingName);
  if (!current) throw editorError(`Unknown drawing: ${drawingName}`, "ENOTFOUND");
  if (current.source !== "project") {
    throw editorError("This drawing is from the shared library and can't be deleted from this project.");
  }
  const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, slotName, drawingName);
  const scriptUsages = usages.filter((item) => item.script);
  if (scriptUsages.length && body.force !== true) {
    const err = editorError(
      `This drawing is used by a script. ${scriptUsages
        .slice(0, 6)
        .map((item) => `${item.script}:${item.line}`)
        .join(", ")}`,
      "EUSED"
    );
    err.usages = usages;
    throw err;
  }
  const srcAbs = absFromProjectRel(projectDir, current.rel);
  assertInsideCharacterAssets(projectDir, characterId, current.rel);
  const historyRel = writeHistoryCopy(projectDir, characterId, "trash", current.rel, srcAbs);
  fs.unlinkSync(srcAbs);

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const live = findSlotSpec(character, slotName);
  let jsonDirty = false;
  if (live) {
    if (live.default_drawing === drawingName) {
      live.default_drawing = null;
      jsonDirty = true;
    }
    if (live.cycles) {
      for (const [cycleName, cycle] of Object.entries(live.cycles)) {
        if (!Array.isArray(cycle.drawings)) continue;
        const nextDrawings = cycle.drawings.filter((item) => item !== drawingName);
        if (nextDrawings.length !== cycle.drawings.length) {
          cycle.drawings = nextDrawings;
          jsonDirty = true;
        }
        if (cycle.drawings.length === 0) {
          delete live.cycles[cycleName];
          jsonDirty = true;
        }
      }
    }
  }
  if (jsonDirty) writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, drawing: drawingName, trash: historyRel, usages };
}

function readRhubarbCues(absPath) {
  if (!fs.existsSync(absPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(absPath, "utf8"));
    const cues = raw.mouthCues || raw.cues || [];
    return cues
      .map((cue) => ({
        shape: String(cue.value || cue.shape || "").toUpperCase(),
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
      }))
      .filter((cue) => RHUBARB_SHAPES.includes(cue.shape));
  } catch {
    return [];
  }
}

function listLipsyncPreview(projectDir, globalAssetsDir, characterId, slotName, viewId) {
  const slot = describeSlot(projectDir, globalAssetsDir, characterId, slotName, viewId);
  if (!slot.mouth) {
    throw editorError("Lip-sync preview is only available on mouth slots");
  }
  const samples = LIPSYNC_SAMPLES.map((sample) => ({
    id: `builtin:${sample.id}`,
    label: sample.label,
    kind: "builtin",
    audioRel: null,
    cues: sample.cues,
  }));
  for (const file of listProjectAudio(projectDir, globalAssetsDir)) {
    if (file.characterId !== characterId) continue;
    const abs = path.join(projectDir, file.rel);
    const cues = readRhubarbCues(`${abs}.rhubarb.json`);
    if (cues.length === 0) continue;
    samples.push({
      id: `audio:${file.rel}`,
      label: `${file.label} · ${file.characterName}`,
      kind: "audio",
      audioRel: file.rel,
      cues,
    });
  }
  const byName = Object.fromEntries(slot.drawings.map((d) => [d.name, d]));
  return {
    ok: true,
    slot: slotName,
    view: slot.view,
    drawings: slot.drawings,
    fallback: byName.X || slot.drawings[0] || null,
    samples,
  };
}

function discoverSlotViewsForLibrary(projectDir, globalAssetsDir, characterId, slotName, slotSpec) {
  return discoverSlotViews(projectDir, globalAssetsDir, characterId, slotName, slotSpec);
}

module.exports = {
  RHUBARB_SHAPES,
  MOUTH_SOUNDS,
  LIPSYNC_SAMPLES,
  VIEW_IDS,
  describeSlot,
  describeDrawing,
  findDrawingUsages,
  discoverSlotViews: discoverSlotViewsForLibrary,
  previewReplace,
  confirmReplace,
  previewAdd,
  confirmAdd,
  cancelEdit,
  renameDrawing,
  deleteDrawing,
  listLipsyncPreview,
  missingMouthShapes,
  rhubarbShapeOf,
};
