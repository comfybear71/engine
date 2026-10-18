"use strict";

const assetLibrary = require("./parser/assetLibrary");

/**
 * Where the baked frames of an Action Shot live, resolved the way the script
 * parser resolves a [Clip:] (characters/<id>/<drawingsDir>/<frame>.png). Frames
 * that cannot be found are left out.
 */
function bakedClipFrames(projectDir, globalAssetsDir, characterId, actionId) {
  const action = assetLibrary.loadAction(projectDir, globalAssetsDir, characterId, actionId);
  if (!action) return null;
  const names = action.slot_frames && Array.isArray(action.slot_frames.body) ? action.slot_frames.body : [];
  const dirRel = String(action.drawingsDir || `characters/${characterId}/actions/${actionId}`).replace(/\/+$/, "");
  const base = dirRel.startsWith("characters/") ? dirRel : `characters/${characterId}/${dirRel}`;
  const frames = [];
  for (const name of names) {
    const resolved = assetLibrary.resolveAsset(projectDir, globalAssetsDir, `${base}/${name}`);
    if (resolved) frames.push(resolved.timelinePath);
  }
  return { fps: Number(action.fps) > 0 ? Number(action.fps) : null, frames };
}

module.exports = { bakedClipFrames };
