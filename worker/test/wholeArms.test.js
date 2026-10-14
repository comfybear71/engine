"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decodeRgbaFile } = require("../src/factoryThumb");
const {
  drawWholeArm,
  promoteWholeArms,
  remapActionJson,
  installLongStrideDrafts,
  trashUnreferencedApproach,
} = require("../src/wholeArms");
const { describeFactoryCharacter, listProjectActions } = require("../src/characterStatus");
const { childRowLabel, armSideFromName } = require("../src/factoryStandard");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { encodeRgbaPng } = require("../src/pngFlip");

function writePng(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 255)));
}

describe("whole-arm rig", () => {
  test("L/R badges come from the drawing name", () => {
    assert.equal(armSideFromName("rest_L", "arm"), "L");
    assert.equal(armSideFromName("grip_mic_R", "arm"), "R");
    assert.equal(armSideFromName("open", "arm_L"), "L");
    assert.equal(childRowLabel({ id: "arm_upper_L", asset: "parts/arm_upper.png" }), "Arms");
    assert.equal(childRowLabel({ id: "hands", asset: "hand/open.png" }), "Arms");
  });

  test("mic grip has opaque pixels at knuckles and thumb (not an empty canvas)", () => {
    const rgba = drawWholeArm("grip_mic", "L");
    let counted = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) counted += 1;
    assert.ok(counted > 400, "whole arm must be a visible piece");
  });

  test("grab_mic remaps split joints to a 4-drawing whole-arm sequence", () => {
    const next = remapActionJson({
      id: "grab_mic",
      frames: 4,
      joints: { arm_upper_L: [0, 10, 20, 25], arm_lower_L: [0, 5, 10, 12] },
      slot_frames: { hand_L: ["open", "open", "palm", "mic"] },
    });
    assert.deepEqual(next.slot_frames.arm_L, ["reach_L", "grasp_L", "grip_mic_L", "hold_mic_L"]);
    assert.equal(next.joints, undefined);
    assert.equal(remapActionJson({ id: "hold_mic" }).slot_frames.arm_L.length, 3);
    assert.equal(remapActionJson({ id: "look_left" }).frames, 3);
  });

  test("promote writes draft whole arms, L/R badges, and drops split pieces", () => {
    const fixture = createFixtureLibrary();
    try {
      const rodney = path.join(fixture.projectDir, "characters", "rodney");
      writePng(path.join(rodney, "blank.png"));
      writePng(path.join(rodney, "parts", "arm_upper.png"));
      writePng(path.join(rodney, "parts", "torso_rig.png"));
      writePng(path.join(rodney, "parts", "shirt.png"));
      writePng(path.join(rodney, "torso", "neutral.png"));
      writePng(path.join(rodney, "torso", "armless_L.png"));
      writePng(path.join(rodney, "torso", "approach.png"));
      writePng(path.join(rodney, "head_base", "neutral.png"));
      writePng(path.join(rodney, "eyes_front", "open.png"));
      fixture.writeJson(path.join(rodney, "character.json"), {
        id: "rodney",
        display_name: "Rodney",
        aliases: ["Rodney"],
        asset: "blank.png",
        z: 10,
        slots: {
          head_base: { drawings_dir: "head_base", default_drawing: "neutral" },
          eyes: { drawings_dir: "eyes", default_drawing: "open" },
          torso: { drawings_dir: "torso", default_drawing: "neutral" },
        },
        children: [
          { id: "arm_upper_L", asset: "parts/arm_upper.png", z: 2 },
          { id: "torso_rig", asset: "parts/torso_rig.png", z: 1 },
          { id: "ov_shirt", asset: "parts/shirt.png", z: 3 },
        ],
      });
      const result = promoteWholeArms(fixture.projectDir, {
        characterId: "rodney",
        globalAssetsDir: fixture.globalAssetsDir,
      });
      assert.ok(result.drawings.some((rel) => rel.endsWith("grip_mic_L.png")));
      assert.ok(result.overlay.keep.some((item) => item.id === "ov_shirt"));
      assert.ok(result.overlay.drop.some((item) => item.id === "torso_rig"));
      const factory = describeFactoryCharacter(fixture.projectDir, fixture.globalAssetsDir, "rodney", "front");
      const arms = factory.rows.find((row) => row.label === "Arms");
      assert.ok(arms, "one Arms section");
      assert.equal(factory.rows.some((row) => /Arm rig|Hands/.test(row.label)), false);
      const grip = arms.drawings.find((d) => d.name === "grip_mic_L");
      assert.ok(grip);
      assert.equal(grip.side, "L");
      assert.equal(grip.badge, "draft");
      const actions = listProjectActions(fixture.projectDir, fixture.globalAssetsDir);
      const grab = actions.find((item) => item.name === "grab_mic");
      assert.equal(grab.frames, 4);
      assert.equal(grab.still, false);
      const hold = actions.find((item) => item.name === "hold_mic");
      assert.equal(hold.still, false);
      const look = actions.find((item) => item.name === "look_left");
      assert.equal(look.still, false);
      assert.ok(!fs.existsSync(path.join(rodney, "torso", "approach.png")));
      const decoded = decodeRgbaFile(path.join(rodney, "arm", "grip_mic_L.png"));
      assert.equal(decoded.width, 1024);
      promoteWholeArms(fixture.projectDir, {
        characterId: "rodney",
        globalAssetsDir: fixture.globalAssetsDir,
      });
      assert.ok(fs.existsSync(path.join(rodney, "arm", "rest_L.png")), "re-promote must not trash live arm drawings");
    } finally {
      fixture.cleanup();
    }
  });

  test("long-stride 8/12/16 drafts sit side by side as actions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-stride-"));
    try {
      const projectDir = path.join(root, "proj");
      const rodney = path.join(projectDir, "characters", "rodney");
      fs.mkdirSync(rodney, { recursive: true });
      writePng(path.join(rodney, "blank.png"));
      fs.writeFileSync(
        path.join(rodney, "character.json"),
        `${JSON.stringify({ id: "rodney", display_name: "Rodney", aliases: ["Rodney"], asset: "blank.png", slots: { torso: { drawings_dir: "torso" } } })}\n`
      );
      const ids = installLongStrideDrafts(projectDir, "rodney");
      assert.deepEqual(ids, ["walk_side_long_stride_8", "walk_side_long_stride_12", "walk_side_long_stride_16"]);
      assert.equal(fs.readdirSync(path.join(rodney, "torso")).filter((n) => n.startsWith("walk_side_long_stride_8")).length, 8);
      assert.equal(fs.readdirSync(path.join(rodney, "torso")).filter((n) => n.startsWith("walk_side_long_stride_16")).length, 16);
      const actions = listProjectActions(projectDir, null);
      assert.equal(actions.filter((item) => /walk_side_long_stride/.test(item.name)).length, 3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("approach torso stays if a script still names it", () => {
    const fixture = createFixtureLibrary();
    try {
      const rodney = path.join(fixture.projectDir, "characters", "rodney");
      writePng(path.join(rodney, "blank.png"));
      writePng(path.join(rodney, "torso", "approach.png"));
      fixture.writeJson(path.join(rodney, "character.json"), {
        id: "rodney",
        display_name: "Rodney",
        aliases: ["Rodney"],
        asset: "blank.png",
        slots: { torso: { drawings_dir: "torso", default_drawing: "neutral" } },
      });
      fs.writeFileSync(path.join(fixture.projectDir, "script.txt"), "[Action: Rodney torso=approach]\n");
      const result = trashUnreferencedApproach(fixture.projectDir, fixture.globalAssetsDir, "rodney");
      assert.equal(result.trashed, false);
      assert.ok(fs.existsSync(path.join(rodney, "torso", "approach.png")));
    } finally {
      fixture.cleanup();
    }
  });
});
