"use strict";

const { test, describe, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createApp, isSafeProjectName, resolveProjectDir, isSafeRelPath } = require("../src/server");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");

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

describe("studio worker API", () => {
  const fixture = createFixtureLibrary();
  fs.mkdirSync(path.join(fixture.root, "other_show"), { recursive: true });

  fixture.writePng(path.join(fixture.globalAssetsDir, "backgrounds", "room_a", "props", "letterbox.png"));
  fixture.writeJson(path.join(fixture.globalAssetsDir, "backgrounds", "room_a", "staging.json"), {
    marks: {
      centre: { x: 500, y: 1000, scale: 1.0 },
      left: { x: 450, y: 1000, scale: 1.0 },
      right: { x: 550, y: 1000, scale: 1.0, flip_x: true },
    },
    auto_order: ["left", "right"],
    props: {
      letterbox: {
        asset: "props/letterbox.png",
        x: 500,
        y: 1000,
        scale: 1.0,
        z: 5,
      },
    },
  });

  const carolDir = path.join(fixture.projectDir, "characters", "carol");
  fixture.writePng(path.join(carolDir, "body.png"));
  fixture.writePng(path.join(carolDir, "mouth", "X.png"));
  fixture.writeJson(path.join(carolDir, "character.json"), {
    id: "carol",
    display_name: "Carol",
    aliases: ["Carol"],
    asset: "body.png",
    z: 8,
    slots: {
      mouth: { offset: { x: 0, y: -10 }, drawings_dir: "mouth" },
    },
    children: [],
  });

  const app = createApp({ projectsDir: fixture.root, skipValidate: true });
  /** @type {{ url: string, close: () => Promise<void> }} */
  let ctx;

  before(async () => {
    ctx = await listen(app);
  });

  after(async () => {
    if (ctx) await ctx.close();
    fixture.cleanup();
  });

  test("GET /api/projects lists folders and excludes _global_assets", async () => {
    const res = await fetch(`${ctx.url}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.projects.map((p) => p.name);
    assert.deepEqual(names, ["other_show", "project"]);
    assert.equal(names.includes("_global_assets"), false);
  });

  test("GET /api/projects/:name/characters includes slots, drawings, cycles, and project-local", async () => {
    const res = await fetch(`${ctx.url}/api/projects/project/characters`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.characters.map((c) => c.id).sort();
    assert.deepEqual(ids, ["alice", "bob", "carol"]);

    const alice = body.characters.find((c) => c.id === "alice");
    assert.equal(alice.display_name, "Alice");
    assert.equal(alice.source, "global");
    assert.equal(alice.thumbRel, "characters/alice/body.png");
    const eyes = alice.slots.find((s) => s.name === "eyes");
    assert.ok(eyes);
    assert.deepEqual(
      eyes.drawings.map((d) => d.name).sort(),
      ["closed", "open"]
    );
    assert.equal(eyes.cycles.blink_loop.fps, 6);
    assert.ok(alice.slots.some((s) => s.name === "right_hand" && s.owner === "right_arm"));

    const carol = body.characters.find((c) => c.id === "carol");
    assert.equal(carol.source, "project");
    assert.equal(carol.thumbRel, "characters/carol/body.png");
  });

  test("GET /api/projects/:name/staging lists backgrounds, props, and marks", async () => {
    const res = await fetch(`${ctx.url}/api/projects/project/staging`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const bgIds = body.backgrounds.map((b) => b.id).sort();
    assert.deepEqual(bgIds, ["room_a", "room_b"]);
    assert.equal(body.marksByLocation.room_a.left.x, 450);
    assert.ok(body.marksByLocation.room_a.off_left, "library-wide fallback marks are merged");
    const letterbox = body.props.find((p) => p.id === "letterbox");
    assert.ok(letterbox);
    assert.equal(letterbox.location, "room_a");
    assert.equal(letterbox.z, 5);
    assert.equal(letterbox.thumbRel, "backgrounds/room_a/props/letterbox.png");
  });

  test("GET /api/projects/:name/asset serves images and rejects traversal", async () => {
    const ok = await fetch(
      `${ctx.url}/api/projects/project/asset?rel=${encodeURIComponent("characters/alice/body.png")}`
    );
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type"), /image\/png/);
    const bytes = Buffer.from(await ok.arrayBuffer());
    assert.ok(bytes.length > 8);
    assert.equal(bytes[0], 0x89);

    assert.equal(isSafeRelPath("../_global_assets/characters/alice/body.png"), false);
    assert.equal(isSafeRelPath("characters/alice/body.png"), true);

    const bad = await fetch(
      `${ctx.url}/api/projects/project/asset?rel=${encodeURIComponent("../package.json")}`
    );
    assert.equal(bad.status, 400);
  });

  test("GET /stage and POST preview-frame do not overwrite timeline.json", async () => {
    fixture.writeScript(
      ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi."].join("\n")
    );
    const timelinePath = path.join(fixture.projectDir, "timeline.json");
    const linesPath = path.join(fixture.projectDir, "lines.json");
    const sentinelTimeline = { sentinel: true, series: "keep-me" };
    const sentinelLines = { sentinel: "lines" };
    fs.writeFileSync(timelinePath, JSON.stringify(sentinelTimeline));
    fs.writeFileSync(linesPath, JSON.stringify(sentinelLines));

    const stage = await fetch(`${ctx.url}/api/projects/project/stage`);
    assert.equal(stage.status, 200, await stage.text());
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);
    assert.deepEqual(JSON.parse(fs.readFileSync(linesPath, "utf8")), sentinelLines);

    await fetch(`${ctx.url}/api/projects/project/preview-frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: 0 }),
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);
    assert.deepEqual(JSON.parse(fs.readFileSync(linesPath, "utf8")), sentinelLines);
  });

  test("path traversal and reserved names are rejected", async () => {
    assert.equal(isSafeProjectName(".."), false);
    assert.equal(isSafeProjectName("_global_assets"), false);
    assert.equal(resolveProjectDir(fixture.root, ".."), null);
    assert.equal(resolveProjectDir(fixture.root, "../project"), null);
    assert.equal(resolveProjectDir(fixture.root, "_global_assets"), null);

    const names = ["_global_assets", encodeURIComponent("../project"), encodeURIComponent("..\\project")];
    for (const name of names) {
      const res = await fetch(`${ctx.url}/api/projects/${name}/characters`);
      assert.equal(res.status, 400, `expected 400 for name ${JSON.stringify(name)}, got ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /Invalid project name/);
    }
  });
});
