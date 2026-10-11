import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyCollar,
  autoFitHeadNudge,
  canvasLandmarks,
  clampHeadNudge,
  defaultHeadNudge,
  fitBodyPlusHead,
  headScaleToSlider,
  landmarksFromRgba,
  previewAlignLayout,
  residualHeadNudge,
  sliderToHeadScale,
} from "../lib/headAlign.ts";
import {
  cueAtTime,
  formatUsage,
  mouthSound,
  needIdForSlot,
  neighborDrawing,
  remapLipSyncShape,
  RHUBARB_SHAPES,
} from "../lib/assetEditor.ts";

describe("asset editor helpers", () => {
  test("mouth cells use Rhubarb letters and the requested plain-English sounds", () => {
    assert.deepEqual([...RHUBARB_SHAPES], ["X", "A", "B", "C", "D", "E", "F", "G", "H"]);
    assert.equal(mouthSound("X"), "rest");
    assert.equal(mouthSound("A"), "closed M/B/P");
    assert.equal(mouthSound("B"), "slightly open EE");
    assert.equal(mouthSound("C"), "open EH");
    assert.equal(mouthSound("D"), "wide AH");
    assert.equal(mouthSound("E"), "round OH");
    assert.equal(mouthSound("F"), "pursed OO");
    assert.equal(mouthSound("G"), "teeth-on-lip F/V");
    assert.equal(mouthSound("H"), "tongue L");
    assert.equal(mouthSound("A_loud"), "closed M/B/P");
  });

  test("prev/next wraps inside the same slot list", () => {
    assert.equal(neighborDrawing(["X", "A", "B"], "A", 1), "B");
    assert.equal(neighborDrawing(["X", "A", "B"], "B", 1), "X");
    assert.equal(neighborDrawing(["X", "A", "B"], "X", -1), "B");
  });

  test("needIdForSlot maps a slot to the Imagine set, preferring a pack cell match", () => {
    assert.equal(needIdForSlot("mouth"), "mouth_sheet");
    assert.equal(needIdForSlot("mouth_left_side"), "mouth_sheet");
    assert.equal(needIdForSlot("eyes"), "expression_heads");
    assert.equal(
      needIdForSlot("eyes", [{ id: "eyes", cells: [{ dest: { slot: "eyes", drawings_dir: "eyes" } }] }]),
      "eyes"
    );
    assert.equal(needIdForSlot("right_hand"), "arm_hand");
    assert.equal(needIdForSlot("mic_arm"), "arm_hand");
    assert.equal(
      needIdForSlot("head", [
        { id: "comedy_expressions", cells: [{ dest: { slot: "head", drawings_dir: "head" } }] },
      ]),
      "comedy_expressions"
    );
  });

  test("lip-sync sample stepping picks the shape for the current time", () => {
    const cues = [
      { shape: "X", start: 0, end: 0.2 },
      { shape: "A", start: 0.2, end: 0.5 },
      { shape: "D", start: 0.5, end: 0.9 },
    ];
    assert.equal(cueAtTime(cues, 0), "X");
    assert.equal(cueAtTime(cues, 0.2), "A");
    assert.equal(cueAtTime(cues, 0.7), "D");
    assert.match(formatUsage({ kind: "dialogue", script: "script.txt", line: 4, text: "Dee: Hi." }), /script.txt:4/);
  });

  test("excluded H remaps to an open mouth, not the tongue drawing", () => {
    assert.equal(remapLipSyncShape("H", ["H"]), "C");
    assert.equal(remapLipSyncShape("H", ["H", "C"]), "D");
    assert.equal(remapLipSyncShape("H", ["H", "C", "D"], "B"), "B");
    assert.equal(remapLipSyncShape("B", ["H"]), "B");
  });

  test("head nudge clamps to a 0.25x–4x range and the scale slider is logarithmic", () => {
    assert.deepEqual(defaultHeadNudge(), { x: 0, y: 0, scale: 1 });
    const clamped = clampHeadNudge({ x: 999, y: -999, scale: 8 });
    assert.equal(clamped.x, 400);
    assert.equal(clamped.y, -400);
    assert.equal(clamped.scale, 4);
    assert.equal(sliderToHeadScale(0), 0.25);
    assert.equal(sliderToHeadScale(1), 4);
    assert.ok(Math.abs(sliderToHeadScale(0.5) - 1) < 1e-9);
    assert.ok(Math.abs(headScaleToSlider(1) - 0.5) < 1e-9);
    const residual = residualHeadNudge({ x: 0, y: 0, scale: 3.2 }, 3.2);
    assert.ok(Math.abs(residual.scale - 1) < 1e-9);
  });

  test("auto-fit scales a small cropped head to the default hat/chin height", () => {
    const w = 8;
    const h = 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const i = (y * w + x) * 4;
        rgba[i] = 255;
        rgba[i + 3] = 255;
      }
    }
    const src = landmarksFromRgba(rgba, w, h);
    assert.equal(src.hat.y, 2);
    assert.equal(src.chin.y, 6);
    const ref = canvasLandmarks(24, 24);
    ref.hat = { x: 12, y: 0 };
    ref.chin = { x: 12, y: 8 };
    ref.neck = { x: 12, y: 8 };
    const cropped = applyCollar(src, 0.5);
    assert.equal(cropped.chin.y, 4);
    const fit = autoFitHeadNudge(cropped, ref);
    assert.equal(fit.scale, 4);
    const layout = previewAlignLayout({
      boxW: 240,
      boxH: 240,
      srcW: 8,
      srcH: 8,
      refW: 24,
      refH: 24,
      src: cropped,
      ref,
      nudge: fit,
    });
    assert.ok(layout.src.height > layout.ref.height * 0.4);
    assert.ok(Math.abs(layout.src.width / layout.ref.width - (8 * fit.scale) / 24) < 1e-9);
  });

  test("align viewport fits a head that sits above the body", () => {
    const fit = fitBodyPlusHead({
      bodyW: 200,
      bodyH: 400,
      headCenter: { x: 100, y: -20 },
      headW: 80,
      headH: 80,
      headScale: 1,
      boxW: 400,
      boxH: 400,
    });
    assert.ok(fit.bodyTop > 0);
    const headTop = fit.bodyTop + (-20) * fit.scale - 40 * fit.scale;
    assert.ok(headTop >= 0, `head top ${headTop}`);
    assert.ok(fit.bodyTop + fit.bodyHeight <= 400);
  });
});
