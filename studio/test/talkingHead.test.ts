import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  characterIdFromAudioRel,
  groupTalkShots,
  placeTalkWindows,
  talkingHeadRangeForBlock,
  type TalkShot,
} from "../lib/talkingHead.ts";

const shot = (index: number, status: string, extra: Partial<TalkShot> = {}): TalkShot => ({
  id: `talk_a_0${index + 1}`,
  status,
  frameCount: 240,
  in: 1,
  out: 180,
  talk: { group: "talk_a", index, total: 3, text: "hi", windowSec: 7.5, clipSec: 8 },
  ...extra,
});

describe("talking head helpers", () => {
  test("character comes from the audio file name", () => {
    assert.equal(characterIdFromAudioRel("audio/rodney_audio_01/001_rodney.wav"), "rodney");
    assert.equal(characterIdFromAudioRel("audio/x/readme.wav"), null);
  });

  test("an audio block maps to its trimmed slice", () => {
    const range = talkingHeadRangeForBlock(
      { rel: "audio/take/001_rodney.wav", startFrame: 48, endFrame: 48 + 24 * 30, trim: { inFrames: 24 * 5, outFrames: 0 } },
      24
    );
    assert.deepEqual(range, { audioRel: "audio/take/001_rodney.wav", inSec: 5, durationSec: 30, characterId: "rodney" });
    assert.equal(talkingHeadRangeForBlock({ rel: null, startFrame: 0, endFrame: 10 }, 24), null);
    assert.equal(talkingHeadRangeForBlock({ rel: "audio/x/readme.wav", startFrame: 0, endFrame: 10 }, 24), null);
  });

  test("groups report ready, generating and stopped states", () => {
    const ready = groupTalkShots([shot(2, "ready"), shot(0, "ready"), shot(1, "ready")])[0];
    assert.equal(ready.state, "ready");
    assert.deepEqual(ready.shots.map((s) => s.talk?.index), [0, 1, 2]);
    assert.equal(ready.seconds, 22.5);

    assert.equal(groupTalkShots([shot(0, "ready"), shot(1, "making"), shot(2, "queued")])[0].state, "making");
    assert.equal(groupTalkShots([shot(0, "queued"), shot(1, "queued")])[0].state, "queued");
    const stopped = groupTalkShots([shot(0, "ready"), shot(1, "error", { error: "boom" }), shot(2, "queued")])[0];
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.error, "boom");
  });

  test("ready windows are placed back to back using their trim", () => {
    const placed = placeTalkWindows([shot(0, "ready"), shot(1, "making"), shot(2, "ready", { out: 100 })], 25);
    assert.deepEqual(placed, [
      { shotId: "talk_a_01", inFrame: 1, outFrame: 180, start: 25 },
      { shotId: "talk_a_03", inFrame: 1, outFrame: 100, start: 205 },
    ]);
  });
});
