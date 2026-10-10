"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { getNeed } = require("../src/assetNeeds");
const { fillPackPrompt, getPack, packForCharacter, packSetToNeed } = require("../src/promptPacks");
const { destRelForCell } = require("../src/assetIngest");

describe("Rodney prompt pack", () => {
  test("loads a character-parametric style block and the ten production sets", () => {
    const pack = getPack("rodney");
    assert.ok(pack);
    assert.match(pack.styleBlock, /crimson felt fedora/i);
    assert.ok(packForCharacter({ id: "rodney", display_name: "Rodney" }));
    assert.equal(packForCharacter({ id: "alice", display_name: "Alice" }), null);

    const ids = pack.sets.map((set) => set.id);
    for (const id of [
      "body_armless",
      "mouth_sheet",
      "comedy_expressions",
      "eyes",
      "hands_to_face",
      "right_arm_poses",
      "left_arm_mic",
      "head_turns",
      "body_turns",
      "walk_cycles",
      "speaker_prop",
      "speaker_slapstick",
    ]) {
      assert.ok(ids.includes(id), `missing set ${id}`);
    }

    const mouths = pack.sets.find((set) => set.id === "mouth_sheet");
    const prompt = fillPackPrompt(mouths, { styleBlock: pack.styleBlock, name: "Rodney" });
    assert.match(prompt, /crimson felt fedora/);
    assert.match(prompt, /Rodney/);
    assert.match(prompt, /X relaxed smirk/);
    assert.doesNotMatch(prompt, /{{styleBlock}}/);
    assert.match(prompt, /never slanted eyes/i);

    for (const view of ["front", "left_34", "left_side", "right_34", "right_side", "up", "down"]) {
      const sheet = pack.sets.find((set) => set.id === `mouth_13_${view}`);
      assert.ok(sheet, `missing 13-mouth set for ${view}`);
      const filled = fillPackPrompt(sheet, { styleBlock: pack.styleBlock, name: "Rodney" });
      assert.match(filled, /crimson felt fedora/);
      assert.match(filled, /B_loud/);
      assert.match(filled, /never slanted eyes/i);
      assert.equal(sheet.cells.filter((cell) => cell.name && cell.name !== "empty" && cell.name !== "empty2").length, 13);
    }
  });

  test("pack sets resolve to ingest destinations and never request a mocking eye gesture", () => {
    const eyes = getNeed("eyes");
    assert.ok(eyes);
    assert.equal(destRelForCell("rodney", eyes.cells[0].dest, "wide"), "characters/rodney/eyes/wide.png");

    const walk = getNeed("walk_cycles");
    assert.deepEqual(walk.grid, { cols: 8, rows: 3 });
    assert.equal(walk.cycles.walk_side.drawings.length, 8);
    assert.equal(walk.cycles.walk_front.drawings.length, 4);

    const blob = JSON.stringify(getPack("rodney"));
    assert.match(blob, /never slanted eyes/i);
    assert.doesNotMatch(blob, /slanted-eyes pose|mock asian|chinky/i);
    assert.equal(packSetToNeed(walk).cells.length, 24);
  });
});
