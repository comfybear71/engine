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
  writeClipIndex,
  uniqueClipId,
  clipDir,
} = require("../src/factoryLibrary");
const { listProjectActions } = require("../src/characterStatus");

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

  test("HTTP library and action frame routes", async () => {
    const ctx = await listen(createApp({ projectsDir: root }));
    try {
      const lib = await fetch(`${ctx.url}/api/projects/rodney_test/characters/rodney/library`);
      assert.equal(lib.ok, true, await lib.text());
      const body = await lib.json();
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
    } finally {
      await ctx.close();
    }
  });
});
