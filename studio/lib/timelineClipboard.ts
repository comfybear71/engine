/**
 * Copy / cut / paste / delete / ripple-delete for Stage timeline blocks.
 * Every edit rewrites script text; the worker re-parses.
 *
 * Sequential lines without at_time= are pinned to their current parsed
 * start before a delete so the clock does not silently slide them.
 * Ripple then subtracts the deleted span from later at_time= values
 * in the same scene (all lanes). Other scenes keep their own clocks.
 */

import { findInsertAfterLine, insertLineAfter } from "./cameraTag.ts";
import {
  formatAtTime,
  idsForMarriedGroup,
  isMouthBlock,
  lineHasAttr,
  setAtTimeOnLine,
} from "./timelineEdit.ts";
import type { LaneId } from "./worker";

export type ClipboardLine = {
  lineText: string;
  lane: LaneId | string;
  tag: string | null;
  role: string | null;
  offsetFrames: number;
  durationFrames: number;
};

export type TimelineClipboard = {
  items: ClipboardLine[];
};

export type ClipboardBlock = {
  id: string;
  scriptLine?: number | null;
  sceneId?: string;
  startFrame: number;
  endFrame: number;
  sourceStartFrame?: number;
  lane?: string;
  tag?: string | null;
  role?: string | null;
  marriedId?: string | null;
  movable?: boolean;
};

export function relatedEditIds(blocks: ClipboardBlock[], seedIds: Iterable<string>): Set<string> {
  const seeds = new Set(seedIds);
  const ids = idsForMarriedGroup(blocks, seeds);
  const seedBlocks = blocks.filter((block) => seeds.has(block.id));
  const lines = new Set(
    seedBlocks.map((block) => block.scriptLine).filter((line): line is number => line != null)
  );
  for (const block of blocks) {
    if (block.scriptLine != null && lines.has(block.scriptLine)) ids.add(block.id);
  }
  return ids;
}

export function classifyClipboardLine(
  line: string,
  lane?: string | null,
  role?: string | null
): "speech" | "face" | "body" | "prop" | "camera" | "sfx" | "other" {
  if (role === "mouth" || lane === "dialogue" || lane === "audio") return "speech";
  const trimmed = line.trim();
  if (/^\[Audio:/i.test(trimmed)) return "speech";
  if (/^\[Prop:/i.test(trimmed)) return "prop";
  if (/^\[Camera:/i.test(trimmed)) return "camera";
  if (/^\[(?:Move|Pose|Swing):/i.test(trimmed)) return "body";
  if (/^\[Action:/i.test(trimmed)) {
    if (/\b(?:face|eyes|head)=/i.test(trimmed)) return "face";
    return "body";
  }
  if (lane === "face") return "face";
  if (lane === "body") return "body";
  if (lane === "props") return "prop";
  if (lane === "camera") return "camera";
  if (lane === "sfx") return "sfx";
  if (!trimmed.startsWith("[") && trimmed.includes(":")) return "speech";
  return "other";
}

const LANE_FIT: Record<string, readonly string[]> = {
  speech: ["dialogue", "audio", "face"],
  face: ["face"],
  body: ["body"],
  prop: ["props"],
  camera: ["camera"],
  sfx: ["sfx"],
};

export function clipboardItemFitsLane(item: ClipboardLine, lane: LaneId | null | undefined): boolean {
  if (!lane) return true;
  const kind = classifyClipboardLine(item.lineText, item.lane, item.role);
  const allowed = LANE_FIT[kind];
  return allowed ? allowed.includes(lane) : false;
}

function primaryBlockForLine(blocks: ClipboardBlock[], scriptLine: number): ClipboardBlock | null {
  const members = blocks.filter((block) => block.scriptLine === scriptLine);
  if (members.length === 0) return null;
  return (
    members.find((block) => block.lane === "audio") ||
    members.find((block) => block.lane === "dialogue") ||
    members.find((block) => !isMouthBlock(block)) ||
    members[0]
  );
}

export function clipboardFromBlocks(
  script: string,
  blocks: ClipboardBlock[],
  seedIds: Iterable<string>
): TimelineClipboard {
  const ids = relatedEditIds(blocks, seedIds);
  const lines = script.split("\n");
  const seen = new Set<number>();
  const items: ClipboardLine[] = [];
  let origin = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    if (!ids.has(block.id) || block.scriptLine == null || seen.has(block.scriptLine)) continue;
    const primary = primaryBlockForLine(blocks, block.scriptLine);
    if (!primary || primary.scriptLine == null) continue;
    const text = lines[primary.scriptLine - 1];
    if (!text || !isDeletableScriptLine(text)) continue;
    seen.add(primary.scriptLine);
    const start = primary.sourceStartFrame ?? primary.startFrame;
    origin = Math.min(origin, start);
    items.push({
      lineText: text,
      lane: primary.lane || "body",
      tag: primary.tag || null,
      role: primary.role || null,
      offsetFrames: start,
      durationFrames: Math.max(1, primary.endFrame - primary.startFrame),
    });
  }
  if (!Number.isFinite(origin)) return { items: [] };
  for (const item of items) item.offsetFrames = Math.max(0, item.offsetFrames - origin);
  items.sort((a, b) => a.offsetFrames - b.offsetFrames);
  return { items };
}

export function isDeletableScriptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (/^\[(?:Scene|Location|Cast|Pause|View)\s*:/i.test(trimmed)) return false;
  if (/^\[(?:Action|Prop|Layer|Move|Pose|Swing|Camera|Audio)\s*:/i.test(trimmed)) return true;
  return !trimmed.startsWith("[") && trimmed.includes(":");
}

export type TimeRange = { sceneId: string; start: number; end: number };

export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  const byScene = new Map<string, { start: number; end: number }[]>();
  for (const range of ranges) {
    const list = byScene.get(range.sceneId) || [];
    list.push({ start: range.start, end: range.end });
    byScene.set(range.sceneId, list);
  }
  const out: TimeRange[] = [];
  for (const [sceneId, list] of byScene) {
    list.sort((a, b) => a.start - b.start);
    let current = list[0];
    for (let i = 1; i < list.length; i++) {
      if (list[i].start <= current.end) {
        current = { start: current.start, end: Math.max(current.end, list[i].end) };
      } else {
        out.push({ sceneId, ...current });
        current = list[i];
      }
    }
    if (current) out.push({ sceneId, start: current.start, end: current.end });
  }
  return out;
}

function sceneStartFor(scenes: { id: string; startFrame: number }[], sceneId: string): number {
  return scenes.find((scene) => scene.id === sceneId)?.startFrame ?? 0;
}

export function pinMissingAtTimes(
  script: string,
  blocks: ClipboardBlock[],
  scenes: { id: string; startFrame: number }[],
  fps: number,
  skipLines?: Iterable<number>
): string {
  const skip = new Set(skipLines || []);
  const byLine = new Map<number, { start: number; sceneStart: number }>();
  for (const block of blocks) {
    if (block.scriptLine == null || block.scriptLine < 1 || skip.has(block.scriptLine)) continue;
    const start = block.sourceStartFrame ?? block.startFrame;
    const existing = byLine.get(block.scriptLine);
    if (!existing || start < existing.start) {
      byLine.set(block.scriptLine, {
        start,
        sceneStart: sceneStartFor(scenes, block.sceneId || ""),
      });
    }
  }
  const lines = script.split("\n");
  for (const [lineNo, info] of byLine) {
    const line = lines[lineNo - 1];
    if (!line || !isDeletableScriptLine(line)) continue;
    if (lineHasAttr(line, "at_time") || /\bstart=\S+/i.test(line)) continue;
    lines[lineNo - 1] = setAtTimeOnLine(line, formatAtTime(Math.max(0, info.start - info.sceneStart), fps));
  }
  return lines.join("\n");
}

function shiftFramesBefore(sceneId: string, start: number, ranges: TimeRange[]): number {
  let shift = 0;
  for (const range of ranges) {
    if (range.sceneId !== sceneId) continue;
    if (range.end <= start) shift += Math.max(0, range.end - range.start);
  }
  return shift;
}

export function shiftLaterAtTimes(
  script: string,
  blocks: ClipboardBlock[],
  scenes: { id: string; startFrame: number }[],
  fps: number,
  ranges: TimeRange[],
  skipLines: Iterable<number>
): string {
  const skip = new Set(skipLines);
  const byLine = new Map<number, { start: number; sceneId: string }>();
  for (const block of blocks) {
    if (block.scriptLine == null || block.scriptLine < 1 || skip.has(block.scriptLine)) continue;
    const start = block.sourceStartFrame ?? block.startFrame;
    const existing = byLine.get(block.scriptLine);
    if (!existing || start < existing.start) {
      byLine.set(block.scriptLine, { start, sceneId: block.sceneId || "" });
    }
  }
  const lines = script.split("\n");
  for (const [lineNo, info] of byLine) {
    const shift = shiftFramesBefore(info.sceneId, info.start, ranges);
    if (shift <= 0) continue;
    const line = lines[lineNo - 1];
    if (!line || !isDeletableScriptLine(line)) continue;
    const sceneStart = sceneStartFor(scenes, info.sceneId);
    const local = Math.max(0, info.start - sceneStart - shift);
    lines[lineNo - 1] = setAtTimeOnLine(line, formatAtTime(local, fps));
  }
  return lines.join("\n");
}

export function removeScriptLines(script: string, lineNumbers: Iterable<number>): string {
  const drop = new Set([...lineNumbers].filter((n) => n >= 1));
  if (drop.size === 0) return script;
  return script
    .split("\n")
    .filter((_line, index) => !drop.has(index + 1))
    .join("\n");
}

export function deletedRangesForIds(blocks: ClipboardBlock[], ids: Iterable<string>): TimeRange[] {
  const wanted = new Set(ids);
  const byLine = new Map<number, TimeRange>();
  for (const block of wanted) {
    const hit = blocks.find((item) => item.id === block);
    if (!hit || hit.scriptLine == null) continue;
    const start = hit.sourceStartFrame ?? hit.startFrame;
    const existing = byLine.get(hit.scriptLine);
    if (!existing) {
      byLine.set(hit.scriptLine, {
        sceneId: hit.sceneId || "",
        start,
        end: Math.max(hit.endFrame, start + 1),
      });
      continue;
    }
    existing.start = Math.min(existing.start, start);
    existing.end = Math.max(existing.end, hit.endFrame);
  }
  return mergeTimeRanges([...byLine.values()]);
}

export function deleteBlocksInScript(opts: {
  script: string;
  blocks: ClipboardBlock[];
  ids: Iterable<string>;
  scenes: { id: string; startFrame: number }[];
  fps: number;
  ripple: boolean;
}): string {
  const ids = relatedEditIds(opts.blocks, opts.ids);
  const lineNumbers = new Set<number>();
  for (const block of opts.blocks) {
    if (!ids.has(block.id) || block.scriptLine == null) continue;
    const text = opts.script.split("\n")[block.scriptLine - 1] || "";
    if (!isDeletableScriptLine(text)) continue;
    lineNumbers.add(block.scriptLine);
  }
  if (lineNumbers.size === 0) return opts.script;
  const ranges = deletedRangesForIds(opts.blocks, ids);
  const sceneIds = new Set(ranges.map((range) => range.sceneId));
  const scoped = opts.blocks.filter((block) => sceneIds.has(block.sceneId || ""));
  let next = pinMissingAtTimes(opts.script, scoped, opts.scenes, opts.fps);
  if (opts.ripple) {
    next = shiftLaterAtTimes(next, scoped, opts.scenes, opts.fps, ranges, lineNumbers);
  }
  return removeScriptLines(next, lineNumbers);
}

export function pasteClipboardInScript(opts: {
  script: string;
  clipboard: TimelineClipboard;
  playhead: number;
  fps: number;
  scenes: { id: string; startFrame: number; endFrame: number }[];
  playheadLine: number | null;
  lane?: LaneId | null;
}): string {
  const items = opts.clipboard.items.filter((item) => clipboardItemFitsLane(item, opts.lane));
  if (items.length === 0) return opts.script;
  const scene =
    opts.scenes.find((item) => opts.playhead >= item.startFrame && opts.playhead < item.endFrame) ||
    opts.scenes[opts.scenes.length - 1] ||
    null;
  let after = findInsertAfterLine(opts.script, opts.playheadLine, scene?.id ?? null);
  let next = opts.script;
  for (const item of items) {
    const local = Math.max(0, Math.round(opts.playhead - (scene?.startFrame ?? 0) + item.offsetFrames));
    const line = setAtTimeOnLine(item.lineText, formatAtTime(local, opts.fps));
    next = insertLineAfter(next, after, line);
    after += 1;
  }
  return next;
}

export function duplicateBlocksInScript(opts: {
  script: string;
  blocks: ClipboardBlock[];
  ids: Iterable<string>;
  fps: number;
  scenes: { id: string; startFrame: number; endFrame: number }[];
}): string {
  const clipboard = clipboardFromBlocks(opts.script, opts.blocks, opts.ids);
  if (clipboard.items.length === 0) return opts.script;
  const ids = relatedEditIds(opts.blocks, opts.ids);
  const members = opts.blocks.filter((block) => ids.has(block.id));
  if (members.length === 0) return opts.script;
  const end = Math.max(...members.map((block) => block.endFrame));
  const scene =
    opts.scenes.find((item) => members[0].sceneId && item.id === members[0].sceneId) ||
    opts.scenes.find((item) => end >= item.startFrame && end < item.endFrame) ||
    opts.scenes[opts.scenes.length - 1] ||
    null;
  const primary = primaryBlockForLine(opts.blocks, members.find((block) => block.scriptLine != null)?.scriptLine || 0);
  return pasteClipboardInScript({
    script: opts.script,
    clipboard,
    playhead: end,
    fps: opts.fps,
    scenes: opts.scenes,
    playheadLine: primary?.scriptLine ?? null,
  });
}
