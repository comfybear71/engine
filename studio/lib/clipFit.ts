/**
 * Size an Action Shot when it is dropped onto a scene. Baked frames keep the
 * pixel size of the video they came from (often taller than the 1080 px
 * canvas), and a clip with no scale= is drawn at the mark's scale, so a clip
 * dropped on a fresh background (mark scale 1) can come in as a giant. The
 * measure is the highest point of the figure over the whole clip, so the top of
 * a hat that rises on some frames stays inside the picture too.
 */

/** A character already fills most of the canvas height at this fraction; bigger than this is "too big". */
export const CLIP_MAX_FRACTION = 0.98;
/** Oversized clips are scaled so the character is this fraction of the canvas height. */
export const CLIP_TARGET_FRACTION = 0.9;

/**
 * How far the visible part of an RGBA picture reaches up from the picture's
 * bottom edge (where a clip sits on its mark), in its own pixels; 0 when
 * nothing is visible. Empty space under the boots counts, because the bottom
 * edge is what stands on the floor mark.
 */
export function opaqueReach(data: ArrayLike<number>, width: number, height: number, alphaThreshold = 24): number {
  if (!(width > 0) || !(height > 0)) return 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > alphaThreshold) return height - y;
    }
  }
  return 0;
}

export const SAMPLE_FRAMES = 24;

/** Up to `count` frame indexes spread evenly over the clip, always including the first and last. */
export function sampleFrameIndexes(total: number, count = SAMPLE_FRAMES): number[] {
  if (!(total > 0)) return [];
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const picks = new Set<number>();
  for (let i = 0; i < count; i += 1) picks.add(Math.round((i * (total - 1)) / (count - 1)));
  return [...picks];
}

/**
 * The scale= to write on a dropped clip, or null to leave it alone (it already
 * fits). `reachPx` is how far the highest frame's figure reaches up from the
 * clip's bottom edge (see `opaqueReach`) and `markScale` the scale the scene
 * would use without a scale=.
 */
export function fitClipScale(opts: { reachPx: number; canvasHeight: number; markScale?: number | null }): number | null {
  const reach = Number(opts.reachPx);
  const canvas = Number(opts.canvasHeight);
  if (!(reach > 0) || !(canvas > 0)) return null;
  const current = opts.markScale != null && Number(opts.markScale) > 0 ? Number(opts.markScale) : 1;
  if (reach * current <= canvas * CLIP_MAX_FRACTION) return null;
  const fitted = Math.floor(((canvas * CLIP_TARGET_FRACTION) / reach) * 100) / 100;
  return fitted > 0 ? fitted : null;
}
