"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { destRelForCell, ensureSlot } = require("../src/assetIngest");
const { getNeed, expandNeed } = require("../src/assetNeeds");

describe("asset ingest helpers", () => {
  test("mouth sheet expands to X then A–H on a 3x3 grid", () => {
    const need = getNeed("mouth_sheet");
    assert.ok(need);
    const expanded = expandNeed(need);
    assert.deepEqual(expanded.grid, { cols: 3, rows: 3 });
    assert.deepEqual(
      expanded.cells.map((c) => c.name),
      ["X", "A", "B", "C", "D", "E", "F", "G", "H"]
    );
    assert.equal(
      destRelForCell("alice", expanded.cells[0].dest, "X"),
      "characters/alice/mouth/X.png"
    );
  });

  test("walk cycle names frames and cycles without clobbering other slots", () => {
    const need = getNeed("walk_cycle");
    const expanded = expandNeed(need, 2);
    assert.deepEqual(expanded.grid, { cols: 2, rows: 3 });
    assert.deepEqual(expanded.cycles.walk_side.drawings, ["walk_side_01", "walk_side_02"]);
    assert.equal(expanded.cells.length, 6);

    const character = {
      id: "alice",
      slots: {
        mouth: { drawings_dir: "mouth" },
      },
      children: [],
    };
    ensureSlot(character, expanded.cells[0].dest);
    assert.ok(character.slots.mouth, "existing mouth slot stays");
    assert.equal(character.slots.body.drawings_dir, "body");
  });
});
