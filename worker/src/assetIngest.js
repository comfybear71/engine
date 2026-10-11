"use strict";

/**
 * Studio image-asset ingest: save a dropped Grok Imagine PNG into the
 * project's characters/<id>/_library/, run the Python cut-out pipeline,
 * preview cells, then (on confirm) write drawings into slot folders and
 * merge slots/cycles into a project-local character.json without
 * clobbering unrelated entries. Confirm always ADDS cells: if a dest
 * name already exists, the new file gets a suffix (_b, _c, …). Never
 * overwrites drawings. Never writes into _global_assets.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { loadCharacter, resolveAsset } = require("./parser/assetLibrary");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { isSafeFolderName } = require("./studioProjects");
const { getNeed, expandNeed } = require("./assetNeeds");
const { flipPngHorizontal } = require("./pngFlip");
const {
  characterDir,
  readWritableCharacter,
  writeCharacterJson,
  findSlotSpec,
} = require("./characterLocal");

const DRAWING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ingestError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function posixJoin(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function safeBasename(name, fallback) {
  const base = path.basename(String(name || fallback || "image.png"));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || fallback || "image.png";
}

function decodeImageBuffer(body) {
  if (!body || typeof body !== "object") {
    throw ingestError("image is required");
  }
  if (typeof body.imageBase64 === "string" && body.imageBase64) {
    const stripped = body.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length < 8) throw ingestError("image is empty");
    return buf;
  }
  throw ingestError("imageBase64 is required");
}

function ensureSlot(character, dest) {
  if (!dest || dest.kind !== "slot") return null;
  const existing = findSlotSpec(character, dest.slot);
  if (existing) {
    if (!existing.drawings_dir && dest.drawings_dir) existing.drawings_dir = dest.drawings_dir;
    // Front head sheets must become the default the compositor reads.
    if (dest.drawings_dir === "mouth_front") existing.drawings_dir = "mouth_front";
    return existing;
  }
  const spec = {
    offset: { x: 0, y: 0 },
    drawings_dir: dest.drawings_dir || dest.slot,
  };
  if (dest.child) {
    character.children = character.children || [];
    let child = character.children.find((c) => c.id === dest.child);
    if (child) {
      child.slots = child.slots || {};
      child.slots[dest.slot] = spec;
      return spec;
    }
  }
  character.slots = character.slots || {};
  character.slots[dest.slot] = spec;
  return spec;
}

function mergeCycles(slotSpec, cycles) {
  if (!slotSpec || !cycles) return;
  slotSpec.cycles = slotSpec.cycles || {};
  for (const [name, cycle] of Object.entries(cycles)) {
    const existing = slotSpec.cycles[name];
    const drawings = [...((existing && existing.drawings) || [])];
    for (const drawing of cycle.drawings || []) {
      if (!drawings.includes(drawing)) drawings.push(drawing);
    }
    slotSpec.cycles[name] = {
      drawings,
      fps: cycle.fps || (existing && existing.fps) || 12,
    };
  }
}

const NAME_LETTERS = "bcdefghijklmnopqrstuvwxyz";

function destExists(projectDir, globalAssetsDir, rel) {
  if (!rel) return false;
  return Boolean(resolveAsset(projectDir, globalAssetsDir, rel));
}

function suffixFileRel(characterId, destRel, suffix) {
  const ext = path.posix.extname(destRel) || ".png";
  const dir = path.posix.dirname(destRel);
  const stem = path.posix.basename(destRel, ext);
  const file = `${stem}${suffix}${ext}`;
  return posixJoin("characters", characterId, dir === "." ? file : posixJoin(dir, file));
}

function uniqueWriteTarget(projectDir, globalAssetsDir, characterId, dest, name, takenRels) {
  const taken = (rel) => Boolean(rel) && (takenRels.has(rel) || destExists(projectDir, globalAssetsDir, rel));
  const first = destRelForCell(characterId, dest, name);
  if (first && !taken(first)) return { name, rel: first };
  for (let i = 0; i < NAME_LETTERS.length + 200; i += 1) {
    const suffix = i < NAME_LETTERS.length ? `_${NAME_LETTERS[i]}` : `_b${i - NAME_LETTERS.length + 2}`;
    const nextName = `${name}${suffix}`;
    if (!DRAWING_NAME.test(nextName)) continue;
    const rel =
      dest && dest.kind === "file" && dest.rel
        ? suffixFileRel(characterId, dest.rel, suffix)
        : destRelForCell(characterId, dest, nextName);
    if (rel && !taken(rel)) return { name: nextName, rel };
  }
  throw ingestError(`Could not find a free name for "${name}"`);
}

function runAlign(args, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-m", "compositor.align", ...args], {
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
      reject(new Error(`Failed to spawn align pipeline (${pythonBin}): ${err.message}`));
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
          (parsed && parsed.error) || (stderr || stdout).trim().split("\n").pop() || `exited with code ${code}`;
        reject(new Error(`Align pipeline failed: ${detail}`));
        return;
      }
      resolve(parsed);
    });
  });
}

function isHeadLikeDest(dest) {
  if (!dest || dest.kind !== "slot") return false;
  const slot = String(dest.slot || "").toLowerCase();
  const dir = String(dest.drawings_dir || "").toLowerCase();
  return slot === "mouth" || slot === "head" || slot === "face" || dir.startsWith("mouth") || dir === "head" || dir === "face";
}

function findAlignReferenceAbs(projectDir, globalAssetsDir, characterId, dest, drawingName) {
  if (!dest || dest.kind !== "slot") return null;
  const dirs = [];
  const destDir = dest.drawings_dir || dest.slot;
  if (destDir && destDir !== "mouth_front") dirs.push(destDir);
  dirs.push("mouth");
  if (destDir === "mouth_front") dirs.unshift("mouth");
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const rel = posixJoin("characters", characterId, dir, `${drawingName}.png`);
    const resolved = resolveAsset(projectDir, globalAssetsDir, rel);
    if (resolved && resolved.absPath && fs.existsSync(resolved.absPath)) return resolved.absPath;
  }
  return null;
}

async function alignCellToReference(projectDir, globalAssetsDir, characterId, cell, options = {}) {
  if (!cell || cell.empty || !cell.path || !isHeadLikeDest(cell.dest)) return cell;
  const name = cell.suggestedName || cell.name;
  const refAbs = findAlignReferenceAbs(projectDir, globalAssetsDir, characterId, cell.dest, name);
  if (!refAbs) return cell;
  const outPath = `${cell.path}.aligned.png`;
  await runAlign(["--src", cell.path, "--ref", refAbs, "--out", outPath, "--crop-to-head"], options);
  if (fs.existsSync(outPath)) {
    fs.copyFileSync(cell.path, `${cell.path}.raw.png`);
    fs.copyFileSync(outPath, cell.path);
  }
  return cell;
}

function runCutout(args, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-m", "compositor.cutout", ...args], {
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
      reject(
        new Error(
          `Failed to spawn cut-out pipeline (${pythonBin}): ${err.message}. ` +
            "Did you create worker/python/venv and install requirements.txt?"
        )
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split("\n").pop() || `exited with code ${code}`;
        reject(new Error(`Cut-out pipeline failed: ${detail}`));
        return;
      }
      const trimmed = stdout.trim();
      let parsed = null;
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split("\n").pop());
        } catch {
          parsed = null;
        }
      }
      if (!parsed || !Array.isArray(parsed.cells)) {
        reject(new Error("Cut-out pipeline returned no cells"));
        return;
      }
      resolve(parsed);
    });
  });
}

function previewDir(projectDir, characterId, sid) {
  return path.join(characterDir(projectDir, characterId), "_library", "_preview", sid);
}

function readManifest(projectDir, characterId, sid) {
  if (!SAFE_SESSION.test(sid)) throw ingestError("Invalid session");
  const manifestPath = path.join(previewDir(projectDir, characterId, sid), "manifest.json");
  if (!fs.existsSync(manifestPath)) throw ingestError("Ingest preview not found", "ENOENT");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function inferMouthViewDest(needId, dest) {
  const match = String(needId || "").match(/^mouth_13_(front|left_34|left_side|right_34|right_side|up|down)$/);
  if (!match || !dest || dest.kind !== "slot") return dest;
  const dir = match[1] === "front" ? "mouth_front" : `mouth_${match[1]}`;
  const current = dest.drawings_dir || dest.slot;
  if (current && current !== dest.slot && current !== "mouth") return dest;
  return { ...dest, drawings_dir: dir };
}

function destRelForCell(characterId, dest, drawingName) {
  if (!dest) return null;
  if (dest.kind === "file" && dest.rel) {
    return posixJoin("characters", characterId, dest.rel);
  }
  if (dest.kind === "slot") {
    const dir = dest.drawings_dir || dest.slot;
    return posixJoin("characters", characterId, dir, `${drawingName}.png`);
  }
  if (dest.kind === "prop") {
    return posixJoin("props", `${drawingName}.png`);
  }
  if (dest.kind === "background") {
    return posixJoin("backgrounds", drawingName, "bg.png");
  }
  return null;
}

function absFromProjectRel(projectDir, rel) {
  const resolved = path.resolve(projectDir, rel);
  const root = path.resolve(projectDir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw ingestError("Invalid destination path");
  }
  return resolved;
}

function pngDataUrl(absPath) {
  const buf = fs.readFileSync(absPath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function filledCellCount(expanded) {
  return (expanded && expanded.cells ? expanded.cells : []).filter((cell) => cell && cell.dest).length;
}

function isMouth13Need(need, expanded) {
  if (/^mouth_13_/.test(String((need && need.id) || ""))) return true;
  return filledCellCount(expanded) === 13;
}

function parseGridBody(body) {
  const raw = body && body.grid;
  if (!raw) return null;
  const cols = Math.floor(Number(raw.cols));
  const rows = Math.floor(Number(raw.rows));
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 16 || rows > 16) {
    throw ingestError("grid must be { cols, rows } with values 1–16");
  }
  return { cols, rows };
}

function resolveCutoutArgs(need, expanded, gridOverride) {
  const mouth13 = isMouth13Need(need, expanded || {});
  const grid = gridOverride || (expanded && expanded.grid) || (mouth13 ? { cols: 5, rows: 3 } : null);
  const useComponents =
    !gridOverride && !mouth13 && (!expanded || expanded.split === "components" || !expanded.grid || !grid);
  if (useComponents || !grid) {
    return { args: ["--components"], grid: null, detectGaps: false, normalize: false };
  }
  const args = ["--grid", `${grid.cols}x${grid.rows}`, "--detect-gaps"];
  const normalize = Boolean(mouth13);
  if (normalize) args.push("--normalize");
  return { args, grid, detectGaps: true, normalize };
}

async function previewIngest(projectDir, globalAssetsDir, characterId, body, options = {}) {
  if (!isSafeFolderName(characterId)) throw ingestError("Invalid character id");
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw ingestError(`Unknown character: ${characterId}`, "ENOTFOUND");

  const need = getNeed(body && body.needId);
  if (!need) throw ingestError("Unknown need");
  if (need.ingest === false || (need.dest && need.dest.kind === "reference")) {
    throw ingestError("This need stores the original as a full-body reference; POST .../reference instead");
  }
  const expanded = expandNeed(need, body && body.frames);
  const gridOverride = parseGridBody(body);
  const recutSid = body && body.sessionId ? String(body.sessionId) : "";

  let sid;
  let originalRel;
  let originalAbs;
  if (recutSid) {
    const existing = readManifest(projectDir, characterId, recutSid);
    if (existing.needId && existing.needId !== need.id) {
      throw ingestError("session need mismatch");
    }
    if (!existing.originalRel) throw ingestError("Ingest preview has no original sheet");
    sid = recutSid;
    originalRel = existing.originalRel;
    originalAbs = absFromProjectRel(projectDir, originalRel);
    if (!fs.existsSync(originalAbs)) throw ingestError("Original sheet missing");
  } else {
    const image = decodeImageBuffer(body);
    sid = sessionId();
    const libDir = path.join(characterDir(projectDir, characterId), "_library");
    fs.mkdirSync(libDir, { recursive: true });
    const originalName = safeBasename(body.filename, `${need.id}.png`);
    originalRel = posixJoin("characters", characterId, "_library", `${stamp()}_${need.id}_${originalName}`);
    originalAbs = absFromProjectRel(projectDir, originalRel);
    fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
    fs.writeFileSync(originalAbs, image);
  }

  const cellsDir = path.join(previewDir(projectDir, characterId, sid), "cells");
  fs.rmSync(cellsDir, { recursive: true, force: true });
  fs.mkdirSync(cellsDir, { recursive: true });

  const resolved = resolveCutoutArgs(need, expanded, gridOverride);
  const args = ["--input", originalAbs, "--out-dir", cellsDir, ...resolved.args];
  if (!expanded.key) args.push("--no-key");

  const result = await runCutout(args, options);
  const expectedEmpty = new Set(
    (expanded.cells || []).map((cell, index) => (cell && cell.dest ? -1 : index)).filter((index) => index >= 0)
  );
  const warnings = (Array.isArray(result.warnings) ? result.warnings : []).filter((line) => {
    const match = String(line).match(/^Cell (\d+) is empty$/);
    return !(match && expectedEmpty.has(Number(match[1])));
  });
  const cells = [];
  for (const raw of result.cells) {
    const template = expanded.cells[raw.index] || {};
    const suggestedName = template.name || `cell_${String(raw.index).padStart(2, "0")}`;
    const warning =
      raw.warning === "empty" && expectedEmpty.has(raw.index) ? null : raw.warning || null;
    const cell = {
      index: raw.index,
      suggestedName,
      name: suggestedName,
      dest: inferMouthViewDest(need.id, template.dest || need.dest || null),
      cycle: template.cycle || null,
      empty: Boolean(raw.empty),
      warning,
      width: raw.width,
      height: raw.height,
      path: raw.path,
    };
    await alignCellToReference(projectDir, globalAssetsDir, characterId, cell, options);
    cells.push(cell);
  }
  const cellsWithPng = cells.map((cell) => ({
    ...cell,
    pngBase64: cell.empty || !cell.path || !fs.existsSync(cell.path) ? null : pngDataUrl(cell.path),
  }));

  const manifest = {
    sessionId: sid,
    characterId,
    needId: need.id,
    frames: body && body.frames,
    originalRel,
    grid: resolved.grid,
    key: expanded.key,
    cycles: expanded.cycles,
    warnings,
    cells: cellsWithPng.map(({ pngBase64, ...rest }) => rest),
  };
  const manifestPath = path.join(previewDir(projectDir, characterId, sid), "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    ok: true,
    sessionId: sid,
    libraryRel: originalRel,
    needId: need.id,
    grid: resolved.grid,
    warnings,
    cells: cellsWithPng.map((cell) => ({
      index: cell.index,
      suggestedName: cell.suggestedName,
      empty: cell.empty,
      warning: cell.warning || null,
      width: cell.width,
      height: cell.height,
      pngBase64: cell.pngBase64,
    })),
  };
}

function confirmIngest(projectDir, globalAssetsDir, characterId, body) {
  if (!isSafeFolderName(characterId)) throw ingestError("Invalid character id");
  const sid = body && body.sessionId;
  const manifest = readManifest(projectDir, characterId, sid);
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  const byIndex = new Map();
  for (const item of assignments) {
    const index = Number(item.index);
    const name = String(item.name || "").trim();
    if (!Number.isInteger(index)) throw ingestError("Invalid assignment index");
    if (!DRAWING_NAME.test(name)) throw ingestError(`Invalid drawing name: ${name}`);
    if (byIndex.has(index)) throw ingestError(`Duplicate assignment for cell ${index}`);
    byIndex.set(index, name);
  }

  const usedNames = new Map();
  const takenRels = new Set();
  const writes = [];
  for (const cell of manifest.cells) {
    const name = byIndex.has(cell.index) ? byIndex.get(cell.index) : cell.suggestedName;
    if (cell.empty && !byIndex.has(cell.index)) continue;
    if (cell.empty) continue;
    if (!DRAWING_NAME.test(name)) throw ingestError(`Invalid drawing name: ${name}`);
    if (usedNames.has(name)) {
      throw ingestError(`Two cells assigned to "${name}"`);
    }
    usedNames.set(name, cell.index);
    if (!destRelForCell(characterId, cell.dest, name)) {
      if (cell.empty || !cell.dest) continue;
      throw ingestError(`No destination for cell ${cell.index}`);
    }
    const unique = uniqueWriteTarget(projectDir, globalAssetsDir, characterId, cell.dest, name, takenRels);
    takenRels.add(unique.rel);
    writes.push({ cell, name: unique.name, rel: unique.rel });
  }
  if (writes.length === 0) throw ingestError("No cells to save");

  const flipAll = Boolean(body && body.flipAll);
  const backupRoot = path.join(characterDir(projectDir, characterId), "_backup", stamp());
  const written = [];
  for (const item of writes) {
    const abs = absFromProjectRel(projectDir, item.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (flipAll) {
      const flipped = flipPngHorizontal(fs.readFileSync(item.cell.path));
      fs.writeFileSync(abs, flipped);
    } else {
      fs.copyFileSync(item.cell.path, abs);
    }
    written.push({ name: item.name, rel: item.rel, dest: item.cell.dest, cycle: item.cell.cycle });
  }

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  let jsonDirty = false;
  const cycleDrawings = {};
  for (const item of written) {
    if (item.dest && item.dest.kind === "slot") {
      const existed = findSlotSpec(character, item.dest.slot);
      ensureSlot(character, item.dest);
      if (!existed) jsonDirty = true;
      if (item.cycle) {
        cycleDrawings[item.cycle] = cycleDrawings[item.cycle] || [];
        cycleDrawings[item.cycle].push(item.name);
      }
    }
  }
  if (manifest.cycles) {
    for (const [cycleName, cycle] of Object.entries(manifest.cycles)) {
      const drawings = cycleDrawings[cycleName];
      if (!drawings || drawings.length === 0) continue;
      const dest = (manifest.cells.find((c) => c.cycle === cycleName) || {}).dest;
      const spec = ensureSlot(character, dest);
      mergeCycles(spec, { [cycleName]: { drawings, fps: cycle.fps } });
      jsonDirty = true;
    }
  }

  for (const item of written) {
    if (item.dest && item.dest.kind === "slot" && item.dest.drawings_dir === "mouth_front") {
      const spec = findSlotSpec(character, item.dest.slot);
      if (spec && spec.drawings_dir !== "mouth_front") {
        spec.drawings_dir = "mouth_front";
        jsonDirty = true;
      }
    }
  }

  if (jsonDirty) {
    writeCharacterJson(projectDir, characterId, character, backupRoot);
  }

  const previewRoot = previewDir(projectDir, characterId, sid);
  fs.rmSync(previewRoot, { recursive: true, force: true });
  const previewParent = path.dirname(previewRoot);
  if (fs.existsSync(previewParent) && fs.readdirSync(previewParent).length === 0) {
    fs.rmdirSync(previewParent);
  }

  return { ok: true, written, characterId };
}

function cancelIngest(projectDir, characterId, body) {
  const sid = body && body.sessionId;
  if (!SAFE_SESSION.test(String(sid || ""))) throw ingestError("Invalid session");
  fs.rmSync(previewDir(projectDir, characterId, sid), { recursive: true, force: true });
  return { ok: true };
}

module.exports = {
  previewIngest,
  confirmIngest,
  cancelIngest,
  ensureSlot,
  mergeCycles,
  uniqueWriteTarget,
  readWritableCharacter,
  destRelForCell,
  inferMouthViewDest,
  isMouth13Need,
  parseGridBody,
  resolveCutoutArgs,
  runAlign,
  isHeadLikeDest,
  findAlignReferenceAbs,
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
};
