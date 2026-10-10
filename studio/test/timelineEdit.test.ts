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
  isMouthBlock,
  moveBlocksInScript,
  pinDurationWriteAttr,
  shiftLanesForMove,
  shiftLanesForSplit,
  shiftLanesForView,
  preserveLaneCues,
  shiftLanesForTrim,
  shiftPlaybackAudio,
  planSplit,
  planTrim,
  setAtTimeOnLine,
  setDurationOnLine,
  setTrimOnLine,
  setViewOnLine,
  splitDialogueText,
  expandDialogueSyncWindows,
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

    const many = Array.from({ length: 50 }, (_, i) => `Hicks at_time=${i}s: Line ${i}.`);
    const fat = ["[Scene: Intro]", "[Cast: Hicks]", ...many].join("\n");
    const moves = many.map((_, i) => ({ scriptLine: i + 3, startFrame: (i + 2) * 24, sceneStartFrame: 0 }));
    const t0 = performance.now();
    const shifted = moveBlocksInScript(fat, moves, 24);
    const rewriteMs = performance.now() - t0;
    assert.equal(shifted.split("\n")[2], "Hicks at_time=2s: Line 0.");
    assert.equal(shifted.split("\n")[51], "Hicks at_time=51s: Line 49.");
    assert.ok(rewriteMs < 50, `batched rewrite ${rewriteMs}ms`);

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

  test("trim a split Audio block writes source in/out and keeps both pieces", () => {
    const script = ["[Scene: Intro]", "[Audio: Alice file=monologue]"].join("\n");
    const audio = {
      id: "a",
      scriptLine: 2,
      sceneId: "intro",
      startFrame: 0,
      endFrame: 96,
      lane: "audio" as const,
      timing: { kind: "audio" as const },
      trim: { inFrames: 0, outFrames: 96 },
      sourceDurationFrames: 96,
      tag: "audio",
      movable: true,
    };
    const scenes = [{ id: "intro", startFrame: 0 }];
    const split = planSplit({
      blocks: [audio],
      ids: ["a"],
      playhead: 48,
      scenes,
      fps: 24,
      script,
    });
    assert.ok(split);
    const splitScript = applySplitWrite(script, split);
    assert.equal(splitScript.split("\n")[1], "[Audio: Alice file=monologue trim_out=2s]");
    assert.equal(splitScript.split("\n")[2], "[Audio: Alice file=monologue at_time=2s trim_in=2s]");

    const left = {
      ...audio,
      id: "l",
      endFrame: 48,
      trim: { inFrames: 0, outFrames: 48 },
    };
    const right = {
      ...audio,
      id: "r",
      scriptLine: 3,
      startFrame: 48,
      sourceStartFrame: 48,
      trim: { inFrames: 48, outFrames: 96 },
    };
    const afterSplit = [left, right];
    const rightOut = planTrim({
      blocks: afterSplit,
      ids: ["r"],
      edge: "out",
      newEdgeFrame: 72,
      scenes,
      fps: 24,
      script: splitScript,
    });
    assert.ok(rightOut);
    assert.equal(
      applyTrimWrite(splitScript, rightOut).split("\n")[2],
      "[Audio: Alice file=monologue at_time=2s trim_in=2s trim_out=3s]"
    );
    const leftIn = planTrim({
      blocks: afterSplit,
      ids: ["l"],
      edge: "in",
      newEdgeFrame: 12,
      scenes,
      fps: 24,
      script: splitScript,
    });
    assert.ok(leftIn);
    assert.equal(
      applyTrimWrite(splitScript, leftIn).split("\n")[1],
      "[Audio: Alice file=monologue at_time=0.5s trim_in=0.5s trim_out=2s]"
    );

    const lanes = {
      fps: 24,
      totalFrames: 96,
      lanes: ["audio"],
      scenes: [{ id: "intro", startFrame: 0, endFrame: 96, frames: 96 }],
      blocks: afterSplit,
    };
    const trimmedRight = shiftLanesForTrim(lanes, ["r"], "out", 72);
    const rightBlock = trimmedRight.blocks.find((block) => block.id === "r");
    assert.equal(rightBlock?.startFrame, 48);
    assert.equal(rightBlock?.endFrame, 72);
    assert.deepEqual(rightBlock?.trim, { inFrames: 48, outFrames: 72 });
    const trimmedLeft = shiftLanesForTrim(lanes, ["l"], "in", 12);
    const leftBlock = trimmedLeft.blocks.find((block) => block.id === "l");
    assert.equal(leftBlock?.startFrame, 12);
    assert.equal(leftBlock?.endFrame, 48);
    assert.deepEqual(leftBlock?.trim, { inFrames: 12, outFrames: 48 });
    const undo = historyUndo(historyPush(emptyScriptHistory(), splitScript), applyTrimWrite(splitScript, rightOut));
    assert.ok(undo);
    assert.equal(undo.text, splitScript);
  });

  test("optimistic split does not duplicate dialogue chips", () => {
    const split = planSplit({
      blocks: [
        {
          id: "d1",
          scriptLine: 2,
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          lane: "dialogue",
          timing: { kind: "dialogue" as const },
          trim: { inFrames: 0, outFrames: 96 },
          sourceDurationFrames: 96,
          sourceStartFrame: 0,
          movable: true,
        },
        {
          id: "d2",
          scriptLine: 2,
          sceneId: "intro",
          startFrame: 24,
          endFrame: 72,
          lane: "dialogue",
          timing: { kind: "dialogue" as const },
          trim: { inFrames: 0, outFrames: 96 },
          sourceDurationFrames: 96,
          sourceStartFrame: 0,
          movable: true,
        },
        {
          id: "a",
          scriptLine: 2,
          sceneId: "intro",
          startFrame: 0,
          endFrame: 96,
          lane: "audio",
          timing: { kind: "audio" as const },
          trim: { inFrames: 0, outFrames: 96 },
          sourceDurationFrames: 96,
          sourceStartFrame: 0,
          movable: true,
        },
      ],
      ids: ["a", "d1", "d2"],
      playhead: 48,
      scenes: [{ id: "intro", startFrame: 0 }],
      fps: 24,
      script: ["[Scene: Intro]", "[Audio: Alice file=monologue]"].join("\n"),
    });
    assert.ok(split);
    const t0 = performance.now();
    const next = shiftLanesForSplit(
      {
        fps: 24,
        totalFrames: 96,
        lanes: ["dialogue", "audio"],
        scenes: [{ id: "intro", startFrame: 0, endFrame: 96, frames: 96 }],
        blocks: [
          {
            id: "d1",
            scriptLine: 2,
            sceneId: "intro",
            startFrame: 0,
            endFrame: 24,
            lane: "dialogue",
            trim: { inFrames: 0, outFrames: 96 },
            sourceStartFrame: 0,
          },
          {
            id: "d2",
            scriptLine: 2,
            sceneId: "intro",
            startFrame: 24,
            endFrame: 72,
            lane: "dialogue",
            trim: { inFrames: 0, outFrames: 96 },
            sourceStartFrame: 0,
          },
          {
            id: "a",
            scriptLine: 2,
            sceneId: "intro",
            startFrame: 0,
            endFrame: 96,
            lane: "audio",
            trim: { inFrames: 0, outFrames: 96 },
            sourceStartFrame: 0,
          },
        ],
      },
      [split],
      48
    );
    const ms = performance.now() - t0;
    const dialogue = next.blocks.filter((block) => block.lane === "dialogue");
    const audio = next.blocks.filter((block) => block.lane === "audio");
    assert.equal(audio.length, 2);
    assert.equal(dialogue.length, 3);
    assert.equal(dialogue.filter((block) => block.startFrame < 48).length, 2);
    assert.equal(dialogue.filter((block) => block.startFrame >= 48).length, 1);
    const at20 = dialogue.filter((block) => block.startFrame <= 24 && block.endFrame > 24);
    assert.equal(at20.length, 1);
    assert.ok(ms < 5, `optimistic split ${ms}ms`);
  });

  test("split near the end of an untrimmed Audio line keeps both halves", () => {
    const script = ["[Scene: Intro]", "[Audio: Alice file=monologue]"].join("\n");
    const blocks = [
      {
        id: "a",
        scriptLine: 2,
        sceneId: "intro",
        startFrame: 0,
        endFrame: 216,
        lane: "audio",
        timing: { kind: "audio" as const },
        trim: { inFrames: 0, outFrames: 216 },
        sourceDurationFrames: 216,
        sourceStartFrame: 0,
        movable: true,
      },
    ];
    const write = planSplit({
      blocks,
      ids: ["a"],
      playhead: 192,
      scenes: [{ id: "intro", startFrame: 0 }],
      fps: 24,
      script,
    });
    assert.ok(write);
    const next = applySplitWrite(script, write);
    const lines = next.split("\n");
    assert.match(lines[1], /trim_out=/);
    assert.match(lines[2], /\[Audio: Alice file=monologue /);
    assert.match(lines[2], /trim_in=/);
    assert.equal(/\btrim_out=/.test(lines[2]), false);
    const optimistic = shiftLanesForSplit(
      {
        fps: 24,
        totalFrames: 216,
        lanes: ["audio"],
        scenes: [{ id: "intro", startFrame: 0, endFrame: 216, frames: 216 }],
        blocks,
      },
      [write],
      192
    );
    const audio = optimistic.blocks.filter((block) => block.lane === "audio");
    assert.equal(audio.length, 2);
    assert.equal(audio[0].endFrame, 192);
    assert.equal(audio[1].startFrame, 192);
    assert.ok((audio[1].trim?.outFrames || 0) > (audio[1].trim?.inFrames || 0));
  });

  test("changing view does not drop mouth cues on other chips", () => {
    const lanes = {
      fps: 24,
      totalFrames: 48,
      lanes: ["dialogue", "mouth"],
      scenes: [{ id: "intro", startFrame: 0, endFrame: 48, frames: 48 }],
      blocks: [
        {
          id: "d1",
          scriptLine: 2,
          startFrame: 0,
          endFrame: 24,
          lane: "dialogue",
          view: null,
          cues: [{ shape: "A", start: 0, end: 0.4 }],
        },
        {
          id: "d2",
          scriptLine: 3,
          startFrame: 24,
          endFrame: 48,
          lane: "dialogue",
          view: null,
          cues: [{ shape: "B", start: 0, end: 0.3 }],
        },
      ],
    };
    const next = shiftLanesForView(lanes, 2, "left_side");
    assert.equal(next.blocks[0].view, "left_side");
    assert.deepEqual(next.blocks[0].cues, [{ shape: "A", start: 0, end: 0.4 }]);
    assert.equal(next.blocks[1].view, null);
    assert.deepEqual(next.blocks[1].cues, [{ shape: "B", start: 0, end: 0.3 }]);
    assert.equal(setViewOnLine("[Audio: Alice file=monologue]", "left_side"), "[Audio: Alice file=monologue view=left_side]");
    const emptied = {
      ...next,
      blocks: next.blocks.map((block) => ({ ...block, cues: [], view: "left_side" })),
    };
    const preserved = preserveLaneCues(next, emptied);
    assert.deepEqual(preserved.blocks[0].cues, [{ shape: "A", start: 0, end: 0.4 }]);
    assert.deepEqual(preserved.blocks[1].cues, [{ shape: "B", start: 0, end: 0.3 }]);
    assert.equal(preserved.blocks[0].view, "left_side");
  });

  test("SYNC ALL expands a 9-minute chip so the last window is near 8:40", () => {
    const parts = expandDialogueSyncWindows({ inSec: 0, outSec: 540 });
    assert.ok(parts.length >= 67);
    assert.ok(parts[parts.length - 1].inSec >= 520);
    assert.equal(parts[parts.length - 1].outSec, 540);
    assert.deepEqual(expandDialogueSyncWindows({ inSec: 520, outSec: 524 }), [{ inSec: 520, outSec: 524 }]);
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

  test("moving a face pin writes at_time= and locks hold= so it does not stretch", () => {
    const script = ["[Scene: Intro]", "[Action: Rodney face=yap]", "[Action: Rodney face=rest]"].join("\n");
    const moved = moveBlocksInScript(
      script,
      [{ scriptLine: 2, startFrame: 12, sceneStartFrame: 0, hold: "0.5s" }],
      24
    );
    assert.equal(moved.split("\n")[1], "[Action: Rodney face=yap at_time=0.5s hold=0.5s]");
    assert.equal(pinDurationWriteAttr("[Action: Rodney face=yap over=1s]"), "over");
    assert.equal(pinDurationWriteAttr("[Action: Rodney face=yap]"), "hold");
    assert.equal(isMouthBlock({ role: "mouth" }), true);
    assert.equal(isMouthBlock({ tag: "action" }), false);
  });

  test("shiftLanesForMove updates every selected block in one pass", () => {
    const blocks = Array.from({ length: 146 }, (_, i) => ({
      id: `b${i}`,
      lane: i % 3 === 0 ? "dialogue" : i % 3 === 1 ? "mouth" : "audio",
      startFrame: i * 24,
      endFrame: i * 24 + 12,
      scriptLine: Math.floor(i / 3) + 1,
      sourceStartFrame: i * 24,
      sceneId: "s1",
      rel: i % 3 === 2 ? `audio/hicks/${i}.wav` : null,
    }));
    const lanes = {
      fps: 24,
      totalFrames: 146 * 24,
      lanes: ["dialogue"],
      scenes: [{ id: "s1", startFrame: 0, endFrame: 146 * 24, frames: 146 * 24 }],
      blocks,
    };
    const t0 = performance.now();
    const next = shiftLanesForMove(lanes, blocks.map((b) => b.id), -24);
    const ms = performance.now() - t0;
    assert.equal(next.blocks[0].startFrame, 0);
    assert.equal(next.blocks[3].startFrame, 48);
    assert.equal(next.blocks[3].endFrame, 60);
    assert.equal(next.scenes[0].startFrame, 0);
    assert.ok(next.totalFrames < lanes.totalFrames);
    assert.ok(ms < 20, `optimistic shift ${ms}ms`);
    const audio = shiftPlaybackAudio(
      [{ startFrame: 48, endFrame: 60, rel: "audio/hicks/5.wav" }],
      -24,
      [48]
    );
    assert.deepEqual(audio[0], { startFrame: 24, endFrame: 36, rel: "audio/hicks/5.wav" });
  });
});
