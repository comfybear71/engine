"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listProjectAudio } = require("../src/studioAudio");
const { writeSilentWav } = require("./helpers/wav");

describe("listProjectAudio", () => {
  test("marks scene folders generated and other labels imported", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-audio-"));
    fs.writeFileSync(
      path.join(root, "script.txt"),
      "[Scene: Intro]\n[Location: room_a]\n[Cast: Alice]\nAlice: Hi.\n"
    );
    writeSilentWav(path.join(root, "audio", "intro", "001_alice.wav"), 0.5);
    writeSilentWav(path.join(root, "audio", "monologue", "001_alice.wav"), 1);
    const files = listProjectAudio(root, path.join(root, "missing-global"));
    const byLabel = Object.fromEntries(files.map((file) => [file.label, file]));
    assert.equal(byLabel.intro.kind, "generated");
    assert.equal(byLabel.intro.sceneId, "intro");
    assert.equal(byLabel.monologue.kind, "imported");
    assert.equal(byLabel.monologue.sceneId, null);
    assert.equal(byLabel.monologue.characterId, "alice");
    assert.ok(byLabel.monologue.durationSeconds > 0.9);
  });
});
