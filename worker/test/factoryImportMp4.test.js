"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { writeSyntheticWalkMp4 } = require("./helpers/syntheticWalkMp4");
const { startImportMp4, buildImportMp4, slugImportActionId } = require("../src/factoryImportMp4");
const { tickFactoryJob, redoFactoryJob } = require("../src/factoryJob");
const { createApp } = require("../src/server");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "import_mp4");
const TINY_SAMPLE = path.join(FIXTURE_DIR, "silly_walk_sample.mp4");

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

describe("slugImportActionId", () => {
  test("strips generated_video_ and does not start with walk_", () => {
    assert.equal(slugImportActionId("generated_video_silly_walk.mp4", "walk", "right_side"), "silly_walk_side");
    assert.equal(slugImportActionId("generated_video_silly_walk.mp4", "", "right_side"), "silly_walk_side");
    assert.equal(/^walk_/.test(slugImportActionId("generated_video_silly_walk.mp4")), false);
  });
});

describe("factory import mp4", { concurrency: false }, () => {
  let root;
  let projectDir;
  let videoPath;
  let xaiCalls;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-import-mp4-"));
    projectDir = path.join(root, "rodney_test");
    fs.mkdirSync(projectDir, { recursive: true });
    buildRodneyTestProject(projectDir);
    videoPath = path.join(root, "generated_video_silly_walk.mp4");
    writeSyntheticWalkMp4(videoPath, { count: 150, width: 96, height: 144, walkStart: 76, period: 24 });
    xaiCalls = 0;
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("detects the 76-145 walk, builds a 16:9 preview, and ticks a draft with no xAI", { timeout: 180000 }, async () => {
    const job = await startImportMp4(
      projectDir,
      null,
      {
        characterId: "rodney",
        filename: "generated_video_silly_walk.mp4",
        videoPath,
        frames: 8,
      },
      {
        fetchFn: () => {
          xaiCalls += 1;
          throw new Error("xAI must not be called for Import MP4");
        },
      }
    );
    assert.equal(xaiCalls, 0);
    assert.equal(job.usedImport, true);
    assert.equal(job.keepHead, true);
    assert.equal(job.usedGrok, false);
    assert.equal(job.actionId, "silly_walk_side");
    assert.equal(/^walk_/.test(job.actionId), false);
    assert.equal(job.dest.slot, "torso");
    assert.equal(job.dest.drawings_dir, "torso_right_side");
    assert.equal(job.frames, 8);
    assert.equal(job.drawings.length, 8);
    assert.ok(job.importMp4);
    assert.equal(job.importMp4.background, "black");
    assert.ok(job.importMp4.steady.start >= 60);
    assert.ok(job.importMp4.steady.start < 120);
    assert.ok(job.importMp4.steady.end >= 130);
    const keys = job.importMp4.selected || [];
    assert.equal(keys.length, 8);
    assert.ok(keys.every((index) => index >= 76 && index <= 145), `keys ${keys.join(",")} should sit in 76-145`);
    assert.ok(job.importMp4.suggested["12"].length === 12);
    assert.ok(job.importMp4.suggested["16"].length === 16);
    assert.ok(job.importMp4.suggested["12"].every((index) => index >= 76 && index <= 145));
    assert.ok(job.importMp4.suggested["16"].every((index) => index >= 76 && index <= 145));
    assert.equal(job.action.hide_children, true);
    assert.equal(job.action.set_slots.head_base, undefined);
    assert.equal(job.action.set_slots.eyes, undefined);
    assert.equal(job.action.set_slots.legs, "none");
    assert.equal(job.action.set_slots.body, "none");
    assert.ok(job.action.distance_per_cycle >= 8);
    const preview = path.join(projectDir, "characters", "rodney", "_factory", job.jobId, "preview.mp4");
    assert.equal(fs.existsSync(preview), true, "preview.mp4 must render");
    assert.ok(fs.statSync(preview).size > 1000);
    assert.ok(job.previewRel);

    const rebuilt = await buildImportMp4(
      projectDir,
      null,
      "rodney",
      job.jobId,
      { indices: keys.slice(0, 6).concat(keys.slice(6)), frames: 8 },
      { fetchFn: () => { throw new Error("no xAI"); } }
    );
    assert.equal(rebuilt.drawings.length, 8);

    const ticked = tickFactoryJob(projectDir, null, "rodney", job.jobId);
    assert.equal(ticked.ticked, true);
    const actionPath = path.join(projectDir, "characters", "rodney", "actions", "silly_walk_side.json");
    assert.equal(fs.existsSync(actionPath), true);
    const action = JSON.parse(fs.readFileSync(actionPath, "utf8"));
    assert.equal(action.id, "silly_walk_side");
    assert.equal(action.view, "right_side");
    assert.equal(action.hide_children, true);
    assert.equal(action.set_slots.head_base, undefined);
    const destDir = path.join(projectDir, "characters", "rodney", "torso_right_side");
    for (let i = 1; i <= 8; i += 1) {
      const name = `silly_walk_side_${String(i).padStart(2, "0")}.png`;
      assert.equal(fs.existsSync(path.join(destDir, name)), true, name);
    }
    const status = JSON.parse(fs.readFileSync(path.join(projectDir, "characters", "rodney", "status.json"), "utf8"));
    assert.ok(Object.keys(status).some((key) => key.includes("silly_walk_side") && status[key] === "draft"));

    await assert.rejects(
      () => redoFactoryJob(projectDir, null, "rodney", job.jobId, {}),
      /already ticked|Import a new MP4/i
    );
  });

  test("HTTP import-mp4 does not call xAI", { timeout: 180000 }, async () => {
    const ctx = await listen(
      createApp({
        projectsDir: root,
        fetchFn: () => {
          xaiCalls += 1;
          throw new Error("xAI must not be called");
        },
      })
    );
    try {
      const res = await fetch(`${ctx.url}/api/projects/rodney_test/factory/import-mp4`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterId: "rodney",
          filename: "generated_video_silly_walk.mp4",
          videoPath: fs.existsSync(TINY_SAMPLE) ? TINY_SAMPLE : videoPath,
          frames: 8,
        }),
      });
      const payload = await res.json();
      assert.equal(res.ok, true, payload.error || `HTTP ${res.status}`);
      assert.equal(payload.usedImport, true);
      assert.match(payload.actionId, /^silly_walk_side/);
      assert.equal(xaiCalls, 0);
      const strip = payload.importMp4 && payload.importMp4.thumbs && payload.importMp4.thumbs[0];
      assert.ok(strip);
      const thumb = await fetch(
        `${ctx.url}/api/projects/rodney_test/factory/rodney/${payload.jobId}/strip/${path.basename(strip.rel)}`
      );
      assert.equal(thumb.ok, true, `strip ${thumb.status}`);
    } finally {
      await ctx.close();
    }
  });
});

describe("committed tiny import sample", () => {
  test("silly_walk_sample.mp4 is a real downscaled clip", () => {
    assert.equal(fs.existsSync(TINY_SAMPLE), true);
    assert.ok(fs.statSync(TINY_SAMPLE).size > 400);
    assert.ok(fs.statSync(TINY_SAMPLE).size < 250000);
  });
});
