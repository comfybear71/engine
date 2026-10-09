"use strict";

/**
 * Resolves assets against the shared library (`projects/_global_assets/`)
 * with per-file, per-project overrides, per the brief: "Episode projects
 * can override any global asset with the same relative path in their own
 * folder." Every lookup here (character.json, body.png, a single drawing
 * inside a slot folder, a location's bg.png/staging.json, ...) is resolved
 * independently, so a project can override just one file (e.g. a single
 * reaction drawing) without forking the whole character or location.
 *
 * `relPath` is always relative to the *library root* convention, e.g.
 * "characters/hicks/body.png" or "backgrounds/corridor/staging.json" --
 * never an absolute path and never CWD-relative.
 */

const fs = require("fs");
const path = require("path");

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

/**
 * @param {string} projectDir Absolute path to the project folder (contains script.txt / timeline.json).
 * @param {string} globalAssetsDir Absolute path to projects/_global_assets.
 * @param {string} relPath e.g. "characters/hicks/body.png"
 * @returns {{ absPath: string, timelinePath: string, source: "project"|"global" } | null}
 *   `timelinePath` is relative to `projectDir`, suitable for embedding
 *   directly in timeline.json (using ".." to reach a global asset). Returns
 *   null if the file exists in neither location.
 */
function resolveAsset(projectDir, globalAssetsDir, relPath) {
  const projectCandidate = path.join(projectDir, relPath);
  if (fs.existsSync(projectCandidate)) {
    return { absPath: projectCandidate, timelinePath: toPosix(relPath), source: "project" };
  }

  const globalCandidate = path.join(globalAssetsDir, relPath);
  if (fs.existsSync(globalCandidate)) {
    const timelinePath = toPosix(path.relative(projectDir, globalCandidate));
    return { absPath: globalCandidate, timelinePath, source: "global" };
  }

  return null;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Reads and JSON.parses a resolved asset, or returns null if not found. */
function readJsonAsset(projectDir, globalAssetsDir, relPath) {
  const resolved = resolveAsset(projectDir, globalAssetsDir, relPath);
  if (!resolved) return null;
  return JSON.parse(fs.readFileSync(resolved.absPath, "utf8"));
}

/**
 * Lists the drawings available in a slot folder (e.g. "characters/hicks/mouth"):
 * every image file's name (without extension) is a valid drawing name. If
 * the folder exists in both the project and the global library, entries are
 * merged with the project's own files taking precedence per-filename (the
 * same per-file override principle, applied within a directory).
 *
 * @returns {Map<string, {absPath: string, timelinePath: string}>} drawing name -> resolved file
 */
function scanDrawingsDir(projectDir, globalAssetsDir, relDirPath) {
  const drawings = new Map();

  const addFrom = (baseDir, isProject) => {
    const absDir = path.join(baseDir, relDirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return;
    for (const entry of fs.readdirSync(absDir)) {
      const ext = path.extname(entry).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      const name = path.basename(entry, ext);
      if (drawings.has(name) && isProject === false) continue; // project already provided this one
      const absPath = path.join(absDir, entry);
      const timelinePath = isProject
        ? toPosix(path.join(relDirPath, entry))
        : toPosix(path.relative(projectDir, absPath));
      drawings.set(name, { absPath, timelinePath });
    }
  };

  // Global first, then project overrides same-named drawings.
  addFrom(globalAssetsDir, false);
  addFrom(projectDir, true);

  return drawings;
}

/** Loads characters/<id>/character.json, or null if the character doesn't exist in either location. */
function loadCharacter(projectDir, globalAssetsDir, characterId) {
  return readJsonAsset(projectDir, globalAssetsDir, `characters/${characterId}/character.json`);
}

function listKnownCharacterIds(projectDir, globalAssetsDir) {
  const ids = new Set();
  for (const base of [globalAssetsDir, projectDir]) {
    const dir = path.join(base, "characters");
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (fs.statSync(path.join(dir, entry)).isDirectory()) ids.add(entry);
    }
  }
  return [...ids].sort();
}

function listKnownLocations(projectDir, globalAssetsDir) {
  const ids = new Set();
  for (const base of [globalAssetsDir, projectDir]) {
    const dir = path.join(base, "backgrounds");
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (fs.statSync(path.join(dir, entry)).isDirectory()) ids.add(entry);
    }
  }
  return [...ids].sort();
}

const DEFAULT_AUTO_ORDER = ["centre", "left", "right", "far_left", "far_right"];

/**
 * Loads a location's staging profile (`backgrounds/<location>/staging.json`),
 * merged with the library-wide fallback marks (`staging_defaults.json` at
 * the library root) -- the location's own marks take precedence by name;
 * any mark name only defined at the global level is still usable ("canvas
 * default marks" in the brief). Falls back to an empty mark set (plus the
 * global defaults) if the location has no staging.json of its own.
 */
function loadStaging(projectDir, globalAssetsDir, location) {
  const globalDefaults = readJsonAsset(projectDir, globalAssetsDir, "staging_defaults.json") || { marks: {} };
  const locationStaging = readJsonAsset(projectDir, globalAssetsDir, `backgrounds/${location}/staging.json`);

  const marks = { ...(globalDefaults.marks || {}), ...((locationStaging && locationStaging.marks) || {}) };
  const autoOrder = (locationStaging && locationStaging.auto_order) || globalDefaults.auto_order || DEFAULT_AUTO_ORDER;

  return { marks, autoOrder, hasLocationProfile: !!locationStaging };
}

module.exports = {
  resolveAsset,
  readJsonAsset,
  scanDrawingsDir,
  loadCharacter,
  loadStaging,
  listKnownCharacterIds,
  listKnownLocations,
  DEFAULT_AUTO_ORDER,
};
