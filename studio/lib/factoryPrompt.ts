/**
 * Hidden Factory prompt pack (client copy of worker/src/factoryPrompt.js).
 * The owner types a plain line; Advanced can show the assembled text.
 */

import { packForCharacter } from "./promptPacks.ts";
import type { Character } from "./worker";

export const GREEN = "#00FF00";
export const FACTORY_FRAMES = [8, 12, 16] as const;
export type FactoryFrames = (typeof FACTORY_FRAMES)[number];
export const FACTORY_MODES = ["character", "new-character", "prop", "background", "slot"] as const;
export type FactoryModeKind = (typeof FACTORY_MODES)[number];
export const PROJECT_OWNER = "project";

export type FactoryContext = {
  kind: FactoryModeKind;
  characterId?: string | null;
  slot?: string | null;
  view?: string | null;
  label?: string | null;
};

const VIEW_LABELS: Record<string, string> = {
  front: "Front",
  left_34: "L 3/4",
  right_34: "R 3/4",
  left_side: "Side L",
  right_side: "Side R",
  back: "Back",
};

const SLOT_LABELS: Record<string, string> = {
  eyes: "Eyes",
  mouth: "Mouth",
  head_base: "Head",
  head: "Head",
  torso: "Torso",
  body: "Torso",
  hand: "Arms",
  hands: "Arms",
  arm: "Arms",
  arms: "Arms",
  arm_l: "Arms",
  arm_r: "Arms",
  legs: "Legs",
  overlay: "Overlays",
  overlays: "Overlays",
};

export const RIG_RULES = [
  "Only one head may ever show.",
  "Eyes and mouths are overlays on a blank head — never full heads.",
  "Never squash or stretch a piece; keep natural proportions.",
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "Full figure fully visible. Small empty margin inside each cell. One character only.",
];

const PROP_RULES = [
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "A single isolated object, fully visible, not a scene, not a character.",
  "Small empty margin. Do not crop the object.",
];

const NEW_CHARACTER_RULES = [
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "Front full-body standing reference sheet. Complete figure including head, face, hair, neck, torso, arms, hands, legs, and feet.",
  "Feet planted, arms slightly off the torso. Small empty margin. One character only. Do not crop hands, feet, or hair.",
  "Finished illustration, not a sprite sheet. No watermark, no caption, no text, no logo.",
];

const BACKGROUND_RULES = [
  "A full 16:9 environment plate. No green screen. No characters. No cut-out. No props floating on empty green.",
  "No text, no watermark, no letterboxing, no UI.",
];

export function normalizeFactoryMode(value: string | null | undefined): FactoryModeKind {
  const id = String(value || "character")
    .trim()
    .toLowerCase();
  return (FACTORY_MODES as readonly string[]).includes(id) ? (id as FactoryModeKind) : "character";
}

export function factoryUsesFrames(mode: string | null | undefined): boolean {
  return normalizeFactoryMode(mode) === "character";
}

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

export function stripGreenFromStyle(style: string): string {
  return String(style || "")
    .replace(/;?\s*flat\s+#00FF00\s+green background[^;]*/gi, "")
    .replace(/;?\s*no shadow, no text, no watermark, full figure fully visible/gi, "")
    .replace(/[;,\s]+$/g, "")
    .trim();
}

export function projectStyleBlock(
  character: Pick<Character, "id" | "display_name" | "style"> | null | undefined,
  projectStyle?: string | null
): string {
  const fromProject = String(projectStyle || "").trim();
  if (fromProject) return fromProject;
  return lockedStyle(character);
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

export function slugFactoryId(raw: string, fallback = "item"): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

export function slotKind(slot?: string | null, label?: string | null): string {
  const n = `${slot || ""} ${label || ""}`.toLowerCase();
  if (/\beyes?\b/.test(n) || n.startsWith("eye")) return "eyes";
  if (/\bmouth\b/.test(n) || n.startsWith("mouth")) return "mouth";
  if (/\bhead_base\b/.test(n) || /(^|\s)head(\s|$)/.test(n)) return "head";
  if (/\btorso\b|\bbody\b/.test(n)) return "torso";
  if (/hand|\barm|mic_arm/.test(n)) return "arm";
  if (/\boverlay/.test(n) || /\bcape\b|\bshirt\b/.test(n)) return "overlay";
  if (/\blegs?\b/.test(n)) return "legs";
  return "slot";
}

export function isOverlaySlot(slot?: string | null, label?: string | null): boolean {
  const kind = slotKind(slot, label);
  return kind === "eyes" || kind === "mouth";
}

export function slotLabel(slot?: string | null, label?: string | null): string {
  if (label && String(label).trim()) return String(label).trim();
  const key = String(slot || "")
    .toLowerCase()
    .replace(/_(front|left_34|right_34|left_side|right_side|back)$/, "");
  if (SLOT_LABELS[key]) return SLOT_LABELS[key];
  const kind = slotKind(slot, label);
  if (kind === "eyes") return "Eyes";
  if (kind === "mouth") return "Mouth";
  if (kind === "head") return "Head";
  if (kind === "torso") return "Torso";
  if (kind === "hands" || kind === "arm") return "Arms";
  if (kind === "overlay") return "Overlays";
  if (kind === "legs") return "Legs";
  return String(slot || "Slot").replace(/_/g, " ");
}

export function viewLabel(view?: string | null): string {
  const id = String(view || "front").trim();
  return VIEW_LABELS[id] || id;
}

export function factoryModeTitle(opts: {
  mode?: string | null;
  character?: Pick<Character, "id" | "display_name"> | null;
  slot?: string | null;
  view?: string | null;
  label?: string | null;
}): string {
  const kind = normalizeFactoryMode(opts.mode);
  if (kind === "prop") return "Prop";
  if (kind === "background") return "Background";
  if (kind === "new-character") return "New character";
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "Character";
  if (kind === "slot") {
    return [name, viewLabel(opts.view || "front"), slotLabel(opts.slot, opts.label)].join(" / ");
  }
  return name;
}

export function factoryHint(
  mode?: string | null,
  opts: {
    character?: Pick<Character, "id" | "display_name"> | null;
    slot?: string | null;
    label?: string | null;
  } = {}
): string {
  const kind = normalizeFactoryMode(mode);
  if (kind === "prop") return "Type the prop you want (e.g. guitar, bar stool)";
  if (kind === "background") return "Type the scene you want (e.g. smoky bar interior)";
  if (kind === "new-character") return "Describe a new character (e.g. grumpy old barman)";
  if (kind === "slot") {
    const slot = slotKind(opts.slot, opts.label);
    if (slot === "eyes") return "Type an expression, e.g. angry, sleepy";
    if (slot === "mouth") return "Type a mouth shape, e.g. shout, smirk";
    if (slot === "torso") return "Type a torso pose, e.g. leaning, arms folded";
    if (slot === "arm" || slot === "hands") return "Type a whole-arm pose, e.g. grip mic, point. Labelled L or R.";
    if (slot === "overlay") return "Type the overlay, e.g. sweat, blush";
    if (slot === "head") return "Type a head pose, e.g. looking down";
    if (slot === "legs") return "Type a legs pose, e.g. standing, mid-step";
    return `Type a ${slotLabel(opts.slot, opts.label)} drawing`;
  }
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "the character";
  return `Type what ${name} should do. A walk builds 8/12/16 long-stride loops from the existing side walk — no Grok. Open Advanced to use Imagine.`;
}

export function factoryPlaceholder(
  mode?: string | null,
  opts: { character?: Pick<Character, "id" | "display_name"> | null; slot?: string | null; label?: string | null } = {}
): string {
  const kind = normalizeFactoryMode(mode);
  if (kind === "prop") return "guitar, bar stool";
  if (kind === "background") return "smoky bar interior";
  if (kind === "new-character") return "grumpy old barman";
  if (kind === "slot") {
    const slot = slotKind(opts.slot, opts.label);
    if (slot === "eyes") return "angry, sleepy";
    if (slot === "mouth") return "shout";
    if (slot === "arm" || slot === "hands") return "grip mic L";
    return String(opts.slot || "pose").replace(/_/g, " ");
  }
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "Rodney";
  return `${name} walking long stride`;
}

function slotRules(slot?: string | null, label?: string | null): string[] {
  const kind = slotKind(slot, label);
  if (kind === "eyes") {
    return [
      "Draw ONLY the eyes (lids, irises, brows if they belong to the eye layer) as a transparent overlay.",
      "Never draw a full head, fedora, hair, neck, or torso.",
      "Place the eyes on the character's blank head base, same 1024×1024 canvas and pivot.",
      `One overlay only. Flat ${GREEN} green background. No shadow, no text, no watermark.`,
    ];
  }
  if (kind === "mouth") {
    return [
      "Draw ONLY the mouth (lips, teeth, tongue) as a transparent overlay.",
      "Never draw a full head, fedora, hair, neck, or torso.",
      "Place the mouth on the character's blank head base, same 1024×1024 canvas and pivot.",
      `One overlay only. Flat ${GREEN} green background. No shadow, no text, no watermark.`,
    ];
  }
  if (kind === "head") {
    return [
      "Blank head base only — no eyes, no mouth drawn on. Same 1024×1024 canvas and pivot.",
      `Flat ${GREEN} green background, no shadow, no text, no watermark.`,
    ];
  }
  if (kind === "arm" || kind === "hands") {
    return [
      "ONE whole arm as a single piece: shoulder + sleeve + forearm + hand in one pose.",
      "Left or Right labelled (L or R). Never a split upper/lower/hand rig.",
      "Never squash or stretch. Do not draw a head, torso, or the other arm. Only one head may ever show — so draw none.",
      "If gripping a mic: knuckles face OUT toward camera, thumb on top of the grip, hand joined to the sleeve (not a backwards floating hand).",
      `Flat ${GREEN} green background. Same 1024 canvas. Do not crop the shoulder or fingertips.`,
    ];
  }
  if (kind === "overlay") {
    return [
      "Clothing or overlay piece only, on the same 1024 canvas and pivot as the body.",
      `Flat ${GREEN} green background. No full character.`,
    ];
  }
  return [
    `A single production drawing on a 1024×1024 canvas. Flat ${GREEN} green background.`,
    "Never squash or stretch. Small empty margin. One piece only.",
  ];
}

type PromptOpts = {
  mode?: string | null;
  character?: Pick<Character, "id" | "display_name" | "style"> | null;
  userPrompt: string;
  frames?: number;
  advancedPrompt?: string;
  slot?: string | null;
  view?: string | null;
  label?: string | null;
  name?: string | null;
  projectStyle?: string | null;
};

function assembleCharacterPrompt(opts: PromptOpts): string {
  const intent = inferFactoryIntent(opts.userPrompt);
  const n = clampFactoryFrames(opts.frames);
  const style = projectStyleBlock(opts.character, opts.projectStyle);
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "the character";
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

function assemblePropPrompt(opts: PromptOpts): string {
  const style = stripGreenFromStyle(projectStyleBlock(opts.character, opts.projectStyle));
  const asked = String(opts.userPrompt || "").trim() || "a prop";
  return [
    style,
    PROP_RULES.join(" "),
    `One production still of ${asked}, a single isolated object.`,
    "Match this project's existing art style. No character, no scene, no hands holding it unless the object is the whole subject.",
    `The user asked: ${asked}.`,
  ].join(" ");
}

function assembleBackgroundPrompt(opts: PromptOpts): string {
  const style = stripGreenFromStyle(projectStyleBlock(opts.character, opts.projectStyle));
  const asked = String(opts.userPrompt || "").trim() || "a scene";
  return [
    style,
    BACKGROUND_RULES.join(" "),
    `A full 16:9 cinematic scene: ${asked}.`,
    "Match this project's existing art style. Empty of people.",
    `The user asked: ${asked}.`,
  ].join(" ");
}

function assembleNewCharacterPrompt(opts: PromptOpts): string {
  const style = stripGreenFromStyle(projectStyleBlock(opts.character, opts.projectStyle));
  const name = String(opts.name || "").trim() || "the new character";
  const asked = String(opts.userPrompt || "").trim() || name;
  return [
    style,
    NEW_CHARACTER_RULES.join(" "),
    `A front full-body standing reference of ${name}. ${asked}.`,
    "Do not copy any existing character from this project. This is a new person.",
    `The user asked: ${asked}.`,
  ].join(" ");
}

function assembleSlotPrompt(opts: PromptOpts): string {
  const style = projectStyleBlock(opts.character, opts.projectStyle);
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "the character";
  const asked = String(opts.userPrompt || "").trim() || "a drawing";
  const rules = slotRules(opts.slot, opts.label);
  const kind = slotKind(opts.slot, opts.label);
  const view = viewLabel(opts.view || "front");
  const piece = slotLabel(opts.slot, opts.label);
  const likeness =
    kind === "eyes" || kind === "mouth"
      ? `Match ${name}'s blank head base for placement. Ordinary eye shape; never slanted eyes or a mocking ethnic eye gesture.`
      : `Match ${name}'s likeness, costume, and proportions.`;
  return [
    style,
    rules.join(" "),
    `${view} ${piece} drawing of ${name}: ${asked}.`,
    likeness,
    `The user asked: ${asked}.`,
  ].join(" ");
}

export function assembleHiddenPrompt(opts: PromptOpts): string {
  const edited = typeof opts.advancedPrompt === "string" ? opts.advancedPrompt.trim() : "";
  if (edited) return edited;
  const mode = normalizeFactoryMode(opts.mode);
  if (mode === "prop") return assemblePropPrompt(opts);
  if (mode === "background") return assembleBackgroundPrompt(opts);
  if (mode === "new-character") return assembleNewCharacterPrompt(opts);
  if (mode === "slot") return assembleSlotPrompt(opts);
  return assembleCharacterPrompt(opts);
}
