"use strict";

/**
 * Turns a temp parse (laneEvents + sceneLengths from the script parser)
 * into Studio timeline blocks. Scene-local frames are converted to a
 * single global playhead that matches preview-frame indexing.
 *
 * Instant Action/Layer/Prop tags are held until the next action on the
 * same subject (or the scene end) so they read as blocks, not ticks.
 * Never writes timeline.json -- caller must use parseProjectToTemp.
 */

const LANES = ["action", "dialogue", "audio", "sfx", "camera"];

function extendActionHolds(events, sceneLengthById) {
  const out = events.map((event) => ({ ...event }));
  const byKey = new Map();
  for (let i = 0; i < out.length; i++) {
    const event = out[i];
    if (event.lane !== "action") continue;
    if (event.endFrame > event.startFrame) continue;
    const key = `${event.sceneId}::${event.subject || ""}`;
    const list = byKey.get(key) || [];
    list.push(i);
    byKey.set(key, list);
  }
  for (const indexes of byKey.values()) {
    for (let n = 0; n < indexes.length; n++) {
      const event = out[indexes[n]];
      const sceneLen = sceneLengthById.get(event.sceneId) || event.startFrame;
      let nextStart = sceneLen;
      if (n + 1 < indexes.length) {
        nextStart = Math.min(nextStart, out[indexes[n + 1]].startFrame);
      }
      for (const other of out) {
        if (other.lane !== "action") continue;
        if (other.sceneId !== event.sceneId) continue;
        if (other.subject !== event.subject) continue;
        if (other.startFrame > event.startFrame && other.startFrame < nextStart) {
          nextStart = other.startFrame;
        }
      }
      event.endFrame = Math.max(event.startFrame, nextStart);
    }
  }
  return out;
}

function clampFrame(frame, totalFrames) {
  const total = Math.max(Number(totalFrames) || 1, 1);
  const max = total - 1;
  const n = Math.floor(Number(frame));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, n);
}

function sceneOffsets(sceneLengths) {
  const offsets = new Map();
  let cursor = 0;
  const scenes = [];
  for (const scene of sceneLengths || []) {
    offsets.set(scene.id, cursor);
    scenes.push({
      id: scene.id,
      startFrame: cursor,
      endFrame: cursor + scene.frames,
      frames: scene.frames,
    });
    cursor += scene.frames;
  }
  return { offsets, scenes, totalFrames: Math.max(cursor, 1) };
}

/**
 * @param {{ laneEvents?: object[], sceneLengths?: {id: string, frames: number}[], timeline?: { fps?: number } }} parsed
 * @returns {{ fps: number, totalFrames: number, lanes: string[], scenes: object[], blocks: object[] }}
 */
function buildLaneBlocks(parsed) {
  const fps = (parsed.timeline && parsed.timeline.fps) || 24;
  const { offsets, scenes, totalFrames } = sceneOffsets(parsed.sceneLengths);
  const sceneLengthById = new Map((parsed.sceneLengths || []).map((s) => [s.id, s.frames]));
  const local = extendActionHolds(parsed.laneEvents || [], sceneLengthById);

  const blocks = local.map((event, index) => {
    const base = offsets.get(event.sceneId) || 0;
    const startFrame = base + event.startFrame;
    const endFrame = base + event.endFrame;
    return {
      id: `${event.lane}-${event.sceneId}-${event.scriptLine}-${index}`,
      lane: event.lane,
      label: event.label,
      startFrame,
      endFrame: Math.max(endFrame, startFrame),
      scriptLine: event.scriptLine,
      sceneId: event.sceneId,
      rel: event.rel || null,
    };
  });

  return { fps, totalFrames, lanes: LANES, scenes, blocks };
}

module.exports = { LANES, buildLaneBlocks, clampFrame };
