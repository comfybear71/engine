"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  runImportAudio,
  wordsToSentences,
  creditNote,
  VoicesFatalError,
} = require("../src/importAudio");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { writeSilentWav } = require("./helpers/wav");

function captureIo() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    io: {
      log: (msg) => lines.log.push(String(msg)),
      warn: (msg) => lines.warn.push(String(msg)),
      error: (msg) => lines.error.push(String(msg)),
    },
  };
}

describe("wordsToSentences", () => {
  test("splits on sentence punctuation and on pauses", () => {
    const sentences = wordsToSentences(
      [
        { word: "Hello", start: 0.0, end: 0.3 },
        { word: "there.", start: 0.3, end: 0.7 },
        { word: "Next", start: 1.5, end: 1.8 },
        { word: "bit", start: 1.85, end: 2.1 },
      ],
      { pauseSeconds: 0.6 }
    );
    assert.equal(sentences.length, 2);
    assert.equal(sentences[0].text, "Hello there.");
    assert.equal(sentences[1].text, "Next bit");
  });
});

describe("import-audio", () => {
  test("--dry-run prints length and the STT credit note and writes nothing", async () => {
    const fixture = createFixtureLibrary();
    try {
      const src = path.join(fixture.root, "take.wav");
      writeSilentWav(src, 3.25);
      let fetchCalls = 0;
      const { lines, io } = captureIo();
      const result = await runImportAudio(fixture.projectDir, src, {
        character: "alice",
        name: "monologue",
        dryRun: true,
        probeDuration: async () => 3.25,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("fetch must not be called during --dry-run");
        },
        ...io,
      });

      assert.equal(fetchCalls, 0);
      assert.equal(result.ok, true);
      assert.equal(result.dryRun, true);
      assert.equal(result.label, "monologue");
      assert.equal(result.character, "alice");
      assert.match(result.creditNote, /Audio length: 3\.3s/);
      assert.match(result.creditNote, /ElevenLabs Speech-to-Text credits/);
      assert.match(result.creditNote, /scribe_v1/);
      assert.match(lines.log.join("\n"), /Dry run: no files written/);
      assert.equal(fs.existsSync(path.join(fixture.projectDir, "audio", "monologue")), false);
    } finally {
      fixture.cleanup();
    }
  });

  test("--no-transcribe converts, runs Rhubarb, and never calls ElevenLabs", async () => {
    const fixture = createFixtureLibrary();
    try {
      const src = path.join(fixture.root, "take.wav");
      writeSilentWav(src, 1.0);
      let fetchCalls = 0;
      let rhubarbCalls = 0;
      const { io } = captureIo();
      const result = await runImportAudio(fixture.projectDir, src, {
        character: "Alice",
        name: "Monologue Take",
        noTranscribe: true,
        probeDuration: async () => 1.0,
        convertToEngineWav: async (from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("fetch must not be called with --no-transcribe");
        },
        runRhubarb: ({ cuesPath }) => {
          rhubarbCalls += 1;
          fs.mkdirSync(path.dirname(cuesPath), { recursive: true });
          fs.writeFileSync(cuesPath, JSON.stringify({ mouthCues: [] }));
          return { ok: true, cuesPath };
        },
        ...io,
      });

      assert.equal(fetchCalls, 0);
      assert.equal(rhubarbCalls, 1);
      assert.equal(result.transcribed, false);
      assert.equal(result.label, "monologue_take");
      assert.equal(result.wavPath, "audio/monologue_take/001_alice.wav");
      assert.equal(fs.existsSync(path.join(fixture.projectDir, result.wavPath)), true);
      assert.equal(fs.existsSync(path.join(fixture.projectDir, result.cuesPath)), true);
      assert.equal(fs.existsSync(path.join(fixture.projectDir, result.wordsPath)), false);
      assert.match(result.creditNote, /Transcription skipped/);
    } finally {
      fixture.cleanup();
    }
  });

  test("transcribe writes [{word,start,end}] from a mocked Scribe response", async () => {
    const fixture = createFixtureLibrary();
    const prevKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key-not-real";
    try {
      const src = path.join(fixture.root, "take.wav");
      writeSilentWav(src, 1.0);
      const { io } = captureIo();
      let seenKey = "";
      const result = await runImportAudio(fixture.projectDir, src, {
        character: "alice",
        name: "take",
        probeDuration: async () => 1.0,
        convertToEngineWav: async (from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        },
        runRhubarb: () => ({ ok: false, reason: "missing" }),
        fetch: async (url, init) => {
          assert.match(String(url), /\/v1\/speech-to-text$/);
          seenKey = init.headers["xi-api-key"];
          return {
            ok: true,
            json: async () => ({
              text: "Hello there.",
              words: [
                { text: "Hello", start: 0.0, end: 0.4, type: "word" },
                { text: " ", start: 0.4, end: 0.45, type: "spacing" },
                { text: "there.", start: 0.45, end: 0.9, type: "word" },
              ],
            }),
          };
        },
        ...io,
      });

      assert.equal(seenKey, "test-key-not-real");
      assert.equal(result.transcribed, true);
      assert.deepEqual(result.words, [
        { word: "Hello", start: 0.0, end: 0.4 },
        { word: "there.", start: 0.45, end: 0.9 },
      ]);
      const written = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, result.wordsPath), "utf8"));
      assert.deepEqual(written, result.words);
    } finally {
      if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prevKey;
      fixture.cleanup();
    }
  });

  test("unknown character and missing API key fail before any write", async () => {
    const fixture = createFixtureLibrary();
    const prevKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const src = path.join(fixture.root, "take.wav");
      writeSilentWav(src, 1.0);
      const { io } = captureIo();
      await assert.rejects(
        () =>
          runImportAudio(fixture.projectDir, src, {
            character: "zelda",
            dryRun: true,
            probeDuration: async () => 1,
            ...io,
          }),
        /Unknown character "zelda"/
      );

      await assert.rejects(
        () =>
          runImportAudio(fixture.projectDir, src, {
            character: "alice",
            name: "x",
            probeDuration: async () => 1,
            convertToEngineWav: async (from, to) => {
              fs.mkdirSync(path.dirname(to), { recursive: true });
              fs.copyFileSync(from, to);
            },
            ...io,
          }),
        (err) => err instanceof VoicesFatalError && /ELEVENLABS_API_KEY/.test(err.message)
      );
    } finally {
      if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prevKey;
      fixture.cleanup();
    }
  });

  test("chunks long audio and offsets word timestamps", async () => {
    const fixture = createFixtureLibrary();
    const prevKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key-not-real";
    try {
      const src = path.join(fixture.root, "long.wav");
      writeSilentWav(src, 1.0);
      let fetchCalls = 0;
      const { io } = captureIo();
      const result = await runImportAudio(fixture.projectDir, src, {
        character: "alice",
        name: "long",
        chunkSeconds: 2,
        probeDuration: async () => 3.0,
        convertToEngineWav: async (from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        },
        extractWavSlice: async (_from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          writeSilentWav(to, 1.0);
        },
        runRhubarb: () => ({ ok: false, reason: "missing" }),
        fetch: async () => {
          fetchCalls += 1;
          const start = fetchCalls === 1 ? 0.1 : 0.2;
          return {
            ok: true,
            json: async () => ({
              text: fetchCalls === 1 ? "One" : "Two",
              words: [{ text: fetchCalls === 1 ? "One" : "Two", start, end: start + 0.3, type: "word" }],
            }),
          };
        },
        ...io,
      });

      assert.equal(fetchCalls, 2);
      assert.equal(result.words.length, 2);
      assert.equal(result.words[0].word, "One");
      assert.equal(result.words[1].word, "Two");
      assert.ok(result.words[1].start > result.words[0].start);
    } finally {
      if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prevKey;
      fixture.cleanup();
    }
  });

  test("creditNote names the audio length and STT credits", () => {
    assert.match(creditNote(194.2), /3m 14s/);
    assert.match(creditNote(194.2), /ElevenLabs Speech-to-Text credits/);
    assert.match(creditNote(12, { noTranscribe: true }), /skipped/);
  });
});
