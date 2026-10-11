import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explainTimelineError } from "../lib/timelineError.ts";

describe("explainTimelineError", () => {
  test("rewrites a compositor schema dump into a lint sentence", () => {
    const text = explainTimelineError(
      "Python compositor exited with code 1: scenes/0/layers/0/slots/right_hand/keyframes/0: {'frame': 0} is not valid under any of the given schemas"
    );
    assert.match(text, /right_hand/);
    assert.match(text, /drawing or cycle/);
    assert.doesNotMatch(text, /not valid under any of the given schemas/);
  });
});
