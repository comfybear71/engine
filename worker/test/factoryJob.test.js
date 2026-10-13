"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeRgbaPng } = require("../src/pngFlip");
const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { resolveActionDest, uniqueActionId, walkBob, runFactoryJob, tickFactoryJob } = require("../src/factoryJob");
const { createApp } = require("../src/server");

function fillRect(rgba, width, x, y, w, h, r, g, b, a) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, x0 + Math.round(w));
  const y1 = Math.min(rgba.length / (width * 4), y0 + Math.round(h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const o = (yy * width + xx) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

function walkSheetPng(frames = 8) {
  const cols = 4;
  const rows = frames / 4;
  const cell = 96;
  const width = cols * cell;
  const height = rows * cell;
  const rgba = Buffer.alloc(width * height * 4);
  fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
  for (let i = 0; i < frames; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cell + 28 + (i % 3) * 4;
    const y = row * cell + 18;
    fillRect(rgba, width, x, y, 22, 58, 140, 70, 40, 255);
    fillRect(rgba, width, x - 8 + (i % 2) * 16, y + 48, 14, 22, 90, 50, 30, 255);
  }
  return encodeRgbaPng(width, height, rgba);
}

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

describe("factory dest and names", () => {
  test("walk jobs land on legs_side when the character has legs", () => {
    const dest = resolveActionDest(
      { slots: { legs: { drawings_dir: "legs" }, body: { drawings_dir: "body" } } },
      { kind: "walk", view: "right_side" }
    );
    assert.equal(dest.slot, "legs");
    assert.equal(dest.drawings_dir, "legs_right_side");
    assert.deepEqual(walkBob(8).length, 8);
  });

  test("action ids do not clobber an existing walk_side", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-factory-id-"));
    try {
      const actions = path.join(root, "characters", "rodney", "actions");
      fs.mkdirSync(actions, { recursive: true });
      fs.writeFileSync(path.join(actions, "walk_side_long_stride.json"), "{}\n");
      assert.equal(uniqueActionId(root, "rodney", "walk_side_long_stride"), "walk_side_long_stride_2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("factory pipeline with a fixture sheet", () => {
  let root;
  let projectDir;
  let otherDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-factory-job-"));
    projectDir = path.join(root, "rodney_test");
    otherDir = path.join(root, "other_show");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    buildRodneyTestProject(projectDir);
    fs.writeFileSync(path.join(otherDir, "studio.json"), `${JSON.stringify({ independent: true }, null, 2)}\n`);
    fs.writeFileSync(path.join(otherDir, "script.txt"), "[Scene: X]\n[Cast: Nobody]\n");
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("fixture sheet cuts, fits, previews, and ticks into this project only", async () => {
    const sheet = walkSheetPng(8);
    const job = await runFactoryJob(projectDir, null, {
      characterId: "rodney",
      prompt: "Rodney walking long stride",
      frames: 8,
      imageBase64: `data:image/png;base64,${sheet.toString("base64")}`,
    });
    assert.equal(job.usedFixture, true);
    assert.equal(job.ticked, false);
    assert.ok(job.drawings.length >= 2);
    assert.equal(job.dest.drawings_dir, "legs_right_side");
    assert.match(job.actionId, /walk_side/);
    const liveDir = path.join(projectDir, "characters", "rodney", "legs_right_side");
    assert.equal(fs.existsSync(liveDir), false, "drawings stay out of the library until Tick");

    const ticked = tickFactoryJob(projectDir, null, "rodney", job.jobId);
    assert.equal(ticked.ticked, true);
    assert.ok(fs.existsSync(path.join(projectDir, "characters", "rodney", "actions", `${job.actionId}.json`)));
    assert.ok(fs.existsSync(liveDir));
    assert.ok(fs.readdirSync(liveDir).some((name) => name.endsWith(".png")));
    assert.equal(fs.existsSync(path.join(otherDir, "characters", "rodney")), false);
  });

  test("POST /api/projects/:name/factory rejects a character from another project", async () => {
    const ctx = await listen(createApp({ projectsDir: root }));
    try {
      const res = await fetch(`${ctx.url}/api/projects/other_show/factory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: "rodney", prompt: "Rodney walking long stride", frames: 8 }),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error || "", /Unknown character|not found/i);
    } finally {
      await ctx.close();
    }
  });
});
