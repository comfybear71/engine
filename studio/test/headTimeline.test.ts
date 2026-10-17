import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applySpeed,
  clampTrim,
  collectSnapTargets,
  placeInFreeSlot,
  repeatSegment,
  rippleDelete,
  snapClipStart,
  snapEdgeFrame,
  sourceFrameAt,
  splitSegment,
  trackSegEnd,
  trackSegLength,
  trimPatch,
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

  test("speed shortens or lengthens a clip and picks the matching source frames", () => {
    const fast = { ...seg("f", 1, 1, 10), speed: 2 };
    assert.equal(trackSegLength(fast), 5);
    assert.deepEqual([1, 2, 3, 4, 5].map((f) => sourceFrameAt(fast, f)), [1, 3, 5, 7, 9]);
    const slow = { ...seg("s", 11, 1, 4), speed: 0.5 };
    assert.equal(trackSegLength(slow), 8);
    assert.deepEqual([11, 12, 13, 14, 18].map((f) => sourceFrameAt(slow, f)), [1, 1, 2, 2, 4]);
    assert.equal(sourceFrameAt({ ...seg("x", 1, 1, 10), speed: 3 }, 99), 10);
  });

  test("a reversed clip walks from the out frame back to the in frame", () => {
    const rev = { ...seg("r", 5, 11, 15), reverse: true };
    assert.deepEqual([5, 6, 7, 8, 9].map((f) => sourceFrameAt(rev, f)), [15, 14, 13, 12, 11]);
    const both = { ...seg("b", 1, 1, 10), reverse: true, speed: 2 };
    assert.deepEqual([1, 2, 3, 4, 5].map((f) => sourceFrameAt(both, f)), [10, 8, 6, 4, 2]);
  });

  test("splitting keeps every source frame exactly once, forwards or reversed", () => {
    const fwd = splitSegment(seg("a", 1, 1, 10), 4, "b");
    assert.ok(fwd);
    assert.deepEqual(fwd.map((s) => [s.id, s.start, s.inFrame, s.outFrame]), [["a", 1, 1, 3], ["b", 4, 4, 10]]);
    const rev = splitSegment({ ...seg("a", 1, 1, 10), reverse: true }, 4, "b");
    assert.ok(rev);
    assert.deepEqual(rev.map((s) => [s.id, s.start, s.inFrame, s.outFrame]), [["a", 1, 8, 10], ["b", 4, 1, 7]]);
    assert.equal(sourceFrameAt(rev[0], 3), 8);
    assert.equal(sourceFrameAt(rev[1], 4), 7);
    const fast = splitSegment({ ...seg("a", 1, 1, 10), speed: 2 }, 3, "b");
    assert.ok(fast);
    assert.deepEqual(fast.map((s) => [s.inFrame, s.outFrame]), [[1, 4], [5, 10]]);
    assert.equal(splitSegment(seg("a", 1, 1, 10), 1, "b"), null);
    assert.equal(splitSegment(seg("a", 1, 1, 10), 11, "b"), null);
  });

  test("trimming a reversed or speed-changed clip moves the right source edge", () => {
    const rev = { ...seg("r", 10, 5, 14), reverse: true };
    assert.deepEqual(trimPatch(rev, "in", 3), { start: 13, outFrame: 11 });
    assert.deepEqual(trimPatch(rev, "out", -2), { inFrame: 7 });
    const fast = { ...seg("f", 10, 5, 14), speed: 2 };
    assert.deepEqual(trimPatch(fast, "in", 2), { start: 12, inFrame: 9 });
    assert.deepEqual(trimPatch(fast, "out", -1), { outFrame: 12 });
    assert.equal(clampTrim({ edge: "out", seg: fast, others: [], shift: 100, sourceFrameCount: 20 }), 3);
    assert.equal(clampTrim({ edge: "in", seg: { ...rev }, others: [], shift: -100, sourceFrameCount: 20 }), -6);
  });

  test("changing speed pushes later clips only as far as needed", () => {
    const list = [seg("a", 1, 1, 10), seg("b", 11, 1, 5), seg("c", 30, 1, 5)];
    const slower = applySpeed(list, "a", 0.5);
    assert.deepEqual(slower.map((s) => [s.id, s.start]), [["a", 1], ["b", 21], ["c", 40]]);
    const faster = applySpeed(list, "a", 2);
    assert.deepEqual(faster.map((s) => [s.id, s.start]), [["a", 1], ["b", 11], ["c", 30]]);
    assert.equal(faster[0].speed, 2);
    assert.equal(applySpeed(faster, "a", 1)[0].speed, undefined);
  });

  test("repeat lays copies after the clip and can ping-pong them", () => {
    let n = 0;
    const list = [seg("a", 1, 3, 6), seg("b", 5, 1, 5)];
    const out = repeatSegment(list, "a", 3, () => `n${++n}`, true);
    assert.deepEqual(out.addedIds, ["n1", "n2", "n3"]);
    const by = new Map(out.segments.map((s) => [s.id, s]));
    assert.equal(by.get("b")?.start, 17);
    assert.deepEqual([by.get("n1")?.start, by.get("n2")?.start, by.get("n3")?.start], [5, 9, 13]);
    assert.deepEqual([by.get("n1")?.reverse, by.get("n2")?.reverse, by.get("n3")?.reverse], [true, undefined, true]);
    assert.equal(repeatSegment(list, "zzz", 3, () => "x").segments, list);
  });
});
