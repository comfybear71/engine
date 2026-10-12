"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const {
  expectedDrawings,
  statusKey,
  parseStatusKey,
  drawingBadge,
  viewTabLabel,
  normalizeView,
  standardForSlot,
  candidateDrawingsDirs,
  childRowLabel,
} = require("../src/factoryStandard");
const {
  readStatus,
  setDrawingState,
  setRedoNote,
  applyStatusBody,
  describeFactoryCharacter,
  inspectorForPiece,
  listProjectActions,
  REDOS_KEY,
} = require("../src/characterStatus");

describe("factory standard catalog", () => {
  test("factory views and tab labels match the Assets mockup", () => {
    assert.equal(normalizeView("LEFT_34"), "left_34");
    assert.equal(viewTabLabel("front"), "Front");
    assert.equal(viewTabLabel("left_34"), "L 3/4");
    assert.equal(viewTabLabel("right_34"), "R 3/4");
    assert.equal(viewTabLabel("left_side"), "Side L");
    assert.equal(viewTabLabel("right_side"), "Side R");
    assert.equal(viewTabLabel("back"), "Back");
  });

  test("expected drawings follow the standard rig, including optional eyes", () => {
    assert.deepEqual(expectedDrawings("head_base", "front"), ["neutral"]);
    assert.deepEqual(expectedDrawings("eyes", "front"), [
      "open",
      "half",
      "closed",
      "surprised",
      "look_left",
      "look_right",
      "down",
    ]);
    assert.deepEqual(expectedDrawings("mouth", "left_34"), ["A", "B", "C", "D", "E", "F", "G", "H", "X"]);
    assert.deepEqual(expectedDrawings("eyes", "back"), []);
    assert.deepEqual(expectedDrawings("legs", "front"), [
      "none",
      "L_forward",
      "R_forward",
      "passing",
      "lift_screenL",
      "lift_screenR",
    ]);
    assert.deepEqual(expectedDrawings("legs", "left_34"), []);
    assert.equal(standardForSlot("right_hand").label, "Hands");
    assert.deepEqual(candidateDrawingsDirs("eyes", "front", "eyes"), ["eyes", "eyes_front"]);
    assert.deepEqual(candidateDrawingsDirs("mouth", "left_34", "mouth"), ["mouth_left_34"]);
  });

  test("status keys are slot/drawing and missing is computed, not stored", () => {
    assert.equal(statusKey("eyes_front", "surprised"), "eyes_front/surprised");
    assert.deepEqual(parseStatusKey("eyes_front/surprised"), { slot: "eyes_front", drawing: "surprised" });
    assert.equal(drawingBadge({ "eyes_front/surprised": "ticked" }, "eyes_front/surprised", true, true), "ticked");
    assert.equal(drawingBadge({}, "eyes_front/half", false, true), "missing");
    assert.equal(drawingBadge({}, "eyes_front/open", true, true), "draft");
  });

  test("shirt and shorts overlays sit under Torso, not Arm rig", () => {
    assert.equal(childRowLabel({ id: "shirt_overlay", asset: "parts/shirt.png" }), "Torso");
    assert.equal(childRowLabel({ id: "shorts", asset: "overlays/shorts.png" }), "Torso");
    assert.equal(childRowLabel({ id: "torso_rig", asset: "parts/torso_rig.png" }), "Torso");
    assert.equal(childRowLabel({ id: "body", asset: "body.png" }), "Torso");
    assert.equal(childRowLabel({ id: "arm_upper_L", asset: "parts/arm_upper.png" }), "Arm rig L");
  });
});

describe("character status.json", () => {
  const fixture = createFixtureLibrary();
  const rodneyDir = path.join(fixture.projectDir, "characters", "rodney");

  fixture.writePng(path.join(rodneyDir, "blank.png"));
  fixture.writePng(path.join(rodneyDir, "head_base", "neutral.png"));
  fixture.writePng(path.join(rodneyDir, "eyes_front", "open.png"));
  fixture.writePng(path.join(rodneyDir, "eyes_front", "surprised.png"));
  fixture.writePng(path.join(rodneyDir, "mouth_front", "X.png"));
  fixture.writePng(path.join(rodneyDir, "mouth_front", "A.png"));
  fixture.writePng(path.join(rodneyDir, "parts", "arm_upper.png"));
  fixture.writeJson(path.join(rodneyDir, "character.json"), {
    id: "rodney",
    display_name: "Rodney",
    aliases: ["Rodney"],
    asset: "blank.png",
    z: 10,
    default_scale: 1.66,
    groups: { head: ["head_base", "eyes", "mouth"] },
    slots: {
      head_base: {
        offset: { x: 0, y: -200 },
        drawings_dir: "head_base",
        default_drawing: "neutral",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
      eyes: {
        offset: { x: 0, y: -200 },
        drawings_dir: "eyes",
        default_drawing: "open",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
      mouth: {
        offset: { x: 0, y: -200 },
        drawings_dir: "mouth",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
    },
    children: [
      {
        id: "arm_upper_L",
        asset: "parts/arm_upper.png",
        z: 1,
        offset: { x: 10, y: -20 },
        pivot: { x: 582, y: 546 },
      },
    ],
  });
  fixture.writeJson(path.join(fixture.projectDir, "characters", "alice", "actions", "walk_side.json"), {
    id: "walk_side",
    fps: 12,
    frames: 8,
    view: "right_side",
  });
  fixture.writeJson(path.join(fixture.globalAssetsDir, "actions", "blink.json"), {
    id: "blink",
    fps: 12,
    frames: 4,
  });

  after(() => fixture.cleanup());

  test("Approve writes ticked and Redo stores a note in status.json", () => {
    setDrawingState(fixture.projectDir, "rodney", "eyes_front/surprised", "ticked");
    setRedoNote(fixture.projectDir, "rodney", "eyes_front/open", "wider lids");
    const abs = path.join(rodneyDir, "status.json");
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    assert.equal(raw["eyes_front/surprised"], "ticked");
    assert.equal(raw["eyes_front/open"], "draft");
    assert.equal(raw[REDOS_KEY]["eyes_front/open"], "wider lids");
    const loaded = readStatus(fixture.projectDir, "rodney");
    assert.equal(loaded.drawings["eyes_front/surprised"], "ticked");
    assert.equal(loaded.redos["eyes_front/open"], "wider lids");
  });

  test("factory view rows use real files and mark standard gaps missing", () => {
    const factory = describeFactoryCharacter(fixture.projectDir, fixture.globalAssetsDir, "rodney", "front");
    assert.equal(factory.displayName, "Rodney");
    assert.equal(factory.default_scale, 1.66);
    assert.equal(factory.canvas.w, 1024);
    assert.equal(factory.canvas.pivot.x, 509);
    const eyes = factory.rows.find((row) => row.slot === "eyes");
    assert.ok(eyes);
    const byName = Object.fromEntries(eyes.drawings.map((d) => [d.name, d]));
    assert.equal(byName.open.rel, "characters/rodney/eyes_front/open.png");
    assert.equal(byName.open.badge, "draft");
    assert.equal(byName.surprised.badge, "ticked");
    assert.equal(byName.half.missing, true);
    assert.equal(byName.half.badge, "missing");
    assert.equal(byName.half.rel, null);
    const mouth = factory.rows.find((row) => row.slot === "mouth");
    assert.ok(mouth.drawings.some((d) => d.name === "B" && d.missing));
    assert.ok(mouth.drawings.some((d) => d.name === "X" && d.rel));
    const arms = factory.rows.find((row) => row.label === "Arm rig L");
    assert.ok(arms);
    assert.ok(arms.drawings.some((d) => d.name === "arm_upper" && d.rel));
    assert.ok(factory.counts.missing > 0);
    assert.equal(factory.counts.ticked, 1);
    const inspect = inspectorForPiece(factory, "eyes_front/surprised", {
      projectDir: fixture.projectDir,
      globalAssetsDir: fixture.globalAssetsDir,
    });
    assert.equal(inspect.slot, "eyes");
    assert.equal(inspect.drawing, "surprised");
    assert.equal(inspect.rel, "characters/rodney/eyes_front/surprised.png");
    assert.equal(inspect.compositeRel, "characters/rodney/head_base/neutral.png");
    assert.equal(inspect.canvas.w, 1024);
    assert.equal(inspect.pivot.x, 509);
    assert.ok(inspect.bounds);
    assert.ok(Array.isArray(inspect.usages));
    assert.ok(Array.isArray(inspect.history));
    const front = factory.views.find((item) => item.id === "front");
    assert.ok(front && front.count >= 4);
  });

  test("torso, body, torso_rig and clothing overlays share one Torso row", () => {
    const dir = path.join(fixture.projectDir, "characters", "riggy");
    fixture.writePng(path.join(dir, "blank.png"));
    fixture.writePng(path.join(dir, "torso", "neutral.png"));
    fixture.writePng(path.join(dir, "body", "walk.png"));
    fixture.writePng(path.join(dir, "parts", "torso_rig.png"));
    fixture.writePng(path.join(dir, "parts", "shirt.png"));
    fixture.writePng(path.join(dir, "parts", "shorts.png"));
    fixture.writeJson(path.join(dir, "character.json"), {
      id: "riggy",
      display_name: "Riggy",
      aliases: ["Riggy"],
      asset: "blank.png",
      z: 10,
      slots: {
        torso: { drawings_dir: "torso", default_drawing: "neutral" },
        body: { drawings_dir: "body", default_drawing: "walk" },
      },
      children: [
        { id: "torso_rig", asset: "parts/torso_rig.png", z: 0, offset: { x: 0, y: 0 } },
        { id: "shirt_overlay", asset: "parts/shirt.png", z: 1, offset: { x: 0, y: 0 } },
        { id: "shorts", asset: "parts/shorts.png", z: 1, offset: { x: 0, y: 0 } },
      ],
    });
    const factory = describeFactoryCharacter(fixture.projectDir, fixture.globalAssetsDir, "riggy", "front");
    const torsoRows = factory.rows.filter((row) => row.label === "Torso");
    assert.equal(torsoRows.length, 1);
    const names = torsoRows[0].drawings.map((item) => item.name);
    assert.ok(names.includes("neutral"));
    assert.ok(names.includes("walk"));
    assert.ok(torsoRows[0].drawings.some((item) => /shirt/.test(item.rel || item.name)));
    assert.ok(torsoRows[0].drawings.some((item) => /shorts/.test(item.rel || item.name)));
    assert.ok(torsoRows[0].drawings.some((item) => /torso_rig/.test(item.rel || item.drawingsDir || "")));
    assert.equal(factory.rows.filter((row) => /overlay/i.test(row.label)).length, 0);
  });

  test("eyes stay hidden on the back view; applyStatusBody validates input", () => {
    const back = describeFactoryCharacter(fixture.projectDir, fixture.globalAssetsDir, "rodney", "back");
    assert.equal(
      back.rows.some((row) => row.slot === "eyes" && row.drawings.some((d) => d.expected)),
      false
    );
    assert.throws(() => applyStatusBody(fixture.projectDir, "rodney", { key: "../x", state: "ticked" }), /Invalid status key/);
    assert.throws(() => applyStatusBody(fixture.projectDir, "rodney", { key: "eyes_front/open" }), /state or redo/);
  });

  test("lists shared and per-character actions", () => {
    const actions = listProjectActions(fixture.projectDir, fixture.globalAssetsDir);
    const labels = actions.map((item) => item.label);
    assert.ok(labels.includes("shared/blink"));
    assert.ok(labels.includes("alice/walk_side"));
  });
});
