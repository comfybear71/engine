/**
 * A head clip that follows the body: on every frame it moves up or down by the
 * body's own up-and-down motion (measured by the worker, the same numbers the
 * bake uses), times the clip's follow strength.
 */

export const FOLLOW_MAX = 1.5;

export function clampFollow(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(FOLLOW_MAX, Math.round(n * 100) / 100);
}

/** Pixels to move the head down (+) or up (-), given the body motion for the clip (fractions of the body frame's height), the 1-based source frame, and the drawn body height. */
export function followDy(offsets: readonly number[] | null | undefined, sourceFrame: number, follow: number, bodyHeight: number): number {
  const strength = clampFollow(follow);
  if (strength <= 0 || !offsets || !(bodyHeight > 0)) return 0;
  const value = offsets[Math.round(sourceFrame) - 1];
  return typeof value === "number" && Number.isFinite(value) ? strength * value * bodyHeight : 0;
}

/** The neck position the worker measures a body clip at: steps of 5% (same rule as the baker), so a small sideways nudge reuses the measurement. */
export function neckPosition(anchorX: number): number {
  return Math.floor(Math.min(1, Math.max(0, anchorX)) * 20 + 0.5) / 20;
}

export function followKey(shotId: string, anchorX: number): string {
  return `${shotId}|${neckPosition(anchorX).toFixed(2)}`;
}
