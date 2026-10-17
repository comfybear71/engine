import type { TalkMeta } from "./talkingHead.ts";

export type ClipDetailsShot = {
  id: string;
  name?: string;
  status?: string;
  error?: string;
  engine?: string;
  prompt?: string;
  requestId?: string;
  fps?: number;
  frameCount?: number;
  keyMode?: string;
  background?: string;
  refImage?: string;
  headSizeTarget?: number;
  hasPrevious?: boolean;
  talk?: TalkMeta;
};

/** LTX is told to keep the mouth shut when its window has no transcript words. */
export function promptSaysMouthClosed(prompt: string | undefined | null): boolean {
  return /mouth closed/i.test(String(prompt || ""));
}

function secs(value: number | undefined): string {
  return Number.isFinite(value) ? `${(value as number).toFixed(2)} s` : "?";
}

/** Plain-text summary of everything that went into a clip, to read or to paste into a message. */
export function clipDetailsText(shot: ClipDetailsShot): string {
  const talk = shot.talk;
  const lines: string[] = [];
  lines.push(`Clip: ${shot.name || shot.id} (folder ${shot.id})`);
  lines.push(`Engine: ${shot.engine || talk?.engine || "grok"}   Status: ${shot.status || "?"}`);
  if (shot.error) lines.push(`Error: ${shot.error}`);
  if (talk) {
    lines.push(`Audio file: ${talk.audioRel || "(unknown)"}`);
    lines.push(`Audio range: ${secs(talk.audioInSec)} to ${secs(talk.audioOutSec)}  (window ${secs(talk.windowSec)})`);
    lines.push(`Words in this window: ${talk.text ? `"${talk.text}"` : "(none found in the transcript)"}`);
    if (talk.subject) lines.push(`Subject: ${talk.subject}`);
  }
  lines.push(`Prompt sent: ${shot.prompt || "(none saved)"}`);
  if (promptSaysMouthClosed(shot.prompt)) {
    lines.push("WARNING: this prompt tells the character to keep the mouth closed (no transcript words in this window).");
  }
  if (shot.requestId) lines.push(`Job id: ${shot.requestId}`);
  const size = [
    Number.isFinite(shot.frameCount) ? `${shot.frameCount} frames` : "",
    Number.isFinite(shot.fps) && (shot.fps as number) > 0 ? `${shot.fps} fps` : "",
  ].filter(Boolean).join(", ");
  if (size) lines.push(`Result: ${size}`);
  if (shot.keyMode) lines.push(`Key mode: ${shot.keyMode}`);
  if (shot.background) lines.push(`Backdrop: ${shot.background}`);
  if (Number(shot.headSizeTarget) > 0) lines.push(`Head size target: ${Math.round(Number(shot.headSizeTarget))}`);
  if (shot.refImage) lines.push(`Reference image: ${shot.refImage}`);
  return lines.join("\n");
}
