"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  computeSyncState,
  stampCuesMeta,
  syncDialogueLines,
  collectDialogueTargets,
  readStudioSettings,
  writeStudioSettings,
  patchMouthCue,
  clearDialogueLipSync,
} = require("../src/voices/lipSync");
const { writeSilentWav } = require("./helpers/wav");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "engine-lipsync-"));
}

function writeCues(filePath, cues, engine) {
  const data = { mouthCues: cues };
  if (engine) data.engine = engine;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data)}\n`);
}

describe("lip-sync state", () => {
  test("not_synced / synced / stale from cues + wav + text", () => {
    const dir = tmpDir();
    try {
      const wavRel = "audio/intro/001_alice.wav";
      const cuesRel = `${wavRel}.rhubarb.json`;
      const wavAbs = path.join(dir, wavRel);
      const cuesAbs = path.join(dir, cuesRel);
      writeSilentWav(wavAbs, 0.4);

      assert.equal(computeSyncState({ projectDir: dir, cuesRel, wavRel, text: "Hi" }), "not_synced");

      writeCues(cuesAbs, [{ start: 0, end: 0.2, value: "A" }]);
      stampCuesMeta(cuesAbs, { text: "Hi", wavPath: wavAbs });
      assert.equal(computeSyncState({ projectDir: dir, cuesRel, wavRel, text: "Hi" }), "synced");
      assert.equal(computeSyncState({ projectDir: dir, cuesRel, wavRel, text: "Hello" }), "stale");

      const later = Date.now() + 2000;
      fs.utimesSync(wavAbs, later / 1000, later / 1000);
      assert.equal(computeSyncState({ projectDir: dir, cuesRel, wavRel, text: "Hi" }), "stale");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncDialogueLines writes cues and stamps text; studio.json toggles manual", async () => {
    const dir = tmpDir();
    try {
      const wavRel = "audio/intro/001_alice.wav";
      const cuesRel = `${wavRel}.rhubarb.json`;
      writeSilentWav(path.join(dir, wavRel), 0.3);
      assert.equal(readStudioSettings(dir).lipSync, "auto");
      writeStudioSettings(dir, { lipSync: "manual" });
      assert.equal(readStudioSettings(dir).lipSync, "manual");
      writeStudioSettings(dir, { lipsync: { smoothing: "off", head_bob: "off" } });
      const natural = readStudioSettings(dir);
      assert.equal(natural.lipSync, "manual");
      assert.equal(natural.lipsync.smoothing, "off");
      assert.equal(natural.lipsync.head_bob, "off");
      assert.equal(natural.lipsync.blinks, true);

      const fake = ({ cuesPath }) => {
        writeCues(cuesPath, [{ start: 0, end: 0.2, value: "B" }]);
        return { ok: true, cuesPath };
      };
      const synced = await syncDialogueLines({
        projectDir: dir,
        force: true,
        runRhubarb: fake,
        targets: [{ scriptLine: 4, wavRel, cuesRel, text: "Hello there." }],
      });
      assert.equal(synced.ok, true);
      assert.equal(synced.results[0].sync, "synced");
      assert.equal(computeSyncState({ projectDir: dir, cuesRel, wavRel, text: "Hello there." }), "synced");

      const skipped = await syncDialogueLines({
        projectDir: dir,
        runRhubarb: () => {
          throw new Error("should skip synced lines");
        },
        targets: [{ scriptLine: 4, wavRel, cuesRel, text: "Hello there." }],
      });
      assert.equal(skipped.results[0].skipped, true);

      const events = [
        { lane: "dialogue", scriptLine: 4, cuesRel, audioRel: wavRel, syncText: "Hello there.", sync: "synced" },
        { lane: "dialogue", scriptLine: 4, cuesRel, audioRel: wavRel, syncText: "Hello there.", sync: "synced" },
        { lane: "face", scriptLine: 5 },
      ];
      assert.equal(collectDialogueTargets(events).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patchMouthCue swaps a shape and pins it", () => {
    const dir = tmpDir();
    try {
      const rel = "audio/intro/001_alice.wav.rhubarb.json";
      const abs = path.join(dir, rel);
      writeCues(abs, [{ start: 0.2, end: 0.4, value: "B" }]);
      const cleared = clearDialogueLipSync({
        projectDir: dir,
        targets: [{ scriptLine: 4, cuesRel: "audio/intro/001_alice.wav.rhubarb.json" }],
      });
      assert.equal(cleared.ok, true);
      assert.equal(cleared.results[0].sync, "not_synced");
      assert.equal(fs.existsSync(abs), false);
      writeCues(abs, [{ start: 0.2, end: 0.4, value: "B" }]);
      const swapped = patchMouthCue(dir, { rel, start: 0.2, end: 0.4, value: "G", pinned: true });
      assert.equal(swapped.ok, true);
      assert.equal(swapped.cue.value, "G");
      assert.equal(swapped.cue.pinned, true);
      const saved = JSON.parse(fs.readFileSync(abs, "utf8"));
      assert.equal(saved.mouthCues[0].value, "G");
      assert.equal(saved.mouthCues[0].pinned, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
