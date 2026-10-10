import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clampZoom,
  fitPixelsPerFrame,
  followPlayheadScroll,
  formatRulerLabel,
  parseStoredZoomMap,
  pixelsPerFrame,
  rulerIntervalFrames,
  rulerTicks,
  sliderToZoom,
  trackWidthPx,
  zoomAroundCursor,
  zoomToSlider,
} from "../lib/timelineZoom.ts";

describe("timeline zoom", () => {
  test("fit is 1x and zoom scales pixels-per-frame together", () => {
    assert.equal(fitPixelsPerFrame(100, 200), 2);
    assert.equal(pixelsPerFrame(1, 100, 200), 2);
    assert.equal(pixelsPerFrame(4, 100, 200), 8);
    assert.equal(trackWidthPx(100, 8, 200), 800);
    assert.equal(clampZoom(0), 1);
  });

  test("ctrl-style zoom keeps the frame under the cursor", () => {
    const view = 400;
    const total = 100;
    const before = zoomAroundCursor(1, 2, 100, 0, total, view);
    assert.equal(before.zoom, 2);
    const ppf = pixelsPerFrame(2, total, view);
    const frameAtCursor = (before.scrollLeft + 100) / ppf;
    assert.ok(Math.abs(frameAtCursor - 25) < 0.51, `frame ${frameAtCursor}`);
  });

  test("playhead follow only scrolls when the head leaves the padded view", () => {
    assert.equal(followPlayheadScroll(10, 10, 0, 400), null);
    const next = followPlayheadScroll(80, 10, 0, 400);
    assert.ok(next != null && next > 0);
  });

  test("ruler interval grows from frames to seconds to minutes", () => {
    assert.equal(rulerIntervalFrames(20, 24), 5);
    assert.equal(rulerIntervalFrames(2, 24), 48);
    assert.equal(rulerIntervalFrames(0.15, 24), 24 * 30);
    assert.equal(formatRulerLabel(48, 24, 5), "48f");
    assert.equal(formatRulerLabel(48, 24, 24), "0:02");
    assert.equal(formatRulerLabel(24 * 60, 24, 24 * 60), "1m");
  });

  test("ruler ticks only cover the visible window", () => {
    const ticks = rulerTicks({
      totalFrames: 24 * 60 * 3,
      fps: 24,
      ppf: 0.2,
      scrollLeft: 0,
      viewWidth: 400,
    });
    assert.ok(ticks.length > 0 && ticks.length < 80);
    assert.equal(ticks[0].frame, 0);
    assert.ok(ticks.some((tick) => tick.major && tick.label));
  });

  test("stored zoom map ignores junk and slider is invertible", () => {
    assert.deepEqual(parseStoredZoomMap("nope"), {});
    assert.equal(parseStoredZoomMap(JSON.stringify({ show: 4 })).show, 4);
    const z = sliderToZoom(0.5);
    assert.ok(Math.abs(zoomToSlider(z) - 0.5) < 1e-9);
  });
});
