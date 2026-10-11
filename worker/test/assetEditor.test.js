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
  promoteSlotView,
  confirmReplace,
  confirmAdd,
  renameDrawing,
  deleteDrawing,
  saveDrawingFlags,
  realignSlotView,
  pickAlignReferenceName,
  flipDrawing,
  restoreReplacedDrawing,
  listLipsyncPreview,
  missingMouthShapes,
  rhubarbShapeOf,
} = require("../src/assetEditor");
const { encodeRgbaPng, decodePng } = require("../src/pngFlip");

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

  test("default mouth view is mouth_front when that folder exists, and promote points the slot at it", () => {
    writePng(path.join(deeDir, "mouth_front", "X.png"));
    writePng(path.join(deeDir, "mouth_front", "A.png"));
    const slot = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.equal(slot.view, "front");
    assert.equal(slot.drawingsDir, "mouth_front");
    assert.equal(slot.isDefaultView, false);
    assert.equal(slot.defaultDrawingsDir, "mouth");
    assert.equal(slot.canRealign, true);

    const promoted = promoteSlotView(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", { view: "front" });
    assert.equal(promoted.drawingsDir, "mouth_front");
    assert.equal(promoted.alreadyDefault, false);
    const after = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.equal(after.drawingsDir, "mouth_front");
    assert.equal(after.isDefaultView, true);
    assert.equal(after.defaultDrawingsDir, "mouth_front");
    const character = JSON.parse(fs.readFileSync(path.join(deeDir, "character.json"), "utf8"));
    character.slots.mouth.drawings_dir = "mouth";
    fs.writeFileSync(path.join(deeDir, "character.json"), JSON.stringify(character, null, 2) + "\n");
    fs.rmSync(path.join(deeDir, "mouth_front"), { recursive: true, force: true });
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

  test("flip horizontally writes a mirror, keeps the original in _replaced, and restore undoes it", () => {
    const redBlue = encodeRgbaPng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]));
    writePng(path.join(deeDir, "mouth", "extra.png"), redBlue);
    const flipped = flipDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "extra", {});
    assert.ok(flipped.replaced && flipped.replaced.includes("_replaced/"));
    assert.ok(fs.existsSync(path.join(fixture.projectDir, flipped.replaced)));
    const after = decodePng(fs.readFileSync(path.join(deeDir, "mouth", "extra.png")));
    assert.equal(after.pixels[0], 0);
    assert.equal(after.pixels[4], 255);
    const restored = restoreReplacedDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "extra", {
      replaced: flipped.replaced,
    });
    assert.equal(restored.ok, true);
    const back = decodePng(fs.readFileSync(path.join(deeDir, "mouth", "extra.png")));
    assert.equal(back.pixels[0], 255);
    assert.equal(back.pixels[4], 0);
  });

  test("pickAlignReferenceName prefers default_drawing then X", () => {
    const scan = new Map([
      ["C", { absPath: "C.png" }],
      ["X", { absPath: "X.png" }],
      ["A", { absPath: "A.png" }],
    ]);
    assert.equal(pickAlignReferenceName({ default_drawing: "A" }, scan, scan), "A");
    assert.equal(pickAlignReferenceName({}, scan, scan), "X");
    assert.equal(pickAlignReferenceName({}, new Map([["C", {}]]), new Map()), "C");
  });

  test("per-drawing align persists on Save and reloads on the slot payload", () => {
    const saved = saveDrawingFlags(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "A", {
      align: { x: 6, y: -3, scale: 1.4 },
    });
    assert.deepEqual(saved.align, { x: 6, y: -3, scale: 1.4 });
    const slot = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.deepEqual(slot.drawings.find((d) => d.name === "A").align, { x: 6, y: -3, scale: 1.4 });
    assert.equal(slot.alignReferenceDrawing, "X");
    const json = JSON.parse(fs.readFileSync(path.join(deeDir, "character.json"), "utf8"));
    assert.deepEqual(json.slots.mouth.drawings.A.align, { x: 6, y: -3, scale: 1.4 });
  });

  test("L/R hand tag persists per drawing", () => {
    const saved = saveDrawingFlags(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "extra", { hand: "L" });
    assert.equal(saved.hand, "L");
    const slot = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    assert.equal(slot.drawings.find((d) => d.name === "extra").hand, "L");
    const cleared = saveDrawingFlags(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "extra", { hand: null });
    assert.equal(cleared.hand, null);
  });

  test("exclude from lip sync persists per drawing and follows rename", () => {
    writePng(path.join(deeDir, "mouth", "H.png"));
    const saved = saveDrawingFlags(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "H", {
      excludeFromLipSync: true,
    });
    assert.equal(saved.excludeFromLipSync, true);
    const slot = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth");
    const h = slot.drawings.find((d) => d.name === "H");
    assert.equal(h.excludeFromLipSync, true);
    const json = JSON.parse(fs.readFileSync(path.join(deeDir, "character.json"), "utf8"));
    assert.equal(json.slots.mouth.drawings.H.excludeFromLipSync, true);
    const renamed = renameDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "H", { name: "H2" });
    assert.equal(renamed.drawing, "H2");
    const after = JSON.parse(fs.readFileSync(path.join(deeDir, "character.json"), "utf8"));
    assert.equal(after.slots.mouth.drawings.H2.excludeFromLipSync, true);
    assert.equal(after.slots.mouth.drawings.H, undefined);
    renameDrawing(fixture.projectDir, fixture.globalAssetsDir, "dee", "mouth", "H2", { name: "H" });
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

  test("apply-all normalises every drawing to the default and does not compound", async () => {
    const rodneyDir = path.join(fixture.projectDir, "characters", "rodney");
    function headPng(w, h, x0, y0, x1, y1) {
      const rgba = Buffer.alloc(w * h * 4);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * w + x) * 4;
          rgba[i] = 30;
          rgba[i + 1] = 40;
          rgba[i + 2] = 200;
          rgba[i + 3] = 255;
        }
      }
      return encodeRgbaPng(w, h, rgba);
    }
    fs.mkdirSync(path.join(rodneyDir, "mouth"), { recursive: true });
    writePng(path.join(rodneyDir, "body.png"));
    writePng(path.join(rodneyDir, "mouth", "X.png"), headPng(200, 220, 70, 20, 130, 180));
    writePng(path.join(rodneyDir, "mouth", "A.png"), headPng(80, 90, 20, 10, 60, 70));
    writePng(path.join(rodneyDir, "mouth", "C.png"), headPng(40, 50, 8, 6, 32, 36));
    fixture.writeJson(path.join(rodneyDir, "character.json"), {
      id: "rodney",
      display_name: "Rodney",
      aliases: ["Rodney"],
      asset: "body.png",
      z: 8,
      slots: { mouth: { offset: { x: 0, y: -12 }, drawings_dir: "mouth" } },
      children: [],
    });
    const first = await realignSlotView(fixture.projectDir, fixture.globalAssetsDir, "rodney", "mouth", {
      normalize: true,
    });
    assert.equal(first.normalize, true);
    assert.equal(first.referenceDrawing, "X");
    assert.ok(first.written.some((item) => item.name === "A"));
    assert.ok(first.written.some((item) => item.name === "C"));
    const afterA = decodePng(fs.readFileSync(path.join(rodneyDir, "mouth", "A.png")));
    const afterC = decodePng(fs.readFileSync(path.join(rodneyDir, "mouth", "C.png")));
    const ref = decodePng(fs.readFileSync(path.join(rodneyDir, "mouth", "X.png")));
    assert.equal(afterA.width, ref.width);
    assert.equal(afterA.height, ref.height);
    assert.equal(afterC.width, ref.width);
    assert.equal(afterC.height, ref.height);
    function headHeight(filePath) {
      const png = decodePng(fs.readFileSync(filePath));
      let y0 = png.height;
      let y1 = 0;
      for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
          if (png.pixels[(y * png.width + x) * png.bpp + (png.bpp - 1)] > 16) {
            if (y < y0) y0 = y;
            if (y + 1 > y1) y1 = y + 1;
          }
        }
      }
      return y1 - y0;
    }
    const heightA = headHeight(path.join(rodneyDir, "mouth", "A.png"));
    const heightC = headHeight(path.join(rodneyDir, "mouth", "C.png"));
    const heightX = headHeight(path.join(rodneyDir, "mouth", "X.png"));
    assert.ok(Math.abs(heightA - heightX) <= 6, `A head ${heightA} vs X ${heightX}`);
    assert.ok(Math.abs(heightC - heightX) <= 6, `C head ${heightC} vs X ${heightX}`);
    const hashA = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(rodneyDir, "mouth", "A.png"))).digest("hex");
    const hashC = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(rodneyDir, "mouth", "C.png"))).digest("hex");
    const second = await realignSlotView(fixture.projectDir, fixture.globalAssetsDir, "rodney", "mouth", {
      normalize: true,
    });
    assert.equal(second.written.length, first.written.length);
    assert.ok(second.written.every((item) => item.unchanged));
    assert.equal(
      require("crypto").createHash("sha256").update(fs.readFileSync(path.join(rodneyDir, "mouth", "A.png"))).digest("hex"),
      hashA
    );
    assert.equal(
      require("crypto").createHash("sha256").update(fs.readFileSync(path.join(rodneyDir, "mouth", "C.png"))).digest("hex"),
      hashC
    );
    assert.equal(headHeight(path.join(rodneyDir, "mouth", "A.png")), heightA);
    assert.equal(headHeight(path.join(rodneyDir, "mouth", "C.png")), heightC);
    const json = JSON.parse(fs.readFileSync(path.join(rodneyDir, "character.json"), "utf8"));
    assert.deepEqual(json.slots.mouth.drawings.A.align, { x: 0, y: 0, scale: 1 });
    assert.deepEqual(json.slots.mouth.drawings.C.align, { x: 0, y: 0, scale: 1 });
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

  test("deleted local drawing does not reappear from the shared library", () => {
    const localA = path.join(fixture.projectDir, "characters", "alice", "mouth", "A.png");
    writePng(localA);
    const before = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "alice", "mouth");
    assert.ok(before.drawings.some((d) => d.name === "A" && d.source === "project"));
    deleteDrawing(fixture.projectDir, fixture.globalAssetsDir, "alice", "mouth", "A", {
      confirm: true,
      force: true,
    });
    const after = describeSlot(fixture.projectDir, fixture.globalAssetsDir, "alice", "mouth");
    assert.equal(after.drawings.some((d) => d.name === "A"), false);
    assert.equal(fs.existsSync(path.join(fixture.globalAssetsDir, "characters", "alice", "mouth", "A.png")), true);
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
  fs.writeFileSync(
    path.join(episodeDir, "characters", "alice", "character.json"),
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
  fs.writeFileSync(path.join(episodeDir, "script.txt"), "[Scene: Intro]\n[Cast: Alice]\n");

  test("Studio lists only project-local drawings", () => {
    const slot = describeSlot(episodeDir, globalAssetsDir, "alice", "mouth");
    const byName = Object.fromEntries(slot.drawings.map((drawing) => [drawing.name, drawing]));
    assert.equal(byName.A.source, "project");
    assert.equal(byName.B, undefined);
    assert.equal(byName.C, undefined);
    assert.equal(
      slot.views.some((view) => view.id === "left_side"),
      false,
      "show-only view folders stay off the Studio grid"
    );
    assert.throws(
      () => describeDrawing(episodeDir, globalAssetsDir, "alice", "mouth", "B"),
      /Unknown drawing/
    );
  });
});
