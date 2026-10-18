/**
 * Size an Action Shot when it is dropped onto a scene. Baked frames keep the
 * pixel size of the video they came from (often taller than the 1080 px
 * canvas), and a clip with no scale= is drawn at the mark's scale, so a clip
 * dropped on a fresh background (mark scale 1) can come in as a giant.
 */

/** A character already fills most of the canvas height at this fraction; bigger than this is "too big". */
export const CLIP_MAX_FRACTION = 0.98;
/** Oversized clips are scaled so the character is this fraction of the canvas height. */
export const CLIP_TARGET_FRACTION = 0.9;

/** Height of the visible (non-transparent) part of an RGBA picture, in its own pixels; 0 when nothing is visible. */
export function opaqueHeight(data: ArrayLike<number>, width: number, height: number, alphaThreshold = 24): number {
  if (!(width > 0) || !(height > 0)) return 0;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height && top < 0; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        top = y;
        break;
      }
    }
  }
  if (top < 0) return 0;
  for (let y = height - 1; y >= top && bottom < 0; y -= 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        bottom = y;
        break;
      }
    }
  }
  return bottom - top + 1;
}

/**
 * The scale= to write on a dropped clip, or null to leave it alone (it already
 * fits). `contentHeightPx` is the character's height in the baked frame and
 * `markScale` the scale the scene would use without a scale=.
 */
export function fitClipScale(opts: { contentHeightPx: number; canvasHeight: number; markScale?: number | null }): number | null {
  const content = Number(opts.contentHeightPx);
  const canvas = Number(opts.canvasHeight);
  if (!(content > 0) || !(canvas > 0)) return null;
  const current = opts.markScale != null && Number(opts.markScale) > 0 ? Number(opts.markScale) : 1;
  if (content * current <= canvas * CLIP_MAX_FRACTION) return null;
  const fitted = Math.floor(((canvas * CLIP_TARGET_FRACTION) / content) * 100) / 100;
  return fitted > 0 ? fitted : null;
}
