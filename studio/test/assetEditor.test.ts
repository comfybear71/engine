import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampHeadNudge, defaultHeadNudge } from "../lib/headAlign.ts";
import {
  cueAtTime,
  formatUsage,
  mouthSound,
  needIdForSlot,
  neighborDrawing,
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

  test("head nudge clamps to a small usable range", () => {
    assert.deepEqual(defaultHeadNudge(), { x: 0, y: 0, scale: 1 });
    const clamped = clampHeadNudge({ x: 999, y: -999, scale: 8 });
    assert.equal(clamped.x, 400);
    assert.equal(clamped.y, -400);
    assert.equal(clamped.scale, 3);
  });
});
