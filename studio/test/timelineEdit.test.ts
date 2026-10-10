import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emptyScriptHistory,
  formatAtTime,
  historyPush,
  historyRedo,
  historyUndo,
  idsForMarriedGroup,
  moveBlocksInScript,
  setAtTimeOnLine,
  setViewOnLine,
} from "../lib/timelineEdit.ts";

describe("timeline script rewrite", () => {
  test("move a block writes at_time= and undo/redo round-trips", () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Move: Alice to=right over=2s]",
      "Alice: Hello there.",
    ].join("\n");

    const moved = moveBlocksInScript(
      script,
      [{ scriptLine: 4, startFrame: 48, sceneStartFrame: 0 }],
      24
    );
    assert.equal(moved.split("\n")[3], "[Move: Alice to=right over=2s at_time=2s]");
    assert.equal(moved.split("\n")[4], "Alice: Hello there.");

    const movedLine = moveBlocksInScript(
      moved,
      [{ scriptLine: 5, startFrame: 12, sceneStartFrame: 0 }],
      24
    );
    assert.equal(movedLine.split("\n")[4], "Alice at_time=0.5s: Hello there.");

    let history = emptyScriptHistory();
    history = historyPush(history, script);
    const undone = historyUndo(history, moved);
    assert.ok(undone);
    assert.equal(undone.text, script);
    const redone = historyRedo(undone.history, undone.text);
    assert.ok(redone);
    assert.equal(redone.text, moved);
    const undoneAgain = historyUndo(redone.history, redone.text);
    assert.ok(undoneAgain);
    assert.equal(undoneAgain.text, script);
  });

  test("setAtTimeOnLine replaces start= and formats seconds", () => {
    assert.equal(formatAtTime(0, 24), "0s");
    assert.equal(formatAtTime(48, 24), "2s");
    assert.equal(formatAtTime(12, 24), "0.5s");
    assert.equal(
      setAtTimeOnLine("[Camera: zoom=1.3 over=2s start=24]", "1s"),
      "[Camera: zoom=1.3 over=2s at_time=1s]"
    );
    assert.equal(setAtTimeOnLine("  Alice start=10: Hi # note", "2s"), "  Alice at_time=2s: Hi # note");
    assert.equal(setViewOnLine("Alice: Hi", "left_side"), "Alice view=left_side: Hi");
    assert.equal(setViewOnLine("Alice view=up: Hi", "front"), "Alice: Hi");
    assert.equal(
      setViewOnLine("[Audio: Alice file=monologue at_time=2s]", "right_34"),
      "[Audio: Alice file=monologue at_time=2s view=right_34]"
    );
    const grouped = idsForMarriedGroup(
      [
        { id: "d", marriedId: "line:intro:4" },
        { id: "a", marriedId: "line:intro:4" },
        { id: "face", marriedId: null },
      ],
      ["d"]
    );
    assert.equal(grouped.has("a"), true);
    assert.equal(grouped.has("face"), false);
  });
});
