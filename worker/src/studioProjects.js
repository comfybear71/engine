"use strict";

/**
 * Project folders for the Studio home screen: summaries, empty templates,
 * script*.txt picking, and library.json references (global characters
 * added to a project without copying their art).
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./parser/tokenizer");
const { parseCastList } = require("./parser/actionTag");
const { slugify, estimateDurationSeconds } = require("./parser/scriptParser");
const {
  loadCharacter,
  listKnownCharacterIds,
  listKnownLocations,
  resolveAsset,
} = require("./parser/assetLibrary");

const DEFAULT_SCRIPT = "script.txt";
const LIBRARY_FILENAME = "library.json";
const SAFE_SCRIPT_NAME = /^script(?:_[A-Za-z0-9][A-Za-z0-9._-]*)?\.txt$/;
const EMPTY_SCRIPT_TEMPLATE = `# New Engine project
# Add a [Location: ...] and [Cast: ...] from the Library, then write dialogue.

[Scene: Scene 1]
`;

function isSafeScriptName(name) {
  if (typeof name !== "string" || !name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return SAFE_SCRIPT_NAME.test(name);
}

function scriptStem(scriptName) {
  const base = path.basename(String(scriptName || DEFAULT_SCRIPT));
  return base.replace(/\.txt$/i, "") || "script";
}

function renderOutputName(scriptName) {
  return `${scriptStem(scriptName)}.mp4`;
}

function resolveScriptName(value) {
  if (value == null || value === "") return DEFAULT_SCRIPT;
  const base = path.basename(String(value));
  if (!isSafeScriptName(base)) return null;
  return base;
}

function listScriptFiles(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir)
    .filter((name) => isSafeScriptName(name) && fs.statSync(path.join(projectDir, name)).isFile())
    .sort((a, b) => {
      if (a === DEFAULT_SCRIPT) return -1;
      if (b === DEFAULT_SCRIPT) return 1;
      return a.localeCompare(b);
    });
}

function emptyLibrary() {
  return { characters: [], backgrounds: [] };
}

function readLibrary(projectDir) {
  const libraryPath = path.join(projectDir, LIBRARY_FILENAME);
  if (!fs.existsSync(libraryPath)) return emptyLibrary();
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
    const characters = Array.isArray(raw.characters)
      ? raw.characters.filter((id) => typeof id === "string")
      : [];
    const backgrounds = Array.isArray(raw.backgrounds)
      ? raw.backgrounds.filter((id) => typeof id === "string")
      : [];
    return { characters, backgrounds };
  } catch {
    return emptyLibrary();
  }
}

function writeLibrary(projectDir, library) {
  const next = {
    characters: [...new Set(library.characters || [])].sort(),
    backgrounds: [...new Set(library.backgrounds || [])].sort(),
  };
  fs.writeFileSync(path.join(projectDir, LIBRARY_FILENAME), JSON.stringify(next, null, 2) + "\n");
  return next;
}

function listLocalDirIds(projectDir, folder) {
  const dir = path.join(projectDir, folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory())
    .sort();
}

function buildAliasIndex(projectDir, globalAssetsDir) {
  const aliasToId = new Map();
  for (const id of listKnownCharacterIds(projectDir, globalAssetsDir)) {
    const config = loadCharacter(projectDir, globalAssetsDir, id);
    if (!config) continue;
    const names = [config.id, config.display_name, ...(config.aliases || [])].filter(Boolean);
    for (const name of names) aliasToId.set(String(name).toLowerCase(), config.id);
  }
  return aliasToId;
}

function scanScriptUsage(scriptText, aliasToId, knownLocations) {
  const characterIds = new Set();
  const locationIds = new Set();
  let tokens;
  try {
    tokens = tokenize(scriptText);
  } catch {
    return { characterIds, locationIds };
  }
  for (const token of tokens) {
    if (token.kind === "cast") {
      for (const name of parseCastList(token.body || "")) {
        const id = aliasToId.get(name.toLowerCase());
        if (id) characterIds.add(id);
      }
    } else if (token.kind === "location") {
      const id = slugify(token.body || "");
      if (knownLocations.has(id)) locationIds.add(id);
    } else if (token.kind === "dialogue" && token.character) {
      const id = aliasToId.get(String(token.character).toLowerCase());
      if (id) characterIds.add(id);
    }
  }
  return { characterIds, locationIds };
}

function collectUsedAssets(projectDir, globalAssetsDir, options = {}) {
  const scripts = options.scripts || listScriptFiles(projectDir);
  const library = readLibrary(projectDir);
  const characterIds = new Set(library.characters);
  const locationIds = new Set(library.backgrounds);
  for (const id of listLocalDirIds(projectDir, "characters")) characterIds.add(id);
  for (const id of listLocalDirIds(projectDir, "backgrounds")) locationIds.add(id);

  const aliasToId = buildAliasIndex(projectDir, globalAssetsDir);
  const knownLocations = new Set(listKnownLocations(projectDir, globalAssetsDir));
  for (const scriptName of scripts) {
    const scriptPath = path.join(projectDir, scriptName);
    if (!fs.existsSync(scriptPath)) continue;
    const usage = scanScriptUsage(fs.readFileSync(scriptPath, "utf8"), aliasToId, knownLocations);
    for (const id of usage.characterIds) characterIds.add(id);
    for (const id of usage.locationIds) locationIds.add(id);
  }

  return {
    characterIds: [...characterIds].sort(),
    locationIds: [...locationIds].sort(),
    library,
    scripts,
  };
}

function estimateProjectLength(projectDir, scriptName) {
  const scripts = scriptName ? [scriptName] : listScriptFiles(projectDir);
  let seconds = 0;
  let sceneCount = 0;
  for (const name of scripts) {
    const scriptPath = path.join(projectDir, name);
    if (!fs.existsSync(scriptPath)) continue;
    let tokens;
    try {
      tokens = tokenize(fs.readFileSync(scriptPath, "utf8"));
    } catch {
      continue;
    }
    for (const token of tokens) {
      if (token.kind === "scene") sceneCount += 1;
      if (token.kind === "dialogue" && token.text) seconds += estimateDurationSeconds(token.text);
    }
  }
  return { durationSeconds: seconds > 0 ? Math.round(seconds * 10) / 10 : null, sceneCount };
}

function firstThumbRel(projectDir, globalAssetsDir, locationIds) {
  for (const loc of locationIds) {
    const rel = `backgrounds/${loc}/bg.png`;
    if (resolveAsset(projectDir, globalAssetsDir, rel)) return rel;
  }
  return null;
}

function newestRenderMtime(projectDir) {
  const dir = path.join(projectDir, "renders");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  let newest = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(mp4|mov)$/i.test(entry)) continue;
    const stat = fs.statSync(path.join(dir, entry));
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}

function summarizeProject(projectDir, name, globalAssetsDir) {
  const used = collectUsedAssets(projectDir, globalAssetsDir);
  const length = estimateProjectLength(projectDir, used.scripts[0] || DEFAULT_SCRIPT);
  return {
    name,
    scripts: used.scripts,
    thumbRel: firstThumbRel(projectDir, globalAssetsDir, used.locationIds),
    durationSeconds: length.durationSeconds,
    sceneCount: length.sceneCount,
    lastRenderAt: newestRenderMtime(projectDir),
  };
}

function createEmptyProject(projectsDir, name) {
  const projectDir = path.join(projectsDir, name);
  if (fs.existsSync(projectDir)) {
    const err = new Error(`Project already exists: ${name}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, DEFAULT_SCRIPT), EMPTY_SCRIPT_TEMPLATE);
  writeLibrary(projectDir, emptyLibrary());
  return projectDir;
}

function addLibraryCharacter(projectDir, globalAssetsDir, characterId) {
  if (typeof characterId !== "string" || !characterId) {
    const err = new Error("characterId is required");
    err.code = "EINVAL";
    throw err;
  }
  const known = listKnownCharacterIds(projectDir, globalAssetsDir);
  if (!known.includes(characterId)) {
    const err = new Error(`Unknown character: ${characterId}`);
    err.code = "ENOTFOUND";
    throw err;
  }
  const library = readLibrary(projectDir);
  if (!library.characters.includes(characterId)) {
    library.characters.push(characterId);
  }
  return writeLibrary(projectDir, library);
}

module.exports = {
  DEFAULT_SCRIPT,
  LIBRARY_FILENAME,
  EMPTY_SCRIPT_TEMPLATE,
  isSafeScriptName,
  scriptStem,
  renderOutputName,
  resolveScriptName,
  listScriptFiles,
  readLibrary,
  writeLibrary,
  collectUsedAssets,
  estimateProjectLength,
  summarizeProject,
  createEmptyProject,
  addLibraryCharacter,
  listLocalDirIds,
};
