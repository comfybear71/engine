import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applySplitWrite,
  applyTrimWrite,
  emptyScriptHistory,
  formatAtTime,
  historyPush,
  historyRedo,
  historyUndo,
  idsForMarriedGroup,
  moveBlocksInScript,
  planSplit,
  planTrim,
  setAtTimeOnLine,
  setDurationOnLine,
  setTrimOnLine,
  setViewOnLine,
  splitDialogueText,
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

  test("trim a move writes over= and start-edge also writes at_time=", () => {
    const script = ["[Scene: Intro]", "[Move: Alice to=right over=2s]"].join("\n");
    const blocks = [
      {
        id: "m",
        scriptLine: 2,
        sceneId: "intro",
        startFrame: 0,
        endFrame: 48,
        timing: { kind: "over" as const },
        tag: "move",
      },
    ];
    const right = planTrim({
      blocks,
      ids: ["m"],
      edge: "out",
      newEdgeFrame: 24,
      scenes: [{ id: "intro", startFrame: 0 }],
      fps: 24,
      script,
    });
    assert.ok(right);
    assert.equal(applyTrimWrite(script, right).split("\n")[1], "[Move: Alice to=right over=1s]");
    const left = planTrim({
      blocks,
      ids: ["m"],
      edge: "in",
      newEdgeFrame: 24,
      scenes: [{ id: "intro", startFrame: 0 }],
      fps: 24,
      script,
    });
    assert.ok(left);
    assert.equal(applyTrimWrite(script, left).split("\n")[1], "[Move: Alice to=right over=1s at_time=1s]");
  });

  test("trim dialogue writes trim_in=/trim_out= and split keeps word timings", () => {
    assert.equal(
      setTrimOnLine("Alice: Hello there friend.", { trimIn: "0.5s", trimOut: "2s" }),
      "Alice trim_in=0.5s trim_out=2s: Hello there friend."
    );
    assert.equal(setDurationOnLine("[Swing: Alice right_arm=20 period=0.4s for=2s]", "for", "1s"), "[Swing: Alice right_arm=20 period=0.4s for=1s]");
    const words = [
      { word: "Hello", start: 0, end: 0.4 },
      { word: "there", start: 0.4, end: 0.8 },
      { word: "friend", start: 0.8, end: 1.2 },
    ];
    assert.deepEqual(splitDialogueText("Hello there friend", words, 0.8), { left: "Hello there", right: "friend" });
    const script = ["[Scene: Intro]", "Alice: Hello there friend."].join("\n");
    const blocks = [
      {
        id: "d",
        scriptLine: 2,
        sceneId: "intro",
        startFrame: 0,
        endFrame: 48,
        lane: "dialogue",
        timing: { kind: "dialogue" as const },
        trim: { inFrames: 0, outFrames: 48 },
        sourceDurationFrames: 72,
        words,
      },
    ];
    const split = planSplit({
      blocks,
      ids: ["d"],
      playhead: 24,
      scenes: [{ id: "intro", startFrame: 0 }],
      fps: 24,
      script,
    });
    assert.ok(split);
    const next = applySplitWrite(script, split);
    assert.equal(next.split("\n")[1], "Alice trim_out=1s: Hello there");
    assert.equal(next.split("\n")[2], "Alice at_time=1s trim_in=1s trim_out=2s: friend");
  });
});
