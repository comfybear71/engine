"use strict";

const { test, describe, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createApp, isSafeProjectName, resolveProjectDir } = require("../src/server");
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

  test("PUT /api/projects/:name/script saves and returns lint with line numbers", async () => {
    const bad = await fetch(`${ctx.url}/api/projects/project/script`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: ["[Scene: Intro]", "[Location: room_a]", "Zelda: Hello."].join("\n"),
    });
    assert.equal(bad.status, 200);
    const badBody = await bad.json();
    assert.equal(badBody.saved, true);
    assert.equal(badBody.ok, false);
    assert.equal(badBody.timeline, null);
    assert.ok(badBody.lint.errors.some((e) => e.line === 3 && /Unknown character "Zelda"/.test(e.message)));
    assert.equal(fs.readFileSync(path.join(fixture.projectDir, "script.txt"), "utf8"), ["[Scene: Intro]", "[Location: room_a]", "Zelda: Hello."].join("\n"));

    const good = await fetch(`${ctx.url}/api/projects/project/script`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: ["[Scene: Intro]", "[Location: room_a]", "Alice: Surprise walk-on."].join("\n"),
    });
    assert.equal(good.status, 200);
    const goodBody = await good.json();
    assert.equal(goodBody.saved, true);
    assert.equal(goodBody.ok, true);
    assert.equal(goodBody.timeline.sceneCount, 1);
    assert.equal(goodBody.lines.total, 1);
    assert.ok(goodBody.lint.warnings.some((w) => w.line === 3 && /not in \[Cast/.test(w.message)));
  });

  test("path traversal and reserved names are rejected", async () => {
    assert.equal(isSafeProjectName(".."), false);
    assert.equal(isSafeProjectName("_global_assets"), false);
    assert.equal(resolveProjectDir(fixture.root, ".."), null);
    assert.equal(resolveProjectDir(fixture.root, "../project"), null);
    assert.equal(resolveProjectDir(fixture.root, "_global_assets"), null);

    // Bare ".." is a URL path segment and gets normalized by fetch; encoded
    // names stay in :name so the server sees the traversal attempt.
    const names = ["_global_assets", encodeURIComponent("../project"), encodeURIComponent("..\\project")];
    for (const name of names) {
      const res = await fetch(`${ctx.url}/api/projects/${name}/script`);
      assert.equal(res.status, 400, `expected 400 for name ${JSON.stringify(name)}, got ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /Invalid project name/);
    }
  });
});
