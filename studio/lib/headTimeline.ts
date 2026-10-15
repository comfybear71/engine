/**
 * Pure timeline maths for the Head Rig body/head tracks: segments never
 * overlap on a track, edges snap to the playhead and to neighbouring cuts,
 * and ripple delete closes the gap it leaves.
 */

export type TrackSeg = { id: string; start: number; inFrame: number; outFrame: number };

export function trackSegLength(seg: { inFrame: number; outFrame: number }): number {
  return Math.max(1, seg.outFrame - seg.inFrame + 1);
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

/**
 * Where a trimmed clip's edge may go. `in` shifts start and inFrame together;
 * `out` changes outFrame. Neighbours on the same track are never covered.
 */
export function clampTrim(opts: {
  edge: "in" | "out";
  seg: TrackSeg;
  others: TrackSeg[];
  /** Requested shift in frames (negative = earlier). */
  shift: number;
  sourceFrameCount: number;
}): number {
  const { seg, others, edge } = opts;
  if (edge === "in") {
    const prevEnd = others
      .filter((other) => other.start < seg.start)
      .reduce((max, other) => Math.max(max, trackSegEnd(other)), 0);
    const room = seg.start - (prevEnd + 1);
    const minShift = -Math.min(room, seg.inFrame - 1);
    const maxShift = trackSegLength(seg) - 1;
    return Math.max(minShift, Math.min(maxShift, opts.shift));
  }
  const nextStart = others
    .filter((other) => other.start > seg.start)
    .reduce((min, other) => Math.min(min, other.start), Number.POSITIVE_INFINITY);
  const room = Number.isFinite(nextStart) ? nextStart - 1 - trackSegEnd(seg) : Number.POSITIVE_INFINITY;
  const minShift = -(trackSegLength(seg) - 1);
  const maxShift = Math.min(room, Math.max(0, opts.sourceFrameCount - seg.outFrame));
  return Math.max(minShift, Math.min(maxShift, opts.shift));
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
