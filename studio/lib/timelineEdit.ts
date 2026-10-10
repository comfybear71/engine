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
const EXISTING_OVER_RE = /\s*\bover=\S+/gi;
const EXISTING_HOLD_RE = /\s*\bhold=\S+/gi;
const EXISTING_FOR_RE = /\s*\bfor=\S+/gi;
const EXISTING_TRIM_IN_RE = /\s*\btrim_in=\S+/gi;
const EXISTING_TRIM_OUT_RE = /\s*\btrim_out=\S+/gi;

export const HEAD_VIEWS = ["front", "left_34", "left_side", "right_34", "right_side", "up", "down"] as const;
export type HeadView = (typeof HEAD_VIEWS)[number];

export type BlockMove = {
  scriptLine: number;
  /** New global start of the tag (sourceStartFrame + delta). */
  startFrame: number;
  /** Global start frame of the scene this line belongs to. */
  sceneStartFrame: number;
  /** Pin hold length to write (hold= / over=) so a move never stretches the block. */
  hold?: string | null;
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

function replaceKeyedAttr(line: string, remove: RegExp, attr: string | null): string {
  const tag = line.match(TIMED_TAG_RE);
  if (tag) {
    let body = tag[2].replace(remove, "").trimEnd();
    if (attr) body = `${body} ${attr}`.trim();
    return `${tag[1]}${body}${tag[3]}${tag[4]}`;
  }
  if (line.trim().startsWith("[")) return line;
  const dialogue = line.match(DIALOGUE_RE);
  if (!dialogue) return line;
  let name = dialogue[2].replace(remove, "").trimEnd();
  if (attr) name = `${name} ${attr}`.trim();
  return `${dialogue[1]}${name}${dialogue[3]}${dialogue[4]}`;
}

export function setAtTimeOnLine(line: string, atTime: string): string {
  return replaceKeyedAttr(line, EXISTING_START_RE, `at_time=${atTime}`);
}

export function setDurationOnLine(line: string, attr: "over" | "for" | "hold", value: string): string {
  const remove = attr === "for" ? EXISTING_FOR_RE : attr === "hold" ? EXISTING_HOLD_RE : EXISTING_OVER_RE;
  return replaceKeyedAttr(line, remove, `${attr}=${value}`);
}

export function pinDurationWriteAttr(line: string): "hold" | "over" {
  if (/\bover=\S+/i.test(line) && !/\bhold=\S+/i.test(line)) return "over";
  return "hold";
}

export function lineHasPinHold(line: string): boolean {
  return /\b(?:hold|over)=\S+/i.test(line);
}

export function setTrimOnLine(
  line: string,
  trim: { trimIn?: string | null; trimOut?: string | null }
): string {
  let next = line;
  if (trim.trimIn !== undefined) {
    next = replaceKeyedAttr(next, EXISTING_TRIM_IN_RE, trim.trimIn ? `trim_in=${trim.trimIn}` : null);
  }
  if (trim.trimOut !== undefined) {
    next = replaceKeyedAttr(next, EXISTING_TRIM_OUT_RE, trim.trimOut ? `trim_out=${trim.trimOut}` : null);
  }
  return next;
}

export function setDialogueTextOnLine(line: string, text: string): string {
  if (line.trim().startsWith("[")) return line;
  const dialogue = line.match(DIALOGUE_RE);
  if (!dialogue) return line;
  return `${dialogue[1]}${dialogue[2]}${dialogue[3]}${text}`;
}

export function lineHasAttr(line: string, key: "over" | "for" | "hold" | "at_time" | "trim_in" | "trim_out"): boolean {
  return new RegExp(String.raw`\b${key}=\S+`, "i").test(line);
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
    if (move.hold) {
      const attr = pinDurationWriteAttr(lines[index]);
      lines[index] = setDurationOnLine(lines[index], attr, move.hold);
    }
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

export type TrimKind = "duration" | "media" | "pin";

export type EditableBlock = {
  id: string;
  scriptLine?: number | null;
  sceneId?: string;
  startFrame: number;
  endFrame: number;
  sourceStartFrame?: number;
  lane?: string;
  tag?: string | null;
  timing?: { kind?: string; attr?: string | null } | null;
  trim?: { inFrames: number; outFrames: number } | null;
  sourceDurationFrames?: number | null;
  words?: { word: string; start: number; end: number }[] | null;
  marriedId?: string | null;
  movable?: boolean;
  role?: string | null;
};

export function trimKindForBlock(block: {
  timing?: { kind?: string } | null;
  lane?: string;
}): TrimKind | null {
  const kind = block.timing?.kind;
  if (kind === "audio" || kind === "dialogue" || block.lane === "audio" || block.lane === "dialogue") {
    return "media";
  }
  if (kind === "over" || kind === "for") return "duration";
  if (kind === "pin") return "pin";
  return null;
}

export function durationAttrForBlock(block: { timing?: { kind?: string } | null; tag?: string | null }): "over" | "for" | "hold" {
  if (block.timing?.kind === "for" || String(block.tag || "").toLowerCase() === "swing") return "for";
  if (block.timing?.kind === "pin") return "hold";
  return "over";
}

export function isMouthBlock(block: { role?: string | null; tag?: string | null }): boolean {
  return block.role === "mouth" || String(block.tag || "").toLowerCase() === "mouth";
}

export function blockIsTrimmable(block: EditableBlock): boolean {
  if (block.scriptLine == null || block.scriptLine < 1) return false;
  if (!blockIsMovable(block) && !isMouthBlock(block)) return false;
  return trimKindForBlock(block) != null && block.endFrame > block.startFrame;
}

export type LineTrimWrite = {
  scriptLine: number;
  atTime?: string | null;
  durationAttr?: "over" | "for" | "hold";
  duration?: string | null;
  trimIn?: string | null;
  trimOut?: string | null;
};

export type LineSplitWrite = {
  scriptLine: number;
  left: LineTrimWrite;
  right: LineTrimWrite & { atTime: string };
  leftText?: string;
  rightText?: string;
};

export type TakeWindow = {
  scriptLine: number;
  sceneId: string;
  start: number;
  end: number;
  kind: TrimKind;
  durationAttr: "over" | "for" | "hold";
  trimIn: number;
  trimOut: number;
  sourceDuration: number | null;
  primary: EditableBlock;
};

export function takeWindowForIds(
  blocks: EditableBlock[],
  ids: Iterable<string>
): TakeWindow | null {
  const wanted = new Set(ids);
  const members = blocks.filter((block) => wanted.has(block.id) && blockIsTrimmable(block));
  if (members.length === 0) return null;
  const primary =
    members.find((block) => block.lane === "audio") ||
    members.find((block) => block.lane === "dialogue") ||
    members[0];
  if (primary.scriptLine == null || primary.scriptLine < 1) return null;
  const kind = trimKindForBlock(primary);
  if (!kind) return null;
  const start = Math.min(...members.map((block) => block.startFrame));
  const end = Math.max(...members.map((block) => block.endFrame));
  const trimIn = primary.trim?.inFrames ?? 0;
  const source = primary.sourceDurationFrames ?? null;
  let trimOut = primary.trim?.outFrames ?? 0;
  if (!(trimOut > trimIn)) trimOut = source != null && source > trimIn ? source : trimIn + Math.max(1, end - start);
  return {
    scriptLine: primary.scriptLine,
    sceneId: primary.sceneId || "",
    start,
    end,
    kind,
    durationAttr: durationAttrForBlock(primary),
    trimIn,
    trimOut,
    sourceDuration: source,
    primary,
  };
}

function sceneStartFor(scenes: { id: string; startFrame: number }[], sceneId: string): number {
  return scenes.find((scene) => scene.id === sceneId)?.startFrame ?? 0;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function clampTrimEdge(opts: {
  edge: "in" | "out";
  rawFrame: number;
  take: TakeWindow;
}): { frame: number; allowed: boolean } {
  const raw = Math.round(opts.rawFrame);
  if (opts.edge === "in") {
    const minStart = opts.take.start - opts.take.trimIn;
    const maxStart = opts.take.end - 1;
    const floor = opts.take.kind === "media" ? Math.max(0, minStart) : 0;
    const frame = clampInt(raw, floor, maxStart);
    return { frame, allowed: frame === raw && frame <= maxStart && frame >= floor };
  }
  const minEnd = opts.take.start + 1;
  const sourceEnd =
    opts.take.kind === "media" && opts.take.sourceDuration != null
      ? opts.take.start - opts.take.trimIn + opts.take.sourceDuration
      : Number.POSITIVE_INFINITY;
  const maxEnd = Number.isFinite(sourceEnd) ? sourceEnd : raw;
  const frame = clampInt(raw, minEnd, Number.isFinite(maxEnd) ? maxEnd : raw);
  const limited = raw < minEnd || (Number.isFinite(sourceEnd) && raw > sourceEnd);
  return { frame, allowed: !limited && frame === raw };
}

export function planTrim(opts: {
  blocks: EditableBlock[];
  ids: Iterable<string>;
  edge: "in" | "out";
  newEdgeFrame: number;
  scenes: { id: string; startFrame: number }[];
  fps: number;
  script?: string;
}): LineTrimWrite | null {
  const take = takeWindowForIds(opts.blocks, opts.ids);
  if (!take) return null;
  const clamped = clampTrimEdge({ edge: opts.edge, rawFrame: opts.newEdgeFrame, take });
  const sceneStart = sceneStartFor(opts.scenes, take.sceneId);
  const write: LineTrimWrite = { scriptLine: take.scriptLine };
  if (take.kind === "media") {
    if (opts.edge === "in") {
      const newIn = take.trimIn + (clamped.frame - take.start);
      write.atTime = formatAtTime(Math.max(0, clamped.frame - sceneStart), opts.fps);
      write.trimIn = newIn > 0 ? formatAtTime(newIn, opts.fps) : null;
      write.trimOut =
        take.sourceDuration != null && take.trimOut >= take.sourceDuration
          ? null
          : formatAtTime(take.trimOut, opts.fps);
    } else {
      const newOut = take.trimIn + (clamped.frame - take.start);
      write.trimIn = take.trimIn > 0 ? formatAtTime(take.trimIn, opts.fps) : null;
      write.trimOut =
        take.sourceDuration != null && newOut >= take.sourceDuration ? null : formatAtTime(newOut, opts.fps);
    }
    return write;
  }
  const newStart = opts.edge === "in" ? clamped.frame : take.start;
  const newEnd = opts.edge === "out" ? clamped.frame : take.end;
  const durationFrames = Math.max(1, newEnd - newStart);
  const line = opts.script ? opts.script.split("\n")[take.scriptLine - 1] || "" : "";
  const durationAttr = take.kind === "pin" ? pinDurationWriteAttr(line) : take.durationAttr;
  const hadDuration = take.kind === "duration" || lineHasPinHold(line) || lineHasAttr(line, take.durationAttr);
  if (opts.edge === "in") write.atTime = formatAtTime(Math.max(0, newStart - sceneStart), opts.fps);
  if (take.kind === "duration" || hadDuration || take.kind === "pin" || opts.edge === "out") {
    write.durationAttr = durationAttr;
    write.duration = formatAtTime(durationFrames, opts.fps);
  }
  return write;
}

export function applyTrimWrite(script: string, write: LineTrimWrite): string {
  const lines = script.split("\n");
  const index = write.scriptLine - 1;
  if (index < 0 || index >= lines.length) return script;
  lines[index] = applyWriteToLine(lines[index], write);
  return lines.join("\n");
}

export function splitDialogueText(
  text: string,
  words: { word: string; start: number; end: number }[] | null | undefined,
  splitSec: number
): { left: string; right: string } {
  if (!words || words.length === 0) return { left: text, right: text };
  const leftWords = words.filter((word) => (word.start + word.end) / 2 < splitSec);
  const rightWords = words.filter((word) => (word.start + word.end) / 2 >= splitSec);
  return {
    left: leftWords.map((word) => word.word).join(" ") || text,
    right: rightWords.map((word) => word.word).join(" ") || text,
  };
}

export function planSplit(opts: {
  blocks: EditableBlock[];
  ids: Iterable<string>;
  playhead: number;
  scenes: { id: string; startFrame: number }[];
  fps: number;
  script: string;
}): LineSplitWrite | null {
  const take = takeWindowForIds(opts.blocks, opts.ids);
  if (!take) return null;
  if (opts.playhead <= take.start || opts.playhead >= take.end) return null;
  if (opts.playhead - take.start < 1 || take.end - opts.playhead < 1) return null;
  const sceneStart = sceneStartFor(opts.scenes, take.sceneId);
  const rightAt = formatAtTime(Math.max(0, opts.playhead - sceneStart), opts.fps);
  const line = opts.script.split("\n")[take.scriptLine - 1] || "";
  if (take.kind === "media") {
    const splitFrames = take.trimIn + (opts.playhead - take.start);
    const splitSec = splitFrames / Math.max(1, opts.fps);
    const leftIn = take.trimIn > 0 ? formatAtTime(take.trimIn, opts.fps) : null;
    const rightOut =
      take.sourceDuration != null && take.trimOut >= take.sourceDuration ? null : formatAtTime(take.trimOut, opts.fps);
    const texts = splitDialogueText(
      "",
      take.primary.words,
      splitSec
    );
    const write: LineSplitWrite = {
      scriptLine: take.scriptLine,
      left: {
        scriptLine: take.scriptLine,
        trimIn: leftIn,
        trimOut: formatAtTime(splitFrames, opts.fps),
      },
      right: {
        scriptLine: take.scriptLine,
        atTime: rightAt,
        trimIn: formatAtTime(splitFrames, opts.fps),
        trimOut: rightOut,
      },
    };
    if (take.primary.words && take.primary.words.length > 0 && !line.trim().startsWith("[")) {
      write.leftText = texts.left;
      write.rightText = texts.right;
    }
    return write;
  }
  const leftDur = formatAtTime(opts.playhead - take.start, opts.fps);
  const rightDur = formatAtTime(take.end - opts.playhead, opts.fps);
  const durationAttr = take.kind === "pin" ? pinDurationWriteAttr(line) : take.durationAttr;
  const hadDuration = take.kind === "duration" || lineHasPinHold(line) || lineHasAttr(line, take.durationAttr);
  const leftAt = lineHasAttr(line, "at_time")
    ? formatAtTime(Math.max(0, take.start - sceneStart), opts.fps)
    : undefined;
  return {
    scriptLine: take.scriptLine,
    left: {
      scriptLine: take.scriptLine,
      atTime: leftAt,
      durationAttr,
      duration: take.kind === "duration" || hadDuration || take.kind === "pin" ? leftDur : null,
    },
    right: {
      scriptLine: take.scriptLine,
      atTime: rightAt,
      durationAttr,
      duration: take.kind === "duration" || hadDuration || take.kind === "pin" ? rightDur : null,
    },
  };
}

function applyWriteToLine(line: string, write: LineTrimWrite): string {
  let next = line;
  if (write.durationAttr && write.duration) next = setDurationOnLine(next, write.durationAttr, write.duration);
  if (write.atTime) next = setAtTimeOnLine(next, write.atTime);
  if (write.trimIn !== undefined || write.trimOut !== undefined) {
    next = setTrimOnLine(next, { trimIn: write.trimIn, trimOut: write.trimOut });
  }
  return next;
}

export function applySplitWrite(script: string, write: LineSplitWrite): string {
  const lines = script.split("\n");
  const index = write.scriptLine - 1;
  if (index < 0 || index >= lines.length) return script;
  const original = lines[index];
  let left = applyWriteToLine(original, write.left);
  if (write.leftText) left = setDialogueTextOnLine(left, write.leftText);
  let right = applyWriteToLine(original, write.right);
  if (write.rightText) right = setDialogueTextOnLine(right, write.rightText);
  lines.splice(index, 1, left, right);
  return lines.join("\n");
}

export function splitBlocksInScript(script: string, writes: LineSplitWrite[]): string {
  const ordered = [...writes].sort((a, b) => b.scriptLine - a.scriptLine);
  let next = script;
  for (const write of ordered) next = applySplitWrite(next, write);
  return next;
}

export function uniqueSplitWrites(writes: Array<LineSplitWrite | null | undefined>): LineSplitWrite[] {
  const seen = new Set<number>();
  const out: LineSplitWrite[] = [];
  for (const write of writes) {
    if (!write || seen.has(write.scriptLine)) continue;
    seen.add(write.scriptLine);
    out.push(write);
  }
  return out;
}
