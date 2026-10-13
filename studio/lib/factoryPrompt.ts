/**
 * Hidden Factory prompt pack (client copy of worker/src/factoryPrompt.js).
 * The owner types a plain line; Advanced can show the assembled text.
 */

import { packForCharacter } from "./promptPacks.ts";
import type { Character } from "./worker";

export const GREEN = "#00FF00";
export const FACTORY_FRAMES = [8, 12, 16] as const;
export type FactoryFrames = (typeof FACTORY_FRAMES)[number];

export const RIG_RULES = [
  "Only one head may ever show.",
  "Eyes and mouths are overlays on a blank head — never full heads.",
  "Never squash or stretch a piece; keep natural proportions.",
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "Full figure fully visible. Small empty margin inside each cell. One character only.",
];

export function clampFactoryFrames(value: number | null | undefined): FactoryFrames {
  const n = Math.floor(Number(value));
  if (n === 8 || n === 12 || n === 16) return n;
  if (!Number.isFinite(n)) return 8;
  if (n <= 8) return 8;
  if (n <= 12) return 12;
  return 16;
}

export function inferFactoryIntent(prompt: string): { kind: "walk" | "action"; view: string; gait?: string } {
  const text = String(prompt || "").toLowerCase();
  const left = /\bleft\b/.test(text) && !/\bright\b/.test(text);
  const view = left ? "left_side" : "right_side";
  if (/walk|stride|step|gait/.test(text)) {
    return { kind: "walk", view, gait: /run|sprint/.test(text) ? "run" : "walk" };
  }
  return { kind: "action", view };
}

export function walkPoseNotes(frames: number): string {
  const n = clampFactoryFrames(frames);
  const lead =
    "Side view. Front leg reaches out ahead of the body with the heel landing first — legs must not trail behind the body.";
  if (n === 8) {
    return `${lead} Eight frames, left to right: 1 contact (heel lands ahead), 2 down/knee bend, 3 passing, 4 push-off-toe, then 5–8 the same four poses on the other leg. Slight body bob.`;
  }
  if (n === 12) {
    return `${lead} Twelve frames: contact, down/knee bend, passing, and push-off-toe on each leg, with one in-between after each of those poses. Slight body bob.`;
  }
  return `${lead} Sixteen frames: contact, down/knee bend, passing, and push-off-toe on each leg, with two in-betweens after each of those poses. Slight body bob.`;
}

export function lockedStyle(character: Pick<Character, "id" | "display_name" | "style"> | null | undefined): string {
  const pack = packForCharacter(character ?? null);
  const fromPack = pack && String(pack.styleBlock || "").trim();
  if (fromPack) return fromPack;
  const style = String((character && character.style) || "").trim();
  return style || "a consistent character style";
}

export function factoryGrid(frames: number): { cols: number; rows: number } {
  const n = clampFactoryFrames(frames);
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

export function slugActionId(prompt: string, intent: { kind: string; view: string }): string {
  let text = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  text = text.replace(/^(rodney|character)\s+/, "");
  const extras = text.split(/\s+/).filter((word) => !["walk", "walking", "walks", "side", "a", "the", "of", "to"].includes(word));
  if (intent.kind === "walk") {
    const tail = extras.join("_");
    const base = intent.view === "left_side" ? "walk_left_side" : "walk_side";
    return tail ? `${base}_${tail}` : base;
  }
  return extras.join("_") || "action";
}

export function assembleHiddenPrompt(opts: {
  character: Pick<Character, "id" | "display_name" | "style">;
  userPrompt: string;
  frames: number;
  advancedPrompt?: string;
}): string {
  const edited = typeof opts.advancedPrompt === "string" ? opts.advancedPrompt.trim() : "";
  if (edited) return edited;
  const intent = inferFactoryIntent(opts.userPrompt);
  const n = clampFactoryFrames(opts.frames);
  const style = lockedStyle(opts.character);
  const name = opts.character.display_name || opts.character.id || "the character";
  const grid = factoryGrid(n);
  const pose = intent.kind === "walk" ? walkPoseNotes(n) : String(opts.userPrompt || "").trim();
  return [
    style,
    RIG_RULES.join(" "),
    `A ${grid.cols}x${grid.rows} production sheet of ${name}.`,
    pose,
    `The user asked: ${String(opts.userPrompt || "").trim() || "an action"}.`,
    "Same size, ground line, and position in every cell; only the pose changes. Do not crop feet, hands, or the hat.",
  ].join(" ");
}
