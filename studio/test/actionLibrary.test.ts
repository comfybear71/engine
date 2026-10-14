import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_ACTION_CATEGORIES,
  actionShotBadge,
  groupActionsByCategory,
  inferActionCategory,
  issueLabel,
  mergeCategories,
} from "../lib/actionLibrary.ts";

describe("action library grouping", () => {
  test("default categories match the Action Shots page", () => {
    assert.deepEqual(
      DEFAULT_ACTION_CATEGORIES.map((item) => [item.id, item.label]),
      [
        ["walks", "Walks"],
        ["turns_looks", "Turns/Looks"],
        ["head_moves", "Head moves"],
        ["mic", "Mic"],
        ["arms_gestures", "Arms/Gestures"],
        ["expressions", "Expressions"],
        ["idle_stand", "Idle/Stand"],
        ["inserts", "Inserts"],
        ["other", "Other"],
      ]
    );
  });

  test("infer category from action id and keep explicit values", () => {
    assert.equal(inferActionCategory("silly_walk_side"), "walks");
    assert.equal(inferActionCategory("generated_video_mic"), "mic");
    assert.equal(inferActionCategory("head_only_movement"), "head_moves");
    assert.equal(inferActionCategory("look_left"), "turns_looks");
    assert.equal(inferActionCategory("wave", "arms_gestures"), "arms_gestures");
  });

  test("group actions by category and keep empty defaults out of the filtered list", () => {
    const grouped = groupActionsByCategory([
      { id: "silly_walk_side", name: "silly_walk_side", category: "walks" },
      { id: "grab_mic", name: "grab_mic", category: "mic" },
      { id: "custom", name: "custom", category: "bites" },
    ]);
    const filled = grouped.filter((group) => group.actions.length);
    assert.deepEqual(
      filled.map((group) => [group.id, group.actions.length]),
      [
        ["walks", 1],
        ["mic", 1],
        ["bites", 1],
      ]
    );
  });

  test("merge custom categories and badge still vs N shots", () => {
    const cats = mergeCategories([{ id: "Bites!", label: "Bites" }]);
    assert.ok(cats.some((item) => item.id === "bites" && item.label === "Bites"));
    assert.equal(actionShotBadge({ still: true, frames: 1 }), "still");
    assert.equal(actionShotBadge({ frames: 8 }), "8 shots");
    assert.equal(issueLabel("arm_side"), "wrong arm/side");
    assert.equal(issueLabel("upside_down"), "upside down");
  });
});
