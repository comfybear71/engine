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
    });
  }
  return files;
}

module.exports = { listProjectAudio, listSceneIds };
