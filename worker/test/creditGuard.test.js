"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { fingerprint, sidecarPathForWav, writeSidecar, shouldSkipLine } = require("../src/voices/creditGuard");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-credit-guard-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fields = { text: "Hello there.", voiceId: "voice-alice", modelId: "eleven_multilingual_v2" };

describe("credit-guard hash / skip", () => {
  test("fingerprint is stable for the same text+voice+model and changes when any field changes", () => {
    assert.equal(fingerprint(fields), fingerprint({ ...fields }));
    assert.notEqual(fingerprint(fields), fingerprint({ ...fields, text: "Hello there!" }));
    assert.notEqual(fingerprint(fields), fingerprint({ ...fields, voiceId: "voice-bob" }));
    assert.notEqual(fingerprint(fields), fingerprint({ ...fields, modelId: "other_model" }));
  });

  test("skips only when the WAV exists and the sidecar hash matches; --force never skips", () => {
    const wavPath = path.join(tmp, "audio", "intro", "001_alice.wav");
    const sidecarPath = sidecarPathForWav(wavPath);
    assert.equal(sidecarPath, `${wavPath}.json`);

    assert.equal(shouldSkipLine({ wavPath, ...fields }), false, "missing WAV must not skip");

    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    fs.writeFileSync(wavPath, "fake-wav");
    assert.equal(shouldSkipLine({ wavPath, ...fields }), false, "WAV without sidecar must not skip");

    writeSidecar(sidecarPath, fields);
    assert.equal(shouldSkipLine({ wavPath, ...fields }), true, "matching hash must skip");
    assert.equal(shouldSkipLine({ wavPath, ...fields, text: "Changed line." }), false, "changed text must re-record");
    assert.equal(shouldSkipLine({ wavPath, ...fields, voiceId: "other" }), false, "changed voice must re-record");
    assert.equal(shouldSkipLine({ wavPath, ...fields, modelId: "other" }), false, "changed model must re-record");
    assert.equal(shouldSkipLine({ wavPath, ...fields, force: true }), false, "--force must re-record");
  });
});
