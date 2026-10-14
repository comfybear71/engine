"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { createApp } = require("../src/server");
const {
  addCategory,
  listCategories,
  listLibraryClips,
  patchActionCategory,
  actionFrameList,
  flagActionFrame,
  deleteActionFrame,
  saveFrameToSlot,
  saveLibraryFrameToSlot,
  extractFaceFromClip,
  tickLibraryClip,
  writeClipIndex,
  uniqueClipId,
  clipDir,
} = require("../src/factoryLibrary");
const { listProjectActions } = require("../src/characterStatus");
const { encodeRgbaPng } = require("../src/pngFlip");

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

function writeTalkingHead(filePath, viseme) {
  const width = 160;
  const height = 200;
  const rgba = Buffer.alloc(width * height * 4);
  fillRect(rgba, width, 18, 12, 124, 176, 196, 140, 90, 255);
  if (viseme === "X") fillRect(rgba, width, 58, 130, 44, 3, 30, 20, 40, 255);
  else if (viseme === "C") fillRect(rgba, width, 56, 124, 48, 16, 22, 18, 20, 255);
  else fillRect(rgba, width, 54, 118, 52, 28, 22, 18, 20, 255);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encodeRgbaPng(width, height, rgba));
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

describe("factory library per character", { concurrency: false }, () => {
  let root;
  let projectDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-factory-lib-"));
    projectDir = path.join(root, "rodney_test");
    fs.mkdirSync(projectDir, { recursive: true });
    buildRodneyTestProject(projectDir);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("categories default and add, actions carry category", () => {
    const defaults = listCategories(projectDir, "rodney");
    assert.ok(defaults.some((item) => item.id === "walks" && item.label === "Walks"));
    assert.ok(defaults.some((item) => item.id === "head_moves"));
    const next = addCategory(projectDir, "rodney", "Bites");
    assert.ok(next.some((item) => item.id === "bites" && item.label === "Bites"));
    const walk = listProjectActions(projectDir, null).find((item) => item.label === "rodney/walk_side");
    assert.ok(walk);
    assert.equal(walk.category, "walks");
    const patched = patchActionCategory(projectDir, "rodney", "walk_side", "idle_stand");
    assert.equal(patched.category, "idle_stand");
    const listed = listProjectActions(projectDir, null).find((item) => item.label === "rodney/walk_side");
    assert.equal(listed.category, "idle_stand");
    patchActionCategory(projectDir, "rodney", "walk_side", "walks");
  });

  test("catalog index lives under characters/<id>/library/<clip>/", () => {
    const clipId = uniqueClipId(projectDir, "rodney", "generated_video_silly_walk.mp4");
    assert.equal(clipId, "silly_walk");
    const dest = clipDir(projectDir, "rodney", clipId);
    fs.mkdirSync(path.join(dest, "frames"), { recursive: true });
    fs.copyFileSync(
      path.join(projectDir, "characters", "rodney", "body", "walk_side_01.png"),
      path.join(dest, "frames", "frame_0000.png")
    );
    writeClipIndex(projectDir, "rodney", clipId, {
      id: clipId,
      filename: "generated_video_silly_walk.mp4",
      kind: "body",
      action: "walk",
      category: "walks",
      warnings: ["upside down on 1 frame(s)"],
      frames: [
        {
          index: 0,
          file: "frames/frame_0000.png",
          rel: "strip/frame_0000.png",
          kind: "body",
          view: "right_side",
          yaw: 90,
          action: "walk",
          phase: "contact_R",
          quality: 0.8,
          issues: ["upside_down"],
        },
      ],
    });
    const lib = listLibraryClips(projectDir, "rodney");
    assert.equal(lib.characterId, "rodney");
    const clip = lib.clips.find((item) => item.id === "silly_walk");
    assert.ok(clip);
    assert.equal(clip.kind, "body");
    assert.equal(clip.category, "walks");
    assert.equal(clip.frames[0].view, "right_side");
    assert.ok(clip.warnings.length);
  });

  test("flag, delete, and save-to-slot draft a frame", () => {
    const before = actionFrameList(projectDir, "rodney", "walk_side");
    assert.ok(before.drawings.length >= 3);
    const flagged = flagActionFrame(projectDir, "rodney", "walk_side", 0, "upside_down");
    assert.ok(flagged.drawings[0].issues.includes("upside_down"));
    const saved = saveFrameToSlot(projectDir, null, "rodney", "walk_side", 0, "torso", "right_side");
    assert.equal(saved.state, "draft");
    assert.equal(fs.existsSync(path.join(projectDir, saved.rel)), true);
    const afterDelete = deleteActionFrame(projectDir, "rodney", "walk_side", before.drawings.length - 1);
    assert.equal(afterDelete.drawings.length, before.drawings.length - 1);
  });

  function writeLibraryClip(clipId, kind, files) {
    const dest = clipDir(projectDir, "rodney", clipId);
    fs.mkdirSync(path.join(dest, "frames"), { recursive: true });
    const frames = files.map((src, index) => {
      const name = `frame_${String(index).padStart(4, "0")}.png`;
      fs.copyFileSync(src, path.join(dest, "frames", name));
      return {
        index,
        file: `frames/${name}`,
        rel: `frames/${name}`,
        kind,
        view: kind === "head" ? "front" : "right_side",
        yaw: kind === "head" ? 0 : 90,
        action: kind === "head" ? "talk" : "walk",
        phase: "",
        quality: 0.8,
        issues: [],
      };
    });
    writeClipIndex(projectDir, "rodney", clipId, {
      id: clipId,
      filename: `${clipId}.mp4`,
      kind,
      action: kind === "head" ? "talk" : "walk",
      category: kind === "head" ? "expressions" : "walks",
      warnings: [],
      frameCount: frames.length,
      frames,
    });
    return dest;
  }

  test("library save-to-slot drafts torso, labels arms L, and fits mouth overlays", async () => {
    writeLibraryClip("lib_body", "body", [
      path.join(projectDir, "characters", "rodney", "body", "walk_side_01.png"),
    ]);
    const torso = await saveLibraryFrameToSlot(projectDir, null, "rodney", "lib_body", 0, "torso", "right_side", "stride");
    assert.equal(torso.state, "draft");
    assert.equal(torso.slot, "torso");
    assert.equal(fs.existsSync(path.join(projectDir, torso.rel)), true);

    const arm = await saveLibraryFrameToSlot(projectDir, null, "rodney", "lib_body", 0, "arm", "front", "reach", "L");
    assert.match(arm.name, /_L$/);
    assert.equal(arm.state, "draft");

    writeLibraryClip("lib_mouth", "head", [
      path.join(projectDir, "characters", "rodney", "mouth_front", "A.png"),
    ]);
    const mouth = await saveLibraryFrameToSlot(projectDir, null, "rodney", "lib_mouth", 0, "mouth", "front", "A");
    assert.equal(mouth.state, "draft");
    assert.equal(mouth.slot, "mouth");

  });

  test("tick library clip writes an Action Shot with frame-count", async () => {
    writeLibraryClip("lib_tick", "body", [
      path.join(projectDir, "characters", "rodney", "body", "walk_side_01.png"),
      path.join(projectDir, "characters", "rodney", "body", "walk_side_02.png"),
      path.join(projectDir, "characters", "rodney", "body", "walk_side_03.png"),
    ]);
    const ticked = await tickLibraryClip(projectDir, null, "rodney", "lib_tick");
    assert.equal(ticked.ok, true);
    assert.ok(ticked.frames >= 2);
    assert.equal(ticked.still, false);
    const listed = listProjectActions(projectDir, null).find((item) => item.id === ticked.actionId);
    assert.ok(listed);
    assert.equal(listed.frames, ticked.frames);
    const lib = listLibraryClips(projectDir, "rodney");
    const clip = lib.clips.find((item) => item.id === "lib_tick");
    assert.equal(clip.ticked, true);
    assert.equal(clip.actionId, ticked.actionId);
  });

  test("extract mouths from a talking-head clip as drafts", async () => {
    const dest = clipDir(projectDir, "rodney", "lib_talk");
    fs.mkdirSync(path.join(dest, "frames"), { recursive: true });
    const frames = ["X", "C", "D"].map((name, index) => {
      const file = path.join(dest, "frames", `frame_${String(index).padStart(4, "0")}.png`);
      writeTalkingHead(file, name);
      return {
        index,
        file: `frames/frame_${String(index).padStart(4, "0")}.png`,
        rel: `frames/frame_${String(index).padStart(4, "0")}.png`,
        kind: "head",
        view: "front",
        yaw: 0,
        action: "talk",
        issues: [],
      };
    });
    writeClipIndex(projectDir, "rodney", "lib_talk", {
      id: "lib_talk",
      filename: "talk.mp4",
      kind: "head",
      action: "talk",
      category: "expressions",
      frames,
    });
    const extracted = await extractFaceFromClip(projectDir, null, "rodney", "lib_talk", "mouth");
    assert.ok(extracted.drawings.length >= 1);
    assert.equal(extracted.state, "draft");
    assert.equal(fs.existsSync(path.join(projectDir, extracted.drawings[0].rel)), true);
  });

  test("HTTP library and action frame routes", async () => {
    const ctx = await listen(createApp({ projectsDir: root }));
    try {
      const lib = await fetch(`${ctx.url}/api/projects/rodney_test/characters/rodney/library`);
      const body = await lib.json();
      assert.equal(lib.ok, true, body.error || `HTTP ${lib.status}`);
      assert.ok(body.categories.some((item) => item.id === "walks"));
      const add = await fetch(`${ctx.url}/api/projects/rodney_test/characters/rodney/library/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Nods" }),
      });
      assert.equal(add.ok, true);
      const frames = await fetch(`${ctx.url}/api/projects/rodney_test/actions/rodney/walk_side/frames`);
      assert.equal(frames.ok, true);
      const detail = await frames.json();
      assert.ok(detail.drawings.length >= 2);
      const flag = await fetch(`${ctx.url}/api/projects/rodney_test/actions/rodney/walk_side/frames/1/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue: "mirrored" }),
      });
      assert.equal(flag.ok, true);
      const flagged = await flag.json();
      assert.ok(flagged.drawings[1].issues.includes("mirrored"));
      const tick = await fetch(`${ctx.url}/api/projects/rodney_test/characters/rodney/library/lib_tick/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(tick.ok, true, await tick.text());
    } finally {
      await ctx.close();
    }
  });
});
