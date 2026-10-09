"use strict";

/**
 * Studio Grok Imagine need templates. Source of truth is
 * studio/lib/assetNeeds.json (plain JSON so it can be edited without a
 * rebuild of the worker). The worker loads it to know grid size, cell
 * names, and destination folders when ingesting a dropped sheet.
 */

const fs = require("fs");
const path = require("path");

const NEEDS_PATH = path.resolve(__dirname, "..", "..", "studio", "lib", "assetNeeds.json");

let cached = null;

function loadNeeds() {
  if (!cached) {
    const raw = JSON.parse(fs.readFileSync(NEEDS_PATH, "utf8"));
    cached = Array.isArray(raw.needs) ? raw.needs : [];
  }
  return cached;
}

function getNeed(id) {
  return loadNeeds().find((need) => need.id === id) || null;
}

function clampFrames(need, frames) {
  const param = need.frameParam;
  if (!param) return frames;
  const n = Math.floor(Number(frames));
  if (!Number.isFinite(n)) return param.default;
  return Math.min(param.max, Math.max(param.min, n));
}

function expandNeed(need, frames) {
  const key = need.key !== false;
  if (!need.frameParam) {
    const cells = need.cells || [];
    return {
      id: need.id,
      label: need.label,
      split: need.split || (need.grid ? "grid" : "components"),
      grid: need.grid || null,
      key,
      cells,
      cycles: null,
    };
  }

  const n = clampFrames(need, frames != null ? frames : need.frameParam.default);
  const views = need.frameParam.views || [];
  const cells = [];
  const cycles = {};
  const fps = need.cycleFps || 12;
  const dest = need.dest || { kind: "slot", slot: "body", drawings_dir: "body" };

  for (const view of views) {
    const drawings = [];
    const cycleName = `walk_${view}`;
    for (let i = 1; i <= n; i += 1) {
      const name = `${cycleName}_${String(i).padStart(2, "0")}`;
      drawings.push(name);
      cells.push({ name, dest, cycle: cycleName });
    }
    cycles[cycleName] = { drawings, fps };
  }

  return {
    id: need.id,
    label: need.label,
    split: "grid",
    grid: { cols: n, rows: views.length },
    key,
    cells,
    cycles,
  };
}

module.exports = {
  NEEDS_PATH,
  loadNeeds,
  getNeed,
  clampFrames,
  expandNeed,
};
