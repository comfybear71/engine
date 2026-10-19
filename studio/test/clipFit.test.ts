import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitClipScale, opaqueReach, sampleFrameIndexes } from "../lib/clipFit.ts";

function picture(width: number, height: number, rows: [number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = rows[0]; y <= rows[1]; y += 1) for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

describe("clip fit", () => {
  test("the reach counts empty space under the figure but not above it", () => {
    assert.equal(opaqueReach(picture(8, 40, [5, 34]), 8, 40), 35);
    assert.equal(opaqueReach(picture(8, 40, [0, 39]), 8, 40), 40);
    assert.equal(opaqueReach(picture(8, 40, [30, 34]), 8, 40), 10);
    assert.equal(opaqueReach(new Uint8ClampedArray(8 * 40 * 4), 8, 40), 0);
  });

  test("frames are sampled across the whole clip, first and last included", () => {
    assert.deepEqual(sampleFrameIndexes(0), []);
    assert.deepEqual(sampleFrameIndexes(3), [0, 1, 2]);
    const picks = sampleFrameIndexes(691);
    assert.equal(picks.length, 24);
    assert.equal(picks[0], 0);
    assert.equal(picks[picks.length - 1], 690);
    assert.deepEqual(picks, [...picks].sort((a, b) => a - b));
  });

  test("a clip taller than the picture is scaled to 90% of the picture height", () => {
    assert.equal(fitClipScale({ reachPx: 2400, canvasHeight: 1080, markScale: 1 }), 0.4);
    assert.equal(fitClipScale({ reachPx: 1500, canvasHeight: 1080 }), 0.64);
  });

  test("a figure that fits only because of empty space under it is still scaled", () => {
    // 700 px of figure plus 500 px empty under the boots reaches 1200 px up from the mark.
    assert.equal(fitClipScale({ reachPx: 1200, canvasHeight: 1080, markScale: 1 }), 0.81);
  });

  test("a clip that already fits is left alone", () => {
    assert.equal(fitClipScale({ reachPx: 1000, canvasHeight: 1080, markScale: 1 }), null);
    assert.equal(fitClipScale({ reachPx: 2400, canvasHeight: 1080, markScale: 0.4 }), null);
  });

  test("the mark's own scale counts before deciding", () => {
    assert.equal(fitClipScale({ reachPx: 2400, canvasHeight: 1080, markScale: 0.5 }), 0.4);
    assert.equal(fitClipScale({ reachPx: 1400, canvasHeight: 1080, markScale: 0.7 }), null);
  });

  test("nothing is written when the size is unknown", () => {
    assert.equal(fitClipScale({ reachPx: 0, canvasHeight: 1080 }), null);
    assert.equal(fitClipScale({ reachPx: Number.NaN, canvasHeight: 1080 }), null);
  });
});
