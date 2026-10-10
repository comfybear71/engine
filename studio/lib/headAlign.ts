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
