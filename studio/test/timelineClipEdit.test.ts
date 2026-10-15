import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applySplitWrite,
  applyTrimWrite,
  moveBlocksInScript,
  planSplit,
  planTrim,
  setAtTimeOnLine,
  type EditableBlock,
} from "../lib/timelineEdit.ts";
import { clipboardFromBlocks, deleteBlocksInScript, pasteClipboardInScript } from "../lib/timelineClipboard.ts";

const SCRIPT = [
  "[Scene: Show]",
  "[Location: curtain]",
  "[Cast: Rodney]",
  "[Clip: Rodney first_clip at_time=1s]",
  "[Audio: Rodney file=japs lines=false at_time=0s trim_in=2s trim_out=6s]",
  "[Do: Rodney wave at_time=3s]",
].join("\n");

const scenes = [{ id: "show", startFrame: 0, endFrame: 240 }];

const clipBlock: EditableBlock = {
  id: "action-show-4-0",
  scriptLine: 4,
  sceneId: "show",
  lane: "action",
  tag: "clip",
  startFrame: 24,
  endFrame: 120,
  sourceStartFrame: 24,
  timing: { kind: "clip", tag: "clip", attr: "at_time" } as EditableBlock["timing"],
  trim: { inFrames: 0, outFrames: 96 },
  sourceDurationFrames: 96,
  movable: true,
};

describe("[Clip:] and [Do:] lines are editable on the timeline", () => {
  test("setAtTimeOnLine rewrites at_time on Clip and Do lines", () => {
    assert.equal(
      setAtTimeOnLine("[Clip: Rodney first_clip at_time=1s]", "5s"),
      "[Clip: Rodney first_clip at_time=5s]"
    );
    assert.equal(setAtTimeOnLine("[Clip: Rodney first_clip]", "2s"), "[Clip: Rodney first_clip at_time=2s]");
    assert.equal(setAtTimeOnLine("[Do: Rodney wave]", "2s"), "[Do: Rodney wave at_time=2s]");
  });

  test("dragging a Clip block writes the new at_time instead of snapping back", () => {
    const moved = moveBlocksInScript(SCRIPT, [{ scriptLine: 4, startFrame: 96, sceneStartFrame: 0 }], 24);
    assert.equal(moved.split("\n")[3], "[Clip: Rodney first_clip at_time=4s]");
  });

  test("trimming the out edge of a Clip writes trim_out", () => {
    const write = planTrim({
      blocks: [clipBlock],
      ids: [clipBlock.id],
      edge: "out",
      newEdgeFrame: 72,
      scenes,
      fps: 24,
      script: SCRIPT,
    });
    assert.ok(write);
    const next = applyTrimWrite(SCRIPT, write!);
    assert.equal(next.split("\n")[3], "[Clip: Rodney first_clip at_time=1s trim_out=2s]");
  });

  test("trimming the in edge of a Clip moves at_time and writes trim_in", () => {
    const write = planTrim({
      blocks: [clipBlock],
      ids: [clipBlock.id],
      edge: "in",
      newEdgeFrame: 48,
      scenes,
      fps: 24,
      script: SCRIPT,
    });
    assert.ok(write);
    const line = applyTrimWrite(SCRIPT, write!).split("\n")[3];
    assert.match(line, /at_time=2s/);
    assert.match(line, /trim_in=1s/);
  });

  test("splitting a Clip yields two lines that each play their own part of the shot", () => {
    const write = planSplit({
      blocks: [clipBlock],
      ids: [clipBlock.id],
      playhead: 72,
      scenes,
      fps: 24,
      script: SCRIPT,
    });
    assert.ok(write);
    const lines = applySplitWrite(SCRIPT, write!).split("\n");
    assert.match(lines[3], /^\[Clip: Rodney first_clip at_time=1s trim_out=2s\]$/);
    assert.match(lines[4], /^\[Clip: Rodney first_clip at_time=3s trim_in=2s\]$/);
  });

  test("copy/paste reuses a trimmed Clip and a trimmed Audio part at the playhead", () => {
    const audioBlock: EditableBlock = {
      id: "audio-show-5-1",
      scriptLine: 5,
      sceneId: "show",
      lane: "audio",
      tag: "audio",
      startFrame: 0,
      endFrame: 96,
      sourceStartFrame: 0,
      timing: { kind: "audio", tag: "audio", attr: "at_time" } as EditableBlock["timing"],
      trim: { inFrames: 48, outFrames: 144 },
      sourceDurationFrames: 480,
      movable: true,
    };
    const blocks = [clipBlock, audioBlock];
    const clipboard = clipboardFromBlocks(SCRIPT, blocks as never, [clipBlock.id, audioBlock.id]);
    assert.equal(clipboard.items.length, 2);
    const pasted = pasteClipboardInScript({
      script: SCRIPT,
      clipboard,
      playhead: 144,
      fps: 24,
      scenes,
      playheadLine: 6,
    });
    const out = pasted.split("\n");
    assert.ok(out.includes("[Audio: Rodney file=japs lines=false trim_in=2s trim_out=6s at_time=6s]"));
    assert.ok(out.includes("[Clip: Rodney first_clip at_time=7s]"));
  });

  test("a Clip pastes only on the Action Shots lane", () => {
    const clipboard = clipboardFromBlocks(SCRIPT, [clipBlock] as never, [clipBlock.id]);
    const wrongLane = pasteClipboardInScript({
      script: SCRIPT,
      clipboard,
      playhead: 0,
      fps: 24,
      scenes,
      playheadLine: 6,
      lane: "audio",
    });
    assert.equal(wrongLane, SCRIPT);
    const rightLane = pasteClipboardInScript({
      script: SCRIPT,
      clipboard,
      playhead: 0,
      fps: 24,
      scenes,
      playheadLine: 6,
      lane: "action",
    });
    assert.notEqual(rightLane, SCRIPT);
  });

  test("deleting a Clip removes exactly its line", () => {
    const next = deleteBlocksInScript({
      script: SCRIPT,
      blocks: [clipBlock] as never,
      ids: [clipBlock.id],
      scenes,
      fps: 24,
      ripple: false,
    });
    assert.ok(!next.includes("[Clip:"));
    assert.ok(next.includes("[Do: Rodney wave"));
  });
});
