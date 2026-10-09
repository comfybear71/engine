"use strict";

/**
 * Studio image-asset ingest: save a dropped Grok Imagine PNG into the
 * project's characters/<id>/_library/, run the Python cut-out pipeline,
 * preview cells, then (on confirm) write drawings into slot folders and
 * merge slots/cycles into a project-local character.json without
 * clobbering unrelated entries. Overwritten local files are copied to
 * _backup/<timestamp>/ first. Never writes into _global_assets.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { loadCharacter } = require("./parser/assetLibrary");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { isSafeFolderName } = require("./studioProjects");
const { getNeed, expandNeed } = require("./assetNeeds");

const DRAWING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ingestError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function characterDir(projectDir, characterId) {
  return path.join(projectDir, "characters", characterId);
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

function backupIfExists(absPath, backupRoot, relFromRoot) {
  if (!fs.existsSync(absPath)) return null;
  const dest = path.join(backupRoot, relFromRoot);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absPath, dest);
  return dest;
}

function readWritableCharacter(projectDir, globalAssetsDir, characterId) {
  const localPath = path.join(characterDir(projectDir, characterId), "character.json");
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  }
  const loaded = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!loaded) throw ingestError(`Unknown character: ${characterId}`, "ENOTFOUND");
  return JSON.parse(JSON.stringify(loaded));
}

function writeCharacterJson(projectDir, characterId, data, backupRoot) {
  const dir = characterDir(projectDir, characterId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "character.json");
  if (backupRoot) backupIfExists(dest, backupRoot, "character.json");
  fs.writeFileSync(dest, JSON.stringify(data, null, 2) + "\n");
  return dest;
}

function findSlotSpec(character, slotName) {
  if (character.slots && character.slots[slotName]) {
    return character.slots[slotName];
  }
  for (const child of character.children || []) {
    if (child.slots && child.slots[slotName]) return child.slots[slotName];
  }
  return null;
}

function ensureSlot(character, dest) {
  if (!dest || dest.kind !== "slot") return null;
  const existing = findSlotSpec(character, dest.slot);
  if (existing) {
    if (!existing.drawings_dir && dest.drawings_dir) existing.drawings_dir = dest.drawings_dir;
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
    slotSpec.cycles[name] = {
      drawings: [...(cycle.drawings || [])],
      fps: cycle.fps,
    };
  }
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

function relInsideCharacter(characterId, rel) {
  const prefix = `characters/${characterId}/`;
  if (rel.startsWith(prefix)) return rel.slice(prefix.length);
  return rel;
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

async function previewIngest(projectDir, globalAssetsDir, characterId, body, options = {}) {
  if (!isSafeFolderName(characterId)) throw ingestError("Invalid character id");
  const character = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!character) throw ingestError(`Unknown character: ${characterId}`, "ENOTFOUND");

  const need = getNeed(body && body.needId);
  if (!need) throw ingestError("Unknown need");
  const expanded = expandNeed(need, body && body.frames);
  const image = decodeImageBuffer(body);

  const sid = sessionId();
  const libDir = path.join(characterDir(projectDir, characterId), "_library");
  fs.mkdirSync(libDir, { recursive: true });
  const originalName = safeBasename(body.filename, `${need.id}.png`);
  const originalRel = posixJoin("characters", characterId, "_library", `${stamp()}_${need.id}_${originalName}`);
  const originalAbs = absFromProjectRel(projectDir, originalRel);
  fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
  fs.writeFileSync(originalAbs, image);

  const cellsDir = path.join(previewDir(projectDir, characterId, sid), "cells");
  fs.mkdirSync(cellsDir, { recursive: true });

  const args = ["--input", originalAbs, "--out-dir", cellsDir];
  if (expanded.split === "components" || !expanded.grid) {
    args.push("--components");
  } else {
    args.push("--grid", `${expanded.grid.cols}x${expanded.grid.rows}`);
  }
  if (!expanded.key) args.push("--no-key");

  const result = await runCutout(args, options);
  const cells = result.cells.map((cell) => {
    const template = expanded.cells[cell.index] || {};
    const suggestedName = template.name || `cell_${String(cell.index).padStart(2, "0")}`;
    return {
      index: cell.index,
      suggestedName,
      name: suggestedName,
      dest: template.dest || null,
      cycle: template.cycle || null,
      empty: Boolean(cell.empty),
      width: cell.width,
      height: cell.height,
      path: cell.path,
      pngBase64: pngDataUrl(cell.path),
    };
  });

  const manifest = {
    sessionId: sid,
    characterId,
    needId: need.id,
    frames: body && body.frames,
    originalRel,
    grid: expanded.grid,
    key: expanded.key,
    cycles: expanded.cycles,
    cells: cells.map(({ pngBase64, ...rest }) => rest),
  };
  const manifestPath = path.join(previewDir(projectDir, characterId, sid), "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    ok: true,
    sessionId: sid,
    libraryRel: originalRel,
    needId: need.id,
    grid: expanded.grid,
    cells: cells.map((cell) => ({
      index: cell.index,
      suggestedName: cell.suggestedName,
      empty: cell.empty,
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
    const rel = destRelForCell(characterId, cell.dest, name);
    if (!rel) throw ingestError(`No destination for cell ${cell.index}`);
    writes.push({ cell, name, rel });
  }
  if (writes.length === 0) throw ingestError("No cells to save");

  const backupRoot = path.join(characterDir(projectDir, characterId), "_backup", stamp());
  const written = [];
  for (const item of writes) {
    const abs = absFromProjectRel(projectDir, item.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    backupIfExists(abs, backupRoot, relInsideCharacter(characterId, item.rel));
    fs.copyFileSync(item.cell.path, abs);
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

  if (jsonDirty) {
    writeCharacterJson(projectDir, characterId, character, backupRoot);
  }

  fs.rmSync(previewDir(projectDir, characterId, sid), { recursive: true, force: true });

  return { ok: true, written, characterId };
}

function cancelIngest(projectDir, characterId, body) {
  const sid = body && body.sessionId;
  if (!SAFE_SESSION.test(String(sid || ""))) throw ingestError("Invalid session");
  fs.rmSync(previewDir(projectDir, characterId, sid), { recursive: true, force: true });
  return { ok: true };
}

function saveCharacterStyle(projectDir, globalAssetsDir, characterId, style) {
  if (!isSafeFolderName(characterId)) throw ingestError("Invalid character id");
  if (typeof style !== "string") throw ingestError("style must be a string");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  character.style = style;
  writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, style: character.style };
}

module.exports = {
  previewIngest,
  confirmIngest,
  cancelIngest,
  saveCharacterStyle,
  ensureSlot,
  readWritableCharacter,
  destRelForCell,
  DRAWING_NAME,
};
