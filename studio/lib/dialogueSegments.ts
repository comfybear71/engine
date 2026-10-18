import type { TalkingHeadRange } from "./worker.ts";

export type DialogueSegment = { id: string; startSec: number; endSec: number; text: string };

export const MIN_SEGMENT_SEC = 0.3;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The free stretch of the recording around `atSec`, between the neighbouring segments (the one being edited is ignored). */
export function freeBounds(segments: DialogueSegment[], atSec: number, durationSec: number, ignoreId?: string): { min: number; max: number } {
  let min = 0;
  let max = Math.max(0, durationSec);
  for (const seg of segments) {
    if (seg.id === ignoreId) continue;
    if (seg.endSec <= atSec && seg.endSec > min) min = seg.endSec;
    if (seg.startSec >= atSec && seg.startSec < max) max = seg.startSec;
  }
  return { min, max };
}

/** A range kept inside the recording and clear of the other segments, or null when it would be shorter than the minimum. */
export function fitRange(
  segments: DialogueSegment[],
  startSec: number,
  endSec: number,
  durationSec: number,
  ignoreId?: string,
  anchorSec?: number
): { startSec: number; endSec: number } | null {
  const lo = Math.min(startSec, endSec);
  const hi = Math.max(startSec, endSec);
  const at = anchorSec ?? (lo + hi) / 2;
  if (segments.some((seg) => seg.id !== ignoreId && at > seg.startSec && at < seg.endSec)) return null;
  const free = freeBounds(segments, at, durationSec, ignoreId);
  const a = round2(Math.max(free.min, lo));
  const b = round2(Math.min(free.max, hi));
  return b - a >= MIN_SEGMENT_SEC - 1e-9 ? { startSec: a, endSec: b } : null;
}

export function addSegment(
  segments: DialogueSegment[],
  startSec: number,
  endSec: number,
  durationSec: number,
  id: string,
  anchorSec?: number
): DialogueSegment[] | null {
  const fit = fitRange(segments, startSec, endSec, durationSec, undefined, anchorSec);
  if (!fit) return null;
  return [...segments, { id, ...fit, text: "" }].sort((x, y) => x.startSec - y.startSec);
}

export function updateSegmentRange(
  segments: DialogueSegment[],
  id: string,
  startSec: number,
  endSec: number,
  durationSec: number
): DialogueSegment[] {
  const fit = fitRange(segments, startSec, endSec, durationSec, id);
  if (!fit) return segments;
  return segments.map((seg) => (seg.id === id ? { ...seg, ...fit } : seg)).sort((x, y) => x.startSec - y.startSec);
}

/** What the talking-head dialog needs for one segment. The typed words (if any) are spread over exactly this stretch of the recording. */
export function segmentRange(audioRel: string, seg: DialogueSegment): TalkingHeadRange {
  const durationSec = round2(seg.endSec - seg.startSec);
  const text = seg.text.trim();
  return {
    audioRel,
    inSec: seg.startSec,
    durationSec,
    ...(text ? { text, textInSec: seg.startSec, textDurationSec: durationSec } : {}),
  };
}

/** m:ss.s for a position in the recording. */
export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const whole = Math.floor(s / 60);
  return `${whole}:${(s - whole * 60).toFixed(1).padStart(4, "0")}`;
}

/** Reads "83.4", "1:23", "1:23.4" (seconds) back into seconds; null when it is not a time. */
export function parseClock(input: string): number | null {
  const text = String(input || "").trim();
  if (!text) return null;
  const match = text.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const value = Number(match[1] || 0) * 60 + Number(match[2]);
  return Number.isFinite(value) ? value : null;
}
