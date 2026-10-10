"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readWavDurationSeconds } = require("../src/parser/wavDuration");
const { probeDurationSeconds, resetDurationCache } = require("../src/parser/ffprobeDuration");
const { writeSilentWav } = require("./helpers/wav");

describe("WAV duration from header", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-wav-duration-"));

  after(() => {
    resetDurationCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads duration from a PCM WAV without spawning ffprobe", async () => {
    const file = path.join(dir, "line.wav");
    writeSilentWav(file, 0.5, 44100);
    const header = readWavDurationSeconds(file);
    assert.ok(Number.isFinite(header));
    assert.ok(Math.abs(header - 0.5) < 0.001);

    resetDurationCache();
    const probed = await probeDurationSeconds(file);
    assert.ok(Math.abs(probed - 0.5) < 0.001);
    const again = await probeDurationSeconds(file);
    assert.equal(again, probed);
  });

  test("returns null for a non-WAV file", () => {
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "not a wav");
    assert.equal(readWavDurationSeconds(file), null);
  });
});
