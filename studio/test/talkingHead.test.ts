import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  characterIdFromAudioRel,
  groupTalkShots,
  ltxPartCount,
  ltxPartRange,
  orderLtxChains,
  placeTalkWindows,
  placeTalkWindowsAtAudio,
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

describe("LTX 20 s runs", () => {
  const range = { audioRel: "audio/a/001_rodney.wav", inSec: 5, durationSec: 47 };

  test("audio longer than 20 s is split into 20 s parts", () => {
    assert.equal(ltxPartCount(20), 1);
    assert.equal(ltxPartCount(20.4), 1, "a sliver under half a second is not its own part");
    assert.equal(ltxPartCount(33), 2);
    assert.equal(ltxPartCount(47), 3);
  });

  test("each part keeps its place in the audio file", () => {
    assert.deepEqual([0, 1, 2].map((i) => ltxPartRange(range, i)).map((r) => [r.inSec, r.durationSec]), [[5, 20], [25, 20], [45, 7]]);
  });

  test("chains are listed in the order the clips were numbered", () => {
    const withNumber = (group: string, number: number, audioInSec: number): TalkShot => ({
      id: `${group}_01`,
      status: "ready",
      frameCount: 240,
      talk: { group, index: 0, total: 1, text: "", windowSec: 10, clipSec: 10, number, audioInSec, audioRel: "audio/take_one/001_rodney.wav" },
    });
    const groups = groupTalkShots([withNumber("talk_b", 3, 20), withNumber("talk_a", 1, 0), withNumber("talk_c", 5, 40)]);
    const ordered = orderLtxChains(groups);
    assert.deepEqual(ordered.map((c) => c.group.group), ["talk_a", "talk_b", "talk_c"]);
    assert.equal(ordered[0].audioLabel, "take_one");
  });

  test("a chain placed at audio time starts where its audio sits in the recording", () => {
    const at = (sec: number) => ({ talk: { group: "talk_a", index: 0, total: 1, text: "hi", windowSec: 7.5, clipSec: 8, audioInSec: sec } });
    assert.equal(placeTalkWindowsAtAudio([shot(0, "ready", at(12.5))], 24)[0].start, 301);
    assert.equal(placeTalkWindowsAtAudio([shot(0, "ready", at(0))], 24)[0].start, 1);
    assert.equal(placeTalkWindowsAtAudio([shot(0, "ready", { talk: undefined })], 24)[0].start, 1);
    const later = placeTalkWindowsAtAudio([shot(0, "making", at(2)), shot(1, "ready", at(30))], 24);
    assert.equal(later[0].start, 721);
  });
});
