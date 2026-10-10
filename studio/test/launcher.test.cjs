"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULTS,
  readEnvFile,
  resolveEnginePaths,
  isStudioDev,
  studioLaunchArgs,
  studioNeedsRebuild,
  ensureStudioBuild,
  launcherErrLogPath,
  sourceUnchangedSinceBuildFailure,
} = require("../../launcher.js");

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

  test("defaults to next start and opts into next dev via STUDIO_DEV", () => {
    assert.equal(isStudioDev({}), false);
    assert.equal(isStudioDev({ STUDIO_DEV: "1" }), true);
    assert.equal(isStudioDev({ ENGINE_STUDIO_DEV: "true" }), true);
    assert.deepEqual(studioLaunchArgs("/next", "3001", { dev: false }), ["/next", "start", "-p", "3001"]);
    assert.deepEqual(studioLaunchArgs("/next", "3001", { dev: true }), ["/next", "dev", "-p", "3001"]);
  });

  test("studioNeedsRebuild is true when there is no Next build", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-studio-build-"));
    const paths = { root: tmp, studioDir: path.join(tmp, "studio") };
    fs.mkdirSync(paths.studioDir, { recursive: true });
    assert.equal(studioNeedsRebuild(paths), true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("failed production build writes launcher.err.log and falls back until source changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-studio-build-"));
    const studioDir = path.join(tmp, "studio");
    fs.mkdirSync(path.join(studioDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(studioDir, "app", "page.tsx"), "export default function Page() { return null; }\n");
    const failBin = path.join(tmp, "next-fail.js");
    fs.writeFileSync(failBin, "process.stderr.write('next build exploded\\n'); process.exit(1);\n");
    const paths = { root: tmp, studioDir, nextBin: failBin };

    assert.throws(() => ensureStudioBuild(paths, {}), (err) => err && err.code === "STUDIO_BUILD");
    const log = fs.readFileSync(launcherErrLogPath(tmp), "utf8");
    assert.match(log, /Studio production build failed/);
    assert.match(log, /next build exploded/);
    assert.equal(sourceUnchangedSinceBuildFailure(paths), true);

    const skipped = ensureStudioBuild(paths, {});
    assert.deepEqual(skipped, { built: false, skipped: true, useDev: true });

    const later = Date.now() + 5_000;
    fs.utimesSync(path.join(studioDir, "app", "page.tsx"), later / 1000, later / 1000);
    assert.equal(sourceUnchangedSinceBuildFailure(paths), false);
    assert.throws(() => ensureStudioBuild(paths, {}), (err) => err && err.code === "STUDIO_BUILD");

    fs.rmSync(tmp, { recursive: true, force: true });
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
