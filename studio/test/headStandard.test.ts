import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  alphaBox,
  fitToStandard,
  matchStandard,
  medianBox,
  standardFromHead,
  targetHeightFraction,
  visibleHeadRect,
  type HeadStandard,
} from "../lib/headStandard.ts";

const body = { w: 1000, h: 2000 };

describe("head standard", () => {
  test("alphaBox finds the visible pixels", () => {
    const w = 8;
    const h = 6;
    const data = new Uint8Array(w * h * 4);
    for (let y = 2; y < 5; y++) for (let x = 3; x < 7; x++) data[(y * w + x) * 4 + 3] = 255;
    data[3] = 10; // below threshold
    assert.deepEqual(alphaBox(data, w, h), { x: 3, y: 2, w: 4, h: 3 });
    assert.equal(alphaBox(new Uint8Array(w * h * 4), w, h), null);
  });

  test("medianBox ignores a few frames where the head turns", () => {
    const boxes = [
      { x: 100, y: 50, w: 200, h: 300 },
      { x: 100, y: 50, w: 200, h: 300 },
      { x: 100, y: 50, w: 200, h: 300 },
      { x: 160, y: 50, w: 90, h: 300 },
      { x: 100, y: 20, w: 200, h: 420 },
    ];
    assert.deepEqual(medianBox(boxes), { x: 100, y: 50, w: 200, h: 300 });
    assert.equal(medianBox([]), null);
  });

  test("fit puts any clip's visible head on the standard whatever its framing", () => {
    const standard: HeadStandard = { height: 0.2, centerX: 0.5, centerY: 0.12 };
    // Two clips framed very differently: a tight crop and a loose one, both off-centre.
    const clips = [
      { frame: { w: 600, h: 600 }, box: { x: 150, y: 40, w: 300, h: 380 } },
      { frame: { w: 1500, h: 1200 }, box: { x: 700, y: 100, w: 320, h: 900 } },
    ];
    for (const clip of clips) {
      const placement = fitToStandard({ ...clip, body, standard, rigKey: "front" });
      const rect = visibleHeadRect(clip.box, clip.frame, placement, body);
      assert.ok(Math.abs(rect.h - 0.2 * body.h) < 1e-6);
      assert.ok(Math.abs(rect.x + rect.w / 2 - 0.5 * body.w) < 1e-6);
      assert.ok(Math.abs(rect.y + rect.h / 2 - 0.12 * body.h) < 1e-6);
      assert.equal(matchStandard({ box: clip.box, placement, body, standard, rigKey: "front" }).state, "match");
    }
  });

  test("match reports large and small outside the tolerance", () => {
    const standard: HeadStandard = { height: 0.2, centerX: 0.5, centerY: 0.12 };
    const box = { x: 0, y: 0, w: 100, h: 400 };
    const at = (headScale: number) =>
      matchStandard({ box, placement: { anchorX: 0.5, anchorY: 0.1, headScale }, body, standard, rigKey: "front" });
    assert.equal(at(1).state, "match");
    assert.equal(at(1.02).state, "match");
    assert.equal(at(1.1).state, "large");
    assert.equal(at(0.9).state, "small");
  });

  test("front defines the standard, other views store a multiplier", () => {
    const box = { x: 100, y: 100, w: 300, h: 400 };
    const frame = { w: 600, h: 700 };
    const placement = { anchorX: 0.5, anchorY: 0.15, headScale: 0.9 };
    const base = standardFromHead({ box, frame, placement, body, rigKey: "front", current: null });
    assert.ok(Math.abs(base.height - (400 * 0.9) / 2000) < 1e-9);

    const side = standardFromHead({
      box,
      frame,
      placement: { ...placement, headScale: 0.9 * 1.05 },
      body,
      rigKey: "left_side",
      current: base,
    });
    assert.equal(side.height, base.height);
    assert.ok(Math.abs((side.views?.left_side ?? 0) - 1.05) < 1e-9);
    assert.ok(Math.abs(targetHeightFraction(side, "left_side") - base.height * 1.05) < 1e-9);
    assert.equal(targetHeightFraction(side, "back"), base.height);

    const reset = standardFromHead({ box, frame, placement, body, rigKey: "left_side", current: side });
    assert.equal(reset.views?.left_side, undefined);
  });

  test("a non-front view with no standard yet creates the base", () => {
    const box = { x: 0, y: 0, w: 100, h: 200 };
    const standard = standardFromHead({
      box,
      frame: { w: 100, h: 200 },
      placement: { anchorX: 0.5, anchorY: 0.5, headScale: 2 },
      body,
      rigKey: "back",
      current: null,
    });
    assert.ok(Math.abs(standard.height - 400 / 2000) < 1e-9);
    assert.deepEqual(standard.views, {});
  });
});
