import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clipboardFromBlocks,
  clipboardItemFitsLane,
  deleteBlocksInScript,
  duplicateBlocksInScript,
  pasteClipboardInScript,
  pinMissingAtTimes,
  selectionIsMouthOnly,
} from "../lib/timelineClipboard.ts";

const scenes = [{ id: "intro", startFrame: 0, endFrame: 96, frames: 96 }];

const script = [
  "[Scene: Intro]",
  "[Location: room_a]",
  "[Cast: Alice]",
  "[Action: Alice eyes=open]",
  "Alice: Hello there.",
  "[Action: Alice right_hand=point]",
  "Alice: Later line.",
].join("\n");

const blocks = [
  { id: "eyes", scriptLine: 4, sceneId: "intro", startFrame: 0, endFrame: 24, lane: "face", tag: "action" },
  { id: "d1", scriptLine: 5, sceneId: "intro", startFrame: 0, endFrame: 24, lane: "dialogue", marriedId: "line:intro:5" },
  { id: "a1", scriptLine: 5, sceneId: "intro", startFrame: 0, endFrame: 24, lane: "audio", marriedId: "line:intro:5" },
  { id: "m1", scriptLine: 5, sceneId: "intro", startFrame: 0, endFrame: 24, lane: "mouth", tag: "mouth", role: "mouth", marriedId: "line:intro:5" },
  { id: "hand", scriptLine: 6, sceneId: "intro", startFrame: 24, endFrame: 48, lane: "body", tag: "action" },
  { id: "d2", scriptLine: 7, sceneId: "intro", startFrame: 24, endFrame: 48, lane: "dialogue", marriedId: "line:intro:7" },
];

describe("timeline clipboard and delete", () => {
  test("delete pins later sequential lines so the gap stays", () => {
    const next = deleteBlocksInScript({
      script,
      blocks,
      ids: ["d1"],
      scenes,
      fps: 24,
      ripple: false,
    });
    const lines = next.split("\n");
    assert.equal(lines.some((line) => line.startsWith("Alice: Hello there.")), false);
    assert.equal(lines.includes("[Action: Alice eyes=open at_time=0s]"), true);
    assert.equal(lines.includes("[Action: Alice right_hand=point at_time=1s]"), true);
    assert.equal(lines.includes("Alice at_time=1s: Later line."), true);
  });

  test("ripple delete shifts later at_time= left on all lanes", () => {
    const next = deleteBlocksInScript({
      script,
      blocks,
      ids: ["d1"],
      scenes,
      fps: 24,
      ripple: true,
    });
    const lines = next.split("\n");
    assert.equal(lines.includes("[Action: Alice right_hand=point at_time=0s]"), true);
    assert.equal(lines.includes("Alice at_time=0s: Later line."), true);
    assert.equal(lines.some((line) => /Hello there/.test(line)), false);
  });

  test("mouth-only selection is not a script-line delete", () => {
    assert.equal(selectionIsMouthOnly(blocks, ["m1"]), true);
    assert.equal(selectionIsMouthOnly(blocks, ["d1"]), false);
    assert.equal(selectionIsMouthOnly(blocks, ["d1", "m1"]), false);
  });

  test("paste copies the married audio/dialogue line at the playhead", () => {
    const clip = clipboardFromBlocks(script, blocks, ["d1"]);
    assert.equal(clip.items.length, 1);
    assert.match(clip.items[0].lineText, /Alice: Hello there/);
    const pasted = pasteClipboardInScript({
      script,
      clipboard: clip,
      playhead: 48,
      fps: 24,
      scenes,
      playheadLine: 7,
      lane: "dialogue",
    });
    assert.match(pasted, /Alice at_time=2s: Hello there/);
    assert.equal(pasted.split("\n").filter((line) => /Hello there/.test(line)).length, 2);
  });

  test("paste into a lane only keeps fitting block types", () => {
    const face = clipboardFromBlocks(script, blocks, ["eyes"]);
    const ontoBody = pasteClipboardInScript({
      script,
      clipboard: face,
      playhead: 12,
      fps: 24,
      scenes,
      playheadLine: 4,
      lane: "body",
    });
    assert.equal(ontoBody, script);
    assert.equal(clipboardItemFitsLane(face.items[0], "face"), true);
    const speech = clipboardFromBlocks(script, blocks, ["a1"]);
    assert.equal(clipboardItemFitsLane(speech.items[0], "audio"), true);
    assert.equal(clipboardItemFitsLane(speech.items[0], "body"), false);
  });

  test("duplicate writes a copy at the end of the original span", () => {
    const next = duplicateBlocksInScript({
      script,
      blocks,
      ids: ["hand"],
      fps: 24,
      scenes,
    });
    assert.match(next, /\[Action: Alice right_hand=point at_time=2s\]/);
  });

  test("pinMissingAtTimes writes at_time= only where it is missing", () => {
    const pinned = pinMissingAtTimes(script, blocks, scenes, 24);
    assert.equal(pinned.split("\n")[3], "[Action: Alice eyes=open at_time=0s]");
    assert.equal(pinned.split("\n")[4], "Alice at_time=0s: Hello there.");
    const already = pinMissingAtTimes(pinned, blocks, scenes, 24);
    assert.equal(already, pinned);
  });
});
