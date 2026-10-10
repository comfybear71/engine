"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  candidateRenderFiles,
  describePlayback,
  isSafeAudioRel,
  isUpToDate,
  previewOutputName,
  resolveProjectAudio,
} = require("../src/studioPlayback");

describe("studio playback", () => {
  test("prefers script-stem mp4 then leftover output.mp4", () => {
    assert.deepEqual(candidateRenderFiles("script.txt"), ["script.mp4", "output.mp4"]);
    assert.equal(previewOutputName("script_mcd.txt"), "script_mcd_preview.mp4");
    assert.equal(isUpToDate(200, 100), true);
    assert.equal(isUpToDate(50, 100), false);
  });

  test("audio rels stay under audio/*.wav", () => {
    assert.equal(isSafeAudioRel("audio/intro/001_alice.wav"), true);
    assert.equal(isSafeAudioRel("audio/../script.txt"), false);
    assert.equal(isSafeAudioRel("characters/alice/body.png"), false);
  });

  test("describePlayback reports freshness and existing wavs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-playback-"));
    const scriptPath = path.join(root, "script.txt");
    fs.writeFileSync(scriptPath, "[Scene: Intro]\n");
    fs.mkdirSync(path.join(root, "renders"), { recursive: true });
    fs.mkdirSync(path.join(root, "audio", "intro"), { recursive: true });
    const renderPath = path.join(root, "renders", "script.mp4");
    fs.writeFileSync(renderPath, "mp4");
    const wav = path.join(root, "audio", "intro", "001_alice.wav");
    fs.writeFileSync(wav, "RIFF");
    const scriptMtime = fs.statSync(scriptPath).mtimeMs;
    fs.utimesSync(renderPath, new Date(), new Date(scriptMtime + 2000));

    const lanes = {
      fps: 24,
      totalFrames: 48,
      blocks: [
        { lane: "audio", rel: "audio/intro/001_alice.wav", startFrame: 0, endFrame: 24 },
        { lane: "audio", rel: "audio/intro/002_missing.wav", startFrame: 24, endFrame: 48 },
      ],
    };
    const fresh = describePlayback(root, "script.txt", lanes);
    assert.equal(fresh.render.file, "script.mp4");
    assert.equal(fresh.render.upToDate, true);
    assert.equal(fresh.audio[0].exists, true);
    assert.equal(fresh.audio[1].exists, false);
    assert.ok(resolveProjectAudio(root, "audio/intro/001_alice.wav"));

    fs.utimesSync(renderPath, new Date(), new Date(scriptMtime - 2000));
    const stale = describePlayback(root, "script.txt", lanes);
    assert.equal(stale.render.upToDate, false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
