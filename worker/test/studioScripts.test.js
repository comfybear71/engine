"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listScriptRecords, newestScriptName } = require("../src/studioProjects");

describe("script recency", () => {
  test("newest script is the most recently edited or created file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-scripts-"));
    fs.writeFileSync(path.join(dir, "script.txt"), "old\n");
    const older = new Date("2020-01-01").getTime();
    fs.utimesSync(path.join(dir, "script.txt"), older / 1000, older / 1000);
    fs.writeFileSync(path.join(dir, "script_showcase_v2.txt"), "new\n");
    const files = listScriptRecords(dir);
    assert.deepEqual(
      files.map((item) => item.name),
      ["script.txt", "script_showcase_v2.txt"]
    );
    assert.equal(newestScriptName(files), "script_showcase_v2.txt");
  });
});
