"use strict";

/**
 * Hidden Factory prompt pack. The owner types a plain line; this file
 * silently adds the locked style, green screen, reference reminder, and
 * rig rules. Advanced in Studio can show/edit the assembled text.
 *
 * Modes: character (action sheet), slot, new-character, prop, background.
 */

const { packForCharacter } = require("./promptPacks");

const GREEN = "#00FF00";
const FACTORY_FRAMES = [8, 12, 16];
const FACTORY_MODES = ["character", "new-character", "prop", "background", "slot"];
const PROJECT_OWNER = "project";

const VIEW_LABELS = {
  front: "Front",
  left_34: "L 3/4",
  right_34: "R 3/4",
  left_side: "Side L",
  right_side: "Side R",
  back: "Back",
};

const SLOT_LABELS = {
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

const RIG_RULES = [
  "Only one head may ever show.",
  "Eyes and mouths are overlays on a blank head — never full heads.",
  "Never squash or stretch a piece; keep natural proportions.",
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "Full figure fully visible from hat to feet. Small empty margin inside each cell. One character only.",
  "Never zoom into legs or boots. Never draw a second figure. Same scale and ground line in every cell.",
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

function normalizeFactoryMode(value) {
  const id = String(value || "character")
    .trim()
    .toLowerCase();
  return FACTORY_MODES.includes(id) ? id : "character";
}

function factoryUsesFrames(mode) {
  return normalizeFactoryMode(mode) === "character";
}

function clampFactoryFrames(value) {
  const n = Math.floor(Number(value));
  if (FACTORY_FRAMES.includes(n)) return n;
  if (!Number.isFinite(n)) return 8;
  if (n <= 8) return 8;
  if (n <= 12) return 12;
  return 16;
}

function inferFactoryIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  const left = /\bleft\b/.test(text) && !/\bright\b/.test(text);
  const view = left ? "left_side" : "right_side";
  if (/walk|stride|step|gait/.test(text)) {
    return { kind: "walk", view, gait: /run|sprint/.test(text) ? "run" : "walk" };
  }
  return { kind: "action", view };
}

const WALK_PHASES_8 = [
  {
    id: "contact_R",
    pose: "right heel striking the ground ahead of the body, left leg extended behind, left toes pushing off",
  },
  {
    id: "down_R",
    pose: "right knee bent, weight over the front right foot, left foot just leaving the ground behind",
  },
  {
    id: "passing_R",
    pose: "left leg swinging past the standing right, thighs crossing, right foot flat on the ground",
  },
  {
    id: "up_R",
    pose: "left heel reaching ahead, right toes pushing off, body leaning slightly forward",
  },
  {
    id: "contact_L",
    pose: "left heel striking the ground ahead of the body, right leg extended behind, right toes pushing off",
  },
  {
    id: "down_L",
    pose: "left knee bent, weight over the front left foot, right foot just leaving the ground behind",
  },
  {
    id: "passing_L",
    pose: "right leg swinging past the standing left, thighs crossing, left foot flat on the ground",
  },
  {
    id: "up_L",
    pose: "right heel reaching ahead, left toes pushing off, body leaning slightly forward",
  },
];

function walkPhases(frames) {
  const n = clampFactoryFrames(frames);
  if (n === 8) return WALK_PHASES_8.map((item) => ({ ...item }));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * WALK_PHASES_8.length;
    const a = Math.floor(t) % WALK_PHASES_8.length;
    const src = WALK_PHASES_8[a];
    const inBetween = t - Math.floor(t) > 0.01 && t - Math.floor(t) < 0.99;
    out.push({
      id: `${src.id}_${String(i + 1).padStart(2, "0")}`,
      pose: inBetween ? `in-between toward ${src.pose}` : src.pose,
    });
  }
  return out;
}

function walkPoseNotes(frames) {
  const n = clampFactoryFrames(frames);
  const lead =
    "WALK CYCLE. Side view, same direction in every cell. Each cell is the WHOLE BODY from hat to boots — never crop to the waist or legs. " +
    "Legs alternate. Do not repeat the same mid-stride pose. Front leg reaches ahead, heel first — legs must not trail behind the body.";
  const phases = walkPhases(n)
    .map((item, i) => `${i + 1} ${item.id.replace(/_/g, " ")} (${item.pose})`)
    .join("; ");
  return `${lead} ${n} DISTINCT phases, one pose per image: ${phases}. Slight body bob.`;
}

function assembleWalkPhasePrompt(opts) {
  const style = projectStyleBlock(opts.character, opts.projectStyle);
  const name = (opts.character && (opts.character.display_name || opts.character.id)) || "the character";
  const phase = opts.phase || walkPhases(8)[0];
  const index = Number(opts.index) || 0;
  const n = clampFactoryFrames(opts.frames);
  const asked = String(opts.userPrompt || "").trim() || "walking long strides";
  return [
    style,
    RIG_RULES.join(" "),
    `ONE production still of ${name}, side view, facing right, walking ${asked}.`,
    `This is gait phase ${index + 1} of ${n} (${phase.id.replace(/_/g, " ")}): ${phase.pose}.`,
    "WHOLE BODY from hat to boots. Same scale and ground line as the reference. Do not crop to the waist.",
    "Do not draw a second figure. Do not copy a mid-stride pose unless this phase is mid-stride.",
    `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  ].join(" ");
}

function lockedStyle(character) {
  const pack = packForCharacter(character);
  const fromPack = pack && String(pack.styleBlock || "").trim();
  if (fromPack) return fromPack;
  const style = String((character && character.style) || "").trim();
  return style || "a consistent character style";
}

function stripGreenFromStyle(style) {
  return String(style || "")
    .replace(/;?\s*flat\s+#00FF00\s+green background[^;]*/gi, "")
    .replace(/;?\s*no shadow, no text, no watermark, full figure fully visible/gi, "")
    .replace(/[;,\s]+$/g, "")
    .trim();
}

function projectStyleBlock(character, projectStyle) {
  const fromProject = String(projectStyle || "").trim();
  if (fromProject) return fromProject;
  return lockedStyle(character);
}

function factoryGrid(frames) {
  const n = clampFactoryFrames(frames);
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

function slugActionId(prompt, intent) {
  let text = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  text = text.replace(/^(rodney|character)\s+/, "");
  const extras = text.split(/\s+/).filter((word) => !["walk", "walking", "walks", "side", "a", "the", "of", "to"].includes(word));
  if (intent && intent.kind === "walk") {
    const tail = extras.join("_");
    const base = intent.view === "left_side" ? "walk_left_side" : "walk_side";
    return tail ? `${base}_${tail}` : base;
  }
  return extras.join("_") || "action";
}

function slugFactoryId(raw, fallback) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || fallback || "item";
}

function slotKind(slot, label) {
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

function isOverlaySlot(slot, label) {
  const kind = slotKind(slot, label);
  return kind === "eyes" || kind === "mouth";
}

function slotLabel(slot, label) {
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

function viewLabel(view) {
  const id = String(view || "front").trim();
  return VIEW_LABELS[id] || id;
}

function factoryModeTitle({ mode, character, slot, view, label }) {
  const kind = normalizeFactoryMode(mode);
  if (kind === "prop") return "Prop";
  if (kind === "background") return "Background";
  if (kind === "new-character") return "New character";
  const name = (character && (character.display_name || character.id)) || "Character";
  if (kind === "slot") {
    return [name, viewLabel(view || "front"), slotLabel(slot, label)].join(" / ");
  }
  return name;
}

function factoryHint(mode, opts = {}) {
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

function factoryPlaceholder(mode, opts = {}) {
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

function slotRules(slot, label) {
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

function assembleCharacterPrompt(opts) {
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
    "Same size, ground line, and position in every cell; only the pose changes. Do not crop feet, hands, or the hat. Whole body in every cell — never a close-up of legs.",
  ].join(" ");
}

function assemblePropPrompt(opts) {
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

function assembleBackgroundPrompt(opts) {
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

function assembleNewCharacterPrompt(opts) {
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

function assembleSlotPrompt(opts) {
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

function assembleHiddenPrompt(opts) {
  const edited = typeof opts.advancedPrompt === "string" && opts.advancedPrompt.trim() ? opts.advancedPrompt.trim() : "";
  if (edited) return edited;
  const mode = normalizeFactoryMode(opts.mode);
  if (mode === "prop") return assemblePropPrompt(opts);
  if (mode === "background") return assembleBackgroundPrompt(opts);
  if (mode === "new-character") return assembleNewCharacterPrompt(opts);
  if (mode === "slot") return assembleSlotPrompt(opts);
  return assembleCharacterPrompt(opts);
}

function buildFactoryPack(opts) {
  const mode = normalizeFactoryMode(opts && opts.mode);
  const userPrompt = String((opts && opts.userPrompt) || "").trim();
  const still = mode !== "character";
  const frames = still ? 1 : clampFactoryFrames(opts && opts.frames);
  const intent = inferFactoryIntent(userPrompt);
  const overlay = mode === "slot" && isOverlaySlot(opts && opts.slot, opts && opts.label);
  const styleBlock = mode === "background" || mode === "prop" || mode === "new-character"
    ? stripGreenFromStyle(projectStyleBlock(opts && opts.character, opts && opts.projectStyle))
    : projectStyleBlock(opts && opts.character, opts && opts.projectStyle);
  const rules =
    mode === "prop"
      ? [...PROP_RULES]
      : mode === "background"
        ? [...BACKGROUND_RULES]
        : mode === "new-character"
          ? [...NEW_CHARACTER_RULES]
          : mode === "slot"
            ? slotRules(opts && opts.slot, opts && opts.label)
            : [...RIG_RULES];
  return {
    mode,
    userPrompt,
    frames,
    grid: still ? { cols: 1, rows: 1 } : factoryGrid(frames),
    styleBlock,
    hiddenPrompt: assembleHiddenPrompt({ ...opts, mode, frames, userPrompt }),
    references: Array.isArray(opts && opts.references) ? opts.references : [],
    skipReferences: mode === "prop" || mode === "background" || mode === "new-character",
    attachHeadBase: overlay,
    aspectRatio: mode === "background" ? "16:9" : "1:1",
    greenScreen: mode === "background" ? null : GREEN,
    rigRules: rules,
    intent,
    actionId: slugActionId(userPrompt, intent),
    drawingId: slugFactoryId(userPrompt, mode === "slot" ? slotKind(opts && opts.slot) : mode),
    characterId: opts && opts.character && opts.character.id,
    slot: (opts && opts.slot) || null,
    view: (opts && opts.view) || null,
    name: String((opts && opts.name) || "").trim() || null,
  };
}

module.exports = {
  GREEN,
  FACTORY_FRAMES,
  FACTORY_MODES,
  PROJECT_OWNER,
  RIG_RULES,
  PROP_RULES,
  NEW_CHARACTER_RULES,
  BACKGROUND_RULES,
  normalizeFactoryMode,
  factoryUsesFrames,
  clampFactoryFrames,
  inferFactoryIntent,
  walkPhases,
  walkPoseNotes,
  assembleWalkPhasePrompt,
  lockedStyle,
  stripGreenFromStyle,
  projectStyleBlock,
  factoryGrid,
  slugActionId,
  slugFactoryId,
  slotKind,
  isOverlaySlot,
  slotLabel,
  viewLabel,
  factoryModeTitle,
  factoryHint,
  factoryPlaceholder,
  slotRules,
  assembleHiddenPrompt,
  buildFactoryPack,
};
