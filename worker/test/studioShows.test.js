"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createEmptyProject } = require("../src/studioProjects");
const {
  createShow,
  moveProjectIntoShow,
  moveEpisodeToExperiments,
  resolveEpisodeDir,
  readShowJson,
} = require("../src/studioShows");
const { buildFinalCutConcatArgs, estimateFinalDurationSeconds } = require("../src/finalCut");

describe("move project into a show and back", { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-show-move-"));
  const projectsDir = path.join(root, "projects");
  const showsDir = path.join(root, "shows");
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(projectsDir, { recursive: true });
  const projectDir = createEmptyProject(projectsDir, "pilot_sketch");
  fs.writeFileSync(path.join(projectDir, "script.txt"), "[Scene: Keep me]\n");
  fs.writeFileSync(path.join(projectDir, "notes.txt"), "do not delete");

  test("move is a rename into shows/<id>/episodes/<name>", () => {
    const created = createShow(showsDir, "Sunny Banks");
    assert.equal(created.id, "sunny_banks");
    assert.equal(readShowJson(created.showDir).name, "Sunny Banks");

    const moved = moveProjectIntoShow(projectsDir, showsDir, "pilot_sketch", "sunny_banks");
    assert.equal(moved.episodeId, "pilot_sketch");
    assert.equal(fs.existsSync(projectDir), false);
    assert.equal(fs.existsSync(moved.projectDir), true);
    assert.equal(fs.readFileSync(path.join(moved.projectDir, "notes.txt"), "utf8"), "do not delete");
    assert.equal(resolveEpisodeDir(showsDir, "sunny_banks", "pilot_sketch"), moved.projectDir);
    assert.equal(fs.existsSync(path.join(projectsDir, "pilot_sketch")), false);
  });

  test("move back to experiments restores the same folder", () => {
    const moved = moveEpisodeToExperiments(projectsDir, showsDir, "sunny_banks", "pilot_sketch");
    assert.equal(moved.name, "pilot_sketch");
    assert.equal(fs.existsSync(path.join(showsDir, "sunny_banks", "episodes", "pilot_sketch")), false);
    assert.equal(fs.existsSync(path.join(projectsDir, "pilot_sketch", "notes.txt")), true);
    assert.equal(fs.readFileSync(path.join(projectsDir, "pilot_sketch", "script.txt"), "utf8"), "[Scene: Keep me]\n");
  });

  test("refuses to overwrite an existing experiment", () => {
    moveProjectIntoShow(projectsDir, showsDir, "pilot_sketch", "sunny_banks");
    createEmptyProject(projectsDir, "pilot_sketch");
    assert.throws(
      () => moveEpisodeToExperiments(projectsDir, showsDir, "sunny_banks", "pilot_sketch"),
      (err) => err.code === "EEXIST"
    );
  });
});

describe("buildFinalCutConcatArgs", () => {
  const a = "/tmp/ep1.mp4";
  const b = "/tmp/ep2.mp4";
  const out = "/tmp/shows/sunny/final/season.mp4";

  test("trims inputs and concats in order", () => {
    const args = buildFinalCutConcatArgs(
      [
        { inputPath: a, trimInSec: 1.5, trimOutSec: 8, durationSec: 10 },
        { inputPath: b, trimInSec: 0, trimOutSec: null, durationSec: 4 },
      ],
      out
    );
    assert.equal(args[0], "-y");
    const iA = args.indexOf(a);
    const iB = args.indexOf(b);
    assert.ok(iA > 0 && iB > iA);
    assert.equal(args[args.indexOf("-ss") + 1], "1.5");
    assert.equal(args[args.indexOf("-to") + 1], "8");
    assert.ok(args.indexOf("-ss") < iA);
    assert.equal(args[args.length - 1], out);
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /concat=n=2:v=1:a=1/);
    assert.ok(args.includes("-map"));
  });

  test("single untrimmed item remuxes without concat", () => {
    const args = buildFinalCutConcatArgs([{ inputPath: a, durationSec: 5 }], out);
    assert.ok(!args.includes("-filter_complex"));
    assert.equal(args[args.length - 1], out);
    assert.ok(args.includes("libx264"));
  });

  test("gap adds tpad/apad before concat", () => {
    const args = buildFinalCutConcatArgs(
      [
        { inputPath: a, durationSec: 3 },
        { inputPath: b, durationSec: 3 },
      ],
      out,
      { gapSeconds: 0.5 }
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /tpad=stop_mode=add:stop_duration=0.5/);
    assert.match(filter, /apad=pad_dur=0.5/);
    assert.match(filter, /concat=n=2/);
  });

  test("fade uses xfade / acrossfade", () => {
    const args = buildFinalCutConcatArgs(
      [
        { inputPath: a, durationSec: 5 },
        { inputPath: b, durationSec: 5 },
      ],
      out,
      { fadeSeconds: 0.25 }
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /xfade=transition=fade:duration=0.25/);
    assert.match(filter, /acrossfade=d=0.25/);
  });

  test("rejects an empty list", () => {
    assert.throws(() => buildFinalCutConcatArgs([], out), (err) => err.code === "EINVAL");
  });

  test("estimateFinalDurationSeconds accounts for gap and fade", () => {
    const items = [
      { durationSec: 10, trimInSec: 0, trimOutSec: 10 },
      { durationSec: 6, trimInSec: 0, trimOutSec: 6 },
    ];
    assert.equal(estimateFinalDurationSeconds(items), 16);
    assert.equal(estimateFinalDurationSeconds(items, { gapSeconds: 1 }), 17);
    assert.equal(estimateFinalDurationSeconds(items, { fadeSeconds: 1 }), 15);
  });
});
