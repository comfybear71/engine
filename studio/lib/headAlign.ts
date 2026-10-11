/** Geometry for the Align head overlay. Offsets match the compositor:
 * from the owner's bottom-center anchor to the slot drawing's center. */

export type Point = { x: number; y: number };

export function containedImageLayout(
  naturalW: number,
  naturalH: number,
  boxW: number,
  boxH: number
): { scale: number; left: number; top: number; width: number; height: number } {
  if (naturalW <= 0 || naturalH <= 0 || boxW <= 0 || boxH <= 0) {
    return { scale: 1, left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(boxW / naturalW, boxH / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return {
    scale,
    left: (boxW - width) / 2,
    top: (boxH - height) / 2,
    width,
    height,
  };
}

/** Fit the body and a head overlay that may sit above the body top. */
export function fitBodyPlusHead(opts: {
  bodyW: number;
  bodyH: number;
  headCenter: Point;
  headW: number;
  headH: number;
  headScale: number;
  boxW: number;
  boxH: number;
  pad?: number;
}): { scale: number; bodyLeft: number; bodyTop: number; bodyWidth: number; bodyHeight: number } {
  const pad = opts.pad ?? 24;
  if (opts.bodyW <= 0 || opts.bodyH <= 0 || opts.boxW <= 0 || opts.boxH <= 0) {
    return { scale: 1, bodyLeft: 0, bodyTop: 0, bodyWidth: 0, bodyHeight: 0 };
  }
  const hw = (Math.max(0, opts.headW) * Math.max(0.15, opts.headScale)) / 2;
  const hh = (Math.max(0, opts.headH) * Math.max(0.15, opts.headScale)) / 2;
  const minX = Math.min(0, opts.headCenter.x - hw);
  const minY = Math.min(0, opts.headCenter.y - hh);
  const maxX = Math.max(opts.bodyW, opts.headCenter.x + hw);
  const maxY = Math.max(opts.bodyH, opts.headCenter.y + hh);
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const innerW = Math.max(1, opts.boxW - pad * 2);
  const innerH = Math.max(1, opts.boxH - pad * 2);
  const scale = Math.min(innerW / contentW, innerH / contentH);
  const width = contentW * scale;
  const height = contentH * scale;
  const originLeft = (opts.boxW - width) / 2;
  const originTop = (opts.boxH - height) / 2;
  return {
    scale,
    bodyLeft: originLeft + -minX * scale,
    bodyTop: originTop + -minY * scale,
    bodyWidth: opts.bodyW * scale,
    bodyHeight: opts.bodyH * scale,
  };
}

export function bodyAnchor(bodyW: number, bodyH: number): Point {
  return { x: bodyW / 2, y: bodyH };
}

export function slotCenter(bodyW: number, bodyH: number, offset: Point): Point {
  const anchor = bodyAnchor(bodyW, bodyH);
  return { x: anchor.x + offset.x, y: anchor.y + offset.y };
}

export function offsetFromCenter(bodyW: number, bodyH: number, center: Point): Point {
  const anchor = bodyAnchor(bodyW, bodyH);
  return { x: center.x - anchor.x, y: center.y - anchor.y };
}

export type HeadNudge = { x: number; y: number; scale: number };

export const HEAD_NUDGE_SCALE_MIN = 0.25;
export const HEAD_NUDGE_SCALE_MAX = 4;

export type HeadLandmarks = {
  hat: Point;
  chin: Point;
  neck: Point;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  canvas: { w: number; h: number };
};

export function defaultHeadNudge(): HeadNudge {
  return { x: 0, y: 0, scale: 1 };
}

export function clampHeadNudge(nudge: HeadNudge): HeadNudge {
  return {
    x: Math.max(-400, Math.min(400, Number(nudge.x) || 0)),
    y: Math.max(-400, Math.min(400, Number(nudge.y) || 0)),
    scale: Math.max(HEAD_NUDGE_SCALE_MIN, Math.min(HEAD_NUDGE_SCALE_MAX, Number(nudge.scale) || 1)),
  };
}

/** Residual passed to the worker: Python still does hat/chin auto-fit, then multiplies. */
export function residualHeadNudge(nudge: HeadNudge, autoScale: number): HeadNudge {
  const base = Number(autoScale) > 1e-6 ? Number(autoScale) : 1;
  return {
    x: Math.max(-400, Math.min(400, Number(nudge.x) || 0)),
    y: Math.max(-400, Math.min(400, Number(nudge.y) || 0)),
    scale: Math.max(0.05, Math.min(8, (Number(nudge.scale) || 1) / base)),
  };
}

export function headScaleToSlider(scale: number): number {
  const s = Math.max(HEAD_NUDGE_SCALE_MIN, Math.min(HEAD_NUDGE_SCALE_MAX, Number(scale) || 1));
  return Math.log(s / HEAD_NUDGE_SCALE_MIN) / Math.log(HEAD_NUDGE_SCALE_MAX / HEAD_NUDGE_SCALE_MIN);
}

export function sliderToHeadScale(t: number): number {
  const u = Math.max(0, Math.min(1, Number(t) || 0));
  return HEAD_NUDGE_SCALE_MIN * (HEAD_NUDGE_SCALE_MAX / HEAD_NUDGE_SCALE_MIN) ** u;
}

const ALPHA_MIN = 16;
const NECK_BAND = 0.15;

export function canvasLandmarks(w: number, h: number): HeadLandmarks {
  return {
    hat: { x: w / 2, y: 0 },
    chin: { x: w / 2, y: h },
    neck: { x: w / 2, y: h },
    bbox: { x0: 0, y0: 0, x1: w, y1: h },
    canvas: { w, h },
  };
}

export function landmarksFromRgba(data: ArrayLike<number>, w: number, h: number, alphaMin = ALPHA_MIN): HeadLandmarks {
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > alphaMin) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return canvasLandmarks(w, h);
  const hat = { x: (x0 + x1) / 2, y: y0 };
  const chin = { x: (x0 + x1) / 2, y: y1 };
  const bandH = Math.max(1, Math.round((y1 - y0) * NECK_BAND));
  let sumX = 0;
  let count = 0;
  for (let y = Math.max(y0, y1 - bandH); y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (data[(y * w + x) * 4 + 3] > alphaMin) {
        sumX += x;
        count += 1;
      }
    }
  }
  const neck = { x: count ? sumX / count : (x0 + x1) / 2, y: y1 };
  return { hat, chin, neck, bbox: { x0, y0, x1, y1 }, canvas: { w, h } };
}

export function applyCollar(lm: HeadLandmarks, collarY: number | null | undefined): HeadLandmarks {
  if (collarY == null || !Number.isFinite(collarY)) return lm;
  const y = collarY > 0 && collarY <= 1 ? collarY * lm.canvas.h : collarY;
  const chinY = Math.max(lm.hat.y + 1, Math.min(lm.canvas.h, y));
  if (chinY >= lm.chin.y) return lm;
  return {
    ...lm,
    chin: { x: lm.chin.x, y: chinY },
    neck: { x: lm.neck.x, y: chinY },
    bbox: { ...lm.bbox, y1: chinY },
  };
}

export function autoFitHeadNudge(src: HeadLandmarks, ref: HeadLandmarks): HeadNudge {
  const srcH = Math.max(1, src.chin.y - src.hat.y);
  const refH = Math.max(1, ref.chin.y - ref.hat.y);
  return clampHeadNudge({ x: 0, y: 0, scale: refH / srcH });
}

export function alignPlacement(src: HeadLandmarks, ref: HeadLandmarks, scale: number): Point {
  const s = Number(scale) || 1;
  let tx = ref.hat.x - src.hat.x * s;
  const ty = ref.hat.y - src.hat.y * s;
  tx += ref.neck.x - (src.neck.x * s + tx);
  return { x: tx, y: ty };
}

export function previewAlignLayout(opts: {
  boxW: number;
  boxH: number;
  srcW: number;
  srcH: number;
  refW: number;
  refH: number;
  src: HeadLandmarks;
  ref: HeadLandmarks;
  nudge: HeadNudge;
}): {
  ref: { left: number; top: number; width: number; height: number };
  src: { left: number; top: number; width: number; height: number };
} {
  const layout = containedImageLayout(opts.refW, opts.refH, opts.boxW, opts.boxH);
  const nudge = clampHeadNudge(opts.nudge);
  const place = alignPlacement(opts.src, opts.ref, nudge.scale);
  return {
    ref: { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
    src: {
      left: layout.left + (place.x + nudge.x) * layout.scale,
      top: layout.top + (place.y + nudge.y) * layout.scale,
      width: opts.srcW * nudge.scale * layout.scale,
      height: opts.srcH * nudge.scale * layout.scale,
    },
  };
}

/** Bust an opaque (no-CORS) img cache so canvas can read pixels. */
export function alignProbeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return `${url}${url.includes("?") ? "&" : "?"}probe=align`;
}

export function alignableSlots<T extends { name: string; drawings: unknown[] }>(slots: T[]): T[] {
  const preferred = ["mouth", "head"];
  const named = preferred
    .map((name) => slots.find((slot) => slot.name === name && slot.drawings.length > 0))
    .filter((slot): slot is T => Boolean(slot));
  if (named.length > 0) return named;
  return slots.filter((slot) => slot.drawings.length > 0);
}
