/**
 * Pure timeline maths for the Head Rig body/head tracks: segments never
 * overlap on a track, edges snap to the playhead and to neighbouring cuts,
 * and ripple delete closes the gap it leaves.
 */

export type TrackSeg = {
  id: string;
  start: number;
  inFrame: number;
  outFrame: number;
  /** Playback speed of this clip alone (1 = normal, 2 = twice as fast). */
  speed?: number;
  /** Play the in..out range backwards. */
  reverse?: boolean;
};

export const MIN_SEG_SPEED = 0.1;
export const MAX_SEG_SPEED = 8;

export function normalizeSpeed(speed: number | undefined | null): number {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(MIN_SEG_SPEED, Math.min(MAX_SEG_SPEED, Math.round(n * 1000) / 1000));
}

/** How many source frames the in..out range holds. */
export function segSourceSpan(seg: { inFrame: number; outFrame: number }): number {
  return Math.max(1, seg.outFrame - seg.inFrame + 1);
}

/** Frames the clip occupies on the timeline: the source range divided by its speed. */
export function trackSegLength(seg: { inFrame: number; outFrame: number; speed?: number }): number {
  return Math.max(1, Math.round(segSourceSpan(seg) / normalizeSpeed(seg.speed)));
}

/**
 * Source frame shown at timeline `frame`. Faster clips skip frames, slower
 * clips hold them, and a reversed clip walks from outFrame down to inFrame.
 */
export function sourceFrameAt(
  seg: { start: number; inFrame: number; outFrame: number; speed?: number; reverse?: boolean },
  frame: number
): number {
  const span = segSourceSpan(seg);
  const k = Math.max(0, frame - seg.start);
  const offset = Math.min(span - 1, Math.floor(k * normalizeSpeed(seg.speed) + 1e-9));
  return seg.reverse ? seg.outFrame - offset : seg.inFrame + offset;
}

export function trackSegEnd(seg: TrackSeg): number {
  return seg.start + trackSegLength(seg) - 1;
}

function overlaps(start: number, length: number, other: TrackSeg): boolean {
  return start <= trackSegEnd(other) && start + length - 1 >= other.start;
}

/** Nearest start to `desired` where a clip of `length` fits without covering another clip. */
export function placeInFreeSlot(others: TrackSeg[], desired: number, length: number): number {
  const want = Math.max(1, Math.round(desired));
  const len = Math.max(1, Math.round(length));
  const fits = (start: number) => start >= 1 && !others.some((other) => overlaps(start, len, other));
  if (fits(want)) return want;
  const candidates = new Set<number>([1]);
  for (const other of others) {
    candidates.add(trackSegEnd(other) + 1);
    candidates.add(other.start - len);
  }
  let best: number | null = null;
  for (const candidate of candidates) {
    if (!fits(candidate)) continue;
    if (best == null || Math.abs(candidate - want) < Math.abs(best - want)) best = candidate;
  }
  if (best != null) return best;
  const last = others.reduce((max, other) => Math.max(max, trackSegEnd(other)), 0);
  return last + 1;
}

export type SnapTarget = { frame: number; kind: "playhead" | "edge" };

export function collectSnapTargets(opts: {
  playhead: number;
  tracks: TrackSeg[][];
  ignoreId?: string;
}): SnapTarget[] {
  const out: SnapTarget[] = [{ frame: Math.max(1, Math.round(opts.playhead)), kind: "playhead" }, { frame: 1, kind: "edge" }];
  for (const list of opts.tracks) {
    for (const seg of list) {
      if (seg.id === opts.ignoreId) continue;
      out.push({ frame: seg.start, kind: "edge" });
      out.push({ frame: trackSegEnd(seg) + 1, kind: "edge" });
    }
  }
  return out;
}

/** Snap whichever of a clip's two edges is closest to a target; returns the shifted start. */
export function snapClipStart(
  start: number,
  length: number,
  targets: SnapTarget[],
  thresholdFrames: number
): { start: number; snappedTo: number | null } {
  if (!(thresholdFrames > 0)) return { start, snappedTo: null };
  let best: { start: number; dist: number; to: number } | null = null;
  for (const target of targets) {
    const viaStart = Math.abs(start - target.frame);
    if (viaStart <= thresholdFrames && (!best || viaStart < best.dist)) {
      best = { start: target.frame, dist: viaStart, to: target.frame };
    }
    const viaEnd = Math.abs(start + length - target.frame);
    if (viaEnd <= thresholdFrames && (!best || viaEnd < best.dist)) {
      best = { start: target.frame - length, dist: viaEnd, to: target.frame };
    }
  }
  return best ? { start: best.start, snappedTo: best.to } : { start, snappedTo: null };
}

export function snapEdgeFrame(
  frame: number,
  targets: SnapTarget[],
  thresholdFrames: number
): { frame: number; snappedTo: number | null } {
  let best: { frame: number; dist: number } | null = null;
  for (const target of targets) {
    const dist = Math.abs(frame - target.frame);
    if (dist <= thresholdFrames && (!best || dist < best.dist)) best = { frame: target.frame, dist };
  }
  return best ? { frame: best.frame, snappedTo: best.frame } : { frame, snappedTo: null };
}

/** Source frames a trimmed edge can still be pulled out into, converted to timeline frames. */
function extendRoom(seg: TrackSeg, edge: "in" | "out", sourceFrameCount: number): number {
  const takesFromStart = (edge === "in") !== Boolean(seg.reverse);
  const sourceRoom = takesFromStart ? seg.inFrame - 1 : Math.max(0, sourceFrameCount - seg.outFrame);
  return Math.floor(sourceRoom / normalizeSpeed(seg.speed) + 1e-9);
}

/**
 * Where a trimmed clip's edge may go, in timeline frames. `in` moves the
 * clip's left edge (start shifts with it); `out` moves its right edge.
 * Neighbours on the same track are never covered and the source is never run
 * past its ends.
 */
export function clampTrim(opts: {
  edge: "in" | "out";
  seg: TrackSeg;
  others: TrackSeg[];
  /** Requested shift in timeline frames (negative = earlier). */
  shift: number;
  sourceFrameCount: number;
}): number {
  const { seg, others, edge } = opts;
  if (edge === "in") {
    const prevEnd = others
      .filter((other) => other.start < seg.start)
      .reduce((max, other) => Math.max(max, trackSegEnd(other)), 0);
    const room = seg.start - (prevEnd + 1);
    const minShift = -Math.min(room, extendRoom(seg, "in", opts.sourceFrameCount));
    const maxShift = trackSegLength(seg) - 1;
    return Math.max(minShift, Math.min(maxShift, opts.shift));
  }
  const nextStart = others
    .filter((other) => other.start > seg.start)
    .reduce((min, other) => Math.min(min, other.start), Number.POSITIVE_INFINITY);
  const room = Number.isFinite(nextStart) ? nextStart - 1 - trackSegEnd(seg) : Number.POSITIVE_INFINITY;
  const minShift = -(trackSegLength(seg) - 1);
  const maxShift = Math.min(room, extendRoom(seg, "out", opts.sourceFrameCount));
  return Math.max(minShift, Math.min(maxShift, opts.shift));
}

/** The seg fields a trim of `shift` timeline frames changes (apply after clampTrim). */
export function trimPatch(
  seg: TrackSeg,
  edge: "in" | "out",
  shift: number
): { start?: number; inFrame?: number; outFrame?: number } {
  const src = Math.round(shift * normalizeSpeed(seg.speed));
  const movesInFrame = (edge === "in") !== Boolean(seg.reverse);
  const patch: { start?: number; inFrame?: number; outFrame?: number } = {};
  if (edge === "in") patch.start = seg.start + shift;
  const delta = seg.reverse ? -src : src;
  if (movesInFrame) patch.inFrame = seg.inFrame + delta;
  else patch.outFrame = seg.outFrame + delta;
  return patch;
}

/** Cut a clip in two at timeline `frame` (which must fall inside it). */
export function splitSegment<T extends TrackSeg>(seg: T, frame: number, newId: string): [T, T] | null {
  const length = trackSegLength(seg);
  const k = frame - seg.start;
  if (k < 1 || k > length - 1) return null;
  const span = segSourceSpan(seg);
  const firstSpan = Math.max(1, Math.min(span - 1, Math.round(k * normalizeSpeed(seg.speed))));
  if (span < 2) return null;
  if (seg.reverse) {
    const first = { ...seg, inFrame: seg.outFrame - firstSpan + 1 };
    const second = { ...seg, id: newId, start: frame, outFrame: seg.outFrame - firstSpan };
    return [first, second];
  }
  const first = { ...seg, outFrame: seg.inFrame + firstSpan - 1 };
  const second = { ...seg, id: newId, start: frame, inFrame: seg.inFrame + firstSpan };
  return [first, second];
}

/** Change a clip's speed; clips after it on the track move right only as far as needed. */
export function applySpeed<T extends TrackSeg>(segments: T[], id: string, speed: number): T[] {
  const target = segments.find((s) => s.id === id);
  if (!target) return segments;
  const next = { ...target, speed: normalizeSpeed(speed) === 1 ? undefined : normalizeSpeed(speed) };
  const newEnd = trackSegEnd(next);
  const oldEnd = trackSegEnd(target);
  let pushBy = 0;
  if (newEnd > oldEnd) {
    const following = segments.filter((s) => s.id !== id && s.start > target.start).sort((a, b) => a.start - b.start);
    const first = following[0];
    if (first && first.start <= newEnd) pushBy = newEnd + 1 - first.start;
  }
  return segments.map((s) => {
    if (s.id === id) return next;
    if (pushBy > 0 && s.start > target.start) return { ...s, start: s.start + pushBy };
    return s;
  });
}

/** Remove `id` and slide every later clip on the track left by the removed length. */
export function rippleDelete<T extends TrackSeg>(segments: T[], id: string): T[] {
  const gone = segments.find((seg) => seg.id === id);
  if (!gone) return segments;
  const length = trackSegLength(gone);
  const end = trackSegEnd(gone);
  return segments
    .filter((seg) => seg.id !== id)
    .map((seg) => (seg.start > end ? { ...seg, start: Math.max(1, seg.start - length) } : seg));
}

/**
 * Lay `times` extra copies of a clip straight after it (Resolve's repeat /
 * loop). With `pingPong` every other copy plays backwards, so a few frames
 * rock back and forth smoothly. Later clips on the track are pushed right.
 */
export function repeatSegment<T extends TrackSeg>(
  segments: T[],
  id: string,
  times: number,
  newId: () => string,
  pingPong = false
): { segments: T[]; addedIds: string[] } {
  const base = segments.find((s) => s.id === id);
  const count = Math.max(0, Math.min(200, Math.floor(times)));
  if (!base || count < 1) return { segments, addedIds: [] };
  const length = trackSegLength(base);
  const copies: T[] = [];
  for (let i = 1; i <= count; i++) {
    const reverse = pingPong ? i % 2 === 1 !== Boolean(base.reverse) : base.reverse;
    copies.push({ ...base, id: newId(), start: base.start + length * i, reverse: reverse || undefined });
  }
  const pushBy = length * count;
  const end = trackSegEnd(base);
  const moved = segments.map((s) => (s.id !== id && s.start > end ? { ...s, start: s.start + pushBy } : s));
  return { segments: [...moved, ...copies], addedIds: copies.map((c) => c.id) };
}
