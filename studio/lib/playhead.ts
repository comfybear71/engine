export function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(fps, 1);
  const safeFrame = Math.max(0, frame);
  const ff = Math.floor(safeFrame % safeFps);
  const totalSeconds = Math.floor(safeFrame / safeFps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

export type PlayheadBlock = {
  startFrame: number;
  endFrame: number;
  scriptLine: number | null;
  lane: string;
};

const LANE_PRIORITY = ["dialogue", "audio", "body", "face", "props", "action", "camera", "sfx"];

/** Script line covering `frame`, preferring dialogue, else the latest line that has already started. */
export function scriptLineAtFrame(blocks: PlayheadBlock[], frame: number): number | null {
  function rank(block: PlayheadBlock): number {
    const p = LANE_PRIORITY.indexOf(block.lane);
    return p === -1 ? 99 : p;
  }

  const covering = blocks.filter((block) => {
    if (block.scriptLine == null) return false;
    const end = Math.max(block.endFrame, block.startFrame + 1);
    return block.startFrame <= frame && frame < end;
  });
  if (covering.length > 0) {
    covering.sort((a, b) => rank(a) - rank(b));
    return covering[0].scriptLine;
  }
  const previous = blocks
    .filter((block) => block.scriptLine != null && block.startFrame <= frame)
    .sort((a, b) => b.startFrame - a.startFrame || rank(a) - rank(b));
  return previous[0]?.scriptLine ?? null;
}

export function clampFrameIndex(frame: number, totalFrames: number): number {
  const maxFrame = Math.max(0, Math.max(Number(totalFrames) || 1, 1) - 1);
  if (!Number.isFinite(frame)) return 0;
  return Math.max(0, Math.min(maxFrame, Math.round(frame)));
}

export function frameFromTrackX(clientX: number, trackLeft: number, trackWidth: number, totalFrames: number): number {
  const maxFrame = Math.max(0, Math.max(Number(totalFrames) || 1, 1) - 1);
  if (trackWidth <= 0) return 0;
  const t = (clientX - trackLeft) / trackWidth;
  return clampFrameIndex(Math.round(Math.min(1, Math.max(0, t)) * maxFrame), totalFrames);
}
