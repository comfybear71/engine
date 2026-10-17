/**
 * Add / remove props on the Stage page. The script stays the source of truth:
 * every change is a `[Prop: name hide|show at_time=...]` line.
 */

import { findInsertAfterLine, insertLineAfter } from "./cameraTag.ts";
import { sceneAtFrame } from "./stageAssets.ts";
import { formatAtTime } from "./timelineEdit.ts";
import type { PropAsset, StageLayer } from "./worker";

export type PropScope = "here" | "scene";

export type ScenePropState = {
  id: string;
  visible: boolean;
  placed: boolean;
  thumbRel: string | null;
  mtime?: number | null;
};

export function propVisibleAt(layers: StageLayer[], propId: string, sceneLocalFrame: number): boolean {
  return layers.some(
    (layer) =>
      layer.kind === "prop" &&
      layer.prop_id === propId &&
      layer.start_frame <= sceneLocalFrame &&
      (layer.end_frame == null || sceneLocalFrame < layer.end_frame)
  );
}

export function scenePropStates(
  props: PropAsset[],
  location: string | null,
  layers: StageLayer[],
  sceneLocalFrame: number
): ScenePropState[] {
  if (!location) return [];
  return props
    .filter((prop) => prop.location === location)
    .map((prop) => ({
      id: prop.id,
      visible: propVisibleAt(layers, prop.id, sceneLocalFrame),
      placed: prop.x != null && prop.y != null,
      thumbRel: prop.thumbRel,
      mtime: prop.mtime,
    }))
    .sort((a, b) => Number(b.visible) - Number(a.visible) || a.id.localeCompare(b.id));
}

export function propTagLine(opts: {
  propId: string;
  action: "hide" | "show";
  sceneLocalFrame: number;
  fps: number;
  at?: { x: number; y: number } | null;
}): string {
  const at = formatAtTime(opts.sceneLocalFrame, opts.fps);
  const pos = opts.action === "show" && opts.at ? ` at=${Math.round(opts.at.x)},${Math.round(opts.at.y)}` : "";
  return `[Prop: ${opts.propId} ${opts.action}${pos} at_time=${at}]`;
}

/**
 * Hide (remove) or show (add) a location prop. `scope: "scene"` writes the
 * line at the start of the scene so the prop is gone / present for the whole
 * scene; `"here"` writes it at the playhead.
 */
export function applyPropEdit(opts: {
  script: string;
  propId: string;
  action: "hide" | "show";
  scope: PropScope;
  frame: number;
  fps: number;
  scenes: { id: string; startFrame: number; endFrame: number }[];
  playheadLine: number | null;
  placed: boolean;
  defaultAt: { x: number; y: number };
}): string {
  const scene = sceneAtFrame(opts.scenes, opts.frame);
  const local =
    opts.scope === "scene" ? 0 : Math.max(0, Math.round(opts.frame - (scene?.startFrame ?? 0)));
  const line = propTagLine({
    propId: opts.propId,
    action: opts.action,
    sceneLocalFrame: local,
    fps: opts.fps,
    at: opts.placed ? null : opts.defaultAt,
  });
  const after = findInsertAfterLine(opts.script, opts.scope === "scene" ? null : opts.playheadLine, scene?.id ?? null);
  return insertLineAfter(opts.script, after, line);
}
