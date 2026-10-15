import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clampTrim,
  collectSnapTargets,
  placeInFreeSlot,
  rippleDelete,
  snapClipStart,
  snapEdgeFrame,
  trackSegEnd,
  type TrackSeg,
} from "../lib/headTimeline.ts";

const seg = (id: string, start: number, inFrame: number, outFrame: number): TrackSeg => ({ id, start, inFrame, outFrame });

describe("head rig timeline maths", () => {
  test("a clip dropped on top of another lands in the nearest free slot", () => {
    const others = [seg("a", 1, 1, 10), seg("b", 21, 1, 10)];
    assert.equal(placeInFreeSlot(others, 5, 5), 11);
    assert.equal(placeInFreeSlot(others, 16, 5), 16);
    assert.equal(placeInFreeSlot(others, 19, 5), 16);
    assert.equal(placeInFreeSlot([], 0, 5), 1);
  });

  test("a clip too big for the gap goes after the last clip", () => {
    const others = [seg("a", 1, 1, 10), seg("b", 14, 1, 10)];
    assert.equal(placeInFreeSlot(others, 8, 8), 24);
  });

  test("edges snap to the playhead and to neighbouring cuts", () => {
    const others = [seg("a", 1, 1, 10)];
    const targets = collectSnapTargets({ playhead: 30, tracks: [others], ignoreId: "me" });
    assert.deepEqual(snapClipStart(12, 5, targets, 3), { start: 11, snappedTo: 11 });
    assert.deepEqual(snapClipStart(26, 5, targets, 3), { start: 25, snappedTo: 30 });
    assert.deepEqual(snapClipStart(50, 5, targets, 3), { start: 50, snappedTo: null });
    assert.deepEqual(snapEdgeFrame(29, targets, 2), { frame: 30, snappedTo: 30 });
  });

  test("trimming never covers a neighbour or runs past the source", () => {
    const left = seg("l", 1, 1, 10);
    const mid = seg("m", 14, 3, 12);
    const right = seg("r", 30, 1, 5);
    const others = [left, right];
    assert.equal(clampTrim({ edge: "in", seg: mid, others, shift: -50, sourceFrameCount: 40 }), -2);
    assert.equal(clampTrim({ edge: "in", seg: mid, others, shift: 50, sourceFrameCount: 40 }), 9);
    assert.equal(clampTrim({ edge: "out", seg: mid, others, shift: 100, sourceFrameCount: 40 }), 6);
    assert.equal(clampTrim({ edge: "out", seg: mid, others: [left], shift: 100, sourceFrameCount: 15 }), 3);
    assert.equal(clampTrim({ edge: "out", seg: mid, others, shift: -100, sourceFrameCount: 40 }), -9);
  });

  test("ripple delete closes the gap and leaves earlier clips alone", () => {
    const list = [seg("a", 1, 1, 10), seg("b", 11, 1, 5), seg("c", 20, 1, 5)];
    const next = rippleDelete(list, "b");
    assert.deepEqual(next.map((s) => [s.id, s.start]), [["a", 1], ["c", 15]]);
    assert.equal(trackSegEnd(next[1]), 19);
  });
});
