import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_IMAGINE_HEIGHT,
  DEFAULT_STAGE_LAYOUT,
  STAGE_LAYOUT_LIMITS,
  clampImagineHeight,
  clampStageLayout,
  parseStoredLayout,
  parseStoredLeftPool,
  parseStoredTreeOpen,
} from "../lib/stageLayout.ts";
import { clampFrameIndex, formatTimecode, frameFromTrackX, scriptLineAtFrame } from "../lib/playhead.ts";
import {
  DEFAULT_LANE_SCALE,
  LANE_EMPTY_PX,
  LANE_ROW_PX,
  MAX_LANE_SCALE,
  MIN_LANE_SCALE,
  clampLaneScale,
  defaultTimelinePanelHeight,
  laneHeightPx,
  laneRowCount,
  laneScaleToSlider,
  occupiedLaneRowPx,
  parseStoredLaneScale,
  sliderToLaneScale,
} from "../lib/timelineLanes.ts";

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

  test("clampImagineHeight bounds the Grok Imagine dock", () => {
    assert.equal(clampImagineHeight(80), 160);
    assert.equal(clampImagineHeight(900), 560);
    assert.equal(clampImagineHeight(DEFAULT_IMAGINE_HEIGHT), DEFAULT_IMAGINE_HEIGHT);
  });

  test("default timeline height fits seven single-row lanes", () => {
    assert.equal(DEFAULT_STAGE_LAYOUT.timelineHeight, defaultTimelinePanelHeight());
    assert.ok(DEFAULT_STAGE_LAYOUT.timelineHeight >= 7 * LANE_ROW_PX + 60);
    assert.equal(STAGE_LAYOUT_LIMITS.timelineHeight.min, 180);
    assert.equal(STAGE_LAYOUT_LIMITS.timelineHeight.max, 560);
  });

  test("left pool and assets tree persist helpers ignore junk", () => {
    assert.equal(parseStoredLeftPool(null), null);
    assert.equal(parseStoredLeftPool(JSON.stringify({ id: "assets" })), "assets");
    assert.equal(parseStoredLeftPool("effects"), "effects");
    assert.equal(parseStoredLeftPool(JSON.stringify({ id: "nope" })), null);
    assert.deepEqual(parseStoredTreeOpen(null), {});
    assert.deepEqual(parseStoredTreeOpen(JSON.stringify({ open: { characters: true } })), { characters: true });
  });

  test("legacy short timeline heights migrate to the new default", () => {
    const fromOldDefault = parseStoredLayout(JSON.stringify({ leftWidth: 300, timelineHeight: 220 }));
    assert.equal(fromOldDefault.leftWidth, 300);
    assert.equal(fromOldDefault.timelineHeight, DEFAULT_STAGE_LAYOUT.timelineHeight);
    assert.equal(
      parseStoredLayout(JSON.stringify({ timelineHeight: 176 })).timelineHeight,
      DEFAULT_STAGE_LAYOUT.timelineHeight
    );
    const kept = parseStoredLayout(JSON.stringify({ timelineHeight: 360 }));
    assert.equal(kept.timelineHeight, 360);
  });
});

describe("timeline lane heights", () => {
  test("empty lanes stay thin; stacked rows grow by 30px", () => {
    assert.equal(laneRowCount([]), 0);
    assert.equal(laneHeightPx([]), LANE_EMPTY_PX);
    assert.ok(LANE_EMPTY_PX >= 20);
    assert.ok(LANE_EMPTY_PX < LANE_ROW_PX);
    assert.equal(laneRowCount([{ row: 0 }, { row: 2 }]), 3);
    assert.equal(laneHeightPx([{ row: 0 }]), LANE_ROW_PX);
    assert.equal(laneHeightPx([{ row: 0 }, { row: 2 }]), 3 * LANE_ROW_PX);
  });

  test("lane scale clamps and grows occupied rows", () => {
    assert.equal(clampLaneScale(0), MIN_LANE_SCALE);
    assert.equal(clampLaneScale(9), MAX_LANE_SCALE);
    assert.equal(clampLaneScale(DEFAULT_LANE_SCALE), DEFAULT_LANE_SCALE);
    assert.equal(occupiedLaneRowPx(1), LANE_ROW_PX);
    assert.ok(occupiedLaneRowPx(MIN_LANE_SCALE) < LANE_ROW_PX);
    assert.ok(occupiedLaneRowPx(MAX_LANE_SCALE) > LANE_ROW_PX);
    assert.equal(laneHeightPx([{ row: 0 }], 1.7), occupiedLaneRowPx(1.7));
    assert.ok(laneHeightPx([], MIN_LANE_SCALE) >= 16);
    const mid = sliderToLaneScale(0.5);
    assert.ok(Math.abs(laneScaleToSlider(mid) - 0.5) < 0.02);
  });

  test("parseStoredLaneScale ignores junk and reads { scale }", () => {
    assert.equal(parseStoredLaneScale(null), DEFAULT_LANE_SCALE);
    assert.equal(parseStoredLaneScale("nope"), DEFAULT_LANE_SCALE);
    assert.equal(parseStoredLaneScale(JSON.stringify({ scale: 1.4 })), 1.4);
    assert.equal(parseStoredLaneScale("1.2"), 1.2);
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

  test("clampFrameIndex stays on [0, total-1] even when lanes extend past the compositor", () => {
    assert.equal(clampFrameIndex(287, 285), 284);
    assert.equal(clampFrameIndex(-3, 285), 0);
    assert.equal(clampFrameIndex(0, 285), 0);
    assert.equal(clampFrameIndex(Number.NaN, 24), 0);
  });
});
