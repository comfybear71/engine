"use strict";

/**
 * Read-only views of project assets for the Studio: characters this project
 * uses (project-local drawings only), plus a catalog of global characters
 * for the Library drawer. Backgrounds, props, and marks come from staging.
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
const { discoverSlotViews } = require("./assetEditor");
const { defaultFactoryCanvas } = require("./factoryStandard");
const { describeFactoryCharacter, listProjectActions } = require("./characterStatus");

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function resolvedMtime(projectDir, globalAssetsDir, rel, options) {
  if (!rel) return null;
  const resolved = resolveAsset(projectDir, globalAssetsDir, rel, options);
  if (!resolved) return null;
  try {
    return Math.round(fs.statSync(resolved.absPath).mtimeMs);
  } catch {
    return null;
  }
}

function locationFromBackgroundAsset(asset) {
  const match = toPosix(asset || "").match(/(?:^|\/)backgrounds\/([^/]+)\//);
  return match ? match[1] : null;
}

function collectSlots(character, projectDir, globalAssetsDir, characterId, options) {
  const slots = [];
  const projectOnly = !options || options.includeGlobal !== true;

  function addSlots(rawSlots, owner) {
    for (const [name, spec] of Object.entries(rawSlots || {})) {
      const drawingsDir = spec.drawings_dir || name;
      const relDir = `characters/${characterId}/${drawingsDir}`;
      const drawings = [];
      for (const [drawingName, file] of scanDrawingsDir(projectDir, globalAssetsDir, relDir, options)) {
        if (projectOnly && file.source !== "project") continue;
        const rel = `${relDir}/${path.basename(file.absPath)}`;
        drawings.push({
          name: drawingName,
          rel,
          mtime: resolvedMtime(projectDir, globalAssetsDir, rel, options),
        });
      }
      drawings.sort((a, b) => a.name.localeCompare(b.name));
      const offset = spec.offset || {};
      const views = discoverSlotViews(projectDir, globalAssetsDir, characterId, name, spec).map((view) => {
        const viewDrawings = [];
        for (const [drawingName, file] of scanDrawingsDir(projectDir, globalAssetsDir, view.relDir, options)) {
          if (projectOnly && file.source !== "project") continue;
          const rel = `${view.relDir}/${path.basename(file.absPath)}`;
          viewDrawings.push({
            name: drawingName,
            rel,
            mtime: resolvedMtime(projectDir, globalAssetsDir, rel, options),
            view: view.id,
          });
        }
        viewDrawings.sort((a, b) => a.name.localeCompare(b.name));
        return { id: view.id, drawingsDir: view.drawingsDir, drawings: viewDrawings };
      });
      const canvas = spec.canvas && spec.canvas.w && spec.canvas.h
        ? {
            w: Number(spec.canvas.w),
            h: Number(spec.canvas.h),
            pivot:
              spec.canvas.pivot && spec.canvas.pivot.x != null && spec.canvas.pivot.y != null
                ? { x: Number(spec.canvas.pivot.x), y: Number(spec.canvas.pivot.y) }
                : null,
          }
        : null;
      slots.push({
        name,
        owner,
        default_drawing: spec.default_drawing || null,
        drawingsDir,
        drawings,
        views,
        cycles: spec.cycles || {},
        offset: {
          x: offset.x == null ? 0 : offset.x,
          y: offset.y == null ? 0 : offset.y,
        },
        scale: spec.scale == null ? 1 : spec.scale,
        rotation: spec.rotation == null ? 0 : spec.rotation,
        canvas,
      });
    }
  }

  addSlots(character.slots, null);
  for (const child of character.children || []) {
    addSlots(child.slots, child.id);
  }
  return slots;
}

function characterReferenceRel(character, projectDir, globalAssetsDir, characterId, options) {
  const raw = character && character.reference;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed.includes("..") || trimmed.startsWith("/")) return null;
  const rel = trimmed.startsWith("characters/") ? trimmed : `characters/${characterId}/${trimmed}`;
  if (!resolveAsset(projectDir, globalAssetsDir, rel, options)) return null;
  return rel;
}

function characterThumbRel(character, projectDir, globalAssetsDir, characterId, options) {
  const bodySlot = character.slots && character.slots.body;
  if (bodySlot && bodySlot.default_drawing) {
    const dir = bodySlot.drawings_dir || "body";
    const drawings = scanDrawingsDir(projectDir, globalAssetsDir, `characters/${characterId}/${dir}`, options);
    const hit = drawings.get(bodySlot.default_drawing);
    if (hit) return `characters/${characterId}/${dir}/${path.basename(hit.absPath)}`;
  }
  if (character.asset) {
    const rel = `characters/${characterId}/${character.asset}`;
    if (resolveAsset(projectDir, globalAssetsDir, rel, options)) return rel;
  }
  return null;
}

function describeCharacter(projectDir, globalAssetsDir, id, options) {
  const jsonRel = `characters/${id}/character.json`;
  const resolved = resolveAsset(projectDir, globalAssetsDir, jsonRel, options);
  const character = loadCharacter(projectDir, globalAssetsDir, id, options);
  if (!resolved || !character) return null;
  const thumbRel = characterThumbRel(character, projectDir, globalAssetsDir, id, options);
  const referenceRel = characterReferenceRel(character, projectDir, globalAssetsDir, id, options);
  const children = (character.children || []).map((child) => {
    const assetRel = child.asset ? `characters/${id}/${String(child.asset).replace(/\\/g, "/")}` : null;
    const offset = child.offset || {};
    return {
      id: child.id,
      asset: child.asset || null,
      rel: assetRel && resolveAsset(projectDir, globalAssetsDir, assetRel, options) ? assetRel : null,
      pivot: child.pivot == null ? null : child.pivot,
      parent: child.parent || null,
      z: child.z == null ? 0 : child.z,
      offset: { x: offset.x == null ? 0 : offset.x, y: offset.y == null ? 0 : offset.y },
      mtime: assetRel ? resolvedMtime(projectDir, globalAssetsDir, assetRel, options) : null,
    };
  });
  return {
    id,
    display_name: character.display_name || id,
    aliases: character.aliases || [],
    source: resolved.source,
    z: character.z,
    default_scale: character.default_scale == null ? 1 : character.default_scale,
    style: typeof character.style === "string" ? character.style : "",
    asset: character.asset || null,
    thumbRel,
    bodyRel: thumbRel,
    mtime: resolvedMtime(projectDir, globalAssetsDir, thumbRel, options),
    reference: typeof character.reference === "string" ? character.reference : null,
    referenceRel,
    referenceMtime: resolvedMtime(projectDir, globalAssetsDir, referenceRel, options),
    canvas: defaultFactoryCanvas(character),
    groups: character.groups || null,
    children,
    slots: collectSlots(character, projectDir, globalAssetsDir, id, options),
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
  const forceGlobal = { includeGlobal: true };
  for (const id of fs.readdirSync(dir).sort()) {
    if (!fs.statSync(path.join(dir, id)).isDirectory()) continue;
    const described = describeCharacter(projectDir, globalAssetsDir, id, forceGlobal);
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
      mtime: bg ? resolvedMtime(projectDir, globalAssetsDir, bgRel) : null,
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
        mtime: resolved ? resolvedMtime(projectDir, globalAssetsDir, fullRel) : null,
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
  describeFactoryCharacter,
  listProjectActions,
};
