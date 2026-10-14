import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assembleHiddenPrompt,
  clampFactoryFrames,
  factoryGrid,
  factoryHint,
  factoryModeTitle,
  inferFactoryIntent,
  slugActionId,
  walkPoseNotes,
} from "../lib/factoryPrompt.ts";

describe("factory hidden prompt pack", () => {
  test("clamps frames to 8 / 12 / 16 and grids a square-ish sheet", () => {
    assert.equal(clampFactoryFrames(8), 8);
    assert.equal(clampFactoryFrames(12), 12);
    assert.equal(clampFactoryFrames(16), 16);
    assert.equal(clampFactoryFrames(9), 12);
    assert.deepEqual(factoryGrid(8), { cols: 4, rows: 2 });
    assert.deepEqual(factoryGrid(16), { cols: 4, rows: 4 });
  });

  test("a plain walk prompt becomes a long-stride side walk pack", () => {
    const intent = inferFactoryIntent("Rodney walking long stride");
    assert.equal(intent.kind, "walk");
    assert.equal(intent.view, "right_side");
    assert.equal(slugActionId("Rodney walking long stride", intent), "walk_side_long_stride");
    const hidden = assembleHiddenPrompt({
      character: { id: "rodney", display_name: "Rodney", style: "", slots: [] },
      userPrompt: "Rodney walking long stride",
      frames: 8,
    });
    assert.match(hidden, /#00FF00/);
    assert.match(hidden, /Only one head/);
    assert.match(hidden, /never full heads/i);
    assert.match(hidden, /heel landing first/);
    assert.match(hidden, /4x2/);
    assert.match(walkPoseNotes(12), /Twelve frames/);
  });

  test("context-aware Factory hints and slot header", () => {
    assert.match(
      factoryHint("character", { character: { id: "rodney", display_name: "Rodney", style: "", slots: [] } }),
      /Import MP4/
    );
    assert.equal(factoryHint("prop"), "Type the prop you want (e.g. guitar, bar stool)");
    assert.equal(factoryHint("new-character"), "Describe a new character (e.g. grumpy old barman)");
    assert.equal(factoryHint("slot", { slot: "eyes" }), "Type an expression, e.g. angry, sleepy");
    assert.equal(
      factoryModeTitle({
        mode: "slot",
        character: { id: "rodney", display_name: "Rodney", style: "" },
        slot: "eyes",
        view: "front",
      }),
      "Rodney / Front / Eyes"
    );
    const hidden = assembleHiddenPrompt({
      mode: "slot",
      character: { id: "rodney", display_name: "Rodney", style: "" },
      userPrompt: "sleepy",
      slot: "eyes",
      view: "front",
    });
    assert.match(hidden, /ONLY the eyes/i);
    assert.match(hidden, /Never draw a full head/i);
    assert.equal(
      factoryHint("slot", { slot: "arm", label: "Arms" }),
      "Type a whole-arm pose, e.g. grip mic, point. Labelled L or R."
    );
    assert.equal(
      factoryModeTitle({
        mode: "slot",
        character: { id: "rodney", display_name: "Rodney", style: "" },
        slot: "arm",
        view: "front",
        label: "Arms",
      }),
      "Rodney / Front / Arms"
    );
    const arm = assembleHiddenPrompt({
      mode: "slot",
      character: { id: "rodney", display_name: "Rodney", style: "" },
      userPrompt: "grip mic",
      slot: "arm",
      view: "front",
      label: "Arms",
    });
    assert.match(arm, /whole arm/i);
    assert.match(arm, /knuckles face OUT/i);
    assert.match(arm, /thumb on top/i);
    assert.doesNotMatch(arm, /two heads/i);
  });
});
