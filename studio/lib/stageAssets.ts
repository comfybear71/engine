/**
 * Drag payload and script-line builders for Stage Assets → timeline / preview.
 * The script stays the source of truth: a drop inserts or rewrites tags.
 */

import { findInsertAfterLine, insertLineAfter, slugifySceneName } from "./cameraTag.ts";
import { formatAtTime } from "./timelineEdit.ts";
import type { LaneId } from "./worker";

export const ASSET_DRAG_MIME = "application/x-engine-asset";

export type AssetDrag =
  | {
      kind: "drawing";
      characterId: string;
      characterName: string;
      slot: string;
      drawing: string;
    }
  | {
      kind: "cycle";
      characterId: string;
      characterName: string;
      slot: string;
      cycle: string;
    }
  | {
      kind: "character";
      characterId: string;
      characterName: string;
    }
  | {
      kind: "prop";
      propId: string;
      location: string;
    }
  | {
      kind: "background";
      locationId: string;
    }
  | {
      kind: "audio";
      audioKind: "imported" | "generated";
      label: string;
      characterId: string;
      characterName: string;
    };

const FACE_SLOT_RE = /^(face|eyes|head)(_|$)/i;
const BODY_SLOT_RE = /^(body)$|hand|arm/i;
const MOUTH_SLOT_RE = /^mouth(_|$)/i;

export function slotLane(slot: string): "face" | "body" | null {
  const name = String(slot || "").trim();
  if (!name || MOUTH_SLOT_RE.test(name)) return null;
  if (FACE_SLOT_RE.test(name)) return "face";
  if (BODY_SLOT_RE.test(name)) return "body";
  return null;
}

export function assetFitsLane(asset: AssetDrag, lane: LaneId | null | undefined): boolean {
  if (!lane) return asset.kind === "background";
  if (asset.kind === "background") return true;
  if (asset.kind === "prop") return lane === "props";
  if (asset.kind === "audio") return asset.audioKind === "imported" && (lane === "audio" || lane === "dialogue");
  if (asset.kind === "character") return false;
  if (asset.kind === "drawing" || asset.kind === "cycle") {
    const dest = slotLane(asset.slot);
    return dest != null && dest === lane;
  }
  return false;
}

export function parseAssetDrag(raw: string | null | undefined): AssetDrag | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AssetDrag;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encodeAssetDrag(asset: AssetDrag): string {
  return JSON.stringify(asset);
}

export function scriptLineForAssetDrop(
  asset: AssetDrag,
  fps: number,
  sceneLocalFrame: number
): string | null {
  const at = formatAtTime(Math.max(0, Math.round(sceneLocalFrame)), fps);
  if (asset.kind === "drawing") {
    if (slotLane(asset.slot) == null) return null;
    return `[Action: ${asset.characterName} ${asset.slot}=${asset.drawing} at_time=${at}]`;
  }
  if (asset.kind === "cycle") {
    if (slotLane(asset.slot) == null) return null;
    return `[Action: ${asset.characterName} ${asset.slot}=${asset.cycle} at_time=${at}]`;
  }
  if (asset.kind === "prop") {
    return `[Prop: ${asset.propId} show at_time=${at}]`;
  }
  if (asset.kind === "audio") {
    if (asset.audioKind !== "imported") return null;
    return `[Audio: ${asset.characterName} file=${asset.label} at_time=${at}]`;
  }
  return null;
}

export function setSceneLocation(script: string, sceneId: string, locationId: string): string {
  if (!sceneId || !locationId) return script;
  const lines = script.split("\n");
  let inScene = false;
  let sceneLine = -1;
  let locationLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const scene = lines[i].match(/^\s*\[Scene:\s*(.+?)\s*\]/i);
    if (scene) {
      const id = slugifySceneName(scene[1]);
      if (inScene && id !== sceneId) break;
      inScene = id === sceneId;
      if (inScene) sceneLine = i;
      continue;
    }
    if (inScene && /^\s*\[Location:/i.test(lines[i])) {
      locationLine = i;
      break;
    }
  }
  const tag = `[Location: ${locationId}]`;
  if (locationLine >= 0) {
    lines[locationLine] = tag;
  } else if (sceneLine >= 0) {
    lines.splice(sceneLine + 1, 0, tag);
  } else {
    return script;
  }
  return lines.join("\n");
}

export function sceneAtFrame(
  scenes: { id: string; startFrame: number; endFrame: number }[],
  frame: number
): { id: string; startFrame: number; endFrame: number } | null {
  if (!scenes.length) return null;
  const hit = scenes.find((scene) => frame >= scene.startFrame && frame < scene.endFrame);
  return hit || scenes[scenes.length - 1];
}

export function applyAssetDropToScript(opts: {
  script: string;
  asset: AssetDrag;
  lane: LaneId | null;
  frame: number;
  fps: number;
  scenes: { id: string; startFrame: number; endFrame: number }[];
  playheadLine: number | null;
}): string {
  const scene = sceneAtFrame(opts.scenes, opts.frame);
  if (opts.asset.kind === "background") {
    if (!scene) return opts.script;
    return setSceneLocation(opts.script, scene.id, opts.asset.locationId);
  }
  if (!assetFitsLane(opts.asset, opts.lane)) return opts.script;
  const local = Math.max(0, Math.round(opts.frame - (scene?.startFrame ?? 0)));
  const line = scriptLineForAssetDrop(opts.asset, opts.fps, local);
  if (!line) return opts.script;
  const after = findInsertAfterLine(opts.script, opts.playheadLine, scene?.id ?? null);
  return insertLineAfter(opts.script, after, line);
}

export type StageMark = { name: string; mark: { x: number; y: number } };

export function nearestMark(marks: StageMark[], x: number, y: number): (StageMark & { dist: number }) | null {
  let best: (StageMark & { dist: number }) | null = null;
  for (const item of marks) {
    const dist = Math.hypot(item.mark.x - x, item.mark.y - y);
    if (!best || dist < best.dist) best = { ...item, dist };
  }
  return best;
}

export function applyStagePlacement(opts: {
  script: string;
  asset: AssetDrag;
  x: number;
  y: number;
  frame: number;
  fps: number;
  scenes: { id: string; startFrame: number; endFrame: number }[];
  playheadLine: number | null;
  marks: StageMark[];
}): string {
  const scene = sceneAtFrame(opts.scenes, opts.frame);
  const local = Math.max(0, Math.round(opts.frame - (scene?.startFrame ?? 0)));
  const at = formatAtTime(local, opts.fps);
  let line: string | null = null;
  if (opts.asset.kind === "prop") {
    line = `[Prop: ${opts.asset.propId} at=${Math.round(opts.x)},${Math.round(opts.y)} at_time=${at}]`;
  } else if (
    opts.asset.kind === "character" ||
    opts.asset.kind === "drawing" ||
    opts.asset.kind === "cycle"
  ) {
    const hit = nearestMark(opts.marks, opts.x, opts.y);
    if (!hit) return opts.script;
    line = `[Action: ${opts.asset.characterName} at=${hit.name} at_time=${at}]`;
  }
  if (!line) return opts.script;
  const after = findInsertAfterLine(opts.script, opts.playheadLine, scene?.id ?? null);
  return insertLineAfter(opts.script, after, line);
}
