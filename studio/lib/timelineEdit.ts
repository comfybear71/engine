/**
 * Script-text rewrite helpers for Stage timeline edits.
 * The script stays the source of truth: moving a block writes at_time=
 * on that line, then the worker re-parses.
 */

const TIMED_TAG_RE =
  /^(\s*\[(?:Action|Prop|Layer|Move|Pose|Swing|Camera|Audio)\s*:\s*)(.*?)(\]\s*)(.*)$/i;
const DIALOGUE_RE = /^(\s*)(.+?)(\s*:\s*)(.*)$/;
const EXISTING_START_RE = /\s*\b(?:at_time|start)=\S+/gi;
const EXISTING_VIEW_RE = /\s*\bview=\S+/gi;

export const HEAD_VIEWS = ["front", "left_34", "left_side", "right_34", "right_side", "up", "down"] as const;
export type HeadView = (typeof HEAD_VIEWS)[number];

export type BlockMove = {
  scriptLine: number;
  /** New global start of the tag (sourceStartFrame + delta). */
  startFrame: number;
  /** Global start frame of the scene this line belongs to. */
  sceneStartFrame: number;
};

export type ScriptHistory = {
  past: string[];
  future: string[];
};

export function emptyScriptHistory(): ScriptHistory {
  return { past: [], future: [] };
}

export function historyCanUndo(history: ScriptHistory): boolean {
  return history.past.length > 0;
}

export function historyCanRedo(history: ScriptHistory): boolean {
  return history.future.length > 0;
}

export function historyPush(history: ScriptHistory, current: string): ScriptHistory {
  return { past: [...history.past, current], future: [] };
}

export function historyUndo(
  history: ScriptHistory,
  current: string
): { history: ScriptHistory; text: string } | null {
  if (history.past.length === 0) return null;
  const past = history.past.slice();
  const text = past.pop() as string;
  return { history: { past, future: [current, ...history.future] }, text };
}

export function historyRedo(
  history: ScriptHistory,
  current: string
): { history: ScriptHistory; text: string } | null {
  if (history.future.length === 0) return null;
  const future = history.future.slice();
  const text = future.shift() as string;
  return { history: { past: [...history.past, current], future }, text };
}

/** Compact human at_time= value: whole seconds, short decimals, else frames. */
export function formatAtTime(sceneLocalFrames: number, fps: number): string {
  const frames = Math.max(0, Math.round(sceneLocalFrames));
  const safeFps = Math.max(1, Math.round(fps) || 24);
  if (frames === 0) return "0s";
  if (frames % safeFps === 0) return `${frames / safeFps}s`;
  const seconds = frames / safeFps;
  for (const places of [1, 2, 3]) {
    const rounded = Number(seconds.toFixed(places));
    if (Math.round(rounded * safeFps) === frames) return `${rounded}s`;
  }
  return String(frames);
}

export function setViewOnLine(line: string, view: string | null): string {
  const tag = line.match(TIMED_TAG_RE);
  if (tag) {
    let body = tag[2].replace(EXISTING_VIEW_RE, "").trimEnd();
    if (view && view !== "front") body = `${body} view=${view}`;
    return `${tag[1]}${body}${tag[3]}${tag[4]}`;
  }
  if (line.trim().startsWith("[")) return line;
  const dialogue = line.match(DIALOGUE_RE);
  if (!dialogue) return line;
  let name = dialogue[2].replace(EXISTING_VIEW_RE, "").trimEnd();
  if (view && view !== "front") name = `${name} view=${view}`;
  return `${dialogue[1]}${name}${dialogue[3]}${dialogue[4]}`;
}

export function setAtTimeOnLine(line: string, atTime: string): string {
  const attr = `at_time=${atTime}`;
  const tag = line.match(TIMED_TAG_RE);
  if (tag) {
    const body = `${tag[2].replace(EXISTING_START_RE, "").trimEnd()} ${attr}`;
    return `${tag[1]}${body}${tag[3]}${tag[4]}`;
  }
  if (line.trim().startsWith("[")) return line;
  const dialogue = line.match(DIALOGUE_RE);
  if (!dialogue) return line;
  const name = dialogue[2].replace(EXISTING_START_RE, "").trimEnd();
  return `${dialogue[1]}${name} ${attr}${dialogue[3]}${dialogue[4]}`;
}

/**
 * Write at_time= on each moved script line. One write per line (earliest
 * tag start wins when several blocks share a line, e.g. [Audio:] sentences).
 */
export function moveBlocksInScript(script: string, moves: BlockMove[], fps: number): string {
  if (!moves.length) return script;
  const byLine = new Map<number, BlockMove>();
  for (const move of moves) {
    if (!move.scriptLine || move.scriptLine < 1) continue;
    const existing = byLine.get(move.scriptLine);
    if (!existing || move.startFrame < existing.startFrame) byLine.set(move.scriptLine, move);
  }
  const lines = script.split("\n");
  for (const move of byLine.values()) {
    const index = move.scriptLine - 1;
    if (index < 0 || index >= lines.length) continue;
    const local = Math.max(0, Math.round(move.startFrame - (move.sceneStartFrame || 0)));
    lines[index] = setAtTimeOnLine(lines[index], formatAtTime(local, fps));
  }
  return lines.join("\n");
}

export type SnapKind = "playhead" | "block" | "second" | "frame";

export function collectSnapFrames(opts: {
  playhead: number;
  blocks: { id: string; startFrame: number; endFrame: number }[];
  ignoreIds: Iterable<string>;
  fps: number;
  totalFrames: number;
}): { frame: number; kind: SnapKind }[] {
  const ignore = new Set(opts.ignoreIds);
  const out: { frame: number; kind: SnapKind }[] = [];
  const seen = new Set<number>();
  function add(frame: number, kind: SnapKind) {
    const n = Math.round(frame);
    if (n < 0 || seen.has(n)) return;
    seen.add(n);
    out.push({ frame: n, kind });
  }
  add(opts.playhead, "playhead");
  for (const block of opts.blocks) {
    if (ignore.has(block.id)) continue;
    add(block.startFrame, "block");
    add(block.endFrame, "block");
  }
  const fps = Math.max(1, Math.round(opts.fps) || 24);
  const last = Math.max(0, opts.totalFrames);
  for (let second = 0; second * fps <= last; second++) add(second * fps, "second");
  return out;
}

export function snapStart(
  start: number,
  targets: { frame: number }[],
  thresholdFrames: number
): { frame: number; snappedTo: number | null } {
  const raw = Math.round(start);
  if (!(thresholdFrames > 0) || targets.length === 0) {
    return { frame: Math.max(0, raw), snappedTo: null };
  }
  let best = raw;
  let bestDist = thresholdFrames + 1;
  let snappedTo: number | null = null;
  for (const target of targets) {
    const dist = Math.abs(raw - target.frame);
    if (dist < bestDist) {
      bestDist = dist;
      best = target.frame;
      snappedTo = target.frame;
    }
  }
  if (bestDist <= thresholdFrames) return { frame: Math.max(0, best), snappedTo };
  return { frame: Math.max(0, raw), snappedTo: null };
}

export function blockIsMovable(block: { movable?: boolean; scriptLine?: number | null }): boolean {
  if (block.movable === false) return false;
  return block.scriptLine != null && block.scriptLine > 0;
}

/** Dialogue + its audio/mouth-cues share marriedId; face pins do not. */
export function idsForMarriedGroup(
  blocks: { id: string; marriedId?: string | null }[],
  seedIds: Iterable<string>
): Set<string> {
  const seeds = new Set(seedIds);
  const keys = new Set<string>();
  for (const block of blocks) {
    if (seeds.has(block.id) && block.marriedId) keys.add(block.marriedId);
  }
  const ids = new Set(seeds);
  if (keys.size === 0) return ids;
  for (const block of blocks) {
    if (block.marriedId && keys.has(block.marriedId)) ids.add(block.id);
  }
  return ids;
}
