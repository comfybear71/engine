"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeShot, internals } = require("../src/shots");

describe("continue a shot from its last frame", () => {
  let projectDir;
  let bodies;
  const savedKey = process.env.XAI_API_KEY;

  function writeShot(id, info, files = {}) {
    const dir = path.join(projectDir, "characters", "rodney", "shots", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "shot.json"), JSON.stringify({ id, name: id, status: "ready", fps: 24, frameCount: 144, in: 1, out: 144, ...info }));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  }

  function fakeFetch() {
    return async (url, init = {}) => {
      if (String(url).endsWith("/videos/generations")) {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ request_id: "req1" }) };
      }
      if (/\/v1\/videos\/req1$/.test(String(url))) {
        return { ok: true, json: async () => ({ status: "done", video: { url: "https://cdn.test/req1.mp4" } }) };
      }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("mp4").buffer };
    };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-shot-"));
    bodies = [];
    process.env.XAI_API_KEY = "test-key";
    fs.mkdirSync(path.join(projectDir, "characters", "rodney"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedKey;
  });

  test("reads the frame at the trimmed out point from the source video", async () => {
    writeShot("wave", { out: 49 }, { "source.mp4": "video" });
    const calls = [];
    const b64 = await internals.lastFrameBase64(projectDir, "rodney", "wave", {
      extractFrame: async (_video, out, seconds) => {
        calls.push(seconds);
        fs.writeFileSync(out, Buffer.from("TRIMMED-END"));
        return true;
      },
    });
    assert.equal(Buffer.from(b64, "base64").toString(), "TRIMMED-END");
    assert.deepEqual(calls, [2]);
  });

  test("uses the true last frame when the shot is not trimmed", async () => {
    writeShot("wave", {}, { "source.mp4": "video" });
    const calls = [];
    await internals.lastFrameBase64(projectDir, "rodney", "wave", {
      extractFrame: async (_video, out, seconds) => {
        calls.push(seconds);
        fs.writeFileSync(out, Buffer.from("X"));
        return true;
      },
    });
    assert.deepEqual(calls, [0]);
  });

  test("falls back to saved frames for shots without a source video", async () => {
    writeShot("baked", { frameCount: 3, out: 2 }, { "cut/f_0001.png": "one", "cut/f_0002.png": "two", "cut/f_0003.png": "three" });
    const b64 = await internals.lastFrameBase64(projectDir, "rodney", "baked");
    assert.equal(Buffer.from(b64, "base64").toString(), "two");
  });

  test("refuses a shot that is still being made or missing", async () => {
    writeShot("busy", { status: "making" });
    await assert.rejects(() => internals.lastFrameBase64(projectDir, "rodney", "busy"), /still being made/);
    await assert.rejects(() => internals.lastFrameBase64(projectDir, "rodney", "nope"), /not found/);
  });

  test("makeShot sends that frame to Grok and records where it continues from", async () => {
    writeShot("wave", {}, { "source.mp4": "video" });
    const result = await makeShot(
      projectDir,
      "rodney",
      { prompt: "keep walking", shotType: "body", continueShotId: "wave", refBase64: Buffer.from("IGNORED").toString("base64") },
      {
        fetchFn: fakeFetch(),
        pollIntervalMs: 1,
        captureFn: async () => ({ fps: 24, frameCount: 24 }),
        extractFrame: async (_video, out) => {
          fs.writeFileSync(out, Buffer.from("LAST-FRAME"));
          return true;
        },
      }
    );
    const sent = bodies[0].image.url.replace(/^data:image\/png;base64,/, "");
    assert.equal(Buffer.from(sent, "base64").toString(), "LAST-FRAME");
    const info = JSON.parse(fs.readFileSync(path.join(projectDir, "characters", "rodney", "shots", result.shotId, "shot.json"), "utf8"));
    assert.equal(info.continuesShot, "wave");
  });

  test("a missing source shot fails before anything is created or billed", async () => {
    await assert.rejects(
      () => makeShot(projectDir, "rodney", { prompt: "go on", continueShotId: "ghost" }, { fetchFn: fakeFetch() }),
      /not found/
    );
    assert.equal(bodies.length, 0);
    const shotsRoot = path.join(projectDir, "characters", "rodney", "shots");
    assert.equal(fs.existsSync(shotsRoot) ? fs.readdirSync(shotsRoot).length : 0, 0);
  });
});
