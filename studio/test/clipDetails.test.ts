import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clipDetailsText, promptSaysMouthClosed } from "../lib/clipDetails.ts";

describe("clip details", () => {
  test("a window with no words is flagged, because the LTX prompt then says the mouth is closed", () => {
    const prompt = "Use the provided start image as the first frame. Rodney listens quietly, mouth closed. Static medium close-up shot.";
    assert.equal(promptSaysMouthClosed(prompt), true);
    assert.equal(promptSaysMouthClosed('Rodney says: "hello there".'), false);
    const text = clipDetailsText({
      id: "talk_a_01",
      name: "LTX 08 · 0:00–0:10",
      status: "ready",
      engine: "ltx",
      prompt,
      talk: { group: "talk_a", index: 0, total: 2, text: "", windowSec: 10, clipSec: 10, audioRel: "audio/x/001_rodney.wav", audioInSec: 0, audioOutSec: 10 },
    });
    assert.match(text, /Words in this window: \(none found in the transcript\)/);
    assert.match(text, /WARNING: this prompt tells the character to keep the mouth closed/);
    assert.match(text, /Audio range: 0\.00 s to 10\.00 s {2}\(window 10\.00 s\)/);
  });

  test("a normal clip lists its words, prompt and job id without a warning", () => {
    const text = clipDetailsText({
      id: "g_02",
      name: "LTX 09",
      status: "ready",
      engine: "ltx",
      prompt: 'Rodney says: "hello there".',
      requestId: "abc-123",
      frameCount: 240,
      fps: 24,
      talk: { group: "g", index: 1, total: 2, text: "hello there", windowSec: 10, clipSec: 10, audioInSec: 10, audioOutSec: 20 },
    });
    assert.match(text, /Words in this window: "hello there"/);
    assert.match(text, /Job id: abc-123/);
    assert.match(text, /Result: 240 frames, 24 fps/);
    assert.equal(/WARNING/.test(text), false);
  });
});
