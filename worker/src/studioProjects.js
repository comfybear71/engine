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
const { slugify } = require("./parser/scriptParser");
const { parseProject } = require("./parser");
const { probeDurationSeconds } = require("./parser/ffprobeDuration");
const { readMp4DurationSeconds } = require("./parser/mp4Duration");
const {
  loadCharacter,
  listKnownCharacterIds,
  listKnownLocations,
  resolveAsset,
} = require("./parser/assetLibrary");

const DEFAULT_SCRIPT = "script.txt";
const LIBRARY_FILENAME = "library.json";
const TRASH_DIR_NAME = "_trash";
const GLOBAL_ASSETS_NAME = "_global_assets";
const SAFE_SCRIPT_NAME = /^script(?:_[A-Za-z0-9][A-Za-z0-9._-]*)?\.txt$/;
const SAFE_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKIP_COPY_NAMES = new Set(["node_modules", "venv", ".venv", "tmp", "temp", "__pycache__", ".git"]);
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

function previewOutputName(scriptName) {
  return `${scriptStem(scriptName)}_preview.mp4`;
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

function countScriptScenes(projectDir, scriptName) {
  const scripts = scriptName ? [scriptName] : listScriptFiles(projectDir);
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
    }
  }
  return sceneCount;
}

function roundTenths(seconds) {
  return Math.round(seconds * 10) / 10;
}

function newestRenderPath(projectDir) {
  const dir = path.join(projectDir, "renders");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  let newest = 0;
  let newestPath = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(mp4|mov)$/i.test(entry)) continue;
    const abs = path.join(dir, entry);
    const stat = fs.statSync(abs);
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
      newestPath = abs;
    }
  }
  return newestPath;
}

async function durationFromRender(projectDir) {
  const renderPath = newestRenderPath(projectDir);
  if (!renderPath) return null;
  try {
    const probed = await probeDurationSeconds(renderPath);
    if (Number.isFinite(probed) && probed > 0) return roundTenths(probed);
  } catch {
    /* fall through to the movie header */
  }
  const header = readMp4DurationSeconds(renderPath);
  if (Number.isFinite(header) && header > 0) return roundTenths(header);
  return null;
}

async function durationFromParsedTimeline(projectDir, scriptName) {
  try {
    const parsed = await parseProject(projectDir, { script: scriptName || DEFAULT_SCRIPT });
    const fps = (parsed.timeline && parsed.timeline.fps) || 24;
    const frames = (parsed.sceneLengths || []).reduce((sum, scene) => sum + (scene.frames || 0), 0);
    if (frames > 0 && fps > 0) return roundTenths(frames / fps);
  } catch {
    return null;
  }
  return null;
}

async function resolveProjectDuration(projectDir, scriptName) {
  const fromRender = await durationFromRender(projectDir);
  if (fromRender != null) return fromRender;
  return durationFromParsedTimeline(projectDir, scriptName);
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

async function summarizeProject(projectDir, name, globalAssetsDir) {
  const used = collectUsedAssets(projectDir, globalAssetsDir);
  const scriptName = used.scripts[0] || DEFAULT_SCRIPT;
  const durationSeconds = await resolveProjectDuration(projectDir, scriptName);
  return {
    name,
    scripts: used.scripts,
    thumbRel: firstThumbRel(projectDir, globalAssetsDir, used.locationIds),
    durationSeconds,
    sceneCount: countScriptScenes(projectDir, scriptName),
    lastRenderAt: newestRenderMtime(projectDir),
  };
}

function isSafeFolderName(name) {
  return typeof name === "string" && SAFE_FOLDER_NAME.test(name);
}

function isReservedName(name) {
  return name === GLOBAL_ASSETS_NAME || name === TRASH_DIR_NAME;
}

function resolveInside(root, name) {
  if (!isSafeFolderName(name) || isReservedName(name)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, name);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    return null;
  }
  return resolved;
}

function trashRoot(projectsDir) {
  return path.resolve(projectsDir, TRASH_DIR_NAME);
}

function originalNameFromTrash(folder) {
  const match = String(folder).match(/^(.*)-(\d+)$/);
  return match ? match[1] : folder;
}

function walkStats(absPath) {
  const files = [];
  let bytes = 0;
  if (!fs.existsSync(absPath)) return { files: 0, bytes: 0 };
  const stat = fs.statSync(absPath);
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  const stack = [absPath];
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
        if (SKIP_COPY_NAMES.has(entry.name)) continue;
        stack.push(child);
      } else if (entry.isFile()) {
        files.push(child);
        try {
          bytes += fs.statSync(child).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { files: files.length, bytes };
}

function describeProjectContents(projectDir) {
  const scripts = listScriptFiles(projectDir);
  let scriptBytes = 0;
  for (const name of scripts) {
    try {
      scriptBytes += fs.statSync(path.join(projectDir, name)).size;
    } catch {
      /* ignore */
    }
  }
  const audio = walkStats(path.join(projectDir, "audio"));
  const renders = walkStats(path.join(projectDir, "renders"));
  const characters = walkStats(path.join(projectDir, "characters"));
  const backgrounds = walkStats(path.join(projectDir, "backgrounds"));
  const libraryPath = path.join(projectDir, LIBRARY_FILENAME);
  const libraryJsonBytes = fs.existsSync(libraryPath) ? fs.statSync(libraryPath).size : 0;
  const localAssets = {
    files: characters.files + backgrounds.files,
    bytes: characters.bytes + backgrounds.bytes,
  };
  return {
    scripts,
    scriptBytes,
    audio,
    renders,
    localAssets,
    libraryJsonBytes,
    totalBytes: scriptBytes + audio.bytes + renders.bytes + localAssets.bytes + libraryJsonBytes,
  };
}

function assertManagedProject(projectsDir, name) {
  if (isReservedName(name) || !isSafeFolderName(name)) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  const projectDir = resolveInside(projectsDir, name);
  if (!projectDir) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    const err = new Error(`Project not found: ${name}`);
    err.code = "ENOENT";
    throw err;
  }
  return projectDir;
}

function moveProjectToTrash(projectsDir, name) {
  const projectDir = assertManagedProject(projectsDir, name);
  const root = path.resolve(projectsDir);
  const globalDir = path.resolve(root, GLOBAL_ASSETS_NAME);
  if (path.resolve(projectDir) === globalDir) {
    const err = new Error("Cannot delete _global_assets");
    err.code = "EINVAL";
    throw err;
  }
  const trashDir = trashRoot(projectsDir);
  fs.mkdirSync(trashDir, { recursive: true });
  const trashName = `${name}-${Date.now()}`;
  if (!SAFE_FOLDER_NAME.test(trashName)) {
    const err = new Error("Invalid trash name");
    err.code = "EINVAL";
    throw err;
  }
  const dest = path.resolve(trashDir, trashName);
  const rel = path.relative(path.resolve(trashDir), dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("Invalid trash name");
    err.code = "EINVAL";
    throw err;
  }
  fs.renameSync(projectDir, dest);
  return { id: trashName, originalName: name, deletedAt: new Date().toISOString() };
}

function listTrash(projectsDir) {
  const dir = trashRoot(projectsDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_FOLDER_NAME.test(entry.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const match = entry.name.match(/-(\d+)$/);
      const deletedAt = match ? new Date(Number(match[1])).toISOString() : fs.statSync(full).mtime.toISOString();
      return {
        id: entry.name,
        originalName: originalNameFromTrash(entry.name),
        deletedAt,
        bytes: walkStats(full).bytes,
      };
    })
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

function resolveTrashEntry(projectsDir, trashName) {
  if (!isSafeFolderName(trashName) || isReservedName(trashName)) return null;
  const dir = trashRoot(projectsDir);
  const resolved = path.resolve(dir, trashName);
  const rel = path.relative(path.resolve(dir), resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    return null;
  }
  return resolved;
}

function restoreFromTrash(projectsDir, trashName) {
  const src = resolveTrashEntry(projectsDir, trashName);
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    const err = new Error(`Trash item not found: ${trashName}`);
    err.code = "ENOENT";
    throw err;
  }
  const originalName = originalNameFromTrash(trashName);
  const dest = resolveInside(projectsDir, originalName);
  if (!dest) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  if (fs.existsSync(dest)) {
    const err = new Error(`Project already exists: ${originalName}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.renameSync(src, dest);
  return { name: originalName, projectDir: dest };
}

function emptyTrash(projectsDir) {
  const dir = trashRoot(projectsDir);
  if (!fs.existsSync(dir)) return { removed: 0 };
  const entries = fs.readdirSync(dir).filter((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { removed: entries.length };
}

function renameProject(projectsDir, name, newName) {
  if (newName === name) {
    return { name, projectDir: assertManagedProject(projectsDir, name) };
  }
  const projectDir = assertManagedProject(projectsDir, name);
  const dest = resolveInside(projectsDir, newName);
  if (!dest) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  if (fs.existsSync(dest)) {
    const err = new Error(`Project already exists: ${newName}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.renameSync(projectDir, dest);
  return { name: newName, projectDir: dest };
}

function nextDuplicateName(projectsDir, name) {
  const base = `${name}-copy`;
  if (!fs.existsSync(path.join(projectsDir, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(path.join(projectsDir, candidate))) return candidate;
  }
  const err = new Error("Too many copies");
  err.code = "EINVAL";
  throw err;
}

function duplicateProject(projectsDir, name) {
  const projectDir = assertManagedProject(projectsDir, name);
  const copyName = nextDuplicateName(projectsDir, name);
  const dest = resolveInside(projectsDir, copyName);
  if (!dest) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  fs.cpSync(projectDir, dest, {
    recursive: true,
    filter: (src) => !SKIP_COPY_NAMES.has(path.basename(src)),
  });
  return { name: copyName, projectDir: dest };
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
  TRASH_DIR_NAME,
  GLOBAL_ASSETS_NAME,
  EMPTY_SCRIPT_TEMPLATE,
  SKIP_COPY_NAMES,
  isSafeScriptName,
  isSafeFolderName,
  scriptStem,
  renderOutputName,
  previewOutputName,
  resolveScriptName,
  listScriptFiles,
  readLibrary,
  writeLibrary,
  collectUsedAssets,
  countScriptScenes,
  resolveProjectDuration,
  summarizeProject,
  describeProjectContents,
  moveProjectToTrash,
  listTrash,
  restoreFromTrash,
  emptyTrash,
  renameProject,
  duplicateProject,
  createEmptyProject,
  addLibraryCharacter,
  listLocalDirIds,
};
