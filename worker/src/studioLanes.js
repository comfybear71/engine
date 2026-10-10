"use strict";

/**
 * Turns a temp parse (laneEvents + sceneLengths from the script parser)
 * into Studio timeline blocks. Scene-local frames are converted to a
 * single global playhead that matches preview-frame indexing.
 *
 * The old single Action lane is split into body / face / props so a
 * wait=false Move can sit over a face pin or a swing. Instant pins
 * (Action / Layer / Prop) hold until the next *instant* pin in the same
 * lane+subject -- duration-bearing Move / Pose / Swing blocks keep their
 * over=/for= end times and do not clip those holds. Overlapping blocks
 * in one lane get a row index so the UI can stack them.
 * Never writes timeline.json -- caller must use parseProjectToTemp.
 */

const LANES = ["body", "face", "props", "dialogue", "audio", "sfx", "camera"];

const FACE_KEYS = new Set(["face", "eyes", "mouth", "head", "brow", "brows", "expression"]);
const BODY_KEYS = new Set(["body", "at", "flip", "scale", "z"]);
const FACE_LABEL_RE = /\b(?:face|eyes|mouth|head)=/i;
const BODY_LABEL_RE = /\bbody=/i;

function eventKeys(event) {
  if (Array.isArray(event.keys) && event.keys.length > 0) {
    return event.keys.map((key) => String(key).toLowerCase());
  }
  const label = String(event.label || "");
  const found = [];
  const re = /\b([A-Za-z_][\w]*)=/g;
  let match;
  while ((match = re.exec(label))) found.push(match[1].toLowerCase());
  return found;
}

function hasFaceKeys(keys, label) {
  if (keys.some((key) => FACE_KEYS.has(key))) return true;
  return FACE_LABEL_RE.test(String(label || ""));
}

function hasBodyKeys(keys, label) {
  if (keys.some((key) => BODY_KEYS.has(key))) return true;
  return BODY_LABEL_RE.test(String(label || ""));
}

/**
 * Map a parser laneEvent onto a Studio lane id.
 * Dialogue / audio / sfx / camera stay as emitted; action (and unknown
 * leftovers) become body, face, or props.
 */
function assignActionLane(event) {
  const lane = event && event.lane;
  if (lane === "dialogue" || lane === "audio" || lane === "sfx" || lane === "camera") return lane;
  if (lane === "body" || lane === "face" || lane === "props") return lane;

  const tag = String((event && event.tag) || "").toLowerCase();
  if (tag === "camera") return "camera";
  if (tag === "dialogue") return "dialogue";
  if (tag === "audio") return "audio";
  if (tag === "prop" || (event && event.subjectKind === "prop")) return "props";
  if (tag === "move" || tag === "pose" || tag === "swing") return "body";

  const keys = eventKeys(event || {});
  const label = event && event.label;
  if (hasFaceKeys(keys, label) && !hasBodyKeys(keys, label)) return "face";
  return "body";
}

function classifyEvents(events) {
  return (events || []).map((event) => ({
    ...event,
    lane: assignActionLane(event),
  }));
}

function isInstant(event) {
  return !(event.endFrame > event.startFrame);
}

/**
 * Instant pins hold until the next instant pin in the same
 * scene + lane + subject, or the scene end. Timed Move / Pose / Swing
 * blocks are left alone so wait=false over=/for= durations stay real
 * and can overlap those holds.
 */
function extendActionHolds(events, sceneLengthById) {
  const out = events.map((event) => ({ ...event }));
  const byKey = new Map();
  for (let i = 0; i < out.length; i++) {
    const event = out[i];
    if (event.lane !== "body" && event.lane !== "face" && event.lane !== "props") continue;
    if (!isInstant(event)) continue;
    const key = `${event.sceneId}::${event.lane}::${event.subject || ""}`;
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
        if (other.lane !== event.lane) continue;
        if (other.sceneId !== event.sceneId) continue;
        if (other.subject !== event.subject) continue;
        if (!isInstant(other)) continue;
        if (other.startFrame > event.startFrame && other.startFrame < nextStart) {
          nextStart = other.startFrame;
        }
      }
      event.endFrame = Math.max(event.startFrame, nextStart);
    }
  }
  return out;
}

function blockEnd(block) {
  return Math.max(block.endFrame, block.startFrame + 1);
}

/**
 * Greedy interval packing: overlapping blocks in the same lane get
 * distinct row indexes so none hide each other. Adjacent (end === next
 * start) does not count as overlap.
 */
function assignOverlapRows(blocks) {
  const byLane = new Map();
  for (const block of blocks) {
    const list = byLane.get(block.lane) || [];
    list.push(block);
    byLane.set(block.lane, list);
  }
  for (const list of byLane.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        a.startFrame - b.startFrame ||
        blockEnd(a) - blockEnd(b) ||
        (a.scriptLine || 0) - (b.scriptLine || 0)
    );
    const rowEnds = [];
    for (const block of sorted) {
      const end = blockEnd(block);
      let row = 0;
      for (; row < rowEnds.length; row++) {
        if (rowEnds[row] <= block.startFrame) break;
      }
      if (row === rowEnds.length) rowEnds.push(end);
      else rowEnds[row] = end;
      block.row = row;
    }
  }
  return blocks;
}

function mouthLabel(label) {
  const text = String(label || "");
  const cut = text.indexOf(":");
  const name = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return name ? `${name} mouth` : "mouth";
}

function addMouthBlocks(blocks) {
  const extra = [];
  for (const block of blocks) {
    if (block.lane !== "dialogue") continue;
    if (block.sync !== "synced" && block.sync !== "stale") continue;
    if (!Array.isArray(block.cues) || block.cues.length === 0) continue;
    extra.push({
      ...block,
      id: `face-mouth-${block.sceneId}-${block.scriptLine}`,
      lane: "face",
      role: "mouth",
      label: mouthLabel(block.label),
      movable: false,
      timing: {
        kind: "dialogue",
        tag: "mouth",
        attr: (block.timing && block.timing.attr) || null,
        movable: false,
      },
    });
  }
  return blocks.concat(extra);
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
  const classified = classifyEvents(parsed.laneEvents || []);
  const local = extendActionHolds(classified, sceneLengthById);

  const blocks = local.map((event, index) => {
    const base = offsets.get(event.sceneId) || 0;
    const startFrame = base + event.startFrame;
    const endFrame = base + event.endFrame;
    const sourceLocal = event.sourceStartFrame != null ? event.sourceStartFrame : event.startFrame;
    return {
      id: `${event.lane}-${event.sceneId}-${event.scriptLine}-${index}`,
      lane: event.lane,
      label: event.label,
      startFrame,
      endFrame: Math.max(endFrame, startFrame),
      scriptLine: event.scriptLine,
      sceneId: event.sceneId,
      rel: event.rel || null,
      row: 0,
      tag: event.tag || null,
      sourceStartFrame: base + sourceLocal,
      timing: event.timing || null,
      movable: event.scriptLine != null && event.scriptLine > 0 && (!event.timing || event.timing.movable !== false),
      cues: Array.isArray(event.cues) ? event.cues : [],
      view: event.view || null,
      marriedId: event.marriedId || null,
      trim: event.trim || { inFrames: 0, outFrames: event.sourceDurationFrames || 0 },
      sourceDurationFrames: event.sourceDurationFrames || 0,
      words: Array.isArray(event.words) ? event.words : [],
      audioRel: event.audioRel || null,
      cuesRel: event.cuesRel || null,
      sync: event.sync || null,
      role: event.role || null,
    };
  });
  const withMouth = addMouthBlocks(blocks);
  assignOverlapRows(withMouth);

  return { fps, totalFrames, lanes: LANES, scenes, blocks: withMouth };
}

module.exports = {
  LANES,
  FACE_KEYS,
  assignActionLane,
  assignOverlapRows,
  addMouthBlocks,
  buildLaneBlocks,
  clampFrame,
};
