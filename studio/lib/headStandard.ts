/**
 * Consistent head size across head clips, views and action shots.
 *
 * A head clip's frame is framed differently every time it is generated, so
 * `headScale` alone says nothing about how big the head looks. The standard is
 * measured on the *visible* head (alpha bounding box, median over the clip)
 * relative to the body frame:
 *
 *   height   visible head height / body frame height (the "front" base size)
 *   centerX/Y where the centre of that visible box sits, as fractions of the body frame
 *   views    optional per-rig-key multiplier on height ("left_34": 0.96)
 *
 * Placement stays frame-centred (what the preview draws and the bake composites),
 * so the visible box is mapped back to the frame centre when fitting.
 */

export type HeadStandard = {
  height: number;
  centerX: number;
  centerY: number;
  views?: Record<string, number>;
};

export type Box = { x: number; y: number; w: number; h: number };

export type HeadPlacement = { anchorX: number; anchorY: number; headScale: number };

export type FrameSize = { w: number; h: number };

export const MATCH_TOLERANCE = 0.03;
export const BASE_RIG_KEY = "front";

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Per-edge median, so a few frames where the head turns or the mouth opens do not skew the size. */
export function medianBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = medianOf(boxes.map((b) => b.x));
  const top = medianOf(boxes.map((b) => b.y));
  const right = medianOf(boxes.map((b) => b.x + b.w));
  const bottom = medianOf(boxes.map((b) => b.y + b.h));
  if (!(right > left) || !(bottom > top)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Bounding box of pixels with alpha above `threshold` in RGBA data, or null if empty. */
export function alphaBox(data: ArrayLike<number>, width: number, height: number, threshold = 16): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function viewFactor(standard: HeadStandard | null | undefined, rigKey: string): number {
  const factor = standard?.views?.[rigKey];
  return typeof factor === "number" && factor > 0 ? factor : 1;
}

export function targetHeightFraction(standard: HeadStandard, rigKey: string): number {
  return standard.height * viewFactor(standard, rigKey);
}

/** The visible head's rectangle in body-frame pixels for a placement. */
export function visibleHeadRect(
  box: Box,
  frame: FrameSize,
  placement: HeadPlacement,
  body: FrameSize
): Box {
  const cx = placement.anchorX * body.w;
  const cy = placement.anchorY * body.h;
  const s = placement.headScale;
  return {
    x: cx + (box.x - frame.w / 2) * s,
    y: cy + (box.y - frame.h / 2) * s,
    w: box.w * s,
    h: box.h * s,
  };
}

export type HeadMatch = { state: "match" | "large" | "small"; ratio: number };

/** Visible head height relative to the standard for this rig key (1 = exact). */
export function matchStandard(opts: {
  box: Box;
  placement: HeadPlacement;
  body: FrameSize;
  standard: HeadStandard;
  rigKey: string;
  tolerance?: number;
}): HeadMatch {
  const target = targetHeightFraction(opts.standard, opts.rigKey) * opts.body.h;
  const actual = opts.box.h * opts.placement.headScale;
  const ratio = target > 0 ? actual / target : 1;
  const tol = opts.tolerance ?? MATCH_TOLERANCE;
  if (Math.abs(ratio - 1) <= tol) return { state: "match", ratio };
  return { state: ratio > 1 ? "large" : "small", ratio };
}

/** Scale and position that put the visible head exactly on the standard. */
export function fitToStandard(opts: {
  box: Box;
  frame: FrameSize;
  body: FrameSize;
  standard: HeadStandard;
  rigKey: string;
}): HeadPlacement {
  const { box, frame, body, standard } = opts;
  const targetH = targetHeightFraction(standard, opts.rigKey) * body.h;
  const headScale = box.h > 0 ? targetH / box.h : 1;
  const wantCx = standard.centerX * body.w;
  const wantCy = standard.centerY * body.h;
  const boxCx = box.x + box.w / 2;
  const boxCy = box.y + box.h / 2;
  const frameCx = wantCx + (frame.w / 2 - boxCx) * headScale;
  const frameCy = wantCy + (frame.h / 2 - boxCy) * headScale;
  return { anchorX: frameCx / body.w, anchorY: frameCy / body.h, headScale };
}

/**
 * The standard as it should read after the user declares this head "right".
 * The base (front) head defines height and centre; other views only record
 * how much larger or smaller they should be relative to the base.
 */
export function standardFromHead(opts: {
  box: Box;
  frame: FrameSize;
  placement: HeadPlacement;
  body: FrameSize;
  rigKey: string;
  current: HeadStandard | null;
}): HeadStandard {
  const rect = visibleHeadRect(opts.box, opts.frame, opts.placement, opts.body);
  const heightFrac = rect.h / opts.body.h;
  const isBase = opts.rigKey === BASE_RIG_KEY || !opts.current;
  if (isBase) {
    return {
      height: heightFrac,
      centerX: (rect.x + rect.w / 2) / opts.body.w,
      centerY: (rect.y + rect.h / 2) / opts.body.h,
      views: { ...(opts.current?.views || {}) },
    };
  }
  const views = { ...(opts.current!.views || {}) };
  const factor = heightFrac / opts.current!.height;
  if (Math.abs(factor - 1) < 0.005) delete views[opts.rigKey];
  else views[opts.rigKey] = factor;
  return { ...opts.current!, views };
}
