export const TIMELINE_ZOOM_KEY = "engine.studio.timelineZoom.v1";
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;
export const MIN_PIXELS_PER_FRAME = 0.12;
export const MAX_PIXELS_PER_FRAME = 32;
export const RULER_TARGET_PX = 88;
export const ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function fitPixelsPerFrame(totalFrames: number, viewWidth: number): number {
  const frames = Math.max(Number(totalFrames) || 1, 1);
  const width = Math.max(Number(viewWidth) || 1, 1);
  return width / frames;
}

export function pixelsPerFrame(zoom: number, totalFrames: number, viewWidth: number): number {
  const fit = fitPixelsPerFrame(totalFrames, viewWidth);
  const raw = fit * clampZoom(zoom);
  return Math.min(MAX_PIXELS_PER_FRAME, Math.max(MIN_PIXELS_PER_FRAME, raw));
}

export function trackWidthPx(totalFrames: number, ppf: number, viewWidth: number): number {
  return Math.max(Math.max(viewWidth, 1), Math.max(totalFrames, 1) * ppf);
}

export function frameAtTrackX(x: number, ppf: number, totalFrames: number): number {
  const maxFrame = Math.max(0, Math.max(Number(totalFrames) || 1, 1) - 1);
  if (!(ppf > 0) || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(maxFrame, Math.round(x / ppf)));
}

export function scrollToKeepFrame(frame: number, ppf: number, cursorX: number, viewWidth: number, trackW: number): number {
  const x = frame * ppf;
  const maxScroll = Math.max(0, trackW - viewWidth);
  return Math.max(0, Math.min(maxScroll, x - cursorX));
}

/** Return a new scrollLeft when the playhead is outside the padded viewport; otherwise null. */
export function followPlayheadScroll(
  frame: number,
  ppf: number,
  scrollLeft: number,
  viewWidth: number,
  pad = 56
): number | null {
  const x = frame * ppf;
  if (x >= scrollLeft + pad && x <= scrollLeft + viewWidth - pad) return null;
  return Math.max(0, x - viewWidth * 0.4);
}

export function zoomAroundCursor(
  currentZoom: number,
  factor: number,
  cursorXInView: number,
  scrollLeft: number,
  totalFrames: number,
  viewWidth: number
): { zoom: number; scrollLeft: number } {
  const oldPpf = pixelsPerFrame(currentZoom, totalFrames, viewWidth);
  const frame = (scrollLeft + cursorXInView) / Math.max(oldPpf, 1e-6);
  const zoom = clampZoom(currentZoom * factor);
  const newPpf = pixelsPerFrame(zoom, totalFrames, viewWidth);
  const trackW = trackWidthPx(totalFrames, newPpf, viewWidth);
  return {
    zoom,
    scrollLeft: scrollToKeepFrame(frame, newPpf, cursorXInView, viewWidth, trackW),
  };
}

const FRAME_STEPS = [1, 2, 5, 10, 15, 20, 30];

export function rulerIntervalFrames(ppf: number, fps: number, targetPx = RULER_TARGET_PX): number {
  const safeFps = Math.max(Math.round(fps) || 24, 1);
  const candidates = [
    ...FRAME_STEPS,
    safeFps,
    safeFps * 2,
    safeFps * 5,
    safeFps * 10,
    safeFps * 15,
    safeFps * 30,
    safeFps * 60,
    safeFps * 120,
    safeFps * 300,
    safeFps * 600,
  ];
  const safePpf = Math.max(ppf, 1e-6);
  for (const step of candidates) {
    if (step * safePpf >= targetPx) return step;
  }
  return candidates[candidates.length - 1];
}

export function formatRulerLabel(frame: number, fps: number, intervalFrames: number): string {
  const safeFps = Math.max(Math.round(fps) || 24, 1);
  const safeFrame = Math.max(0, frame);
  if (intervalFrames < safeFps) return `${safeFrame}f`;
  const totalSeconds = safeFrame / safeFps;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  if (intervalFrames < safeFps * 60) return `${m}:${String(s).padStart(2, "0")}`;
  return `${m}m`;
}

export function visibleFrameRange(
  scrollLeft: number,
  viewWidth: number,
  ppf: number,
  totalFrames: number
): { start: number; end: number } {
  const maxFrame = Math.max(0, Math.max(Number(totalFrames) || 1, 1) - 1);
  const safePpf = Math.max(ppf, 1e-6);
  const start = Math.max(0, Math.floor(scrollLeft / safePpf) - 2);
  const end = Math.min(maxFrame, Math.ceil((scrollLeft + viewWidth) / safePpf) + 2);
  return { start, end };
}

export function rulerTicks(opts: {
  totalFrames: number;
  fps: number;
  ppf: number;
  scrollLeft: number;
  viewWidth: number;
  targetPx?: number;
}): { frame: number; label: string; major: boolean }[] {
  const interval = rulerIntervalFrames(opts.ppf, opts.fps, opts.targetPx ?? RULER_TARGET_PX);
  const minor = interval >= 5 && (interval * opts.ppf) / 5 >= 7 ? interval / 5 : interval;
  const { start, end } = visibleFrameRange(opts.scrollLeft, opts.viewWidth, opts.ppf, opts.totalFrames);
  const first = Math.floor(start / minor) * minor;
  const ticks: { frame: number; label: string; major: boolean }[] = [];
  for (let frame = first; frame <= end; frame += minor) {
    const snapped = Math.round(frame);
    if (snapped < 0) continue;
    const major = snapped % interval === 0;
    ticks.push({
      frame: snapped,
      label: major ? formatRulerLabel(snapped, opts.fps, interval) : "",
      major,
    });
  }
  return ticks;
}

export function parseStoredZoomMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") out[key] = clampZoom(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function loadProjectZoom(project: string): number {
  if (typeof window === "undefined") return MIN_ZOOM;
  try {
    const map = parseStoredZoomMap(window.localStorage.getItem(TIMELINE_ZOOM_KEY));
    return clampZoom(map[project] ?? MIN_ZOOM);
  } catch {
    return MIN_ZOOM;
  }
}

export function saveProjectZoom(project: string, zoom: number): void {
  if (typeof window === "undefined") return;
  try {
    const map = parseStoredZoomMap(window.localStorage.getItem(TIMELINE_ZOOM_KEY));
    map[project] = clampZoom(zoom);
    window.localStorage.setItem(TIMELINE_ZOOM_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / private mode */
  }
}

export function sliderToZoom(t: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const u = Math.min(1, Math.max(0, t));
  return clampZoom(min * (max / min) ** u);
}

export function zoomToSlider(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const z = clampZoom(zoom);
  if (z <= min) return 0;
  return Math.log(z / min) / Math.log(max / min);
}
