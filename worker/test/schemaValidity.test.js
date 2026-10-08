"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateTimelineFile } = require("../src/parser/validateTimelineFile");

describe("validateTimelineFile (Python schema + load validator)", () => {
  test("the committed sample project's generated timeline.json is valid", async () => {
    const timelinePath = path.join(__dirname, "..", "..", "projects", "sample", "timeline.json");
    const result = await validateTimelineFile(timelinePath);
    assert.equal(result.ok, true, result.message);
  });

  test("a structurally invalid timeline.json is rejected with a useful message", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-schema-test-"));
    const badTimelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      badTimelinePath,
      JSON.stringify({
        series: "Test",
        // missing "episode" and "fps" -- required by the schema
        scenes: [],
      })
    );

    const result = await validateTimelineFile(badTimelinePath);
    assert.equal(result.ok, false);
    assert.match(result.message, /fps|episode|required/i);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
