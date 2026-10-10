export const LABEL_WIDTH = 88;
export const RULER_PX = 20;
export const LANE_ROW_PX = 30;
export const LANE_EMPTY_PX = 22;
export const LANE_CHIP_PX = 26;
export const LANE_SCROLL_GUTTER_PX = 14;
export const TIMELINE_HEADER_PX = 32;

export const TIMELINE_LANE_IDS = [
  "body",
  "face",
  "props",
  "dialogue",
  "audio",
  "sfx",
  "camera",
] as const;

export function laneRowCount(blocks: { row?: number }[]): number {
  if (blocks.length === 0) return 0;
  return Math.max(1, ...blocks.map((block) => (block.row ?? 0) + 1));
}

/** Occupied lanes are 30px per stacked sub-row; empty lanes stay thin. */
export function laneHeightPx(blocks: { row?: number }[]): number {
  const rows = laneRowCount(blocks);
  if (rows <= 0) return LANE_EMPTY_PX;
  return rows * LANE_ROW_PX;
}

export function lanesStackHeight(rowCounts: number[]): number {
  return rowCounts.reduce((sum, rows) => sum + (rows <= 0 ? LANE_EMPTY_PX : rows * LANE_ROW_PX), 0);
}

/** Default panel height: chrome + ruler + one row per category lane + scrollbar gutter. */
export function defaultTimelinePanelHeight(laneCount = TIMELINE_LANE_IDS.length): number {
  return TIMELINE_HEADER_PX + RULER_PX + laneCount * LANE_ROW_PX + LANE_SCROLL_GUTTER_PX;
}
