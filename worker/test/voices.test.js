"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { runVoices } = require("../src/voices");
const { writeSidecar } = require("../src/voices/creditGuard");
const { resolveModelId } = require("../src/voices/elevenlabs");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { writeSilentWav } = require("./helpers/wav");

function setVoiceId(fixture, characterId, voiceId) {
  const abs = path.join(fixture.globalAssetsDir, "characters", characterId, "character.json");
  const config = JSON.parse(fs.readFileSync(abs, "utf8"));
  config.voice_id = voiceId;
  fs.writeFileSync(abs, JSON.stringify(config, null, 2));
}

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

describe("voices --dry-run", () => {
  test("lists every dialogue line to record and never calls fetch", async () => {
    const fixture = createFixtureLibrary();
    try {
      setVoiceId(fixture, "alice", "voice-alice-test");
      setVoiceId(fixture, "bob", "voice-bob-test");
      fixture.writeScript(
        ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice, Bob]", "Alice: Hello there friend.", "Bob: Hi."].join("\n")
      );

      let fetchCalls = 0;
      const fetch = async () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called during --dry-run");
      };

      const { lines, io } = captureIo();
      const result = await runVoices(fixture.projectDir, {
        dryRun: true,
        fetch,
        ...io,
      });

      assert.equal(fetchCalls, 0);
      assert.equal(result.ok, true);
      assert.equal(result.toRecord.length, 2);
      assert.equal(result.totalChars, "Hello there friend.".length + "Hi.".length);
      assert.equal(result.skipped, 0);
      assert.equal(result.failed, 0);

      const output = lines.log.join("\n");
      assert.match(output, /Would record:/);
      assert.match(output, /intro\s+001\s+alice\s+19 chars/);
      assert.match(output, /intro\s+002\s+bob\s+3 chars/);
      assert.match(output, /Total characters: 22 \(~22 credits estimated/);
      assert.match(output, /this is an estimate/);
      assert.equal(lines.error.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test("skips an unchanged WAV+sidecar and errors on a missing voice_id without calling fetch", async () => {
    const fixture = createFixtureLibrary();
    try {
      setVoiceId(fixture, "alice", "voice-alice-test");
      setVoiceId(fixture, "bob", null);
      fixture.writeScript(
        [
          "[Scene: Intro]",
          "[Location: room_a]",
          "[Cast: Alice, Bob]",
          "Alice: Already recorded.",
          "Bob: No voice yet.",
        ].join("\n")
      );

      const aliceWav = path.join(fixture.projectDir, "audio", "intro", "001_alice.wav");
      writeSilentWav(aliceWav, 0.5);
      writeSidecar(`${aliceWav}.json`, {
      text: "Already recorded.",
      voiceId: "voice-alice-test",
      modelId: resolveModelId(),
    });

      let fetchCalls = 0;
      const { lines, io } = captureIo();
      const result = await runVoices(fixture.projectDir, {
        dryRun: true,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("fetch must not be called during --dry-run");
        },
        ...io,
      });

      assert.equal(fetchCalls, 0);
      assert.equal(result.ok, false);
      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 1);
      assert.equal(result.toRecord.length, 0);
      assert.match(lines.error.join("\n"), /Character "bob" has no voice_id in/);
      assert.match(lines.error.join("\n"), /characters\/bob\/character\.json/);
      assert.match(lines.log.join("\n"), /No lines to record/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("watcher isolation", () => {
  test("watcher source never mentions ElevenLabs or the voices command", () => {
    const watcherSrc = fs.readFileSync(path.join(__dirname, "..", "src", "watcher.js"), "utf8");
    assert.equal(/elevenlabs|voices/i.test(watcherSrc), false);
  });
});
