"use strict";

/**
 * Read-only views of the shared asset library for the Studio: characters
 * (global + project-local), backgrounds, props, and marks from staging.json.
 */

const fs = require("fs");
const path = require("path");

const {
  resolveAsset,
  scanDrawingsDir,
  loadCharacter,
  loadStaging,
  listKnownCharacterIds,
  listKnownLocations,
} = require("./parser/assetLibrary");

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function locationFromBackgroundAsset(asset) {
  const match = toPosix(asset || "").match(/(?:^|\/)backgrounds\/([^/]+)\//);
  return match ? match[1] : null;
}

function collectSlots(character, projectDir, globalAssetsDir, characterId) {
  const slots = [];

  function addSlots(rawSlots, owner) {
    for (const [name, spec] of Object.entries(rawSlots || {})) {
      const drawingsDir = spec.drawings_dir || name;
      const relDir = `characters/${characterId}/${drawingsDir}`;
      const drawings = [];
      for (const [drawingName, file] of scanDrawingsDir(projectDir, globalAssetsDir, relDir)) {
        drawings.push({
          name: drawingName,
          rel: `${relDir}/${path.basename(file.absPath)}`,
        });
      }
      drawings.sort((a, b) => a.name.localeCompare(b.name));
      slots.push({
        name,
        owner,
        default_drawing: spec.default_drawing || null,
        drawings,
        cycles: spec.cycles || {},
      });
    }
  }

  addSlots(character.slots, null);
  for (const child of character.children || []) {
    addSlots(child.slots, child.id);
  }
  return slots;
}

function characterThumbRel(character, projectDir, globalAssetsDir, characterId) {
  const bodySlot = character.slots && character.slots.body;
  if (bodySlot && bodySlot.default_drawing) {
    const dir = bodySlot.drawings_dir || "body";
    const drawings = scanDrawingsDir(projectDir, globalAssetsDir, `characters/${characterId}/${dir}`);
    const hit = drawings.get(bodySlot.default_drawing);
    if (hit) return `characters/${characterId}/${dir}/${path.basename(hit.absPath)}`;
  }
  if (character.asset) {
    const rel = `characters/${characterId}/${character.asset}`;
    if (resolveAsset(projectDir, globalAssetsDir, rel)) return rel;
  }
  return null;
}

function describeCharacter(projectDir, globalAssetsDir, id) {
  const jsonRel = `characters/${id}/character.json`;
  const resolved = resolveAsset(projectDir, globalAssetsDir, jsonRel);
  const character = loadCharacter(projectDir, globalAssetsDir, id);
  if (!resolved || !character) return null;
  return {
    id,
    display_name: character.display_name || id,
    aliases: character.aliases || [],
    source: resolved.source,
    z: character.z,
    style: typeof character.style === "string" ? character.style : "",
    thumbRel: characterThumbRel(character, projectDir, globalAssetsDir, id),
    slots: collectSlots(character, projectDir, globalAssetsDir, id),
  };
}

function listCharacters(projectDir, globalAssetsDir, options = {}) {
  const allow = options.ids ? new Set(options.ids) : null;
  const characters = [];
  for (const id of listKnownCharacterIds(projectDir, globalAssetsDir)) {
    if (allow && !allow.has(id)) continue;
    const described = describeCharacter(projectDir, globalAssetsDir, id);
    if (described) characters.push(described);
  }
  return characters;
}

function listGlobalCharacters(projectDir, globalAssetsDir) {
  const characters = [];
  const dir = path.join(globalAssetsDir, "characters");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return characters;
  for (const id of fs.readdirSync(dir).sort()) {
    if (!fs.statSync(path.join(dir, id)).isDirectory()) continue;
    const described = describeCharacter(projectDir, globalAssetsDir, id);
    if (described) characters.push({ ...described, source: "global" });
  }
  return characters;
}

function listStaging(projectDir, globalAssetsDir, options = {}) {
  const allow = options.locationIds ? new Set(options.locationIds) : null;
  const backgrounds = [];
  const props = [];
  const marksByLocation = {};

  for (const loc of listKnownLocations(projectDir, globalAssetsDir)) {
    if (allow && !allow.has(loc)) continue;
    const staging = loadStaging(projectDir, globalAssetsDir, loc);
    const bgRel = `backgrounds/${loc}/bg.png`;
    const bg = resolveAsset(projectDir, globalAssetsDir, bgRel);
    backgrounds.push({
      id: loc,
      source: bg ? bg.source : "global",
      thumbRel: bg ? bgRel : null,
    });
    marksByLocation[loc] = staging.marks || {};

    for (const [propId, spec] of Object.entries(staging.props || {})) {
      const assetRel = spec.asset || `props/${propId}.png`;
      const fullRel = toPosix(assetRel).startsWith("backgrounds/")
        ? toPosix(assetRel)
        : `backgrounds/${loc}/${toPosix(assetRel)}`;
      const resolved = resolveAsset(projectDir, globalAssetsDir, fullRel);
      props.push({
        id: propId,
        location: loc,
        z: spec.z == null ? 0 : spec.z,
        x: spec.x == null ? null : spec.x,
        y: spec.y == null ? null : spec.y,
        scale: spec.scale == null ? 1 : spec.scale,
        anchor: spec.anchor || "bottom-center",
        thumbRel: resolved ? fullRel : null,
      });
    }
  }

  return { backgrounds, props, marksByLocation };
}

function summarizeStage(timeline) {
  const fps = timeline.fps || 24;
  const canvas = timeline.canvas || { width: 1920, height: 1080 };
  const scenes = (timeline.scenes || []).map((scene) => {
    const layers = (scene.layers || [])
      .map((layer) => ({
        id: layer.id,
        z: layer.z,
        kind: layer.prop_id ? "prop" : "character",
        character_id: layer.character_id || null,
        prop_id: layer.prop_id || null,
        start_frame: layer.timing && layer.timing.start_frame != null ? layer.timing.start_frame : 0,
        end_frame: layer.timing && layer.timing.end_frame != null ? layer.timing.end_frame : null,
      }))
      .sort((a, b) => b.z - a.z || a.id.localeCompare(b.id));
    return {
      id: scene.id,
      location: locationFromBackgroundAsset(scene.background && scene.background.asset),
      layers,
    };
  });
  return {
    series: timeline.series,
    episode: timeline.episode,
    fps,
    canvas: { width: canvas.width || 1920, height: canvas.height || 1080 },
    scenes,
  };
}

module.exports = {
  listCharacters,
  listGlobalCharacters,
  listStaging,
  summarizeStage,
  locationFromBackgroundAsset,
};
