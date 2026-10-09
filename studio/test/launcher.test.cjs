"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULTS, readEnvFile, resolveEnginePaths } = require("../../launcher.js");

describe("launcher", () => {
  test("defaults to worker 4100 and Studio on 3001", () => {
    assert.equal(DEFAULTS.workerPort, 4100);
    assert.equal(DEFAULTS.studioPort, 3001);
    assert.equal(DEFAULTS.studioOrigin, "http://localhost:3001");
  });

  test("resolveEnginePaths finds worker and next from the repo root", () => {
    const root = path.resolve(__dirname, "..", "..");
    const paths = resolveEnginePaths(root);
    assert.equal(paths.workerDir, path.join(root, "worker"));
    assert.ok(fs.existsSync(paths.workerEntry));
  });

  test("readEnvFile skips comments and quotes", () => {
    const file = path.join(os.tmpdir(), `engine-env-${process.pid}.env`);
    fs.writeFileSync(file, "# hi\nWORKER_PORT=4100\nSTUDIO_ORIGIN=\"http://localhost:3001\"\n");
    const env = readEnvFile(file);
    fs.unlinkSync(file);
    assert.equal(env.WORKER_PORT, "4100");
    assert.equal(env.STUDIO_ORIGIN, "http://localhost:3001");
    assert.equal(env["# hi"], undefined);
  });
});
