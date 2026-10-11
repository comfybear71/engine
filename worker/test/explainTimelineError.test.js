"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { explainTimelineError } = require("../src/parser/explainTimelineError");

describe("explainTimelineError", () => {
  test("rewrites empty keyframe schema paths into a lint sentence", () => {
    const raw =
      "Python compositor exited with code 1: scenes/0/layers/0/slots/right_hand/keyframes/0: {'frame': 0} is not valid under any of the given schemas";
    const text = explainTimelineError(raw);
    assert.match(text, /right_hand/);
    assert.match(text, /drawing or cycle/);
    assert.doesNotMatch(text, /not valid under any of the given schemas/);
  });

  test("names every empty slot from a lint schema dump", () => {
    const raw = [
      "timeline.json failed schema validation:",
      "  - scenes/0/layers/0/slots/body/keyframes/0: {'frame': 0} is not valid under any of the given schemas",
      "  - scenes/0/layers/0/slots/eyes/keyframes/0: {'frame': 0} is not valid under any of the given schemas",
    ].join("\n");
    const text = explainTimelineError(raw);
    assert.match(text, /body/);
    assert.match(text, /eyes/);
    assert.match(text, /none to hide/);
  });
});
