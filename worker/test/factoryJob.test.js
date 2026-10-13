"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeRgbaPng } = require("../src/pngFlip");
const { decodeRgbaFile, alphaBounds } = require("../src/factoryThumb");
const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { resolveActionDest, uniqueActionId, walkBob, runFactoryJob, tickFactoryJob, pickSideTorsoDrawing } = require("../src/factoryJob");
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
  const rows = Math.max(1, frames / 4);
  const inner = 72;
  const gutter = 10;
  const width = cols * inner + (cols + 1) * gutter;
  const height = rows * inner + (rows + 1) * gutter;
  const rgba = Buffer.alloc(width * height * 4);
  fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
  for (let i = 0; i < frames; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = gutter + col * (inner + gutter);
    const y0 = gutter + row * (inner + gutter);
    const stride = (i % 4) * 3;
    // Cape behind (left), head, torso, two legs, two boots — one full figure per cell.
    fillRect(rgba, width, x0 + 6, y0 + 10, 10, 36, 180, 20, 20, 255);
    fillRect(rgba, width, x0 + 28 + stride, y0 + 6, 16, 14, 196, 140, 96, 255);
    fillRect(rgba, width, x0 + 24 + stride, y0 + 20, 22, 22, 150, 28, 28, 255);
    fillRect(rgba, width, x0 + 22 + stride, y0 + 42, 8, 18, 140, 70, 40, 255);
    fillRect(rgba, width, x0 + 36 + stride, y0 + 42, 8, 18, 140, 70, 40, 255);
    fillRect(rgba, width, x0 + 20 + stride, y0 + 58, 10, 10, 70, 40, 24, 255);
    fillRect(rgba, width, x0 + 38 + stride, y0 + 58, 10, 10, 70, 40, 24, 255);
  }
  return encodeRgbaPng(width, height, rgba);
}

function paintFigure(rgba, width, x0, y0, stride) {
  fillRect(rgba, width, x0 + 6, y0 + 10, 10, 36, 180, 20, 20, 255);
  fillRect(rgba, width, x0 + 28 + stride, y0 + 6, 16, 14, 196, 140, 96, 255);
  fillRect(rgba, width, x0 + 24 + stride, y0 + 20, 22, 22, 150, 28, 28, 255);
  fillRect(rgba, width, x0 + 22 + stride, y0 + 42, 8, 18, 140, 70, 40, 255);
  fillRect(rgba, width, x0 + 36 + stride, y0 + 42, 8, 18, 140, 70, 40, 255);
  fillRect(rgba, width, x0 + 20 + stride, y0 + 58, 10, 10, 70, 40, 24, 255);
  fillRect(rgba, width, x0 + 38 + stride, y0 + 58, 10, 10, 70, 40, 24, 255);
}

function grokBrokenWalkSheet() {
  // Real Grok failure modes packed into one 4x2 sheet: extra bodies + a
  // zoomed boot close-up that used to be scaled to fill the 1024 canvas.
  const cols = 4;
  const rows = 2;
  const inner = 120;
  const gutter = 12;
  const width = cols * inner + (cols + 1) * gutter;
  const height = rows * inner + (rows + 1) * gutter;
  const rgba = Buffer.alloc(width * height * 4);
  fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
  for (let i = 0; i < 8; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = gutter + col * (inner + gutter);
    const y0 = gutter + row * (inner + gutter);
    if (i === 6) {
      paintFigure(rgba, width, x0 + 4, y0 + 20, 0);
      paintFigure(rgba, width, x0 + 58, y0 + 20, 6);
      continue;
    }
    if (i === 7) {
      fillRect(rgba, width, x0 + 8, y0 + 10, 44, 100, 70, 40, 24, 255);
      fillRect(rgba, width, x0 + 68, y0 + 10, 44, 100, 70, 40, 24, 255);
      continue;
    }
    paintFigure(rgba, width, x0 + 24, y0 + 24, (i % 4) * 3);
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

  test("side torso skip list ignores walk/run/approach so a walk job uses a standing torso", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-factory-torso-"));
    try {
      const dir = path.join(root, "characters", "rodney", "torso_right_side");
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ["approach.png", "walk.png", "neutral.png"]) {
        fs.writeFileSync(path.join(dir, name), "");
      }
      assert.equal(pickSideTorsoDrawing(root, "rodney", "right_side"), "neutral");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    assert.equal(job.action && job.action.set_slots && job.action.set_slots.body, "none");
    assert.equal(job.action && job.action.set_slots && job.action.set_slots.torso, "neutral");
    assert.equal(job.action && job.action.view, "right_side");
    const liveDir = path.join(projectDir, "characters", "rodney", "legs_right_side");
    const oldWalk = path.join(liveDir, "walk_side_01.png");
    assert.equal(fs.existsSync(oldWalk), true, "existing walk_side legs stay on disk until Tick");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, "characters", "rodney", "_factory", job.jobId, "manifest.json"), "utf8")
    );
    assert.ok(manifest.action.set_slots.body === "none");
    assert.equal(
      (manifest.action.slot_frames.legs || []).includes("walk_side_01"),
      false,
      "new action does not keep the old walk_side drawing"
    );
    assert.equal(
      fs.readdirSync(liveDir).some((name) => name.startsWith(job.actionId)),
      false,
      "new drawings stay out of the library until Tick"
    );

    const ticked = tickFactoryJob(projectDir, null, "rodney", job.jobId);
    assert.equal(ticked.ticked, true);
    const actionJson = JSON.parse(
      fs.readFileSync(path.join(projectDir, "characters", "rodney", "actions", `${job.actionId}.json`), "utf8")
    );
    assert.equal(actionJson.set_slots.body, "none");
    assert.equal(actionJson.view, "right_side");
    assert.ok(fs.existsSync(oldWalk), "Tick adds new legs and does not delete the leftover file on disk");
    assert.ok(fs.readdirSync(liveDir).some((name) => name.startsWith(job.actionId) && name.endsWith(".png")));
    assert.equal(fs.existsSync(path.join(otherDir, "characters", "rodney")), false);

    const alignedDir = path.join(projectDir, "characters", "rodney", "_factory", job.jobId, "aligned");
    const aligned = fs.readdirSync(alignedDir).filter((name) => name.endsWith(".png"));
    assert.ok(aligned.length >= 2);
    for (const name of aligned) {
      const decoded = decodeRgbaFile(path.join(alignedDir, name));
      const box = alphaBounds(decoded.rgba, decoded.width, decoded.height);
      assert.equal(box.empty, false);
      assert.ok(box.h < 220, `legs ${name} should match the rig, not fill the canvas (${box.h}px)`);
      assert.ok(box.y + box.h > 680, `feet of ${name} should sit on the rig ground line`);
    }
    const preview = path.join(projectDir, "characters", "rodney", "_factory", job.jobId, "preview.mp4");
    if (fs.existsSync(preview)) {
      const { execFileSync } = require("child_process");
      const dims = execFileSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", preview],
        { encoding: "utf8" }
      ).trim();
      assert.equal(dims, "854,480", "factory walk preview must be 16:9, not a cropped square");
    }
  });

  test("real-like Grok extras and zoomed boots fail the walk job instead of compositing giant legs", async () => {
    const factoryDir = path.join(projectDir, "characters", "rodney", "_factory");
    const before = new Set(fs.existsSync(factoryDir) ? fs.readdirSync(factoryDir) : []);
    await assert.rejects(
      () =>
        runFactoryJob(projectDir, null, {
          characterId: "rodney",
          prompt: "Rodney walking long stride",
          frames: 8,
          imageBase64: `data:image/png;base64,${grokBrokenWalkSheet().toString("base64")}`,
        }),
      /extra figures|zoomed crop|failed validation/i
    );
    const after = fs.existsSync(factoryDir) ? fs.readdirSync(factoryDir) : [];
    for (const jobId of after) {
      if (before.has(jobId)) continue;
      const preview = path.join(factoryDir, jobId, "preview.mp4");
      assert.equal(fs.existsSync(preview), false, "broken walk must not leave a preview");
    }
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

  test("prop / background / new-character dry-run packs skip character references", async () => {
    const prop = await runFactoryJob(projectDir, null, {
      mode: "prop",
      prompt: "bar stool",
      dryRun: true,
    });
    assert.equal(prop.pack.skipReferences, true);
    assert.equal(prop.pack.mode, "prop");
    assert.match(prop.pack.hiddenPrompt, /isolated object/i);

    const bg = await runFactoryJob(projectDir, null, {
      mode: "background",
      prompt: "smoky bar interior",
      dryRun: true,
    });
    assert.equal(bg.pack.greenScreen, null);
    assert.equal(bg.pack.aspectRatio, "16:9");

    const newbie = await runFactoryJob(projectDir, null, {
      mode: "new-character",
      name: "Grumpy old barman",
      prompt: "grumpy old barman",
      dryRun: true,
    });
    assert.equal(newbie.pack.skipReferences, true);
    assert.match(newbie.pack.hiddenPrompt, /Do not copy any existing character/);
    assert.equal(fs.existsSync(path.join(otherDir, "characters", "grumpy_old_barman")), false);
  });

  test("slot eyes job ticks a draft overlay into this character only", async () => {
    const width = 1024;
    const height = 1024;
    const rgba = Buffer.alloc(width * height * 4);
    fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
    fillRect(rgba, width, 468, 318, 28, 14, 20, 18, 16, 255);
    fillRect(rgba, width, 532, 318, 28, 14, 20, 18, 16, 255);
    const sheet = encodeRgbaPng(width, height, rgba);
    const job = await runFactoryJob(projectDir, null, {
      mode: "slot",
      characterId: "rodney",
      slot: "eyes",
      view: "front",
      prompt: "sleepy",
      imageBase64: `data:image/png;base64,${sheet.toString("base64")}`,
    });
    assert.equal(job.mode, "slot");
    assert.equal(job.ticked, false);
    assert.equal(job.dest.slot, "eyes");
    const before = fs.existsSync(path.join(projectDir, "characters", "rodney", "eyes_front", "sleepy.png"));
    assert.equal(before, false);
    const ticked = tickFactoryJob(projectDir, null, "rodney", job.jobId);
    assert.equal(ticked.ticked, true);
    const status = JSON.parse(fs.readFileSync(path.join(projectDir, "characters", "rodney", "status.json"), "utf8"));
    const draftKey = Object.keys(status).find((key) => key.includes("sleepy") && status[key] === "draft");
    assert.ok(draftKey, "Tick stores the overlay as draft");
    assert.equal(fs.existsSync(path.join(otherDir, "characters", "rodney", "eyes_front", "sleepy.png")), false);
  });

  test("new-character tick creates a project-local folder and reference", async () => {
    const width = 64;
    const height = 64;
    const rgba = Buffer.alloc(width * height * 4);
    fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
    fillRect(rgba, width, 20, 8, 24, 48, 180, 80, 40, 255);
    const sheet = encodeRgbaPng(width, height, rgba);
    const job = await runFactoryJob(projectDir, null, {
      mode: "new-character",
      name: "Barman",
      prompt: "grumpy old barman",
      imageBase64: `data:image/png;base64,${sheet.toString("base64")}`,
    });
    assert.equal(job.characterId, "project");
    const ticked = tickFactoryJob(projectDir, null, "project", job.jobId);
    assert.equal(ticked.ticked, true);
    const dir = path.join(projectDir, "characters", "barman");
    assert.equal(fs.existsSync(path.join(dir, "character.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "_reference", "full.png")), true);
    assert.equal(fs.existsSync(path.join(otherDir, "characters", "barman")), false);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "character.json"), "utf8"));
    assert.equal(json.display_name, "Barman");
  });

  test("prop tick saves a cut-out tile in this project", async () => {
    const width = 48;
    const height = 48;
    const rgba = Buffer.alloc(width * height * 4);
    fillRect(rgba, width, 0, 0, width, height, 0, 255, 0, 255);
    fillRect(rgba, width, 12, 8, 24, 32, 90, 60, 30, 255);
    const sheet = encodeRgbaPng(width, height, rgba);
    const job = await runFactoryJob(projectDir, null, {
      mode: "prop",
      prompt: "bar stool",
      imageBase64: `data:image/png;base64,${sheet.toString("base64")}`,
    });
    const ticked = tickFactoryJob(projectDir, null, "project", job.jobId);
    assert.equal(ticked.ticked, true);
    assert.ok(ticked.written || fs.existsSync(path.join(projectDir, "backgrounds")));
    const propPngs = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith(".png") && /stool|prop/.test(abs)) propPngs.push(abs);
      }
    };
    walk(path.join(projectDir, "backgrounds"));
    assert.ok(propPngs.length >= 1 || (ticked.written && ticked.written.rel));
    assert.equal(fs.existsSync(path.join(otherDir, "backgrounds")), false);
  });
});
