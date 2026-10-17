import { sourceFrameAt, trackSegEnd, trackSegLength, normalizeSpeed } from "./headTimeline.ts";

type AudioSeg = {
  id: string;
  shotId: string;
  start: number;
  inFrame: number;
  outFrame: number;
  speed?: number;
  reverse?: boolean;
};

type AudioShot = { fps?: number; talk?: { audio?: string } | null };

export type AudioLaneItem = {
  segId: string;
  shotId: string;
  start: number;
  length: number;
  /** Seconds into the shot's audio.wav where this piece starts and ends (source order). */
  fromSec: number;
  toSec: number;
  speed: number;
  reverse: boolean;
};

export const SHOT_AUDIO_REL = "audio.wav";

/** A talking-head clip carries the audio slice it was made from, next to its frames. */
export function shotHasAudio(shot: AudioShot | null | undefined): boolean {
  return Boolean(shot?.talk?.audio);
}

function shotFps(shot: AudioShot | null | undefined, fallback: number): number {
  const fps = Number(shot?.fps);
  return Number.isFinite(fps) && fps > 0 ? fps : Math.max(1, fallback);
}

/** The pieces of dialogue on a track: one per segment whose clip has audio, placed exactly where the segment sits. */
export function audioLaneItems(segments: AudioSeg[], shotsById: Map<string, AudioShot>, timelineFps: number): AudioLaneItem[] {
  const items: AudioLaneItem[] = [];
  for (const seg of segments) {
    const shot = shotsById.get(seg.shotId);
    if (!shotHasAudio(shot)) continue;
    const fps = shotFps(shot, timelineFps);
    items.push({
      segId: seg.id,
      shotId: seg.shotId,
      start: seg.start,
      length: trackSegLength(seg),
      fromSec: Math.max(0, (seg.inFrame - 1) / fps),
      toSec: Math.max(0, seg.outFrame / fps),
      speed: normalizeSpeed(seg.speed),
      reverse: seg.reverse === true,
    });
  }
  return items;
}

/** Which audio should be heard at a timeline frame, and where in the file. Reversed pieces are silent. */
export function audioAtFrame(
  segments: AudioSeg[],
  shotsById: Map<string, AudioShot>,
  frame: number,
  timelineFps: number
): { segId: string; shotId: string; timeSec: number; rate: number } | null {
  for (const seg of segments) {
    if (frame < seg.start || frame > trackSegEnd(seg)) continue;
    const shot = shotsById.get(seg.shotId);
    if (!shotHasAudio(shot) || seg.reverse === true) return null;
    const rate = normalizeSpeed(seg.speed);
    const fps = shotFps(shot, timelineFps);
    return { segId: seg.id, shotId: seg.shotId, timeSec: Math.max(0, (sourceFrameAt(seg, frame) - 1) / fps), rate };
  }
  return null;
}

/** Loudness per bucket (0..1) for drawing a waveform. */
export function audioPeaks(samples: ArrayLike<number>, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Array<number>(n).fill(0);
  if (!samples.length) return out;
  const per = samples.length / n;
  let loudest = 0;
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((b + 1) * per)));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      const v = Math.abs(Number(samples[i]) || 0);
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > loudest) loudest = peak;
  }
  return loudest > 0 ? out.map((v) => v / loudest) : out;
}

/** The slice of a whole-file peak list that covers [fromSec, toSec] of a file lasting durationSec. */
export function sliceAudioPeaks(peaks: number[], durationSec: number, fromSec: number, toSec: number): number[] {
  if (!peaks.length || !(durationSec > 0)) return [];
  const a = Math.max(0, Math.min(peaks.length, Math.floor((fromSec / durationSec) * peaks.length)));
  const b = Math.max(a + 1, Math.min(peaks.length, Math.ceil((toSec / durationSec) * peaks.length)));
  return peaks.slice(a, b);
}
