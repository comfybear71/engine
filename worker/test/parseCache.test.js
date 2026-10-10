"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

const { getCachedParse, resetParseCache, fingerprintParseInputs } = require("../src/parser/parseCache");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { writeSilentWav } = require("./helpers/wav");
const fs = require("fs");
const path = require("path");

describe("parse cache", () => {
  const fixture = createFixtureLibrary();
  fixture.writeScript(
    ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hello there friend."].join("\n")
  );
  writeSilentWav(path.join(fixture.projectDir, "audio", "intro", "001_alice.wav"), 0.4);

  after(() => {
    resetParseCache();
    fixture.cleanup();
  });

  test("shares one in-flight parse across concurrent callers", async () => {
    resetParseCache();
    const [a, b] = await Promise.all([
      getCachedParse(fixture.projectDir, { script: "script.txt" }),
      getCachedParse(fixture.projectDir, { script: "script.txt" }),
    ]);
    assert.equal(a, b);
    assert.equal(a.cached, true);
    assert.ok(fs.existsSync(a.timelinePath));
    const again = await getCachedParse(fixture.projectDir, { script: "script.txt" });
    assert.equal(again, a);
  });

  test("fingerprint changes when the script or a WAV mtime changes", () => {
    const script = path.join(fixture.projectDir, "script.txt");
    const wav = path.join(fixture.projectDir, "audio", "intro", "001_alice.wav");
    const before = fingerprintParseInputs(fixture.projectDir, "script.txt");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(script, later, later);
    assert.notEqual(fingerprintParseInputs(fixture.projectDir, "script.txt"), before);
    const mid = fingerprintParseInputs(fixture.projectDir, "script.txt");
    fs.utimesSync(wav, later, new Date(later.getTime() + 1000));
    assert.notEqual(fingerprintParseInputs(fixture.projectDir, "script.txt"), mid);
  });
});
