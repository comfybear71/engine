import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { drawingInsertRel, insertDurationFrames, insertStillTag } from "../lib/insertImage.ts";

describe("insert still tag", () => {
  test("inclusive 942-952 is eleven frames on the Inserts lane", () => {
    const span = insertDurationFrames(942, 952);
    assert.equal(span.frames, 11);
    assert.equal(span.endFrame, 953);
    assert.equal(
      insertStillTag({ image: "inserts/tongue_closeup.png", startFrame: 942, endFrame: 952 }),
      "[Insert: image=inserts/tongue_closeup.png at_time=942 for=11]"
    );
    assert.equal(
      drawingInsertRel({
        characterId: "rodney",
        slot: "mouth_front",
        drawing: "tongue",
        rel: "characters/rodney/mouth_front/tongue.png",
      }),
      "characters/rodney/mouth_front/tongue.png"
    );
  });
});
