export const LABEL_WIDTH = 88;
export const RULER_PX = 20;
export const LANE_ROW_PX = 30;
export const LANE_EMPTY_PX = 22;
export const LANE_CHIP_INSET_PX = 4;
export const H_SCROLLBAR_PX = 14;
export const TIMELINE_HEADER_PX = 32;

export const LANE_HEIGHT_KEY = "engine.studio.laneHeight.v1";
export const MIN_LANE_SCALE = 0.7;
export const MAX_LANE_SCALE = 1.7;
export const DEFAULT_LANE_SCALE = 1;
export const LANE_SCALE_STEP = 0.1;

export const TIMELINE_LANE_IDS = [
  "body",
  "face",
  "props",
  "dialogue",
  "audio",
  "sfx",
  "camera",
] as const;

export function clampLaneScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LANE_SCALE;
  return Math.min(MAX_LANE_SCALE, Math.max(MIN_LANE_SCALE, Math.round(value * 100) / 100));
}

export function occupiedLaneRowPx(scale = DEFAULT_LANE_SCALE): number {
  return Math.round(LANE_ROW_PX * clampLaneScale(scale));
}

export function emptyLanePx(scale = DEFAULT_LANE_SCALE): number {
  return Math.max(16, Math.round(LANE_EMPTY_PX * clampLaneScale(scale)));
}

export function chipHeightPx(scale = DEFAULT_LANE_SCALE): number {
  return Math.max(14, occupiedLaneRowPx(scale) - LANE_CHIP_INSET_PX);
}

export function laneScaleToSlider(scale: number): number {
  return (clampLaneScale(scale) - MIN_LANE_SCALE) / (MAX_LANE_SCALE - MIN_LANE_SCALE);
}

export function sliderToLaneScale(t: number): number {
  const u = Math.min(1, Math.max(0, Number(t) || 0));
  return clampLaneScale(MIN_LANE_SCALE + u * (MAX_LANE_SCALE - MIN_LANE_SCALE));
}

export function parseStoredLaneScale(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_LANE_SCALE;
  try {
    const parsed = JSON.parse(raw) as { scale?: number } | number;
    if (typeof parsed === "number") return clampLaneScale(parsed);
    return clampLaneScale(typeof parsed.scale === "number" ? parsed.scale : DEFAULT_LANE_SCALE);
  } catch {
    return DEFAULT_LANE_SCALE;
  }
}

export function loadLaneScale(): number {
  if (typeof window === "undefined") return DEFAULT_LANE_SCALE;
  try {
    return parseStoredLaneScale(window.localStorage.getItem(LANE_HEIGHT_KEY));
  } catch {
    return DEFAULT_LANE_SCALE;
  }
}

export function saveLaneScale(scale: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANE_HEIGHT_KEY, JSON.stringify({ scale: clampLaneScale(scale) }));
  } catch {
    /* ignore quota / private mode */
  }
}

export function laneRowCount(blocks: { row?: number }[]): number {
  if (blocks.length === 0) return 0;
  return Math.max(1, ...blocks.map((block) => (block.row ?? 0) + 1));
}

/** Occupied lanes are ~30px per stacked sub-row at scale 1; empty lanes stay thin. */
export function laneHeightPx(blocks: { row?: number }[], scale = DEFAULT_LANE_SCALE): number {
  const rows = laneRowCount(blocks);
  if (rows <= 0) return emptyLanePx(scale);
  return rows * occupiedLaneRowPx(scale);
}

export function lanesStackHeight(rowCounts: number[], scale = DEFAULT_LANE_SCALE): number {
  return rowCounts.reduce((sum, rows) => sum + (rows <= 0 ? emptyLanePx(scale) : rows * occupiedLaneRowPx(scale)), 0);
}

/** Default panel height: chrome + ruler + one row per category lane + bottom scrollbar. */
export function defaultTimelinePanelHeight(laneCount = TIMELINE_LANE_IDS.length): number {
  return TIMELINE_HEADER_PX + RULER_PX + laneCount * LANE_ROW_PX + H_SCROLLBAR_PX;
}
