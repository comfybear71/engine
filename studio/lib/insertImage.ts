/** Script helpers for `[Insert: image=… at_time=… for=…]` still clips. */

export function insertDurationFrames(startFrame: number, endFrameInclusive: number) {
  const start = Math.max(0, Math.floor(Number(startFrame) || 0));
  const last = Math.max(start, Math.floor(Number(endFrameInclusive) || start));
  return { startFrame: start, endFrame: last + 1, frames: last - start + 1, lastFrame: last };
}

export function insertStillTag(opts: {
  image: string;
  startFrame: number;
  endFrame?: number;
  durationFrames?: number;
}): string {
  const rel = String(opts.image || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const span = opts.durationFrames
    ? insertDurationFrames(opts.startFrame, Number(opts.startFrame) + Number(opts.durationFrames) - 1)
    : insertDurationFrames(opts.startFrame, opts.endFrame ?? opts.startFrame);
  return `[Insert: image=${rel} at_time=${span.startFrame} for=${span.frames}]`;
}

export function drawingInsertRel(opts: {
  characterId: string;
  slot: string;
  drawing: string;
  rel?: string | null;
}): string {
  if (opts.rel) return String(opts.rel).replace(/\\/g, "/");
  const slot = String(opts.slot || "mouth").replace(/\\/g, "/");
  return `characters/${opts.characterId}/${slot}/${opts.drawing}.png`;
}
