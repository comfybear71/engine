import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PROXY_SEGMENT_SEC,
  bumpAudioGeneration,
  chooseVideoFile,
  clipDurationSec,
  frameFromElapsedMs,
  frameInSegment,
  isLiveAudioStart,
  isRenderUpToDate,
  segmentWindow,
  shouldFallbackToProxy,
  webAudioSchedule,
  type PlaybackStatus,
} from "../lib/playback.ts";

const base: PlaybackStatus = {
  fps: 24,
  totalFrames: 240,
  render: null,
  proxy: null,
  audio: [],
};

describe("stage playback helpers", () => {
  test("prefers an up-to-date full render, then a proxy", () => {
    assert.equal(chooseVideoFile(base), null);
    assert.deepEqual(
      chooseVideoFile({ ...base, render: { file: "script.mp4", upToDate: true } }),
      { file: "script.mp4", kind: "render" }
    );
    assert.deepEqual(
      chooseVideoFile({
        ...base,
        render: { file: "script.mp4", upToDate: false },
        proxy: { file: "script_preview.mp4", upToDate: true },
      }),
      { file: "script_preview.mp4", kind: "proxy" }
    );
    assert.equal(
      chooseVideoFile({ ...base, render: { file: "script.mp4", upToDate: false } }),
      null
    );
  });

  test("isRenderUpToDate is mtime >= script", () => {
    assert.equal(isRenderUpToDate(200, 100), true);
    assert.equal(isRenderUpToDate(100, 100), true);
    assert.equal(isRenderUpToDate(99, 100), false);
  });

  test("frameFromElapsedMs advances at fps and clamps", () => {
    assert.equal(frameFromElapsedMs(0, 0, 24, 100), 0);
    assert.equal(frameFromElapsedMs(1000, 0, 24, 100), 24);
    assert.equal(frameFromElapsedMs(500, 10, 24, 100), 22);
    assert.equal(frameFromElapsedMs(10_000, 0, 24, 50), 49);
  });

  test("shouldFallbackToProxy when a frame fetch misses real time, including long shots", () => {
    assert.equal(shouldFallbackToProxy(20, 24), false);
    assert.equal(shouldFallbackToProxy(80, 24), true);
    assert.equal(shouldFallbackToProxy(80, 24, 24 * 60), true);
    assert.equal(shouldFallbackToProxy(80, 24, 24 * 120), true);
    assert.equal(shouldFallbackToProxy(80, 24, 24 * 120 + 1), true);
  });

  test("segmentWindow covers the next play slice from any start", () => {
    const mid = segmentWindow(240, 24, 24 * 600, PROXY_SEGMENT_SEC);
    assert.equal(mid.startFrame, 240);
    assert.equal(mid.frames, 24 * PROXY_SEGMENT_SEC);
    assert.equal(mid.endFrame, 240 + 24 * PROXY_SEGMENT_SEC);
    const tail = segmentWindow(24 * 599, 24, 24 * 600);
    assert.equal(tail.startFrame, 24 * 599);
    assert.ok(tail.frames <= 24);
    assert.equal(frameInSegment(250, mid), true);
    assert.equal(frameInSegment(239, mid), false);
    assert.equal(frameInSegment(mid.endFrame, mid), false);
    assert.equal(frameInSegment(mid.endFrame, mid, 2), true);
  });

  test("clipDurationSec prefers the WAV header, else the lane span", () => {
    assert.equal(clipDurationSec({ startFrame: 0, endFrame: 48, durationSeconds: 9.5 }, 24), 9.5);
    assert.equal(clipDurationSec({ startFrame: 24, endFrame: 72 }, 24), 2);
  });

  test("generation token keeps only the latest audio start live", () => {
    let gen = 0;
    const first = (gen = bumpAudioGeneration(gen));
    assert.equal(isLiveAudioStart(first, gen, true), true);

    gen = bumpAudioGeneration(gen);
    const second = (gen = bumpAudioGeneration(gen));
    assert.equal(isLiveAudioStart(first, gen, true), false);
    assert.equal(isLiveAudioStart(second, gen, true), true);

    gen = bumpAudioGeneration(gen);
    assert.equal(isLiveAudioStart(second, gen, true), false);
    assert.equal(isLiveAudioStart(second, gen, false), false);

    const third = (gen = bumpAudioGeneration(gen));
    assert.equal(isLiveAudioStart(third, gen, false), false);
    assert.equal(isLiveAudioStart(third, gen, true), true);
  });

  test("webAudioSchedule offsets into a clip already under the playhead", () => {
    const mid = webAudioSchedule({ startFrame: 24, endFrame: 72, durationSec: 2 }, 36, 24, 200);
    assert.deepEqual(mid, { offsetSec: 0.5, delaySec: 0, playSec: 1.5 });
    const later = webAudioSchedule({ startFrame: 48, endFrame: 72, durationSec: 1 }, 24, 24, 200);
    assert.deepEqual(later, { offsetSec: 0, delaySec: 1, playSec: 1 });
    assert.equal(webAudioSchedule({ startFrame: 0, endFrame: 10, durationSec: 0.4 }, 12, 24, 200), null);
    const trimmed = webAudioSchedule(
      { startFrame: 0, endFrame: 24, durationSec: 3, trimInSec: 1, trimOutSec: 2 },
      0,
      24,
      200
    );
    assert.deepEqual(trimmed, { offsetSec: 1, delaySec: 0, playSec: 1 });
  });
});
