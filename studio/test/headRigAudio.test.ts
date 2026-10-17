import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { audioAtFrame, audioLaneHasShot, audioLaneItems, audioPeaks, deriveAudioPieces, shotHasAudio, sliceAudioPeaks } from "../lib/headRigAudio.ts";

const shots = new Map([
  ["talk", { fps: 24, talk: { audio: "audio.wav" } }],
  ["plain", { fps: 24 }],
]);

describe("head rig audio lane", () => {
  test("only clips that carry audio get an audio piece, placed where the segment sits", () => {
    const segs = [
      { id: "a", shotId: "talk", start: 25, inFrame: 1, outFrame: 48 },
      { id: "b", shotId: "plain", start: 1, inFrame: 1, outFrame: 24 },
    ];
    const items = audioLaneItems(segs, shots, 24);
    assert.equal(items.length, 1);
    assert.deepEqual({ ...items[0] }, { segId: "a", shotId: "talk", start: 25, length: 48, fromSec: 0, toSec: 2, speed: 1, reverse: false });
    assert.equal(shotHasAudio(shots.get("plain")), false);
  });

  test("a trimmed clip plays the matching part of its audio", () => {
    const seg = { id: "a", shotId: "talk", start: 10, inFrame: 25, outFrame: 72 };
    const at = audioAtFrame([seg], shots, 10, 24);
    assert.equal(at?.timeSec, 1);
    assert.equal(audioAtFrame([seg], shots, 34, 24)?.timeSec, 2);
    assert.equal(audioAtFrame([seg], shots, 9, 24), null);
    assert.equal(audioAtFrame([seg], shots, 58, 24), null);
  });

  test("speed changes the rate and a reversed piece is silent", () => {
    const fast = { id: "a", shotId: "talk", start: 1, inFrame: 1, outFrame: 48, speed: 2 };
    assert.equal(audioAtFrame([fast], shots, 13, 24)?.rate, 2);
    assert.equal(audioAtFrame([fast], shots, 13, 24)?.timeSec, 1);
    assert.equal(audioAtFrame([{ ...fast, speed: 1, reverse: true }], shots, 5, 24), null);
  });

  test("waveform peaks are normalised and can be sliced to a trimmed range", () => {
    const samples = [0, 0.1, -0.5, 0.25, 0, 0, 0.5, -0.5];
    const peaks = audioPeaks(samples, 4);
    assert.deepEqual(peaks, [0.2, 1, 0, 1]);
    assert.deepEqual(sliceAudioPeaks(peaks, 4, 1, 3), [1, 0]);
    assert.deepEqual(audioPeaks([], 3), [0, 0, 0]);
  });

  test("an older rig's audio lane is built once from its head clips that have audio, keeping place, cut and speed", () => {
    let n = 0;
    const heads = [
      { shotId: "talk", start: 5, inFrame: 3, outFrame: 30, speed: 2, reverse: true },
      { shotId: "plain", start: 40, inFrame: 1, outFrame: 10 },
      { shotId: "talk", start: 60, inFrame: 1, outFrame: 24 },
    ];
    const pieces = deriveAudioPieces(heads, shots, () => `p${++n}`);
    assert.deepEqual(pieces, [
      { id: "p1", shotId: "talk", start: 5, inFrame: 3, outFrame: 30, speed: 2, reverse: true },
      { id: "p2", shotId: "talk", start: 60, inFrame: 1, outFrame: 24 },
    ]);
  });

  test("audio plays from the lane's own pieces, not from the head clips", () => {
    const lane = [{ id: "keep", shotId: "talk", start: 1, inFrame: 1, outFrame: 48 }];
    assert.equal(audioAtFrame(lane, shots, 25, 24)?.segId, "keep");
    assert.equal(audioAtFrame([], shots, 25, 24), null);
    assert.equal(audioLaneHasShot(lane, "talk"), true);
    assert.equal(audioLaneHasShot(lane, "other"), false);
  });
});
