import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitClipScale, opaqueHeight } from "../lib/clipFit.ts";

function picture(width: number, height: number, rows: [number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = rows[0]; y <= rows[1]; y += 1) for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

describe("clip fit", () => {
  test("the visible height ignores transparent padding above and below", () => {
    assert.equal(opaqueHeight(picture(8, 40, [5, 34]), 8, 40), 30);
    assert.equal(opaqueHeight(picture(8, 40, [0, 39]), 8, 40), 40);
    assert.equal(opaqueHeight(new Uint8ClampedArray(8 * 40 * 4), 8, 40), 0);
  });

  test("a clip taller than the picture is scaled to 90% of the picture height", () => {
    assert.equal(fitClipScale({ contentHeightPx: 2400, canvasHeight: 1080, markScale: 1 }), 0.4);
    assert.equal(fitClipScale({ contentHeightPx: 1500, canvasHeight: 1080 }), 0.64);
  });

  test("a clip that already fits is left alone", () => {
    assert.equal(fitClipScale({ contentHeightPx: 1000, canvasHeight: 1080, markScale: 1 }), null);
    assert.equal(fitClipScale({ contentHeightPx: 2400, canvasHeight: 1080, markScale: 0.4 }), null);
  });

  test("the mark's own scale counts before deciding", () => {
    assert.equal(fitClipScale({ contentHeightPx: 2400, canvasHeight: 1080, markScale: 0.5 }), 0.4);
    assert.equal(fitClipScale({ contentHeightPx: 1400, canvasHeight: 1080, markScale: 0.7 }), null);
  });

  test("nothing is written when the size is unknown", () => {
    assert.equal(fitClipScale({ contentHeightPx: 0, canvasHeight: 1080 }), null);
    assert.equal(fitClipScale({ contentHeightPx: Number.NaN, canvasHeight: 1080 }), null);
  });
});
