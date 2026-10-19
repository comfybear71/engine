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

  test("to= / over= walk the clip from x to a mark with transform keyframes", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Cast: Rodney]",
      "[Clip: Rodney grab_mic at_time=0s x=-200 to=centre over=1s]",
    ]);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const clip = parsed.timeline.scenes[0].layers.find((layer) => layer.sequence);
    assert.equal(clip.transform.x, -200);
    assert.equal(clip.transform.y, 1000);
    assert.deepEqual(clip.transform_keyframes, [
      { frame: 0, x: -200, y: 1000, scale: 0.5, ease: "linear" },
      { frame: 24, x: 960, y: 1000, scale: 0.5, ease: "linear" },
    ]);
  });

  test("to= accepts x,y, defaults over to the clip length and honours ease", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Cast: Rodney]",
      "[Clip: Rodney grab_mic x=100 y=900 scale=0.4 to=500,800 ease=inout]",
    ]);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const clip = parsed.timeline.scenes[0].layers.find((layer) => layer.sequence);
    assert.deepEqual(clip.transform_keyframes, [
      { frame: 0, x: 100, y: 900, scale: 0.4, ease: "inout" },
      { frame: FRAME_COUNT, x: 500, y: 800, scale: 0.4, ease: "inout" },
    ]);
  });

  test("clips without to= carry no transform keyframes", async () => {
    const parsed = await parseScript(["[Scene: Bar]", "[Location: studio]", "[Clip: Rodney grab_mic]"]);
    const clip = parsed.timeline.scenes[0].layers.find((layer) => layer.sequence);
    assert.equal(clip.transform_keyframes, undefined);
  });

  test("over= longer than the clip warns; over= without to= is an error", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Clip: Rodney grab_mic to=centre over=4s]",
    ]);
    assert.ok(parsed.warnings.some((w) => /longer than the clip plays/.test(w)), JSON.stringify(parsed.warnings));
    await assert.rejects(
      parseScript(["[Scene: Bar]", "[Location: studio]", "[Clip: Rodney grab_mic over=2s]"]),
      /only work together with to=/
    );
  });

  test("speed= plays the clip faster and shortens the block", async () => {
    const { sequenceFrameIndex } = await import("../../shared/placement.js");
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Clip: Rodney grab_mic at_time=1s speed=2]",
      "[Clip: Rodney grab_mic at_time=3s trim_in=0.5s trim_out=1s speed=2]",
      "[Clip: Rodney grab_mic at_time=5s speed=0.5]",
    ]);
    assert.equal(parsed.validation.ok, true, parsed.validation.message);
    const clips = parsed.timeline.scenes[0].layers.filter((layer) => layer.sequence);
    const fast = clips[0];
    assert.equal(fast.timing.start_frame, 24);
    assert.equal(fast.timing.end_frame, 24 + FRAME_COUNT / 2);
    const seq = { files: fast.sequence.frames, fps: fast.sequence.fps, trimIn: fast.sequence.trim_in };
    const shown = [];
    for (let local = 0; local < FRAME_COUNT / 2; local += 1) shown.push(sequenceFrameIndex(seq, local, 24));
    assert.deepEqual(shown, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);

    const trimmed = clips[1];
    assert.equal(trimmed.timing.end_frame - trimmed.timing.start_frame, 6);
    const tseq = { files: trimmed.sequence.frames, fps: trimmed.sequence.fps, trimIn: trimmed.sequence.trim_in };
    assert.equal(sequenceFrameIndex(tseq, 0, 24), 12);
    assert.equal(sequenceFrameIndex(tseq, 5, 24), 22);

    const slow = clips[2];
    assert.equal(slow.timing.end_frame - slow.timing.start_frame, FRAME_COUNT * 2);
  });

  test("speed= must be a sensible number", async () => {
    await assert.rejects(
      parseScript(["[Scene: Bar]", "[Location: studio]", "[Clip: Rodney grab_mic speed=0]"]),
      /Invalid speed/
    );
  });

  test("walk-on over= default follows the sped-up clip length", async () => {
    const parsed = await parseScript([
      "[Scene: Bar]",
      "[Location: studio]",
      "[Clip: Rodney grab_mic speed=2 x=0 to=centre]",
    ]);
    const clip = parsed.timeline.scenes[0].layers.find((layer) => layer.sequence);
    assert.equal(clip.transform_keyframes[1].frame, FRAME_COUNT / 2);
  });

  test("unknown Action Shot is a clear script error", async () => {
    await assert.rejects(
      parseScript(["[Scene: Bar]", "[Location: studio]", "[Clip: Rodney nope]"]),
      /Unknown Action Shot "nope"/
    );
  });
});
