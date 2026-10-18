import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addSegment,
  fitRange,
  formatClock,
  freeBounds,
  parseClock,
  segmentRange,
  updateSegmentRange,
  type DialogueSegment,
} from "../lib/dialogueSegments.ts";

const seg = (id: string, startSec: number, endSec: number, text = ""): DialogueSegment => ({ id, startSec, endSec, text });

describe("dialogue segments", () => {
  test("two separate stretches of one recording can be picked", () => {
    let list = addSegment([], 12, 16.5, 60, "a");
    assert.ok(list);
    list = addSegment(list, 41.2, 47, 60, "b");
    assert.deepEqual(list?.map((s) => [s.id, s.startSec, s.endSec]), [["a", 12, 16.5], ["b", 41.2, 47]]);
  });

  test("a new segment is kept inside the recording and clear of its neighbours", () => {
    const list = [seg("a", 10, 20), seg("b", 30, 40)];
    assert.deepEqual(fitRange(list, 15, 35, 60, undefined, 15), null);
    assert.deepEqual(fitRange(list, 25, 55, 60, undefined, 25), { startSec: 25, endSec: 30 });
    assert.deepEqual(fitRange(list, 21, 35, 60), { startSec: 21, endSec: 30 });
    assert.deepEqual(fitRange(list, 55, 70, 60), { startSec: 55, endSec: 60 });
    assert.equal(addSegment(list, 25, 25.1, 60, "c"), null);
    assert.deepEqual(freeBounds(list, 25, 60), { min: 20, max: 30 });
  });

  test("dragging backwards works and resizing ignores the segment itself", () => {
    assert.deepEqual(fitRange([], 9, 4, 60), { startSec: 4, endSec: 9 });
    const list = [seg("a", 10, 20), seg("b", 30, 40)];
    const grown = updateSegmentRange(list, "a", 8, 28, 60);
    assert.deepEqual([grown[0].startSec, grown[0].endSec], [8, 28]);
    const blocked = updateSegmentRange(list, "a", 8, 35, 60);
    assert.deepEqual([blocked[0].startSec, blocked[0].endSec], [8, 30]);
  });

  test("the range sent to the talking head carries the typed words over exactly that stretch", () => {
    assert.deepEqual(segmentRange("audio/t/001_rodney.wav", seg("a", 12, 16.5)), {
      audioRel: "audio/t/001_rodney.wav",
      inSec: 12,
      durationSec: 4.5,
    });
    assert.deepEqual(segmentRange("audio/t/001_rodney.wav", seg("a", 12, 16.5, "  Aloha  ")), {
      audioRel: "audio/t/001_rodney.wav",
      inSec: 12,
      durationSec: 4.5,
      text: "Aloha",
      textInSec: 12,
      textDurationSec: 4.5,
    });
  });

  test("times read and print as m:ss.s", () => {
    assert.equal(formatClock(83.46), "1:23.5");
    assert.equal(formatClock(4.2), "0:04.2");
    assert.equal(parseClock("1:23.5"), 83.5);
    assert.equal(parseClock("83.5"), 83.5);
    assert.equal(parseClock("4"), 4);
    assert.equal(parseClock("abc"), null);
    assert.equal(parseClock(""), null);
  });
});
