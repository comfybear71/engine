"use strict";

/**
 * Soft-delete project assets into projects/<name>/.trash/<timestamp>/.
 * Never hard-deletes. Script-used sounds (and other items) report usages.
 */

const fs = require("fs");
const path = require("path");

const { listScriptFiles } = require("./studioProjects");
const { tokenize } = require("./parser/tokenizer");
const { parseActionTag } = require("./parser/actionTag");
const { resolveAsset } = require("./parser/assetLibrary");

const TRASH_DIR = ".trash";
const SAFE_REL = /^(audio|backgrounds|props|characters|actions)\/[A-Za-z0-9._/-]+$/;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function toPosix(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function assertSafeRel(rel) {
  const posix = toPosix(rel);
  if (!posix || posix.includes("..") || posix.startsWith("/") || !SAFE_REL.test(posix)) {
    const err = new Error(`Unsafe asset path: ${rel}`);
    err.code = "EBADPATH";
    throw err;
  }
  return posix;
}

function absInProject(projectDir, rel) {
  const posix = assertSafeRel(rel);
  const abs = path.resolve(projectDir, posix);
  const root = path.resolve(projectDir);
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const err = new Error("Path is outside the project");
    err.code = "EBADPATH";
    throw err;
  }
  return abs;
}

function collectTree(abs) {
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    out.push(...collectTree(path.join(abs, name)));
  }
  return out;
}

function moveToProjectTrash(projectDir, rels) {
  const destRoot = path.join(projectDir, TRASH_DIR, stamp());
  const moved = [];
  for (const rel of rels) {
    const posix = assertSafeRel(rel);
    const src = absInProject(projectDir, posix);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destRoot, posix);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    moved.push({ from: posix, to: toPosix(path.relative(projectDir, dest)) });
  }
  if (!moved.length) {
    const err = new Error("Nothing to delete");
    err.code = "ENOTFOUND";
    throw err;
  }
  return { trash: toPosix(path.relative(projectDir, destRoot)), moved };
}

function scriptUsages(projectDir, matchFn) {
  const usages = [];
  for (const script of listScriptFiles(projectDir)) {
    const abs = path.join(projectDir, script);
    let tokens;
    try {
      tokens = tokenize(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const token of tokens) {
      if (matchFn(token, script)) {
        usages.push({
          script,
          line: token.lineNumber,
          text: String(token.raw || "").trim(),
        });
      }
    }
  }
  return usages;
}

function findSoundUsages(projectDir, label) {
  const want = String(label || "").toLowerCase();
  return scriptUsages(projectDir, (token) => {
    if (token.kind !== "audio") return false;
    const parsed = parseActionTag(token.body || "", { bareFlags: [] });
    const file = String(parsed.kv.file || parsed.kv.name || "").toLowerCase();
    return file === want;
  });
}

function findLocationUsages(projectDir, locationId) {
  const want = String(locationId || "").toLowerCase();
  return scriptUsages(projectDir, (token) => {
    if (token.kind !== "location") return false;
    const name = String(token.body || "")
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
    return name === want;
  });
}

function findPropUsages(projectDir, propId) {
  const want = String(propId || "").toLowerCase();
  return scriptUsages(projectDir, (token) => {
    if (token.kind !== "prop") return false;
    const parsed = parseActionTag(token.body || "", { bareFlags: ["hide", "show"] });
    const name = String(parsed.character || parsed.kv.prop || "")
      .toLowerCase();
    return name === want;
  });
}

function findActionUsages(projectDir, actionId) {
  const want = String(actionId || "").toLowerCase();
  return scriptUsages(projectDir, (token) => {
    if (token.kind === "do") {
      const parsed = parseActionTag(token.body || "", { allowPositional: true });
      const id = String(parsed.positional[0] || parsed.kv.action || "")
        .toLowerCase()
        .split(/\s+/)[0];
      return id === want;
    }
    if (token.kind === "move" || token.kind === "action") {
      const parsed = parseActionTag(token.body || "", { bareFlags: ["hide", "show", "flip"] });
      return String(parsed.kv.action || "").toLowerCase() === want;
    }
    return false;
  });
}

function usedMessage(usages) {
  const scripts = [...new Set(usages.map((item) => item.script))];
  if (!scripts.length) return "";
  return `Used in ${scripts.join(", ")}`;
}

function trashSound(projectDir, label, body) {
  const folder = `audio/${label}`;
  const abs = absInProject(projectDir, folder);
  if (!fs.existsSync(abs)) {
    const err = new Error(`Unknown sound: ${label}`);
    err.code = "ENOTFOUND";
    throw err;
  }
  const usages = findSoundUsages(projectDir, label);
  if (usages.length && !(body && body.force === true)) {
    const err = new Error(usedMessage(usages));
    err.code = "EUSED";
    err.usages = usages;
    throw err;
  }
  return { ...moveToProjectTrash(projectDir, [folder]), usages };
}

function trashBackground(projectDir, globalAssetsDir, locationId, body) {
  const rel = `backgrounds/${locationId}`;
  const resolved = resolveAsset(projectDir, globalAssetsDir, `backgrounds/${locationId}/bg.png`);
  if (resolved && resolved.source !== "project") {
    const err = new Error("This background is from the shared library and can't be deleted from this project.");
    err.code = "ELOCKED";
    throw err;
  }
  const usages = findLocationUsages(projectDir, locationId);
  if (usages.length && !(body && body.force === true)) {
    const err = new Error(usedMessage(usages));
    err.code = "EUSED";
    err.usages = usages;
    throw err;
  }
  return { ...moveToProjectTrash(projectDir, [rel]), usages };
}

function trashProp(projectDir, globalAssetsDir, locationId, propId, rel, body) {
  const posix = assertSafeRel(rel || `backgrounds/${locationId}/props/${propId}.png`);
  const resolved = resolveAsset(projectDir, globalAssetsDir, posix);
  if (resolved && resolved.source !== "project") {
    const err = new Error("This prop is from the shared library and can't be deleted from this project.");
    err.code = "ELOCKED";
    throw err;
  }
  const usages = findPropUsages(projectDir, propId);
  if (usages.length && !(body && body.force === true)) {
    const err = new Error(usedMessage(usages));
    err.code = "EUSED";
    err.usages = usages;
    throw err;
  }
  return { ...moveToProjectTrash(projectDir, [posix]), usages };
}

function trashAction(projectDir, characterId, actionId, body) {
  const rel = `characters/${characterId}/actions/${actionId}.json`;
  const usages = findActionUsages(projectDir, actionId);
  if (usages.length && !(body && body.force === true)) {
    const err = new Error(usedMessage(usages));
    err.code = "EUSED";
    err.usages = usages;
    throw err;
  }
  return { ...moveToProjectTrash(projectDir, [rel]), usages };
}

function trashAsset(projectDir, globalAssetsDir, body) {
  if (!(body && body.confirm === true)) {
    const err = new Error("Delete needs confirm: true");
    err.code = "ECONFIRM";
    throw err;
  }
  const kind = body.kind;
  if (kind === "sound") return trashSound(projectDir, body.label || body.id, body);
  if (kind === "background") return trashBackground(projectDir, globalAssetsDir, body.id, body);
  if (kind === "prop") return trashProp(projectDir, globalAssetsDir, body.location, body.id, body.rel, body);
  if (kind === "action") return trashAction(projectDir, body.characterId, body.id, body);
  const err = new Error(`Unknown asset kind: ${kind}`);
  err.code = "EBADKIND";
  throw err;
}

module.exports = {
  TRASH_DIR,
  findSoundUsages,
  findLocationUsages,
  findPropUsages,
  findActionUsages,
  moveToProjectTrash,
  trashAsset,
  usedMessage,
  collectTree,
};
