export type TalkMeta = {
  group: string;
  index: number;
  total: number;
  text: string;
  windowSec: number;
  clipSec: number;
  audio?: string;
  engine?: string;
  number?: number;
  audioRel?: string;
  audioInSec?: number;
  audioOutSec?: number;
};

export type TalkShot = {
  id: string;
  status: string;
  error?: string;
  frameCount: number;
  hasPrevious?: boolean;
  engine?: string;
  in?: number;
  out?: number;
  talk?: TalkMeta;
};

export type TalkGroupState = "queued" | "making" | "ready" | "stopped";

export type TalkGroup = {
  group: string;
  shots: TalkShot[];
  state: TalkGroupState;
  readyCount: number;
  error: string | null;
  seconds: number;
};

export function characterIdFromAudioRel(rel: string | null | undefined): string | null {
  const base = String(rel || "").replace(/\\/g, "/").split("/").pop() || "";
  const match = base.replace(/\.wav$/i, "").match(/^\d+_(.+)$/);
  return match ? match[1] : null;
}

export type AudioBlockLike = {
  rel: string | null;
  startFrame: number;
  endFrame: number;
  trim?: { inFrames: number; outFrames: number };
};

/** The slice of a project WAV that an audio block on the Stage plays. */
export function talkingHeadRangeForBlock(
  block: AudioBlockLike,
  fps: number
): { audioRel: string; inSec: number; durationSec: number; characterId: string } | null {
  if (!block.rel || !/\.wav$/i.test(block.rel)) return null;
  const characterId = characterIdFromAudioRel(block.rel);
  if (!characterId || fps <= 0) return null;
  const inSec = Math.max(0, (block.trim?.inFrames || 0) / fps);
  const durationSec = Math.max(1, block.endFrame - block.startFrame) / fps;
  return { audioRel: block.rel, inSec, durationSec, characterId };
}

/** Group talking-head shots by chain, windows in order, with a summary state. */
export function groupTalkShots(shots: TalkShot[]): TalkGroup[] {
  const byGroup = new Map<string, TalkShot[]>();
  for (const shot of shots) {
    if (!shot.talk) continue;
    const list = byGroup.get(shot.talk.group) || [];
    list.push(shot);
    byGroup.set(shot.talk.group, list);
  }
  const groups: TalkGroup[] = [];
  for (const [group, list] of byGroup) {
    list.sort((a, b) => (a.talk?.index ?? 0) - (b.talk?.index ?? 0));
    const readyCount = list.filter((s) => s.status === "ready").length;
    const failed = list.find((s) => s.status === "error");
    const making = list.some((s) => s.status === "making");
    let state: TalkGroupState = "queued";
    if (readyCount === list.length) state = "ready";
    else if (failed) state = "stopped";
    else if (making || readyCount > 0) state = "making";
    groups.push({
      group,
      shots: list,
      state,
      readyCount,
      error: failed?.error || null,
      seconds: list.reduce((sum, s) => sum + (s.talk?.windowSec || 0), 0),
    });
  }
  return groups.sort((a, b) => b.group.localeCompare(a.group));
}

export type TalkPlacement = { shotId: string; inFrame: number; outFrame: number; start: number };

/** Back-to-back head-track segments for the ready windows of a chain. */
export function placeTalkWindows(shots: TalkShot[], startFrame: number): TalkPlacement[] {
  const placements: TalkPlacement[] = [];
  let cursor = Math.max(1, Math.round(startFrame));
  for (const shot of shots) {
    if (shot.status !== "ready" || !shot.frameCount) continue;
    const inFrame = Math.max(1, Math.min(shot.in || 1, shot.frameCount));
    const outFrame = Math.max(inFrame, Math.min(shot.out || shot.frameCount, shot.frameCount));
    placements.push({ shotId: shot.id, inFrame, outFrame, start: cursor });
    cursor += outFrame - inFrame + 1;
  }
  return placements;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`;
}

/** LTX makes at most this much audio per run (two 10 s clips); longer audio is made one part at a time. */
export const LTX_RUN_SEC = 20;

export function ltxPartCount(durationSec: number): number {
  return Math.max(1, Math.ceil((Math.max(0, durationSec) - 0.5) / LTX_RUN_SEC));
}

export function ltxPartRange<T extends { audioRel: string; inSec: number; durationSec: number }>(range: T, part: number): T {
  const offset = Math.max(0, part) * LTX_RUN_SEC;
  return { ...range, inSec: range.inSec + offset, durationSec: Math.min(LTX_RUN_SEC, Math.max(0, range.durationSec - offset)) };
}

export type LtxChain = { key: string; audioLabel: string; group: TalkGroup };

/**
 * The LTX section lists chains in the order they were made (clip numbers), with
 * older chains that predate numbering sorted by their audio position.
 */
export function orderLtxChains(groups: TalkGroup[]): LtxChain[] {
  const rank = (group: TalkGroup) => {
    const first = group.shots[0]?.talk;
    return first?.number ?? Number.POSITIVE_INFINITY;
  };
  return [...groups]
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ta = a.shots[0]?.talk?.audioInSec ?? 0;
      const tb = b.shots[0]?.talk?.audioInSec ?? 0;
      return ta - tb || a.group.localeCompare(b.group);
    })
    .map((group) => {
      const rel = group.shots[0]?.talk?.audioRel || "";
      const base = rel.split("/").slice(-2, -1)[0] || group.group;
      return { key: group.group, audioLabel: base, group };
    });
}
