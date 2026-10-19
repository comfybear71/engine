import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampFollow, followDy, followKey } from "../lib/headFollow.ts";

describe("head follow body", () => {
  test("strength is kept between 0 and 150%", () => {
    assert.equal(clampFollow(undefined), 0);
    assert.equal(clampFollow(-1), 0);
    assert.equal(clampFollow(0.756), 0.76);
    assert.equal(clampFollow(9), 1.5);
  });

  test("the head moves by the body's motion times the strength", () => {
    const offsets = [0, 0.02, -0.03];
    assert.equal(followDy(offsets, 2, 1, 500), 10);
    assert.equal(followDy(offsets, 3, 0.5, 500), -7.5);
    assert.equal(followDy(offsets, 2, 0, 500), 0);
  });

  test("nothing moves without a measurement or outside the clip", () => {
    assert.equal(followDy(null, 2, 1, 500), 0);
    assert.equal(followDy([0.1], 5, 1, 500), 0);
    assert.equal(followDy([0.1], 0, 1, 500), 0);
    assert.equal(followDy([0.1], 1, 1, 0), 0);
  });

  test("the measurement is keyed by clip and neck position", () => {
    assert.equal(followKey("walk", 0.5), "walk|0.50");
    assert.equal(followKey("walk", 0.514), "walk|0.50");
    assert.equal(followKey("walk", 0.53), "walk|0.55");
    assert.equal(followKey("walk", 2), "walk|1.00");
  });
});
