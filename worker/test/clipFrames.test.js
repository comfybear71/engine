"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { bakedClipFrames } = require("../src/clipFrames");

test("baked Action Shot frames resolve the way a [Clip:] line finds them", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "clipframes-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipframes-global-"));
  try {
    const dir = path.join(project, "characters", "rodney", "actions", "walk");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "f_0001.png"), "x");
    fs.writeFileSync(path.join(dir, "f_0002.png"), "x");
    fs.writeFileSync(
      path.join(project, "characters", "rodney", "actions", "walk.json"),
      JSON.stringify({ id: "walk", fps: 12, slot_frames: { body: ["f_0001.png", "f_0002.png", "f_0003.png"] }, drawingsDir: "actions/walk" })
    );
    const found = bakedClipFrames(project, globalDir, "rodney", "walk");
    assert.equal(found.fps, 12);
    assert.deepEqual(found.frames, ["characters/rodney/actions/walk/f_0001.png", "characters/rodney/actions/walk/f_0002.png"]);
    assert.equal(bakedClipFrames(project, globalDir, "rodney", "missing"), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});
