import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blocksIntersectingView, cueSourceTimes, visibleCueIndexes } from "../lib/mouthCues.ts";

describe("mouth cue view helpers", () => {
  test("blocksIntersectingView keeps only the visible window", () => {
    const blocks = [
      { id: "a", startFrame: 0, endFrame: 24 },
      { id: "b", startFrame: 100, endFrame: 200 },
      { id: "c", startFrame: 40, endFrame: 50 },
    ];
    assert.deepEqual(
      blocksIntersectingView(blocks, 30, 60).map((block) => block.id),
      ["c"]
    );
  });

  test("visibleCueIndexes caps and uses clip-relative times", () => {
    const cues = [
      { shape: "A", start: 0, end: 0.2 },
      { shape: "B", start: 1, end: 1.2 },
      { shape: "C", start: 8, end: 8.2 },
    ];
    assert.deepEqual(visibleCueIndexes(cues, 0, 24, 20, 30), [1]);
    assert.equal(visibleCueIndexes(cues, 0, 24, 0, 400, 2).length, 2);
  });

  test("cueSourceTimes adds trim_in", () => {
    assert.deepEqual(cueSourceTimes({ shape: "B", start: 0.2, end: 0.5 }, 12, 24), { start: 0.7, end: 1 });
  });
});
