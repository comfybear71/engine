"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  planSilenceCuts,
  sliceWords,
  sliceCues,
  chunkLabel,
  writeAudioChunks,
  splitExistingAudio,
  shouldSplitLongAudio,
} = require("../src/splitLongAudio");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { writeSilentWav } = require("./helpers/wav");

describe("planSilenceCuts", () => {
  test("keeps a take at or under 60s as one range", () => {
    assert.deepEqual(planSilenceCuts(60, [], []), [{ start: 0, end: 60 }]);
    assert.equal(shouldSplitLongAudio(60, undefined), false);
    assert.equal(shouldSplitLongAudio(61, undefined), true);
    assert.equal(shouldSplitLongAudio(90, false), false);
  });

  test("cuts at the longest silence inside the 30–60s window", () => {
    const words = [
      { word: "a", start: 0, end: 29 },
      { word: "b", start: 32.5, end: 50 },
      { word: "c", start: 51, end: 80 },
      { word: "d", start: 81, end: 125 },
    ];
    const ranges = planSilenceCuts(125, words, []);
    assert.ok(ranges.length >= 2);
    assert.ok(ranges[0].end > 30 && ranges[0].end <= 60);
    assert.ok(ranges[0].end >= 30.5 && ranges[0].end <= 32.5);
    assert.equal(ranges[ranges.length - 1].end, 125);
    const span = ranges.reduce((max, r) => Math.max(max, r.end - r.start), 0);
    assert.ok(span <= 60.5, `chunk ${span}s over 60s`);
  });

  test("hard-cuts near 60s when there are no words or cues", () => {
    const ranges = planSilenceCuts(150, [], []);
    assert.ok(ranges.length >= 3);
    for (const range of ranges) {
      assert.ok(range.end - range.start <= 60.5);
    }
  });
});

describe("slice sidecars", () => {
  test("shifts words and cues into chunk-local time", () => {
    const words = sliceWords(
      [
        { word: "hi", start: 40, end: 40.4 },
        { word: "there", start: 40.5, end: 41 },
        { word: "later", start: 90, end: 91 },
      ],
      40,
      80
    );
    assert.deepEqual(
      words.map((w) => [w.word, w.start, w.end]),
      [
        ["hi", 0, 0.4],
        ["there", 0.5, 1],
      ]
    );
    const cues = sliceCues(
      [
        { start: 39, end: 41, value: "B" },
        { start: 50, end: 51, value: "X" },
      ],
      40,
      80
    );
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].value, "B");
    assert.equal(cues[1].start, 10);
    assert.equal(chunkLabel("My Take", 0), "my_take_01");
  });
});

describe("writeAudioChunks", () => {
  test("writes each chunk wav plus sliced words/cues and never fetches", async () => {
    const fixture = createFixtureLibrary();
    try {
      const src = path.join(fixture.projectDir, "audio", "mono", "001_alice.wav");
      writeSilentWav(src, 2);
      const extracts = [];
      let fetchCalls = 0;
      const written = await writeAudioChunks({
        projectDir: fixture.projectDir,
        sourceWavAbs: src,
        characterId: "alice",
        baseLabel: "mono",
        durationSec: 125,
        words: [
          { word: "one", start: 0, end: 40 },
          { word: "gap", start: 44, end: 80 },
          { word: "end", start: 81, end: 124 },
        ],
        cues: [
          { start: 0, end: 40, value: "B" },
          { start: 40, end: 44, value: "X" },
          { start: 44, end: 125, value: "C" },
        ],
        extractWavSlice: async (from, to, start, dur) => {
          extracts.push({ from, to, start, dur });
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        },
      });
      assert.ok(written.chunks.length >= 2);
      assert.equal(extracts.length, written.chunks.length);
      assert.equal(fetchCalls, 0);
      const first = written.chunks[0];
      assert.equal(first.label, "mono_01");
      assert.equal(fs.existsSync(path.join(fixture.projectDir, first.wavPath)), true);
      assert.equal(fs.existsSync(path.join(fixture.projectDir, first.wordsPath)), true);
      assert.equal(fs.existsSync(path.join(fixture.projectDir, first.cuesPath)), true);
      const words = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, first.wordsPath), "utf8"));
      assert.ok(words.every((w) => w.start >= 0 && w.end <= first.durationSec + 0.05));
    } finally {
      fixture.cleanup();
    }
  });

  test("splitExistingAudio reuses words.json and does not call ElevenLabs", async () => {
    const fixture = createFixtureLibrary();
    try {
      const rel = "audio/mono/001_alice.wav";
      const wavAbs = path.join(fixture.projectDir, rel);
      writeSilentWav(wavAbs, 2);
      fs.writeFileSync(
        path.join(fixture.projectDir, "audio/mono/001_alice.words.json"),
        JSON.stringify([
          { word: "one", start: 0, end: 40 },
          { word: "two", start: 43, end: 90 },
          { word: "three", start: 91, end: 130 },
        ])
      );
      fs.writeFileSync(
        path.join(fixture.projectDir, "audio/mono/001_alice.wav.rhubarb.json"),
        JSON.stringify({ mouthCues: [{ start: 0, end: 130, value: "B" }] })
      );
      const result = await splitExistingAudio(fixture.projectDir, {
        rel,
        durationSec: 130,
        probeDuration: async () => 130,
        extractWavSlice: async (from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        },
      });
      assert.equal(result.split, true);
      assert.equal(result.reusedWords, true);
      assert.equal(result.reusedCues, true);
      assert.ok(result.chunks.length >= 2);
      assert.ok(result.chunks.every((c) => c.durationSec <= 60.5));
    } finally {
      fixture.cleanup();
    }
  });

  test("clamps an overstated duration to the probed length and skips empty slices", async () => {
    const fixture = createFixtureLibrary();
    try {
      const rel = "audio/mono/001_alice.wav";
      const wavAbs = path.join(fixture.projectDir, rel);
      writeSilentWav(wavAbs, 2);
      const result = await splitExistingAudio(fixture.projectDir, {
        rel,
        durationSec: 200,
        probeDuration: async () => 90,
        extractWavSlice: async (from, to, start, dur) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          if (start >= 90) {
            fs.writeFileSync(to, "");
            return;
          }
          fs.copyFileSync(from, to);
        },
      });
      assert.equal(result.durationSeconds, 90);
      assert.ok(result.chunks.length >= 2);
      assert.ok(result.chunks.every((c) => c.offsetSec + c.durationSec <= 90.01));
      assert.equal(result.chunks.some((c) => c.offsetSec >= 90), false);
    } finally {
      fixture.cleanup();
    }
  });
});
