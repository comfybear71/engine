"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseProjectToFiles } = require("../src/parser");
const { encodeRgbaPng } = require("../src/pngFlip");
const {
  insertDurationFrames,
  insertStillTag,
  installRodneyTongueInsert,
  drawTongueMouthRgba,
} = require("../src/insertStill");
const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { buildLaneBlocks } = require("../src/studioLanes");

describe("insert still", () => {
  let root;
  let projectDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "insert-still-"));
    projectDir = path.join(root, "rodney_test");
    fs.mkdirSync(projectDir, { recursive: true });
    buildRodneyTestProject(projectDir);
    const bgDir = path.join(projectDir, "backgrounds", "studio");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, "bg.png"), encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4)));
    fs.writeFileSync(
      path.join(bgDir, "staging.json"),
      `${JSON.stringify({ marks: { centre: { x: 960, y: 1080, scale: 1 } }, auto_order: ["centre"], props: {} }, null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(projectDir, "script.txt"),
      ["[Scene: Bar]", "[Location: studio]", "[Cast: Rodney]", "Rodney: Evening.", ""].join("\n")
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("tongue overlay is a mouth, not a second head", () => {
    const rgba = drawTongueMouthRgba();
    assert.equal(rgba[3], 0);
    assert.equal(rgba[(1023 * 1024 + 1023) * 4 + 3], 0);
    let headPixels = 0;
    let mouthPixels = 0;
    for (let y = 0; y < 1024; y += 1) {
      for (let x = 0; x < 1024; x += 1) {
        if (rgba[(y * 1024 + x) * 4 + 3] < 8) continue;
        if (y < 300) headPixels += 1;
        else mouthPixels += 1;
      }
    }
    assert.equal(headPixels, 0);
    assert.ok(mouthPixels > 1000);
  });

  test("942-952 inclusive is 11 frames", () => {
    const span = insertDurationFrames(942, 952);
    assert.equal(span.frames, 11);
    assert.equal(span.startFrame, 942);
    assert.equal(span.endFrame, 953);
    assert.equal(insertStillTag({ image: "inserts/tongue_closeup.png", startFrame: 942, endFrame: 952 }),
      "[Insert: image=inserts/tongue_closeup.png at_time=942 for=11]");
  });

  test("installs a Front tongue draft and wires the insert on 942-952", async () => {
    const result = installRodneyTongueInsert(projectDir);
    assert.equal(result.startFrame, 942);
    assert.equal(result.endFrame, 952);
    assert.equal(fs.existsSync(path.join(projectDir, result.mouthRel)), true);
    assert.equal(fs.existsSync(path.join(projectDir, result.insertRel)), true);
    const status = JSON.parse(fs.readFileSync(path.join(projectDir, "characters", "rodney", "status.json"), "utf8"));
    assert.equal(status["mouth_front/tongue"], "draft");
    const script = fs.readFileSync(path.join(projectDir, "script.txt"), "utf8");
    assert.match(script, /\[Insert: image=inserts\/tongue_closeup\.png at_time=942 for=11\]/);

    const parsed = await parseProjectToFiles(projectDir);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const layer = parsed.timeline.scenes[0].layers.find((item) => item.insert_id);
    assert.ok(layer, "parser emits an insert layer");
    assert.equal(layer.timing.start_frame, 942);
    assert.equal(layer.timing.end_frame, 953);
    assert.equal(layer.z, 1000);
    const lanes = buildLaneBlocks(parsed);
    const block = lanes.blocks.find((item) => item.lane === "inserts");
    assert.ok(block);
    assert.equal(block.startFrame, 942);
    assert.equal(block.endFrame, 953);
    assert.ok(lanes.lanes.includes("inserts"));
  });
});
