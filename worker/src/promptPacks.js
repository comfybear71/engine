"use strict";

/**
 * Built-in Imagine prompt packs (character-parametric style block + sets).
 * Source of truth: docs/prompt-packs/*.json
 */

const fs = require("fs");
const path = require("path");

const PACKS_DIR = path.resolve(__dirname, "..", "..", "docs", "prompt-packs");

let cached = null;

function loadPacks() {
  if (cached) return cached;
  const packs = [];
  if (!fs.existsSync(PACKS_DIR)) {
    cached = packs;
    return packs;
  }
  for (const name of fs.readdirSync(PACKS_DIR).sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, name), "utf8"));
    if (raw && raw.id && Array.isArray(raw.sets)) packs.push(raw);
  }
  cached = packs;
  return packs;
}

function resetPackCache() {
  cached = null;
}

function norm(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function packForCharacter(character) {
  if (!character) return null;
  const id = norm(character.id || character.characterId);
  const display = norm(character.display_name || character.displayName);
  for (const pack of loadPacks()) {
    const ids = (pack.characterIds || [pack.id]).map(norm);
    const names = (pack.displayNames || (pack.displayName ? [pack.displayName] : [])).map(norm);
    if ((id && ids.includes(id)) || (display && names.includes(display))) return pack;
  }
  return null;
}

function getPack(packId) {
  return loadPacks().find((pack) => pack.id === packId) || null;
}

function getPackSet(setId) {
  for (const pack of loadPacks()) {
    const set = (pack.sets || []).find((item) => item.id === setId);
    if (set) return { pack, set };
  }
  return null;
}

function fillPackPrompt(set, vars = {}) {
  const styleBlock = vars.styleBlock || "";
  const name = vars.name || "the character";
  return String(set.prompt || "")
    .replaceAll("{{styleBlock}}", styleBlock)
    .replaceAll("{{name}}", name);
}

function packSetToNeed(set) {
  if (!set) return null;
  const cells = Array.isArray(set.cells) ? set.cells : [];
  return {
    id: set.id,
    label: set.label,
    description: set.description || "",
    split: set.split || (set.grid ? "grid" : "components"),
    grid: set.grid || null,
    key: set.key !== false,
    ingest: set.ingest,
    dest: set.dest || null,
    cells,
    assignChoices: set.assignChoices || cells.map((cell) => cell.name).filter(Boolean),
    cycles: set.cycles || null,
    cycleFps: set.cycleFps,
    prompt: set.prompt || "",
  };
}

function listPackSummaries() {
  return loadPacks().map((pack) => ({
    id: pack.id,
    displayName: pack.displayName || pack.id,
    characterIds: pack.characterIds || [pack.id],
    sets: (pack.sets || []).map((set) => ({
      id: set.id,
      label: set.label,
      description: set.description || "",
      group: set.group || null,
      needId: set.needId || set.id,
    })),
  }));
}

module.exports = {
  PACKS_DIR,
  loadPacks,
  resetPackCache,
  packForCharacter,
  getPack,
  getPackSet,
  fillPackPrompt,
  packSetToNeed,
  listPackSummaries,
};
