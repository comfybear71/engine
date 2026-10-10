export type PlaybackVideo = {
  file: string;
  upToDate: boolean;
};

export type PlaybackAudioClip = {
  rel: string;
  startFrame: number;
  endFrame: number;
  exists: boolean;
  durationSeconds?: number | null;
  trimInSec?: number;
  trimOutSec?: number | null;
};

export type PlaybackStatus = {
  fps: number;
  totalFrames: number;
  render: PlaybackVideo | null;
  proxy: PlaybackVideo | null;
  audio: PlaybackAudioClip[];
};

export function isRenderUpToDate(renderMtimeMs: number, scriptMtimeMs: number): boolean {
  return Number.isFinite(renderMtimeMs) && Number.isFinite(scriptMtimeMs) && renderMtimeMs >= scriptMtimeMs;
}

export function chooseVideoFile(
  status: PlaybackStatus | null | undefined
): { file: string; kind: "render" | "proxy" } | null {
  if (!status) return null;
  if (status.render?.upToDate) return { file: status.render.file, kind: "render" };
  if (status.proxy?.upToDate) return { file: status.proxy.file, kind: "proxy" };
  return null;
}

export function frameFromElapsedMs(elapsedMs: number, startFrame: number, fps: number, totalFrames: number): number {
  const safeFps = Math.max(fps, 1);
  const maxFrame = Math.max(0, Math.max(Number(totalFrames) || 1, 1) - 1);
  const next = startFrame + Math.floor((Math.max(0, elapsedMs) / 1000) * safeFps);
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.min(maxFrame, next));
}

/** Upcoming play window rendered as a low-res proxy segment. */
export const PROXY_SEGMENT_SEC = 25;
export const PROXY_SEGMENT_SIZE = { width: 960, height: 540 };
/** Start the next window when this much of the current segment remains. */
export const PROXY_SEGMENT_PREFETCH_SEC = 8;

export function segmentWindow(
  startFrame: number,
  fps: number,
  totalFrames: number,
  durationSec = PROXY_SEGMENT_SEC
): { startFrame: number; frames: number; endFrame: number } {
  const safeFps = Math.max(fps, 1);
  const start = Math.max(0, Math.min(Math.floor(startFrame) || 0, Math.max(0, totalFrames - 1)));
  const frames = Math.max(1, Math.min(Math.round(durationSec * safeFps), Math.max(1, totalFrames - start)));
  return { startFrame: start, frames, endFrame: start + frames };
}

export function frameInSegment(
  frame: number,
  segment: { startFrame: number; frames: number } | null | undefined
): boolean {
  if (!segment) return false;
  return frame >= segment.startFrame && frame < segment.startFrame + segment.frames;
}

export function shouldFallbackToProxy(frameFetchMs: number, fps: number, _totalFrames = 0): boolean {
  const budget = 1000 / Math.max(fps, 1);
  return Number.isFinite(frameFetchMs) && frameFetchMs > budget * 1.5;
}

/** Bump the Stage audio start generation so in-flight starts abort. */
export function bumpAudioGeneration(generation: number): number {
  return generation + 1;
}

export function clipDurationSec(
  clip: { startFrame: number; endFrame: number; durationSeconds?: number | null },
  fps: number
): number {
  if (clip.durationSeconds != null && Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0) {
    return clip.durationSeconds;
  }
  return Math.max(0, (clip.endFrame - clip.startFrame) / Math.max(fps, 1));
}

/** True when this startLineAudio invocation may still create sources. */
export function isLiveAudioStart(
  startedGeneration: number,
  currentGeneration: number,
  playing: boolean
): boolean {
  return startedGeneration === currentGeneration && playing === true;
}

export function audioClipsFromBlocks(
  blocks: {
    lane: string;
    rel?: string | null;
    startFrame: number;
    endFrame: number;
    trim?: { inFrames: number; outFrames: number } | null;
  }[],
  totalFrames: number,
  fps = 24
): { rel: string; startFrame: number; endFrame: number; trimInSec: number; trimOutSec: number | null }[] {
  const max = Math.max(Number(totalFrames) || 0, 0);
  const safeFps = Math.max(fps, 1);
  return blocks
    .filter((block) => block.lane === "audio" && typeof block.rel === "string" && block.rel.length > 0)
    .map((block) => ({
      rel: block.rel as string,
      startFrame: Math.max(0, block.startFrame),
      endFrame: Math.min(max, Math.max(block.endFrame, block.startFrame)),
      trimInSec: (block.trim?.inFrames || 0) / safeFps,
      trimOutSec: block.trim?.outFrames ? block.trim.outFrames / safeFps : null,
    }))
    .filter((clip) => clip.endFrame > clip.startFrame);
}

/** Where to start a clip in Web Audio relative to the current playhead. */
export function webAudioSchedule(
  clip: { startFrame: number; endFrame: number; durationSec: number; trimInSec?: number; trimOutSec?: number | null },
  playheadFrame: number,
  fps: number,
  totalFrames: number
): { offsetSec: number; delaySec: number; playSec: number } | null {
  const safeFps = Math.max(fps, 1);
  const clipEnd = Math.min(clip.endFrame, Math.max(totalFrames, 0));
  if (clipEnd <= playheadFrame) return null;
  if (clip.startFrame >= totalFrames) return null;
  const trimIn = Math.max(0, clip.trimInSec || 0);
  const trimOut = clip.trimOutSec != null && clip.trimOutSec > trimIn ? clip.trimOutSec : trimIn + clip.durationSec;
  const intoClip = Math.max(0, playheadFrame - clip.startFrame) / safeFps;
  const offsetSec = trimIn + intoClip;
  if (offsetSec >= trimOut - 1e-6) return null;
  const remainOnTimeline = (clipEnd - Math.max(playheadFrame, clip.startFrame)) / safeFps;
  const playSec = Math.max(0, Math.min(trimOut - offsetSec, remainOnTimeline));
  if (playSec <= 0) return null;
  const delaySec = Math.max(0, (clip.startFrame - playheadFrame) / safeFps);
  return { offsetSec, delaySec, playSec };
}

export type FrameCache = {
  get: (frame: number) => string | null;
  has: (frame: number) => boolean;
  put: (frame: number, url: string) => void;
  ensure: (frame: number, loader: () => Promise<string | null>) => Promise<string | null>;
  clear: () => void;
};

export function createFrameCache(): FrameCache {
  const urls = new Map<number, string>();
  const inflight = new Map<number, Promise<string | null>>();

  return {
    get(frame) {
      return urls.get(frame) ?? null;
    },
    has(frame) {
      return urls.has(frame);
    },
    put(frame, url) {
      const prev = urls.get(frame);
      if (prev && prev !== url) URL.revokeObjectURL(prev);
      urls.set(frame, url);
    },
    ensure(frame, loader) {
      const hit = urls.get(frame);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(frame);
      if (pending) return pending;
      const next = loader()
        .then((url) => {
          if (url) {
            const prev = urls.get(frame);
            if (prev && prev !== url) URL.revokeObjectURL(prev);
            urls.set(frame, url);
          }
          return url;
        })
        .finally(() => {
          inflight.delete(frame);
        });
      inflight.set(frame, next);
      return next;
    },
    clear() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      inflight.clear();
    },
  };
}
