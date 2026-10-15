"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseProjectToFiles } = require("../src/parser");
const { encodeRgbaPng } = require("../src/pngFlip");
const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { buildLaneBlocks } = require("../src/studioLanes");

const FRAME_COUNT = 24;

function frameName(n) {
  return `f_${String(n).padStart(4, "0")}.png`;
}

describe("[Clip:] baked Action Shot flipbook", () => {
  let root;
  let projectDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clip-flipbook-"));
    projectDir = path.join(root, "rodney_test");
    fs.mkdirSync(projectDir, { recursive: true });
    buildRodneyTestProject(projectDir);
    const bgDir = path.join(projectDir, "backgrounds", "studio");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, "bg.png"), encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4)));
    fs.writeFileSync(
      path.join(bgDir, "staging.json"),
      `${JSON.stringify({ marks: { centre: { x: 960, y: 1000, scale: 0.5 } }, auto_order: ["centre"], props: {} }, null, 2)}\n`
    );
    const actionDir = path.join(projectDir, "characters", "rodney", "actions", "grab_mic");
    fs.mkdirSync(actionDir, { recursive: true });
    const names = [];
    for (let i = 1; i <= FRAME_COUNT; i += 1) {
      names.push(frameName(i));
      fs.writeFileSync(path.join(actionDir, frameName(i)), encodeRgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 255)));
    }
    fs.writeFileSync(
      path.join(projectDir, "characters", "rodney", "actions", "grab_mic.json"),
      JSON.stringify({
        id: "grab_mic",
        view: "front",
        fps: 24,
        frames: FRAME_COUNT,
        slot_frames: { body: names },
        hide_children: true,
        shotId: "shot_1",
        drawingsDir: "actions/grab_mic",
      })
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function parseScript(lines) {
    fs.writeFileSync(path.join(projectDir, "script.txt"), `${lines.join("\n")}\n`);
    return parseProjectToFiles(projectDir);
  }

  test("emits a sequence layer on the mark and an Action Shots lane block", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Cast: Rodney]",
      "[Clip: Rodney grab_mic at_time=1s trim_in=0.25s trim_out=0.75s]",
    ]);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const layers = parsed.timeline.scenes[0].layers;
    const clip = layers.find((layer) => layer.sequence);
    assert.ok(clip, "clip layer present");
    assert.equal(clip.character_id, "rodney");
    assert.equal(clip.sequence.frames.length, FRAME_COUNT);
    assert.equal(clip.sequence.fps, 24);
    assert.equal(clip.sequence.trim_in, 0.25);
    assert.equal(clip.timing.start_frame, 24);
    assert.equal(clip.timing.end_frame, 36);
    assert.equal(clip.transform.x, 960);
    assert.equal(clip.transform.y, 1000);
    assert.equal(clip.transform.scale, 0.5);
    assert.equal(clip.asset, clip.sequence.frames[0]);
    assert.equal(
      layers.filter((layer) => !layer.sequence).length,
      0,
      "the cast rig layer is dropped when a clip stands in for the character"
    );

    const lanes = buildLaneBlocks(parsed);
    const block = lanes.blocks.find((item) => item.lane === "action");
    assert.ok(block, "clip shows in the action lane");
    assert.equal(block.tag, "clip");
    assert.equal(block.startFrame, 24);
    assert.equal(block.endFrame, 36);
    assert.equal(block.timing.kind, "clip");
    assert.equal(block.sourceDurationFrames, FRAME_COUNT);
    assert.deepEqual(block.trim, { inFrames: 6, outFrames: 18 });
  });

  test("untimed clips run back to back", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Clip: Rodney grab_mic]",
      "[Clip: Rodney grab_mic]",
    ]);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const clips = parsed.timeline.scenes[0].layers.filter((layer) => layer.sequence);
    assert.equal(clips.length, 2);
    assert.equal(clips[0].timing.start_frame, 0);
    assert.equal(clips[0].timing.end_frame, FRAME_COUNT);
    assert.equal(clips[1].timing.start_frame, FRAME_COUNT);
    assert.notEqual(clips[0].id, clips[1].id);
  });

  test("unknown Action Shot is a clear script error", async () => {
    await assert.rejects(
      parseScript(["[Scene: Bar]", "[Location: studio]", "[Clip: Rodney nope]"]),
      /Unknown Action Shot "nope"/
    );
  });
});
