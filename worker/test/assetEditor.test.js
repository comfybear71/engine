"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createFixtureLibrary, TRANSPARENT_PNG_1X1 } = require("./helpers/fixtureLibrary");
const { previewDir } = require("../src/assetIngest");
const {
  describeSlot,
  describeDrawing,
  findDrawingUsages,
  confirmReplace,
  confirmAdd,
  renameDrawing,
  deleteDrawing,
  listLipsyncPreview,
  missingMouthShapes,
  rhubarbShapeOf,
} = require("../src/assetEditor");

function writePng(filePath, buf = TRANSPARENT_PNG_1X1) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

describe("asset editor", { concurrency: 1 }, () => {
  const fixture = createFixtureLibrary();
  const deeDir = path.join(fixture.projectDir, "characters", "dee");
  writePng(path.join(deeDir, "body.png"));
  writePng(path.join(deeDir, "mouth", "X.png"));
  writePng(path.join(deeDir, "mouth", "A.png"));
  writePng(path.join(deeDir, "mouth", "B.png"));
  writePng(path.join(deeDir, "mouth", "extra.png"));
  writePng(path.join(deeDir, "mouth_left_side", "X.png"));
  writePng(path.join(deeDir, "eyes", "open.png"));
  fixture.writeJson(path.join(deeDir, "character.json"), {
    id: "dee",
    display_name: "Dee",
    aliases: ["Dee"],
    asset: "body.png",
    z: 8,
    slots: {
      mouth: { offset: { x: 0, y: -12 }, drawings_dir: "mouth", scale: 1.1 },
      eyes: {
        offset: { x: 0, y: -20 },
        drawings_dir: "eyes",
        default_drawing: "open",
        cycles: { blink: { drawings: ["open", "extra"], fps: 6 } },
      },
    },
    children: [],
  });
  writePng(path.join(deeDir, "eyes", "extra.png"));
  fixture.writeScript(
    [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Dee]",
      "Dee: Hello friend.",
      "[Action: Dee eyes=open]",
    ].join("\n")
  );

  test("mouth labels and missing shapes", () => {
    assert.equal(rhubarbShapeOf("A_loud"), "A");
    assert.deepEqual(missingMouthShapes([{ name: "X" }, { name: "A" }]), ["B", "C", "D", "E", "F", "G", "H"]);
  });

  test("describeSlot lists drawings, view folders, duplicates, and missing shapes", () => {
    const slot = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.equal(slot.mouth, true);
    assert.equal(slot.offset.y, -12);
    assert.equal(slot.scale, 1.1);
    assert.ok(slot.views.some((view) => view.id === "left_side"));
    assert.deepEqual(slot.missingShapes, ["C", "D", "E", "F", "G", "H"]);
    const names = slot.drawings.map((d) => d.name).sort();
    assert.deepEqual(names, ["A", "B", "X", "extra"]);
    const a = slot.drawings.find((d) => d.name === "A");
    const b = slot.drawings.find((d) => d.name === "B");
    assert.equal(a.duplicateOf, "B");
    assert.equal(b.duplicateOf, "A");
    const side = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "left_side");
    assert.equal(side.view, "left_side");
    assert.deepEqual(
      side.drawings.map((d) => d.name),
      ["X"]
    );
  });

  test("describeDrawing includes script and cycle usage", () => {
    const mouthA = describeDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "A");
    assert.equal(mouthA.drawing.width, 1);
    assert.equal(mouthA.drawing.height, 1);
    assert.ok(mouthA.usages.some((u) => u.kind === "dialogue" && u.script === "script.txt"));
    const extra = findDrawingUsages(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes", "extra");
    assert.ok(extra.some((u) => u.kind === "cycle" && u.cycle === "blink"));
    const open = findDrawingUsages(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes", "open");
    assert.ok(open.some((u) => u.kind === "action" && /eyes=open/.test(u.text)));
  });

  test("replace confirm keeps the old file in _replaced and never deletes it", () => {
    const sid = "replacetest1";
    const cellsDir = path.join(previewDir(fixture.projectDir, "dee", sid), "cells");
    writePng(path.join(cellsDir, "00.png"));
    fs.writeFileSync(
      path.join(previewDir(fixture.projectDir, "dee", sid), "manifest.json"),
      JSON.stringify({
        kind: "replace",
        sessionId: sid,
        characterId: "dee",
        slot: "mouth",
        drawing: "extra",
        view: "front",
        drawingsDir: "mouth",
        destRel: "characters/dee/mouth/extra.png",
        cellPath: path.join(cellsDir, "00.png"),
      })
    );
    const before = fs.readFileSync(path.join(deeDir, "mouth", "extra.png"));
    const result = confirmReplace(fixture.projectDir, fixture.globalAssetsDir, "dee", { sessionId: sid });
    assert.equal(result.ok, true);
    assert.ok(result.replaced.includes("_replaced/"));
    assert.ok(fs.existsSync(path.join(fixture.projectDir, result.replaced)));
    assert.deepEqual(fs.readFileSync(path.join(fixture.projectDir, result.replaced)), before);
    assert.ok(fs.existsSync(path.join(deeDir, "mouth", "extra.png")));
    assert.equal(fs.existsSync(previewDir(fixture.projectDir, "dee", sid)), false);
  });

  test("add confirm writes the named drawing into the slot folder", () => {
    const sid = "addtest1";
    const cellsDir = path.join(previewDir(fixture.projectDir, "dee", sid), "cells");
    writePng(path.join(cellsDir, "00.png"));
    fs.writeFileSync(
      path.join(previewDir(fixture.projectDir, "dee", sid), "manifest.json"),
      JSON.stringify({
        kind: "add",
        sessionId: sid,
        characterId: "dee",
        slot: "mouth",
        name: "C",
        view: "front",
        drawingsDir: "mouth",
        cellPath: path.join(cellsDir, "00.png"),
      })
    );
    const result = confirmAdd(fixture.projectDir, fixture.globalAssetsDir, "dee", { sessionId: sid, name: "C" });
    assert.equal(result.drawing, "C");
    assert.ok(fs.existsSync(path.join(deeDir, "mouth", "C.png")));
  });

  test("rename updates cycle lists in the project-local character.json", () => {
    const result = renameDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes", "extra", {
      name: "wink",
    });
    assert.equal(result.drawing, "wink");
    const json = JSON.parse(fs.readFileSync(path.join(deeDir, "character.json"), "utf8"));
    assert.deepEqual(json.slots.eyes.cycles.blink.drawings, ["open", "wink"]);
    assert.ok(fs.existsSync(path.join(deeDir, "eyes", "wink.png")));
    assert.equal(fs.existsSync(path.join(deeDir, "eyes", "extra.png")), false);
  });

  test("delete refuses a script-used drawing, then moves an unused one to _trash", () => {
    assert.throws(
      () =>
        deleteDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes", "open", { confirm: true }),
      (err) => err.code === "EUSED" && Array.isArray(err.usages) && err.usages.some((u) => u.script)
    );
    writePng(path.join(deeDir, "eyes", "spare.png"));
    const result = deleteDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes", "spare", {
      confirm: true,
    });
    assert.ok(result.trash.includes("_trash/"));
    assert.ok(fs.existsSync(path.join(fixture.projectDir, result.trash)));
    assert.equal(fs.existsSync(path.join(deeDir, "eyes", "spare.png")), false);
  });

  test("rejects path-unsafe slot, drawing, and view names", () => {
    assert.throws(() => describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "../mouth"), /Invalid slot/);
    assert.throws(
      () => describeDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "../X"),
      /Invalid drawing/
    );
    assert.throws(
      () => describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "../front"),
      /Invalid view/
    );
    assert.throws(
      () =>
        renameDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "X", { name: "..hidden" }),
      /Invalid drawing/
    );
  });

  test("lipsync preview returns builtin samples for a mouth slot", () => {
    const preview = listLipsyncPreview(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.ok(preview.samples.some((sample) => sample.id === "builtin:hello"));
    assert.ok(preview.samples[0].cues.length > 0);
    assert.throws(
      () => listLipsyncPreview(fixture.projectDir, fixture.globalAssetsDir, "dee", "eyes"),
      /mouth slots/
    );
  });

  test("refuses to delete a shared-library drawing", () => {
    assert.throws(
      () =>
        deleteDrawing(fixture.projectDir, fixture.globalAssetsDir, "alice", "mouth", "A", { confirm: true }),
      /shared library/
    );
  });
});

describe("asset editor episode/show/global paths", { concurrency: 1 }, () => {
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "engine-asset-editor-show-"));
  const globalAssetsDir = path.join(tmp, "_global_assets");
  const showDir = path.join(tmp, "shows", "sunny");
  const episodeDir = path.join(showDir, "episodes", "pilot");
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(path.join(globalAssetsDir, "characters", "alice", "mouth"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "characters", "alice", "mouth_left_side"), { recursive: true });
  fs.mkdirSync(path.join(episodeDir, "characters", "alice", "mouth"), { recursive: true });
  fs.writeFileSync(path.join(showDir, "show.json"), JSON.stringify({ name: "Sunny" }));
  fs.writeFileSync(
    path.join(globalAssetsDir, "characters", "alice", "character.json"),
    JSON.stringify({
      id: "alice",
      display_name: "Alice",
      aliases: ["Alice"],
      asset: "body.png",
      z: 10,
      slots: { mouth: { offset: { x: 0, y: -10 }, drawings_dir: "mouth" } },
      children: [],
    })
  );
  writePng(path.join(globalAssetsDir, "characters", "alice", "mouth", "X.png"));
  writePng(path.join(globalAssetsDir, "characters", "alice", "mouth", "C.png"));
  writePng(path.join(showDir, "characters", "alice", "mouth", "B.png"));
  writePng(path.join(showDir, "characters", "alice", "mouth_left_side", "X.png"));
  writePng(path.join(episodeDir, "characters", "alice", "mouth", "A.png"));
  fs.writeFileSync(path.join(episodeDir, "script.txt"), "[Scene: Intro]\n[Cast: Alice]\n");

  test("lists episode, show, and global drawings and show view folders", () => {
    const slot = describeSlot(episodeDir, globalAssetsDir, "alice", "mouth");
    const byName = Object.fromEntries(slot.drawings.map((drawing) => [drawing.name, drawing]));
    assert.equal(byName.A.source, "project");
    assert.equal(byName.B.source, "show");
    assert.equal(byName.C.source, "global");
    assert.ok(slot.views.some((view) => view.id === "left_side"));
    const side = describeSlot(episodeDir, globalAssetsDir, "alice", "mouth", "left_side");
    assert.equal(side.view, "left_side");
    assert.equal(side.drawings[0].source, "show");
    const drawing = describeDrawing(episodeDir, globalAssetsDir, "alice", "mouth", "B");
    assert.equal(drawing.drawing.source, "show");
  });
});
