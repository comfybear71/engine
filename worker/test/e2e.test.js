"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKER_DIR = path.join(REPO_ROOT, "worker");
const SAMPLE_PROJECT_DIR = path.join(REPO_ROOT, "projects", "sample");

function ffprobeStreamTypes(filePath) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", filePath],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout).streams;
}

describe("end-to-end: parse + render the sample project via the real CLI", () => {
  test("`node src/cli.js parse` produces a schema-valid timeline.json for the committed sample", () => {
    const result = spawnSync("node", ["src/cli.js", "parse", SAMPLE_PROJECT_DIR], {
      cwd: WORKER_DIR,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Schema\/load validation: OK/);
  });

  test("`node src/cli.js render` renders the sample to a video with both video and audio streams", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-e2e-render-"));
    const outputPath = path.join(tmpDir, "output.mp4");

    const result = spawnSync(
      "node",
      ["src/cli.js", "render", SAMPLE_PROJECT_DIR, "--codec", "h264", "--output", outputPath],
      { cwd: WORKER_DIR, encoding: "utf8", timeout: 120000 }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.existsSync(outputPath));

    const streams = ffprobeStreamTypes(outputPath);
    const codecTypes = streams.map((s) => s.codec_type);
    assert.ok(codecTypes.includes("video"), "output is missing a video stream");
    assert.ok(codecTypes.includes("audio"), "output is missing an audio stream");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("`node src/cli.js lint` reports no errors for the committed sample script", () => {
    const result = spawnSync("node", ["src/cli.js", "lint", SAMPLE_PROJECT_DIR], {
      cwd: WORKER_DIR,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Lint OK/);
    // lint must not leave its throwaway output file behind.
    assert.equal(fs.existsSync(path.join(SAMPLE_PROJECT_DIR, ".lint-timeline.json")), false);
  });
});
