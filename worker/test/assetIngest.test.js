"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { destRelForCell, ensureSlot, uniqueWriteTarget, mergeCycles, confirmIngest, previewDir } = require("../src/assetIngest");
const { getNeed, expandNeed } = require("../src/assetNeeds");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { encodeRgbaPng, decodePng } = require("../src/pngFlip");

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

  test("front head ingest writes mouth_front and points the existing mouth slot at it", () => {
    const need = getNeed("mouth_13_front");
    assert.ok(need);
    const expanded = expandNeed(need);
    assert.equal(destRelForCell("rodney", expanded.cells[0].dest, "X"), "characters/rodney/mouth_front/X.png");
    const character = {
      id: "rodney",
      slots: { mouth: { drawings_dir: "mouth" } },
      children: [],
    };
    ensureSlot(character, expanded.cells[0].dest);
    assert.equal(character.slots.mouth.drawings_dir, "mouth_front");
  });

  test("unique write target suffixes _b then _c when the dest already exists", () => {
    const fixture = createFixtureLibrary();
    const dest = { kind: "slot", slot: "mouth", drawings_dir: "mouth" };
    const first = uniqueWriteTarget(fixture.projectDir, fixture.globalAssetsDir, "alice", dest, "X", new Set());
    assert.equal(first.name, "X_b");
    assert.equal(first.rel, "characters/alice/mouth/X_b.png");
    const second = uniqueWriteTarget(
      fixture.projectDir,
      fixture.globalAssetsDir,
      "alice",
      dest,
      "X",
      new Set([first.rel])
    );
    assert.equal(second.name, "X_c");
    assert.equal(second.rel, "characters/alice/mouth/X_c.png");
    fixture.cleanup();
  });

  test("mergeCycles appends new drawings instead of replacing the list", () => {
    const spec = { cycles: { walk_side: { drawings: ["walk_side_01"], fps: 12 } } };
    mergeCycles(spec, { walk_side: { drawings: ["walk_side_01_b"], fps: 12 } });
    assert.deepEqual(spec.cycles.walk_side.drawings, ["walk_side_01", "walk_side_01_b"]);
  });

  test("confirm ingest adds a second sheet without overwriting, and flipAll mirrors pixels", () => {
    const fixture = createFixtureLibrary();
    const dest = { kind: "slot", slot: "mouth", drawings_dir: "mouth" };
    const redBlue = encodeRgbaPng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]));
    const mouthDir = path.join(fixture.projectDir, "characters", "alice", "mouth");
    fs.mkdirSync(mouthDir, { recursive: true });
    fs.writeFileSync(path.join(mouthDir, "X.png"), redBlue);

    function writeSession(sid, flipSource) {
      const cellsDir = path.join(previewDir(fixture.projectDir, "alice", sid), "cells");
      fs.mkdirSync(cellsDir, { recursive: true });
      const cellPath = path.join(cellsDir, "00.png");
      fs.writeFileSync(cellPath, flipSource);
      fs.writeFileSync(
        path.join(previewDir(fixture.projectDir, "alice", sid), "manifest.json"),
        JSON.stringify({
          sessionId: sid,
          characterId: "alice",
          needId: "mouth_sheet",
          cells: [{ index: 0, suggestedName: "X", dest, empty: false, path: cellPath }],
        })
      );
    }

    writeSession("addsheet1", redBlue);
    const first = confirmIngest(fixture.projectDir, fixture.globalAssetsDir, "alice", {
      sessionId: "addsheet1",
      assignments: [{ index: 0, name: "X" }],
    });
    assert.equal(first.written[0].name, "X_b");
    assert.ok(fs.existsSync(path.join(mouthDir, "X.png")));
    assert.ok(fs.existsSync(path.join(mouthDir, "X_b.png")));

    writeSession("addsheet2", redBlue);
    const second = confirmIngest(fixture.projectDir, fixture.globalAssetsDir, "alice", {
      sessionId: "addsheet2",
      assignments: [{ index: 0, name: "X" }],
      flipAll: true,
    });
    assert.equal(second.written[0].name, "X_c");
    const original = decodePng(fs.readFileSync(path.join(mouthDir, "X.png")));
    assert.equal(original.pixels[0], 255);
    const flipped = decodePng(fs.readFileSync(path.join(mouthDir, "X_c.png")));
    assert.equal(flipped.pixels[0], 0);
    assert.equal(flipped.pixels[4], 255);
    fixture.cleanup();
  });
});
