import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_STAGE_LAYOUT,
  clampStageLayout,
  parseStoredLayout,
} from "../lib/stageLayout.ts";
import { formatTimecode, frameFromTrackX, scriptLineAtFrame } from "../lib/playhead.ts";

describe("stage layout", () => {
  test("clamps sizes and fills defaults", () => {
    const clamped = clampStageLayout({ leftWidth: 50, rightWidth: 900, timelineHeight: 200 });
    assert.equal(clamped.leftWidth, 200);
    assert.equal(clamped.rightWidth, 480);
    assert.equal(clamped.timelineHeight, 200);
    assert.deepEqual(clampStageLayout({}), DEFAULT_STAGE_LAYOUT);
  });

  test("parseStoredLayout ignores bad JSON and resets to defaults", () => {
    assert.deepEqual(parseStoredLayout(null), DEFAULT_STAGE_LAYOUT);
    assert.deepEqual(parseStoredLayout("not-json"), DEFAULT_STAGE_LAYOUT);
    const stored = parseStoredLayout(JSON.stringify({ leftWidth: 300, extra: true }));
    assert.equal(stored.leftWidth, 300);
    assert.equal(stored.rightWidth, DEFAULT_STAGE_LAYOUT.rightWidth);
    assert.equal(stored.timelineHeight, DEFAULT_STAGE_LAYOUT.timelineHeight);
  });
});

describe("playhead", () => {
  test("formatTimecode pads h:m:s:ff", () => {
    assert.equal(formatTimecode(0, 24), "00:00:00:00");
    assert.equal(formatTimecode(24, 24), "00:00:01:00");
    assert.equal(formatTimecode(49, 24), "00:00:02:01");
  });

  test("scriptLineAtFrame prefers covering dialogue, else the last started line", () => {
    const blocks = [
      { startFrame: 0, endFrame: 10, scriptLine: 4, lane: "action" },
      { startFrame: 0, endFrame: 10, scriptLine: 5, lane: "dialogue" },
      { startFrame: 20, endFrame: 30, scriptLine: 9, lane: "camera" },
    ];
    assert.equal(scriptLineAtFrame(blocks, 3), 5);
    assert.equal(scriptLineAtFrame(blocks, 15), 5);
    assert.equal(scriptLineAtFrame(blocks, 22), 9);
    assert.equal(scriptLineAtFrame([], 0), null);
  });

  test("frameFromTrackX maps click position onto 0..total-1", () => {
    assert.equal(frameFromTrackX(0, 0, 100, 101), 0);
    assert.equal(frameFromTrackX(100, 0, 100, 101), 100);
    assert.equal(frameFromTrackX(50, 0, 100, 101), 50);
  });
});
