"use strict";

/**
 * Extra checks used by `node src/cli.js lint` (and attached to parse
 * results so the CLI can print them). These are not schema/load
 * validation -- they catch staging overlaps, incomplete mouth sheets,
 * and missing prop assets.
 */

const assetLibrary = require("./assetLibrary");

const RHUBARB_MOUTH_SHAPES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const REST_MOUTH_SHAPE = "X";

/**
 * One occupancy interval: a character standing on a named mark at a
 * given z, from startFrame up to (but not including) endFrame.
 *
 * @typedef {{
 *   sceneId: string,
 *   characterId: string,
 *   displayName: string,
 *   markName: string,
 *   z: number,
 *   startFrame: number,
 *   endFrame: number,
 *   lineNumber: number,
 * }} Occupancy
 */

/**
 * Warns when two different characters in the same scene share a mark at
 * the same z for at least one frame. Characters who later move off that
 * mark only count for the frames they actually share.
 *
 * @param {Occupancy[]} occupancy
 * @returns {string[]}
 */
function findOverlapWarnings(occupancy) {
  const warnings = [];
  const seen = new Set();

  for (let i = 0; i < occupancy.length; i++) {
    for (let j = i + 1; j < occupancy.length; j++) {
      const a = occupancy[i];
      const b = occupancy[j];
      if (a.sceneId !== b.sceneId) continue;
      if (a.characterId === b.characterId) continue;
      if (a.markName !== b.markName) continue;
      if (a.z !== b.z) continue;

      const overlapStart = Math.max(a.startFrame, b.startFrame);
      const overlapEnd = Math.min(a.endFrame, b.endFrame);
      if (overlapStart >= overlapEnd) continue;

      const pairKey = [a.characterId, b.characterId].sort().join("\0");
      const dedupeKey = `${a.sceneId}\0${pairKey}\0${a.markName}\0${a.z}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const [first, second] = [a, b].sort((x, y) => {
        if (x.startFrame !== y.startFrame) return x.startFrame - y.startFrame;
        if (x.lineNumber !== y.lineNumber) return x.lineNumber - y.lineNumber;
        return x.displayName.localeCompare(y.displayName);
      });
      const lineNumber = Math.max(a.lineNumber, b.lineNumber);
      warnings.push(
        `Line ${lineNumber}: ${first.displayName} and ${second.displayName} overlap on mark '${a.markName}' with the same z (${a.z}).`
      );
    }
  }

  return warnings;
}

function findMouthSlot(config) {
  if (config.slots && config.slots.mouth) return config.slots.mouth;
  for (const child of config.children || []) {
    if (child.slots && child.slots.mouth) return child.slots.mouth;
  }
  return null;
}

/**
 * Errors if a used character that *has* a mouth slot is missing rest
 * shape X or any Rhubarb shape A–H. Characters with no mouth slot are
 * skipped. Each error names the character, the missing shapes, and
 * what is actually in the folder.
 *
 * @param {Map<string, object>} usedCharacters characterId -> character.json
 * @param {string} projectDir
 * @param {string} globalAssetsDir
 * @returns {string[]}
 */
function findMouthSheetErrors(usedCharacters, projectDir, globalAssetsDir) {
  const errors = [];

  for (const [characterId, config] of usedCharacters) {
    const mouthSlot = findMouthSlot(config);
    if (!mouthSlot) continue;

    const drawingsDir = `characters/${characterId}/${mouthSlot.drawings_dir}`;
    const drawings = assetLibrary.scanDrawingsDir(projectDir, globalAssetsDir, drawingsDir);
    const present = [...drawings.keys()].sort();

    const missing = [];
    if (!drawings.has(REST_MOUTH_SHAPE)) missing.push(REST_MOUTH_SHAPE);
    for (const shape of RHUBARB_MOUTH_SHAPES) {
      if (!drawings.has(shape)) missing.push(shape);
    }
    if (missing.length === 0) continue;

    const name = (config && (config.display_name || config.id)) || characterId;
    errors.push(
      `${name} is missing mouth shape(s) ${missing.join(", ")}. Available: ${present.join(", ") || "(none)"}`
    );
  }

  return errors;
}

/**
 * One declared/used location prop, so lint can confirm its image exists.
 *
 * @typedef {{
 *   name: string,
 *   assetRel: string,
 *   lineNumber: number,
 *   location?: string,
 * }} UsedProp
 */

/**
 * Errors if a used location prop's image is missing from both the
 * project folder and `_global_assets`. Each error cites the script line
 * that introduced the location (or the `[Prop: ...]` tag) and lists
 * whatever *is* in that location's `props/` folder.
 *
 * @param {UsedProp[]} usedProps
 * @param {string} projectDir
 * @param {string} globalAssetsDir
 * @returns {string[]}
 */
function findMissingPropAssets(usedProps, projectDir, globalAssetsDir) {
  const errors = [];
  const listed = new Set();

  for (const prop of usedProps) {
    const resolved = assetLibrary.resolveAsset(projectDir, globalAssetsDir, prop.assetRel);
    if (resolved) continue;

    const dedupeKey = `${prop.lineNumber}\0${prop.assetRel}`;
    if (listed.has(dedupeKey)) continue;
    listed.add(dedupeKey);

    const propsDir = prop.location ? `backgrounds/${prop.location}/props` : null;
    const present = propsDir
      ? [...assetLibrary.scanDrawingsDir(projectDir, globalAssetsDir, propsDir).keys()].sort()
      : [];
    errors.push(
      `Line ${prop.lineNumber}: Prop "${prop.name}" is missing asset "${prop.assetRel}". Available: ${present.join(", ") || "(none)"}`
    );
  }

  return errors;
}

module.exports = {
  findOverlapWarnings,
  findMouthSheetErrors,
  findMissingPropAssets,
  findMouthSlot,
  RHUBARB_MOUTH_SHAPES,
  REST_MOUTH_SHAPE,
};
