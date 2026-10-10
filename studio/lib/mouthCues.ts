export const MOUTH_SHAPES = ["X", "A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];

export type MouthCue = {
  shape: string;
  start: number;
  end: number;
  pinned?: boolean;
};

export function cueSourceTimes(
  cue: MouthCue,
  trimInFrames: number | null | undefined,
  fps: number
): { start: number; end: number } {
  const trimSec = Math.max(0, Number(trimInFrames) || 0) / Math.max(1, fps);
  return { start: trimSec + cue.start, end: trimSec + cue.end };
}

export function blocksIntersectingView<T extends { startFrame: number; endFrame: number }>(
  blocks: T[],
  viewStartFrame: number,
  viewEndFrame: number
): T[] {
  const from = Math.min(viewStartFrame, viewEndFrame);
  const to = Math.max(viewStartFrame, viewEndFrame);
  return blocks.filter((block) => block.endFrame >= from && block.startFrame <= to);
}

export function visibleCueIndexes(
  cues: MouthCue[],
  clipStartFrame: number,
  fps: number,
  viewStartFrame: number,
  viewEndFrame: number,
  limit = 120
): number[] {
  const out: number[] = [];
  const safeFps = Math.max(1, fps);
  for (let i = 0; i < cues.length; i++) {
    const start = clipStartFrame + cues[i].start * safeFps;
    const end = clipStartFrame + cues[i].end * safeFps;
    if (end >= viewStartFrame && start <= viewEndFrame) {
      out.push(i);
      if (out.length >= limit) break;
    }
  }
  return out;
}
