export type PlaybackVideo = {
  file: string;
  upToDate: boolean;
};

export type PlaybackAudioClip = {
  rel: string;
  startFrame: number;
  endFrame: number;
  exists: boolean;
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

export function shouldFallbackToProxy(frameFetchMs: number, fps: number): boolean {
  const budget = 1000 / Math.max(fps, 1);
  return Number.isFinite(frameFetchMs) && frameFetchMs > budget * 1.5;
}

export function audioClipsFromBlocks(
  blocks: { lane: string; rel?: string | null; startFrame: number; endFrame: number }[],
  totalFrames: number
): { rel: string; startFrame: number; endFrame: number }[] {
  const max = Math.max(Number(totalFrames) || 0, 0);
  return blocks
    .filter((block) => block.lane === "audio" && typeof block.rel === "string" && block.rel.length > 0)
    .map((block) => ({
      rel: block.rel as string,
      startFrame: Math.max(0, block.startFrame),
      endFrame: Math.min(max, Math.max(block.endFrame, block.startFrame)),
    }))
    .filter((clip) => clip.endFrame > clip.startFrame);
}

/** Where to start a clip in Web Audio relative to the current playhead. */
export function webAudioSchedule(
  clip: { startFrame: number; endFrame: number; durationSec: number },
  playheadFrame: number,
  fps: number,
  totalFrames: number
): { offsetSec: number; delaySec: number } | null {
  const safeFps = Math.max(fps, 1);
  const clipEnd = Math.min(clip.endFrame, Math.max(totalFrames, 0));
  if (clipEnd <= playheadFrame) return null;
  if (clip.startFrame >= totalFrames) return null;
  const offsetSec = Math.max(0, playheadFrame - clip.startFrame) / safeFps;
  if (offsetSec >= clip.durationSec) return null;
  const delaySec = Math.max(0, (clip.startFrame - playheadFrame) / safeFps);
  return { offsetSec, delaySec };
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
