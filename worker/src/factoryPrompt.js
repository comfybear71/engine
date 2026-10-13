"use strict";

/**
 * Hidden Factory prompt pack. The owner types a plain line; this file
 * silently adds the locked style, green screen, reference reminder, and
 * rig rules. Advanced in Studio can show/edit the assembled text.
 */

const { packForCharacter } = require("./promptPacks");

const GREEN = "#00FF00";
const FACTORY_FRAMES = [8, 12, 16];

const RIG_RULES = [
  "Only one head may ever show.",
  "Eyes and mouths are overlays on a blank head — never full heads.",
  "Never squash or stretch a piece; keep natural proportions.",
  `Flat ${GREEN} green background, no shadow, no floor, no text, no watermark.`,
  "Full figure fully visible. Small empty margin inside each cell. One character only.",
];

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

function walkPoseNotes(frames) {
  const n = clampFactoryFrames(frames);
  const lead =
    "Side view. Front leg reaches out ahead of the body with the heel landing first — legs must not trail behind the body.";
  if (n === 8) {
    return (
      `${lead} Eight frames, left to right: 1 contact (heel lands ahead), 2 down/knee bend, ` +
      `3 passing, 4 push-off-toe, then 5–8 the same four poses on the other leg. Slight body bob.`
    );
  }
  if (n === 12) {
    return (
      `${lead} Twelve frames: contact, down/knee bend, passing, and push-off-toe on each leg, ` +
      `with one in-between after each of those poses. Slight body bob.`
    );
  }
  return (
    `${lead} Sixteen frames: contact, down/knee bend, passing, and push-off-toe on each leg, ` +
    `with two in-betweens after each of those poses. Slight body bob.`
  );
}

function lockedStyle(character) {
  const pack = packForCharacter(character);
  const fromPack = pack && String(pack.styleBlock || "").trim();
  if (fromPack) return fromPack;
  const style = String((character && character.style) || "").trim();
  return style || "a consistent character style";
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

function assembleHiddenPrompt({ character, userPrompt, frames, advancedPrompt }) {
  const intent = inferFactoryIntent(userPrompt);
  const n = clampFactoryFrames(frames);
  const style = lockedStyle(character);
  const name = (character && (character.display_name || character.id)) || "the character";
  const grid = factoryGrid(n);
  const pose = intent.kind === "walk" ? walkPoseNotes(n) : String(userPrompt || "").trim();
  const edited = typeof advancedPrompt === "string" && advancedPrompt.trim() ? advancedPrompt.trim() : "";
  if (edited) return edited;
  return [
    style,
    RIG_RULES.join(" "),
    `A ${grid.cols}x${grid.rows} production sheet of ${name}.`,
    pose,
    `The user asked: ${String(userPrompt || "").trim() || "an action"}.`,
    "Same size, ground line, and position in every cell; only the pose changes. Do not crop feet, hands, or the hat.",
  ].join(" ");
}

function buildFactoryPack({ character, userPrompt, frames, advancedPrompt, references }) {
  const intent = inferFactoryIntent(userPrompt);
  const n = clampFactoryFrames(frames);
  return {
    userPrompt: String(userPrompt || "").trim(),
    frames: n,
    grid: factoryGrid(n),
    styleBlock: lockedStyle(character),
    hiddenPrompt: assembleHiddenPrompt({ character, userPrompt, frames: n, advancedPrompt }),
    references: Array.isArray(references) ? references : [],
    greenScreen: GREEN,
    rigRules: [...RIG_RULES],
    intent,
    actionId: slugActionId(userPrompt, intent),
    characterId: character && character.id,
  };
}

module.exports = {
  GREEN,
  FACTORY_FRAMES,
  RIG_RULES,
  clampFactoryFrames,
  inferFactoryIntent,
  walkPoseNotes,
  lockedStyle,
  factoryGrid,
  slugActionId,
  assembleHiddenPrompt,
  buildFactoryPack,
};
