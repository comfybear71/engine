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

export function defaultHeadNudge(): HeadNudge {
  return { x: 0, y: 0, scale: 1 };
}

export function clampHeadNudge(nudge: HeadNudge): HeadNudge {
  return {
    x: Math.max(-400, Math.min(400, Number(nudge.x) || 0)),
    y: Math.max(-400, Math.min(400, Number(nudge.y) || 0)),
    scale: Math.max(0.2, Math.min(3, Number(nudge.scale) || 1)),
  };
}

export function alignableSlots<T extends { name: string; drawings: unknown[] }>(slots: T[]): T[] {
  const preferred = ["mouth", "head"];
  const named = preferred
    .map((name) => slots.find((slot) => slot.name === name && slot.drawings.length > 0))
    .filter((slot): slot is T => Boolean(slot));
  if (named.length > 0) return named;
  return slots.filter((slot) => slot.drawings.length > 0);
}
