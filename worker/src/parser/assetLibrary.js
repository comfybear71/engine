"use strict";

/**
 * Resolves assets against the project folder, optional show-level files,
 * and (only when the project allows it) the shared library
 * (`projects/_global_assets/`). Lookup order is episode (project folder)
 * -> show -> global. Every lookup (character.json, body.png, a single
 * drawing inside a slot folder, a location's bg.png/staging.json, ...) is
 * resolved independently, so a project or show can override just one file
 * without forking the whole character or location.
 *
 * Projects default to Independent (`studio.json` `independent: true`,
 * including when the field is missing): global is skipped. Episode -> show
 * is still allowed. Pass `{ includeGlobal: true }` to force a shared-library
 * read (Library drawer, Add, Make independent).
 *
 * `relPath` is always relative to the *library root* convention, e.g.
 * "characters/hicks/body.png" or "backgrounds/corridor/staging.json" --
 * never an absolute path and never CWD-relative.
 */

const fs = require("fs");
const path = require("path");

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

/**
 * An episode lives at `shows/<show-id>/episodes/<episode-id>` and has a
 * sibling `show.json` on the show folder. Flat projects under `projects/`
 * have no show layer.
 */
const DEFAULT_GLOBAL_ASSETS_DIR_NAME = "_global_assets";

/**
 * Flat project: sibling `_global_assets`. Episode under `shows/<id>/episodes/`
 * walks up to `projects/_global_assets` (or a fixture-root `_global_assets`).
 */
function resolveGlobalAssetsDir(projectDir) {
  const sibling = path.join(path.dirname(projectDir), DEFAULT_GLOBAL_ASSETS_DIR_NAME);
  if (fs.existsSync(sibling)) return sibling;

  let dir = path.resolve(projectDir);
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    const nextToParent = path.join(parent, DEFAULT_GLOBAL_ASSETS_DIR_NAME);
    if (fs.existsSync(nextToParent)) return nextToParent;
    const underProjects = path.join(parent, "projects", DEFAULT_GLOBAL_ASSETS_DIR_NAME);
    if (fs.existsSync(underProjects)) return underProjects;
    if (parent === dir) break;
    dir = parent;
  }
  return sibling;
}

function resolveShowAssetsDir(projectDir) {
  if (!projectDir) return null;
  const episodesDir = path.dirname(path.resolve(projectDir));
  const showDir = path.dirname(episodesDir);
  if (path.basename(episodesDir) !== "episodes") return null;
  if (!fs.existsSync(path.join(showDir, "show.json"))) return null;
  return showDir;
}

const STUDIO_SETTINGS_FILENAME = "studio.json";

/**
 * Per-project Independent setting. Default ON (never read `_global_assets`)
 * for new and existing projects. Only an explicit `independent: false` in
 * `studio.json` re-enables the shared-library fallback.
 */
function isProjectIndependent(projectDir) {
  if (!projectDir) return true;
  const filePath = path.join(projectDir, STUDIO_SETTINGS_FILENAME);
  if (!fs.existsSync(filePath)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) || {};
    return data.independent !== false;
  } catch {
    return true;
  }
}

function shouldIncludeGlobal(projectDir, options) {
  if (options && options.includeGlobal === true) return true;
  if (options && options.includeGlobal === false) return false;
  return !isProjectIndependent(projectDir);
}

function assetSearchRoots(projectDir, globalAssetsDir, options) {
  const roots = [];
  if (projectDir) roots.push({ dir: path.resolve(projectDir), source: "project" });
  const showDir = resolveShowAssetsDir(projectDir);
  if (showDir) roots.push({ dir: showDir, source: "show" });
  if (globalAssetsDir && shouldIncludeGlobal(projectDir, options)) {
    roots.push({ dir: path.resolve(globalAssetsDir), source: "global" });
  }
  return roots;
}

/**
 * @param {string} projectDir Absolute path to the project folder (contains script.txt / timeline.json).
 * @param {string} globalAssetsDir Absolute path to projects/_global_assets.
 * @param {string} relPath e.g. "characters/hicks/body.png"
 * @returns {{ absPath: string, timelinePath: string, source: "project"|"show"|"global" } | null}
 *   `timelinePath` is relative to `projectDir`, suitable for embedding
 *   directly in timeline.json (using ".." to reach a show or global asset).
 */
function resolveAsset(projectDir, globalAssetsDir, relPath, options) {
  if (!relPath) return null;
  for (const root of assetSearchRoots(projectDir, globalAssetsDir, options)) {
    const candidate = path.join(root.dir, relPath);
    if (!fs.existsSync(candidate)) continue;
    const timelinePath =
      root.source === "project" ? toPosix(relPath) : toPosix(path.relative(projectDir, candidate));
    return { absPath: candidate, timelinePath, source: root.source };
  }
  return null;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Reads and JSON.parses a resolved asset, or returns null if not found. */
function readJsonAsset(projectDir, globalAssetsDir, relPath, options) {
  const resolved = resolveAsset(projectDir, globalAssetsDir, relPath, options);
  if (!resolved) return null;
  return JSON.parse(fs.readFileSync(resolved.absPath, "utf8"));
}

/**
 * Lists the drawings available in a slot folder (e.g. "characters/hicks/mouth"):
 * every image file's name (without extension) is a valid drawing name. If
 * the folder exists in the project, the show, and the global library, entries
 * are merged with later layers winning per-filename (episode > show > global).
 *
 * @returns {Map<string, {absPath: string, timelinePath: string}>} drawing name -> resolved file
 */
function scanDrawingsDir(projectDir, globalAssetsDir, relDirPath, options) {
  const drawings = new Map();

  const addFrom = (baseDir, source) => {
    if (!baseDir) return;
    const absDir = path.join(baseDir, relDirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return;
    const isProject = source === "project";
    for (const entry of fs.readdirSync(absDir)) {
      const ext = path.extname(entry).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      const name = path.basename(entry, ext);
      const absPath = path.join(absDir, entry);
      const timelinePath = isProject
        ? toPosix(path.join(relDirPath, entry))
        : toPosix(path.relative(projectDir, absPath));
      drawings.set(name, { absPath, timelinePath, source });
    }
  };

  // Global first (when allowed), then show, then episode/project — later entries win.
  if (shouldIncludeGlobal(projectDir, options)) addFrom(globalAssetsDir, "global");
  addFrom(resolveShowAssetsDir(projectDir), "show");
  addFrom(projectDir, "project");

  return drawings;
}

/** Loads characters/<id>/character.json, or null if the character doesn't exist in any location. */
function loadCharacter(projectDir, globalAssetsDir, characterId, options) {
  return readJsonAsset(projectDir, globalAssetsDir, `characters/${characterId}/character.json`, options);
}

/** Loads characters/<id>/actions/<actionId>.json. Project-local overrides global, like character.json. */
function loadAction(projectDir, globalAssetsDir, characterId, actionId, options) {
  if (!characterId || !actionId) return null;
  if (!SAFE_FOLDER_NAME.test(String(actionId))) return null;
  return readJsonAsset(projectDir, globalAssetsDir, `characters/${characterId}/actions/${actionId}.json`, options);
}

/** Action ids from characters/<id>/actions/*.json. Later roots win (episode > show > global). */
function listActionIds(projectDir, globalAssetsDir, characterId, options) {
  const ids = new Set();
  if (!characterId) return [];
  for (const root of assetSearchRoots(projectDir, globalAssetsDir, options).reverse()) {
    const dir = path.join(root.dir, "characters", characterId, "actions");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (path.extname(entry).toLowerCase() !== ".json") continue;
      const id = path.basename(entry, ".json");
      if (!SAFE_FOLDER_NAME.test(id)) continue;
      ids.add(id);
    }
  }
  return [...ids].sort();
}

const SAFE_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function listIdsInFolder(baseDir, folder, isCharacter) {
  const ids = [];
  if (!baseDir) return ids;
  const dir = path.join(baseDir, folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return ids;
  for (const entry of fs.readdirSync(dir)) {
    if (!SAFE_FOLDER_NAME.test(entry)) continue;
    const abs = path.join(dir, entry);
    if (!fs.statSync(abs).isDirectory()) continue;
    if (isCharacter) {
      const hasJson = fs.existsSync(path.join(abs, "character.json"));
      const hasBody = fs.existsSync(path.join(abs, "body.png"));
      if (!hasJson && !hasBody) continue;
    }
    ids.push(entry);
  }
  return ids;
}

function listKnownCharacterIds(projectDir, globalAssetsDir, options) {
  const ids = new Set();
  for (const root of assetSearchRoots(projectDir, globalAssetsDir, options).reverse()) {
    for (const id of listIdsInFolder(root.dir, "characters", true)) ids.add(id);
  }
  return [...ids].sort();
}

function listKnownLocations(projectDir, globalAssetsDir, options) {
  const ids = new Set();
  for (const root of assetSearchRoots(projectDir, globalAssetsDir, options).reverse()) {
    for (const id of listIdsInFolder(root.dir, "backgrounds")) ids.add(id);
  }
  return [...ids].sort();
}

const DEFAULT_AUTO_ORDER = ["centre", "left", "right", "far_left", "far_right"];
const ANCHOR_NAMES = new Set([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

/** Accepts British "centre" spellings; returns a schema anchor or null if unknown. */
function normalizeAnchor(value) {
  if (value == null || value === "") return "bottom-center";
  const normalized = String(value).trim().toLowerCase().replace(/centre/g, "center");
  return ANCHOR_NAMES.has(normalized) ? normalized : null;
}

/**
 * Loads a location's staging profile (`backgrounds/<location>/staging.json`),
 * merged with the library-wide fallback marks (`staging_defaults.json` at
 * the library root) -- the location's own marks take precedence by name;
 * any mark name only defined at the global level is still usable ("canvas
 * default marks" in the brief). Falls back to an empty mark set (plus the
 * global defaults) if the location has no staging.json of its own.
 */
function loadStaging(projectDir, globalAssetsDir, location, options) {
  const globalDefaults = readJsonAsset(projectDir, globalAssetsDir, "staging_defaults.json", options) || { marks: {} };
  const locationStaging = readJsonAsset(
    projectDir,
    globalAssetsDir,
    `backgrounds/${location}/staging.json`,
    options
  );

  const marks = { ...(globalDefaults.marks || {}), ...((locationStaging && locationStaging.marks) || {}) };
  const autoOrder = (locationStaging && locationStaging.auto_order) || globalDefaults.auto_order || DEFAULT_AUTO_ORDER;
  const props = { ...((locationStaging && locationStaging.props) || {}) };

  return { marks, autoOrder, props, hasLocationProfile: !!locationStaging };
}

module.exports = {
  resolveAsset,
  readJsonAsset,
  scanDrawingsDir,
  loadCharacter,
  loadAction,
  listActionIds,
  loadStaging,
  listKnownCharacterIds,
  listKnownLocations,
  resolveShowAssetsDir,
  resolveGlobalAssetsDir,
  assetSearchRoots,
  isProjectIndependent,
  shouldIncludeGlobal,
  normalizeAnchor,
  ANCHOR_NAMES,
  DEFAULT_AUTO_ORDER,
  STUDIO_SETTINGS_FILENAME,
  SAFE_FOLDER_NAME,
};
