"use strict";

const { test, describe, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApp } = require("../src/server");
const {
  creditNote,
  estimateCost,
  explainXaiStatus,
  generateProjectImage,
  GenerateImageError,
} = require("../src/generateImage");
const { saveXaiApiKey, describeEngineSettings } = require("../src/engineSettings");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { closePreviewSession } = require("../src/previewSession");
const { resetParseCache } = require("../src/parser/parseCache");
const { resetDurationCache } = require("../src/parser/ffprobeDuration");
const { resetSummaryCache } = require("../src/studioProjects");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

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

describe("generate-image helpers", () => {
  test("dry-run cost note uses published grok-imagine-image-2.0 prices", () => {
    const estimated = estimateCost({
      model: "grok-imagine-image-2.0",
      n: 2,
      referenceCount: 0,
      useEdits: false,
    });
    assert.equal(estimated, 0.08);
    const note = creditNote({
      model: "grok-imagine-image-2.0",
      n: 2,
      referenceCount: 0,
      useEdits: false,
      estimatedCost: estimated,
    });
    assert.match(note, /uses xAI credits/i);
    assert.match(note, /0\.08|\$0\.080/);
  });

  test("unknown model falls back to a generic credits note", () => {
    const note = creditNote({
      model: "some-future-model",
      n: 1,
      referenceCount: 0,
      useEdits: false,
      estimatedCost: null,
    });
    assert.match(note, /uses xAI credits/i);
    assert.doesNotMatch(note, /\$0\./);
  });

  test("plain-language errors for missing key, rate limit, and refusals", () => {
    assert.match(explainXaiStatus(401, ""), /rejected the API key/i);
    assert.match(explainXaiStatus(429, "rate limit exceeded"), /rate limit/i);
    assert.match(explainXaiStatus(400, "content policy violation"), /refused this prompt/i);
  });

  test("settings write stores the key and never returns it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-env-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "WORKER_PORT=4100\n");
    const prev = process.env.XAI_API_KEY;
    try {
      const result = saveXaiApiKey("sk-test-secret-value", { envPath });
      assert.equal(result.xaiKeyConfigured, true);
      assert.equal(describeEngineSettings({ XAI_API_KEY: "sk-test-secret-value" }).xaiKeyConfigured, true);
      const text = fs.readFileSync(envPath, "utf8");
      assert.match(text, /^XAI_API_KEY=sk-test-secret-value$/m);
      assert.doesNotMatch(JSON.stringify(result), /sk-test-secret-value/);
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/generate-image", () => {
  const fixture = createFixtureLibrary();
  const prevKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key-not-real";

  let lastRequest = null;
  const fetchFn = async (url, init) => {
    lastRequest = { url: String(url), init };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: [{ b64_json: TINY_PNG.toString("base64"), mime_type: "image/png" }],
          usage: { cost_in_usd_ticks: 400000000 },
        });
      },
    };
  };

  const app = createApp({ projectsDir: fixture.root, skipValidate: true, fetchFn });
  /** @type {{ url: string, close: () => Promise<void> }} */
  let ctx;

  before(async () => {
    ctx = await listen(app);
  });

  after(async () => {
    if (ctx) await ctx.close();
    closePreviewSession();
    resetParseCache();
    resetDurationCache();
    resetSummaryCache();
    fixture.cleanup();
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;
  });

  test("dry-run returns a credit note and does not call xAI", async () => {
    lastRequest = null;
    const res = await fetch(`${ctx.url}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "project",
        characterId: "alice",
        needId: "mouth_sheet",
        n: 2,
        dryRun: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, true);
    assert.match(body.creditNote, /uses xAI credits/i);
    assert.equal(lastRequest, null);
    assert.equal(body.images, undefined);
  });

  test("generate saves the sheet into _library and uses edits when a body exists", async () => {
    lastRequest = null;
    const res = await fetch(`${ctx.url}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "project",
        characterId: "alice",
        needId: "mouth_sheet",
        n: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.images.length, 1);
    assert.match(body.images[0].libraryRel, /characters\/alice\/_library\//);
    assert.ok(fs.existsSync(path.join(fixture.projectDir, body.images[0].libraryRel)));
    assert.match(String(lastRequest.url), /images\/edits/);
    const sent = JSON.parse(lastRequest.init.body);
    assert.ok(sent.images || sent.image);
    assert.doesNotMatch(JSON.stringify(body), /test-key-not-real/);
    assert.doesNotMatch(String(lastRequest.init.body), /test-key-not-real/);
  });

  test("missing key is a plain-language 400", async () => {
    const projectDir = fixture.projectDir;
    const globalAssetsDir = path.join(fixture.root, "_global_assets");
    await assert.rejects(
      () =>
        generateProjectImage(
          projectDir,
          globalAssetsDir,
          { characterId: "alice", needId: "mouth_sheet", n: 1 },
          { env: { XAI_IMAGE_MODEL: "grok-imagine-image-2.0" }, fetchFn }
        ),
      (err) => err instanceof GenerateImageError && /API key is missing/i.test(err.message)
    );
  });
});
