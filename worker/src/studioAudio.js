"use strict";

/**
 * Project audio files for the Stage Assets tree: imported
 * `audio/<label>/001_<character>.wav` takes and generated
 * `audio/<scene>/<nnn>_<character>.wav` line files.
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./parser/tokenizer");
const { slugify } = require("./parser/scriptParser");
const { readWavDurationSeconds } = require("./parser/wavDuration");
const { loadCharacter, listKnownCharacterIds } = require("./parser/assetLibrary");
const { listScriptFiles } = require("./studioProjects");

const WAV_NAME_RE = /^(\d{3})_([A-Za-z0-9][A-Za-z0-9._-]*)\.wav$/i;

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function listSceneIds(projectDir) {
  const ids = new Set();
  for (const name of listScriptFiles(projectDir)) {
    const abs = path.join(projectDir, name);
    if (!fs.existsSync(abs)) continue;
    let tokens;
    try {
      tokens = tokenize(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const token of tokens) {
      if (token.kind === "scene" && token.body) ids.add(slugify(token.body));
    }
  }
  return ids;
}

function characterIndex(projectDir, globalAssetsDir) {
  const byId = new Map();
  for (const id of listKnownCharacterIds(projectDir, globalAssetsDir)) {
    const character = loadCharacter(projectDir, globalAssetsDir, id);
    if (!character) continue;
    byId.set(id, character.display_name || id);
  }
  return byId;
}

function walkWavs(audioDir) {
  const out = [];
  if (!fs.existsSync(audioDir) || !fs.statSync(audioDir).isDirectory()) return out;
  const stack = [audioDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile() || !/\.wav$/i.test(entry.name)) continue;
      out.push(child);
    }
  }
  return out.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

function readWavPeaks(absPath, buckets = 48) {
  const peaks = Array.from({ length: buckets }, () => 0);
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 44) return peaks;
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return peaks;
    let offset = 12;
    let channels = 1;
    let bits = 16;
    let dataOffset = 0;
    let dataSize = 0;
    const chunkHead = Buffer.alloc(8);
    while (offset + 8 <= fileSize) {
      fs.readSync(fd, chunkHead, 0, 8, offset);
      const id = chunkHead.toString("ascii", 0, 4);
      const size = chunkHead.readUInt32LE(4);
      const payload = offset + 8;
      if (id === "fmt " && size >= 16) {
        const fmt = Buffer.alloc(16);
        fs.readSync(fd, fmt, 0, 16, payload);
        channels = fmt.readUInt16LE(2) || 1;
        bits = fmt.readUInt16LE(14) || 16;
      } else if (id === "data") {
        dataOffset = payload;
        dataSize = size;
        break;
      }
      offset = payload + size + (size % 2);
    }
    if (!dataSize || !dataOffset) return peaks;
    const bytesPerSample = Math.max(1, Math.round(bits / 8));
    const frameSize = bytesPerSample * channels;
    const frames = Math.floor(dataSize / frameSize);
    if (frames <= 0) return peaks;
    const maxRead = Math.min(dataSize, 512 * 1024);
    const buf = Buffer.alloc(maxRead);
    fs.readSync(fd, buf, 0, maxRead, dataOffset);
    const usableFrames = Math.floor(buf.length / frameSize);
    for (let i = 0; i < usableFrames; i += 1) {
      const bucket = Math.min(buckets - 1, Math.floor((i / usableFrames) * buckets));
      let amp = 0;
      if (bits === 16) amp = Math.abs(buf.readInt16LE(i * frameSize)) / 32768;
      else if (bits === 8) amp = Math.abs(buf[i * frameSize] - 128) / 128;
      else amp = Math.abs(buf.readInt16LE(i * frameSize)) / 32768;
      if (amp > peaks[bucket]) peaks[bucket] = amp;
    }
    return peaks.map((value) => Math.round(value * 1000) / 1000);
  } catch {
    return peaks;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function listProjectAudio(projectDir, globalAssetsDir) {
  const sceneIds = listSceneIds(projectDir);
  const names = characterIndex(projectDir, globalAssetsDir);
  const audioDir = path.join(projectDir, "audio");
  const files = [];
  for (const abs of walkWavs(audioDir)) {
    const rel = toPosix(path.relative(projectDir, abs));
    const parts = rel.split("/");
    if (parts[0] !== "audio" || parts.length < 3) continue;
    const folder = parts[1];
    const base = parts[parts.length - 1];
    const match = base.match(WAV_NAME_RE);
    if (!match) continue;
    const characterId = match[2].toLowerCase();
    let durationSeconds = null;
    try {
      durationSeconds = readWavDurationSeconds(abs);
    } catch {
      durationSeconds = null;
    }
    let mtime = null;
    try {
      mtime = Math.round(fs.statSync(abs).mtimeMs);
    } catch {
      mtime = null;
    }
    const kind = sceneIds.has(folder) ? "generated" : "imported";
    files.push({
      kind,
      label: folder,
      sceneId: kind === "generated" ? folder : null,
      characterId,
      characterName: names.get(characterId) || match[2],
      rel,
      durationSeconds,
      mtime,
      peaks: readWavPeaks(abs),
    });
  }
  return files;
}

module.exports = { listProjectAudio, listSceneIds, readWavPeaks };
