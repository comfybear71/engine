"use strict";

const { test, describe, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createApp, isSafeProjectName, resolveProjectDir, isSafeRelPath } = require("../src/server");
const { renderOutputName, resolveScriptName } = require("../src/studioProjects");
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

  fixture.writeScript(
    [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice, Bob]",
      "Alice: Hello there friend.",
      "[Scene: Next]",
      "[Location: room_b]",
      "[Cast: Alice]",
      "Alice: Bye.",
    ].join("\n")
  );

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
    const project = body.projects.find((p) => p.name === "project");
    assert.ok(project.scripts.includes("script.txt"));
    assert.equal(project.thumbRel, "backgrounds/room_a/bg.png");
    assert.equal(typeof project.sceneCount, "number");
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

  test("PUT /script and GET /lanes do not overwrite timeline.json", async () => {
    const timelinePath = path.join(fixture.projectDir, "timeline.json");
    const linesPath = path.join(fixture.projectDir, "lines.json");
    const sentinelTimeline = { sentinel: true, series: "keep-me" };
    const sentinelLines = { sentinel: "lines" };
    fs.writeFileSync(timelinePath, JSON.stringify(sentinelTimeline));
    fs.writeFileSync(linesPath, JSON.stringify(sentinelLines));

    const bad = await fetch(`${ctx.url}/api/projects/project/script`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: ["[Scene: Intro]", "[Location: room_a]", "Zelda: Hello."].join("\n"),
    });
    assert.equal(bad.status, 200);
    const badBody = await bad.json();
    assert.equal(badBody.saved, true);
    assert.equal(badBody.ok, false);
    assert.ok(badBody.lint.errors.some((e) => e.line === 3 && /Unknown character "Zelda"/.test(e.message)));
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);
    assert.deepEqual(JSON.parse(fs.readFileSync(linesPath, "utf8")), sentinelLines);

    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Camera: zoom=1.3 over=1s]",
      "[Action: Alice eyes=closed]",
      "Alice: Hello there friend.",
      "[Move: Alice to=right over=1s]",
    ].join("\n");
    const good = await fetch(`${ctx.url}/api/projects/project/script`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: script,
    });
    const goodBody = await good.json();
    assert.equal(good.status, 200, JSON.stringify(goodBody));
    assert.equal(goodBody.saved, true);
    assert.equal(goodBody.ok, true);
    assert.equal(fs.readFileSync(path.join(fixture.projectDir, "script.txt"), "utf8"), script);
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);

    const lint = await fetch(`${ctx.url}/api/projects/project/lint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: script }),
    });
    assert.equal(lint.status, 200);
    const lintBody = await lint.json();
    assert.equal(lintBody.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);

    const lanes = await fetch(`${ctx.url}/api/projects/project/lanes`);
    const laneBody = await lanes.json();
    assert.equal(lanes.status, 200, JSON.stringify(laneBody));
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);
    assert.deepEqual(JSON.parse(fs.readFileSync(linesPath, "utf8")), sentinelLines);
    assert.ok(laneBody.totalFrames > 0);
    assert.deepEqual(laneBody.lanes, ["action", "dialogue", "audio", "sfx", "camera"]);
    const byLane = (name) => laneBody.blocks.filter((b) => b.lane === name);
    assert.ok(byLane("camera").some((b) => b.scriptLine === 4 && /zoom/.test(b.label)));
    assert.ok(byLane("dialogue").some((b) => b.scriptLine === 6 && /Hello there friend/.test(b.label)));
    assert.ok(byLane("audio").some((b) => b.scriptLine === 6 && /\.wav$/.test(b.label)));
    assert.ok(byLane("action").some((b) => b.scriptLine === 5 && /eyes=closed/.test(b.label)));
    assert.ok(byLane("action").some((b) => b.scriptLine === 7 && /right/.test(b.label)));
    for (const block of laneBody.blocks) {
      assert.equal(typeof block.startFrame, "number");
      assert.equal(typeof block.endFrame, "number");
      assert.ok(block.endFrame >= block.startFrame);
    }
  });

  test("Assets filter to script cast plus local, Library records a reference without copying art", async () => {
    fixture.writeScript(
      ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice, Bob]", "Alice: Hi."].join("\n")
    );
    const used = await fetch(`${ctx.url}/api/projects/project/characters`);
    assert.equal(used.status, 200);
    const usedIds = (await used.json()).characters.map((c) => c.id).sort();
    assert.deepEqual(usedIds, ["alice", "bob", "carol"]);

    const emptyDir = path.join(fixture.root, "other_show");
    fs.writeFileSync(path.join(emptyDir, "script.txt"), "[Scene: Empty]\n");
    const emptyChars = await fetch(`${ctx.url}/api/projects/other_show/characters`);
    assert.equal(emptyChars.status, 200);
    assert.deepEqual((await emptyChars.json()).characters, []);

    const library = await fetch(`${ctx.url}/api/projects/other_show/library`);
    assert.equal(library.status, 200);
    const libBody = await library.json();
    assert.ok(libBody.characters.some((c) => c.id === "alice"));
    assert.deepEqual(libBody.added, []);

    const add = await fetch(`${ctx.url}/api/projects/other_show/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: "alice" }),
    });
    const added = await add.json();
    assert.equal(add.status, 200, JSON.stringify(added));
    assert.deepEqual(added.library.characters, ["alice"]);
    assert.equal(fs.existsSync(path.join(emptyDir, "characters", "alice")), false);
    const libJson = JSON.parse(fs.readFileSync(path.join(emptyDir, "library.json"), "utf8"));
    assert.deepEqual(libJson.characters, ["alice"]);

    const after = await fetch(`${ctx.url}/api/projects/other_show/characters`);
    assert.deepEqual((await after.json()).characters.map((c) => c.id), ["alice"]);
  });

  test("POST /api/projects creates an empty folder from the template", async () => {
    const res = await fetch(`${ctx.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new_ep" }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.project.name, "new_ep");
    const created = path.join(fixture.root, "new_ep");
    assert.equal(fs.existsSync(path.join(created, "script.txt")), true);
    assert.equal(fs.existsSync(path.join(created, "library.json")), true);
    const dup = await fetch(`${ctx.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new_ep" }),
    });
    assert.equal(dup.status, 409);
  });

  test("?script= selects a file; preview/lanes never overwrite timeline.json", async () => {
    assert.equal(renderOutputName("script_mcd.txt"), "script_mcd.mp4");
    assert.equal(renderOutputName("script.txt"), "script.mp4");
    assert.equal(resolveScriptName("../x.txt"), null);
    assert.equal(resolveScriptName("script_mcd.txt"), "script_mcd.txt");

    const originalScript = fs.readFileSync(path.join(fixture.projectDir, "script.txt"), "utf8");
    const alt = [
      "[Scene: Alt]",
      "[Location: room_b]",
      "[Cast: Alice]",
      "Alice: Different script.",
    ].join("\n");
    const put = await fetch(`${ctx.url}/api/projects/project/script?script=script_mcd.txt`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: alt,
    });
    const putBody = await put.json();
    assert.equal(put.status, 200, JSON.stringify(putBody));
    assert.equal(fs.readFileSync(path.join(fixture.projectDir, "script_mcd.txt"), "utf8"), alt);
    assert.equal(fs.readFileSync(path.join(fixture.projectDir, "script.txt"), "utf8"), originalScript);

    const got = await fetch(`${ctx.url}/api/projects/project/script?script=script_mcd.txt`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), alt);

    const scripts = await fetch(`${ctx.url}/api/projects/project/scripts`);
    assert.deepEqual((await scripts.json()).scripts, ["script.txt", "script_mcd.txt"]);

    const timelinePath = path.join(fixture.projectDir, "timeline.json");
    const sentinelTimeline = { sentinel: true, series: "keep-me" };
    fs.writeFileSync(timelinePath, JSON.stringify(sentinelTimeline));

    const lanes = await fetch(`${ctx.url}/api/projects/project/lanes?script=script_mcd.txt`);
    const laneBody = await lanes.json();
    assert.equal(lanes.status, 200, JSON.stringify(laneBody));
    assert.ok(laneBody.blocks.some((b) => /Different script/.test(b.label)));
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);

    const stage = await fetch(`${ctx.url}/api/projects/project/stage?script=script_mcd.txt`);
    assert.equal(stage.status, 200, await stage.text());
    assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, "utf8")), sentinelTimeline);

    const bad = await fetch(`${ctx.url}/api/projects/project/script?script=../secret.txt`);
    assert.equal(bad.status, 400);
  });

  test("path traversal and reserved names are rejected", async () => {
    assert.equal(isSafeProjectName(".."), false);
    assert.equal(isSafeProjectName("_global_assets"), false);
    assert.equal(isSafeProjectName("_trash"), false);
    assert.equal(resolveProjectDir(fixture.root, ".."), null);
    assert.equal(resolveProjectDir(fixture.root, "../project"), null);
    assert.equal(resolveProjectDir(fixture.root, "_global_assets"), null);
    assert.equal(resolveProjectDir(fixture.root, "_trash"), null);

    const names = [
      "_global_assets",
      "_trash",
      encodeURIComponent("../project"),
      encodeURIComponent("..\\project"),
    ];
    for (const name of names) {
      const res = await fetch(`${ctx.url}/api/projects/${name}/characters`);
      assert.equal(res.status, 400, `expected 400 for name ${JSON.stringify(name)}, got ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /Invalid project name/);
    }
  });

  test("POST /trash moves the folder into _trash and rejects traversal", async () => {
    const created = await fetch(`${ctx.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "doomed_del" }),
    });
    assert.equal(created.status, 201, await created.text());
    const doomed = path.join(fixture.root, "doomed_del");
    fs.mkdirSync(path.join(doomed, "audio"), { recursive: true });
    fs.writeFileSync(path.join(doomed, "audio", "line.wav"), Buffer.alloc(16));
    const globalBefore = fs.readdirSync(fixture.globalAssetsDir);

    const missingConfirm = await fetch(`${ctx.url}/api/projects/doomed_del/trash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingConfirm.status, 400);
    assert.equal(fs.existsSync(doomed), true);

    const wrongConfirm = await fetch(`${ctx.url}/api/projects/doomed_del/trash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: "other" }),
    });
    assert.equal(wrongConfirm.status, 400);
    assert.equal(fs.existsSync(doomed), true);

    const trashed = await fetch(`${ctx.url}/api/projects/doomed_del/trash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: "doomed_del" }),
    });
    const trashBody = await trashed.json();
    assert.equal(trashed.status, 200, JSON.stringify(trashBody));
    assert.equal(fs.existsSync(doomed), false);
    const trashDir = path.join(fixture.root, "_trash");
    assert.equal(fs.existsSync(path.join(trashDir, trashBody.trash.id)), true);
    assert.match(trashBody.trash.id, /^doomed_del-\d+$/);
    assert.deepEqual(fs.readdirSync(fixture.globalAssetsDir), globalBefore);

    const listed = await fetch(`${ctx.url}/api/projects`);
    const names = (await listed.json()).projects.map((p) => p.name);
    assert.equal(names.includes("doomed_del"), false);
    assert.equal(names.includes("_trash"), false);

    const trashList = await fetch(`${ctx.url}/api/trash`);
    const trashItems = (await trashList.json()).trash;
    assert.ok(trashItems.some((item) => item.id === trashBody.trash.id));

    const forbidden = ["_global_assets", "_trash", encodeURIComponent("../project"), encodeURIComponent("..")];
    for (const name of forbidden) {
      const res = await fetch(`${ctx.url}/api/projects/${name}/trash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: decodeURIComponent(name) }),
      });
      assert.equal(res.status, 400, `expected 400 for trash ${name}, got ${res.status}`);
    }
    assert.equal(fs.existsSync(fixture.globalAssetsDir), true);
  });

  test("POST /duplicate copies the folder to name-copy, incrementing", async () => {
    const created = await fetch(`${ctx.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup_src" }),
    });
    assert.equal(created.status, 201, await created.text());
    fs.writeFileSync(path.join(fixture.root, "dup_src", "script.txt"), "[Scene: Copy me]\n");

    const first = await fetch(`${ctx.url}/api/projects/dup_src/duplicate`, { method: "POST" });
    const firstBody = await first.json();
    assert.equal(first.status, 201, JSON.stringify(firstBody));
    assert.equal(firstBody.project.name, "dup_src-copy");
    assert.equal(fs.existsSync(path.join(fixture.root, "dup_src", "script.txt")), true);
    assert.equal(
      fs.readFileSync(path.join(fixture.root, "dup_src-copy", "script.txt"), "utf8"),
      "[Scene: Copy me]\n"
    );

    const second = await fetch(`${ctx.url}/api/projects/dup_src/duplicate`, { method: "POST" });
    const secondBody = await second.json();
    assert.equal(second.status, 201, JSON.stringify(secondBody));
    assert.equal(secondBody.project.name, "dup_src-copy-2");
  });

  test("POST /rename validates the name and renames the folder", async () => {
    const created = await fetch(`${ctx.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ren_src" }),
    });
    assert.equal(created.status, 201, await created.text());

    const bad = await fetch(`${ctx.url}/api/projects/ren_src/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../nope" }),
    });
    assert.equal(bad.status, 400);
    assert.equal(fs.existsSync(path.join(fixture.root, "ren_src")), true);

    const reserved = await fetch(`${ctx.url}/api/projects/ren_src/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "_global_assets" }),
    });
    assert.equal(reserved.status, 400);

    const ok = await fetch(`${ctx.url}/api/projects/ren_src/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ren_dst" }),
    });
    const body = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.equal(body.project.name, "ren_dst");
    assert.equal(fs.existsSync(path.join(fixture.root, "ren_src")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "ren_dst", "script.txt")), true);
  });
});
