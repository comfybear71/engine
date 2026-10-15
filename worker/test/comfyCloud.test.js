"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { generateLtxVideo } = require("../src/comfyCloud");

const done = { status: "completed", outputs: { 341: { images: [{ filename: "c.mp4", subfolder: "video", type: "output" }] } } };

function netError(code) {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("read ECONNRESET"), { code });
  return err;
}

describe("comfyCloud generateLtxVideo", () => {
  let dest;
  const saved = process.env.COMFY_CLOUD_API_KEY;

  beforeEach(() => {
    dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comfy-")), "out.mp4");
    process.env.COMFY_CLOUD_API_KEY = "k";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.COMFY_CLOUD_API_KEY;
    else process.env.COMFY_CLOUD_API_KEY = saved;
  });

  function fetchWith(jobResponses, calls = []) {
    let polls = 0;
    return async (url, init = {}) => {
      const u = String(url);
      calls.push(u);
      assert.ok(init.signal, "every request has a timeout signal");
      if (u.endsWith("/api/upload/image")) return { ok: true, json: async () => ({ name: "up" }) };
      if (u.endsWith("/api/prompt")) return { ok: true, json: async () => ({ prompt_id: "job1" }) };
      if (u.includes("/api/jobs/")) {
        const next = jobResponses[Math.min(polls++, jobResponses.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      }
      if (u.includes("/api/view")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("mp4").buffer };
      throw new Error(`unexpected ${u}`);
    };
  }

  const run = (fetchFn, extra = {}) =>
    generateLtxVideo({
      imageBytes: Buffer.from("i"),
      audioBytes: Buffer.from("a"),
      prompt: "p",
      durationSec: 2,
      destPath: dest,
      options: { fetchFn, pollIntervalMs: 1 },
      ...extra,
    });

  test("a few dropped poll requests do not lose the job", async () => {
    const ok = { ok: true, status: 200, json: async () => done };
    const running = { ok: true, status: 200, json: async () => ({ status: "in_progress" }) };
    const fetchFn = fetchWith([netError("ECONNRESET"), { ok: false, status: 503 }, running, ok]);
    const result = await run(fetchFn);
    assert.equal(result.promptId, "job1");
    assert.equal(fs.readFileSync(dest, "utf8"), "mp4");
  });

  test("gives up after repeated network failures and names the real cause", async () => {
    await assert.rejects(run(fetchWith([netError("ETIMEDOUT")])), (err) => {
      assert.equal(err.code, "ENETWORK");
      assert.match(err.message, /ETIMEDOUT/);
      assert.match(err.message, /job1/);
      assert.match(err.message, /Retry will pick it up/);
      return true;
    });
  });

  test("resuming polls the existing job without uploading or submitting again", async () => {
    const calls = [];
    const ok = { ok: true, status: 200, json: async () => done };
    await run(fetchWith([ok], calls), { resumePromptId: "job1" });
    assert.equal(calls.some((u) => u.endsWith("/api/upload/image") || u.endsWith("/api/prompt")), false);
    assert.ok(calls.some((u) => u.includes("/api/jobs/job1")));
  });

  test("a job Comfy reports as failed is a hard failure with its reason", async () => {
    const failed = { ok: true, status: 200, json: async () => ({ status: "failed", execution_error: { exception_message: "OOM" } }) };
    await assert.rejects(run(fetchWith([failed])), (err) => err.code === "EJOBFAILED" && /OOM/.test(err.message));
  });
});
