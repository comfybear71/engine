"use strict";

/**
 * Disk + memory cache of composed preview frames. Keyed by script
 * fingerprint + image-asset mtimes + frame + format.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { fingerprintParseInputs, fingerprintAssets } = require("./parser/parseCache");

const MEM_LIMIT = 48;
const memory = new Map();

function cacheDir() {
  const dir = path.join(os.tmpdir(), "engine-preview-frames");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function previewCacheKey(projectDir, scriptName, frame, format, quality, width, height) {
  const parseFp = fingerprintParseInputs(projectDir, scriptName);
  const assetFp = fingerprintAssets(projectDir);
  return crypto
    .createHash("sha1")
    .update(`${parseFp}|${assetFp}|${frame}|${format}|${quality || ""}|${width || ""}|${height || ""}`)
    .digest("hex");
}

function remember(key, entry) {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MEM_LIMIT) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
  return entry;
}

function readDisk(key, type) {
  const ext = type === "image/jpeg" ? "jpg" : "png";
  const file = path.join(cacheDir(), `${key}.${ext}`);
  const metaFile = path.join(cacheDir(), `${key}.json`);
  if (!fs.existsSync(file) || !fs.existsSync(metaFile) || fs.statSync(file).size === 0) {
    return null;
  }
  return {
    buffer: fs.readFileSync(file),
    type,
    meta: JSON.parse(fs.readFileSync(metaFile, "utf8")),
    path: file,
  };
}

function writeDisk(key, type, buffer, meta) {
  const ext = type === "image/jpeg" ? "jpg" : "png";
  const file = path.join(cacheDir(), `${key}.${ext}`);
  const metaFile = path.join(cacheDir(), `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  return file;
}

function getCachedPreview(projectDir, scriptName, frame, format, quality, width, height) {
  const key = previewCacheKey(projectDir, scriptName, frame, format, quality, width, height);
  const type = format === "png" ? "image/png" : "image/jpeg";
  const mem = memory.get(key);
  if (mem) {
    remember(key, mem);
    return { ...mem, key };
  }
  const disk = readDisk(key, type);
  if (disk) {
    remember(key, { buffer: disk.buffer, type: disk.type, meta: disk.meta });
    return { ...disk, key };
  }
  return { key, type, miss: true };
}

function storePreview(key, type, buffer, meta) {
  writeDisk(key, type, buffer, meta);
  return remember(key, { buffer, type, meta });
}

function resetPreviewCache() {
  memory.clear();
}

module.exports = {
  previewCacheKey,
  getCachedPreview,
  storePreview,
  resetPreviewCache,
  cacheDir,
};
