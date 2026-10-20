"use strict";

/**
 * Project folders for the Studio home screen: summaries, empty templates,
 * script*.txt picking, and library.json plus copied-in global characters.
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./parser/tokenizer");
const { parseCastList } = require("./parser/actionTag");
const { slugify } = require("./parser/scriptParser");
const { probeDurationSeconds } = require("./parser/ffprobeDuration");
const { getCachedParse } = require("./parser/parseCache");
const { readMp4DurationSeconds } = require("./parser/mp4Duration");
const {
  loadCharacter,
  listKnownCharacterIds,
  listKnownLocations,
  resolveAsset,
  resolveShowAssetsDir,
} = require("./parser/assetLibrary");
const { writeStudioSettings } = require("./voices/lipSync");

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

function normalizeNewScriptName(raw) {
  let stem = String(raw || "").trim();
  if (!stem) return null;
  stem = stem.replace(/\.txt$/i, "");
  if (!/^script(?:_|$)/i.test(stem)) stem = `script_${stem}`;
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const name = /\.txt$/i.test(stem) ? stem : `${stem}.txt`;
  return isSafeScriptName(name) ? name : null;
}

function nextNewScriptName(existing) {
  const used = new Set(existing || []);
  if (!used.has("script_new.txt")) return "script_new.txt";
  let n = 2;
  while (used.has(`script_new_${n}.txt`)) n += 1;
  return `script_new_${n}.txt`;
}

function createScriptFile(projectDir, requested) {
  const existing = listScriptFiles(projectDir);
  const name = requested ? normalizeNewScriptName(requested) : nextNewScriptName(existing);
  if (!name) {
    const err = new Error("Use a short name like walk or script_walk.txt");
    err.code = "INVALID_SCRIPT";
    throw err;
  }
  if (existing.includes(name)) {
    const err = new Error(`${name} already exists`);
    err.code = "SCRIPT_EXISTS";
    throw err;
  }
  fs.writeFileSync(path.join(projectDir, name), EMPTY_SCRIPT_TEMPLATE);
  return name;
}

const SCRIPT_TRASH_DIR = path.join(TRASH_DIR_NAME, "scripts");

/**
 * Moves one script*.txt into <project>/_trash/scripts/<timestamp>__<name>.
 * Never a hard delete, and never the project's last script (the editor needs
 * one open). Its .history snapshots stay where they are.
 */
function trashScriptFile(projectDir, requested) {
  const name = typeof requested === "string" && isSafeScriptName(requested) ? requested : null;
  if (!name) {
    const err = new Error("Not a script file name");
    err.code = "INVALID_SCRIPT";
    throw err;
  }
  const existing = listScriptFiles(projectDir);
  if (!existing.includes(name)) {
    const err = new Error(`${name} does not exist`);
    err.code = "SCRIPT_MISSING";
    throw err;
  }
  if (existing.length <= 1) {
    const err = new Error("This is the only script in the project. Create another one first.");
    err.code = "LAST_SCRIPT";
    throw err;
  }
  const destDir = path.join(projectDir, SCRIPT_TRASH_DIR);
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = path.join(destDir, `${stamp}__${name}`);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(destDir, `${stamp}_${n++}__${name}`);
  fs.renameSync(path.join(projectDir, name), dest);
  return { name, trashedTo: path.posix.join(TRASH_DIR_NAME, "scripts", path.basename(dest)) };
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

function listScriptRecords(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  const records = [];
  for (const name of fs.readdirSync(projectDir)) {
    if (!isSafeScriptName(name)) continue;
    const abs = path.join(projectDir, name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    records.push({
      name,
      mtime: Math.round(stat.mtimeMs),
      birthtime: Math.round(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
    });
  }
  return records.sort((a, b) => {
    if (a.name === DEFAULT_SCRIPT) return -1;
    if (b.name === DEFAULT_SCRIPT) return 1;
    return a.name.localeCompare(b.name);
  });
}

function scriptRecency(record) {
  return Math.max(Number(record && record.mtime) || 0, Number(record && record.birthtime) || 0);
}

function newestScriptName(records, fallback = DEFAULT_SCRIPT) {
  if (!records || !records.length) return fallback;
  let best = records[0];
  for (const item of records) {
    const age = scriptRecency(item);
    const bestAge = scriptRecency(best);
    if (age > bestAge || (age === bestAge && item.name.localeCompare(best.name) < 0)) best = item;
  }
  return best.name;
}

function listScriptFiles(projectDir) {
  return listScriptRecords(projectDir).map((item) => item.name);
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

function buildAliasIndex(projectDir, globalAssetsDir, options) {
  const aliasToId = new Map();
  for (const id of listKnownCharacterIds(projectDir, globalAssetsDir, options)) {
    const config = loadCharacter(projectDir, globalAssetsDir, id, options);
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
  const searchOpts = options.includeGlobal != null ? { includeGlobal: options.includeGlobal } : undefined;
  const library = readLibrary(projectDir);
  const characterIds = new Set(library.characters);
  const locationIds = new Set(library.backgrounds);
  for (const id of listLocalDirIds(projectDir, "characters")) characterIds.add(id);
  for (const id of listLocalDirIds(projectDir, "backgrounds")) locationIds.add(id);

  const aliasToId = buildAliasIndex(projectDir, globalAssetsDir, searchOpts);
  const knownLocations = new Set(listKnownLocations(projectDir, globalAssetsDir, searchOpts));
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
  const header = readMp4DurationSeconds(renderPath);
  if (Number.isFinite(header) && header > 0) return roundTenths(header);
  try {
    const probed = await probeDurationSeconds(renderPath);
    if (Number.isFinite(probed) && probed > 0) return roundTenths(probed);
  } catch {
    /* no usable duration */
  }
  return null;
}

async function durationFromParsedTimeline(projectDir, scriptName) {
  try {
    const parsed = await getCachedParse(projectDir, { script: scriptName || DEFAULT_SCRIPT });
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

function resolvedMtime(projectDir, globalAssetsDir, rel) {
  if (!rel) return null;
  const resolved = resolveAsset(projectDir, globalAssetsDir, rel);
  if (!resolved) return null;
  try {
    return Math.round(fs.statSync(resolved.absPath).mtimeMs);
  } catch {
    return null;
  }
}

function projectSummaryFingerprint(projectDir) {
  const parts = [];
  function add(abs) {
    try {
      const stat = fs.statSync(abs);
      parts.push(`${abs}\t${stat.mtimeMs}\t${stat.size}`);
    } catch {
      parts.push(`${abs}\tmissing`);
    }
  }
  add(projectDir);
  for (const script of listScriptFiles(projectDir)) add(path.join(projectDir, script));
  add(path.join(projectDir, LIBRARY_FILENAME));
  const rendersDir = path.join(projectDir, "renders");
  add(rendersDir);
  if (fs.existsSync(rendersDir) && fs.statSync(rendersDir).isDirectory()) {
    for (const entry of fs.readdirSync(rendersDir)) {
      if (/\.(mp4|mov)$/i.test(entry)) add(path.join(rendersDir, entry));
    }
  }
  const audioDir = path.join(projectDir, "audio");
  if (fs.existsSync(audioDir)) {
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
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile() && /\.wav$/i.test(entry.name)) add(child);
      }
    }
  }
  return parts.join("\n");
}

const summaryCache = new Map();

async function summarizeProject(projectDir, name, globalAssetsDir) {
  const used = collectUsedAssets(projectDir, globalAssetsDir);
  const scriptName = used.scripts[0] || DEFAULT_SCRIPT;
  const durationSeconds = await resolveProjectDuration(projectDir, scriptName);
  const thumbRel = firstThumbRel(projectDir, globalAssetsDir, used.locationIds);
  const showDir = resolveShowAssetsDir(projectDir);
  return {
    name,
    showId: showDir ? path.basename(showDir) : null,
    scripts: used.scripts,
    thumbRel,
    thumbMtime: resolvedMtime(projectDir, globalAssetsDir, thumbRel),
    durationSeconds,
    sceneCount: countScriptScenes(projectDir, scriptName),
    lastRenderAt: newestRenderMtime(projectDir),
  };
}

async function summarizeProjectCached(projectDir, name, globalAssetsDir) {
  const fp = projectSummaryFingerprint(projectDir);
  const hit = summaryCache.get(projectDir);
  if (hit && hit.fp === fp) return hit.summary;
  const summary = await summarizeProject(projectDir, name, globalAssetsDir);
  summaryCache.set(projectDir, { fp, summary });
  return summary;
}

function resetSummaryCache() {
  summaryCache.clear();
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
  const match = String(folder).match(/^(?:show-)?(.*)-(\d+)$/);
  return match ? match[1] : folder;
}

const TRASH_META_FILENAME = "engine-trash.json";

function writeTrashMeta(folder, meta) {
  fs.writeFileSync(path.join(folder, TRASH_META_FILENAME), JSON.stringify(meta, null, 2) + "\n");
}

function readTrashMeta(folder) {
  const file = path.join(folder, TRASH_META_FILENAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

function moveFolderToTrash(trashHome, folderDir, originalName, meta) {
  const trashDir = trashRoot(trashHome);
  fs.mkdirSync(trashDir, { recursive: true });
  const prefix = meta && meta.kind === "show" ? "show-" : "";
  const trashName = `${prefix}${originalName}-${Date.now()}`;
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
  fs.renameSync(folderDir, dest);
  if (meta) writeTrashMeta(dest, { ...meta, originalName });
  return {
    id: trashName,
    originalName,
    deletedAt: new Date().toISOString(),
    kind: (meta && meta.kind) || "project",
    showId: (meta && meta.showId) || null,
  };
}

function moveProjectToTrash(projectsDir, name, options = {}) {
  const parentDir = options.parentDir || projectsDir;
  const projectDir = assertManagedProject(parentDir, name);
  const root = path.resolve(projectsDir);
  const globalDir = path.resolve(root, GLOBAL_ASSETS_NAME);
  if (path.resolve(projectDir) === globalDir) {
    const err = new Error("Cannot delete _global_assets");
    err.code = "EINVAL";
    throw err;
  }
  return moveFolderToTrash(projectsDir, projectDir, name, options.meta || null);
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
      const meta = readTrashMeta(full);
      return {
        id: entry.name,
        originalName: (meta && meta.originalName) || originalNameFromTrash(entry.name),
        deletedAt,
        bytes: walkStats(full).bytes,
        kind: (meta && meta.kind) || "project",
        showId: (meta && meta.showId) || null,
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

function restoreFromTrash(projectsDir, trashName, options = {}) {
  const src = resolveTrashEntry(projectsDir, trashName);
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    const err = new Error(`Trash item not found: ${trashName}`);
    err.code = "ENOENT";
    throw err;
  }
  const meta = readTrashMeta(src);
  const originalName = (meta && meta.originalName) || originalNameFromTrash(trashName);
  let dest;
  let kind = (meta && meta.kind) || "project";
  if (kind === "show") {
    const showsDir = options.showsDir;
    if (!showsDir) {
      const err = new Error("Cannot restore a show without a shows folder");
      err.code = "EINVAL";
      throw err;
    }
    dest = resolveInside(showsDir, originalName);
  } else if (kind === "episode") {
    const showsDir = options.showsDir;
    const showId = meta && meta.showId;
    if (!showsDir || !showId) {
      const err = new Error("Cannot restore an episode without its show");
      err.code = "EINVAL";
      throw err;
    }
    dest = path.resolve(showsDir, showId, "episodes", originalName);
    const episodesRoot = path.resolve(showsDir, showId, "episodes");
    fs.mkdirSync(episodesRoot, { recursive: true });
    const rel = path.relative(episodesRoot, dest);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      const err = new Error("Invalid episode name");
      err.code = "EINVAL";
      throw err;
    }
  } else {
    dest = resolveInside(projectsDir, originalName);
  }
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
  const metaFile = path.join(src, TRASH_META_FILENAME);
  if (fs.existsSync(metaFile)) fs.rmSync(metaFile);
  fs.renameSync(src, dest);
  return { name: originalName, projectDir: dest, kind, showId: (meta && meta.showId) || null };
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
  writeStudioSettings(projectDir, { independent: true });
  return projectDir;
}

const SKIP_GLOBAL_COPY_DIRS = new Set(["_trash", "_replaced", "_preview", "_backup"]);

function wasRemovedLocally(projectDir, libraryRel) {
  const posix = String(libraryRel || "").replace(/\\/g, "/");
  const match = posix.match(/^characters\/([^/]+)\/(.+)$/);
  if (!match) return false;
  const characterId = match[1];
  const rest = match[2];
  const charDir = path.join(projectDir, "characters", characterId);
  for (const folder of ["_trash", "_replaced"]) {
    const root = path.join(charDir, folder);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    let stamps;
    try {
      stamps = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      if (!stamp.isDirectory()) continue;
      if (fs.existsSync(path.join(root, stamp.name, rest))) return true;
    }
  }
  return false;
}

function copyTreeFromGlobal(srcDir, destDir, options = {}) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return { files: 0 };
  let files = 0;
  const stack = [[srcDir, destDir, ""]];
  while (stack.length) {
    const [from, to, rel] = stack.pop();
    fs.mkdirSync(to, { recursive: true });
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_GLOBAL_COPY_DIRS.has(entry.name)) continue;
      const childFrom = path.join(from, entry.name);
      const childTo = path.join(to, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push([childFrom, childTo, childRel]);
      } else if (entry.isFile()) {
        if (fs.existsSync(childTo)) continue;
        if (options.skipRel && options.skipRel(childRel)) continue;
        fs.mkdirSync(path.dirname(childTo), { recursive: true });
        fs.copyFileSync(childFrom, childTo);
        files += 1;
      }
    }
  }
  return { files };
}

function copyCharacterFromGlobal(projectDir, globalAssetsDir, characterId, options = {}) {
  const src = path.join(globalAssetsDir, "characters", characterId);
  const dest = path.join(projectDir, "characters", characterId);
  const copied = copyTreeFromGlobal(src, dest, {
    skipRel: options.skipRemoved
      ? (rel) => wasRemovedLocally(projectDir, `characters/${characterId}/${rel}`)
      : null,
  });
  const localJson = path.join(dest, "character.json");
  if (!fs.existsSync(localJson)) {
    const loaded = loadCharacter(projectDir, globalAssetsDir, characterId, { includeGlobal: true });
    if (loaded) {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(localJson, JSON.stringify(loaded, null, 2) + "\n");
      copied.files += 1;
    }
  }
  return copied;
}

function addLibraryCharacter(projectDir, globalAssetsDir, characterId) {
  if (typeof characterId !== "string" || !characterId) {
    const err = new Error("characterId is required");
    err.code = "EINVAL";
    throw err;
  }
  const known = listKnownCharacterIds(projectDir, globalAssetsDir, { includeGlobal: true });
  if (!known.includes(characterId)) {
    const err = new Error(`Unknown character: ${characterId}`);
    err.code = "ENOTFOUND";
    throw err;
  }
  copyCharacterFromGlobal(projectDir, globalAssetsDir, characterId);
  const library = readLibrary(projectDir);
  if (!library.characters.includes(characterId)) {
    library.characters.push(characterId);
  }
  return writeLibrary(projectDir, library);
}

function makeProjectIndependent(projectDir, globalAssetsDir) {
  const used = collectUsedAssets(projectDir, globalAssetsDir, { includeGlobal: true });
  const copied = {
    characters: [],
    backgrounds: [],
    stagingDefaults: false,
    files: 0,
  };

  for (const id of used.characterIds) {
    const src = path.join(globalAssetsDir, "characters", id);
    if (!fs.existsSync(src)) continue;
    const result = copyCharacterFromGlobal(projectDir, globalAssetsDir, id, { skipRemoved: true });
    if (result.files > 0) copied.characters.push(id);
    copied.files += result.files;
  }

  for (const id of used.locationIds) {
    const src = path.join(globalAssetsDir, "backgrounds", id);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    const dest = path.join(projectDir, "backgrounds", id);
    const result = copyTreeFromGlobal(src, dest);
    if (result.files > 0) copied.backgrounds.push(id);
    copied.files += result.files;
  }

  const stagingSrc = path.join(globalAssetsDir, "staging_defaults.json");
  const stagingDest = path.join(projectDir, "staging_defaults.json");
  if (fs.existsSync(stagingSrc) && !fs.existsSync(stagingDest)) {
    fs.copyFileSync(stagingSrc, stagingDest);
    copied.stagingDefaults = true;
    copied.files += 1;
  }

  const settings = writeStudioSettings(projectDir, { independent: true });
  return {
    ok: true,
    independent: settings.independent,
    copied,
  };
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
  normalizeNewScriptName,
  nextNewScriptName,
  createScriptFile,
  trashScriptFile,
  listScriptFiles,
  listScriptRecords,
  newestScriptName,
  readLibrary,
  writeLibrary,
  collectUsedAssets,
  countScriptScenes,
  resolveProjectDuration,
  summarizeProject,
  summarizeProjectCached,
  resetSummaryCache,
  describeProjectContents,
  moveProjectToTrash,
  moveFolderToTrash,
  writeTrashMeta,
  readTrashMeta,
  TRASH_META_FILENAME,
  listTrash,
  restoreFromTrash,
  emptyTrash,
  renameProject,
  duplicateProject,
  createEmptyProject,
  addLibraryCharacter,
  makeProjectIndependent,
  copyCharacterFromGlobal,
  listLocalDirIds,
};
