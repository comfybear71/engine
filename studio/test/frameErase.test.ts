import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatFrameList, frameBaseRel, frameMaskRel, parseFrameList } from "../lib/frameErase.ts";

describe("frame erase helpers", () => {
  test("a list of frames and ranges becomes sorted unique frame numbers", () => {
    assert.deepEqual(parseFrameList("5-7, 12", 72), [5, 6, 7, 12]);
    assert.deepEqual(parseFrameList("9 3 3-4", 72), [3, 4, 9]);
    assert.deepEqual(parseFrameList("7-5", 72), [5, 6, 7]);
  });

  test("anything outside the clip or not a number is refused, not guessed at", () => {
    assert.equal(parseFrameList("", 72), null);
    assert.equal(parseFrameList("0-3", 72), null);
    assert.equal(parseFrameList("70-80", 72), null);
    assert.equal(parseFrameList("a-b", 72), null);
    assert.equal(parseFrameList("1.5", 72), null);
  });

  test("frame lists are shown as short ranges", () => {
    assert.equal(formatFrameList([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
    assert.equal(formatFrameList([]), "");
  });

  test("an erased frame is shown from its untouched copy", () => {
    assert.equal(frameBaseRel(4, new Set([4])), "cut_orig/f_0004.png");
    assert.equal(frameBaseRel(5, new Set([4])), "cut/f_0005.png");
    assert.equal(frameMaskRel(12), "erase/f_0012.png");
  });
});
