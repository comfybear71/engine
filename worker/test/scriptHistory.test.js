"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  snapshotScriptWrite,
  listScriptHistory,
  restoreScriptSnapshot,
  snapshotIdFromDate,
} = require("../src/scriptHistory");

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "engine-history-"));
}

describe("script history", () => {
  test("snapshots the previous file, skips identical content, and restore snapshots first", () => {
    const dir = tmpProject();
    try {
      const script = "script.txt";
      fs.writeFileSync(path.join(dir, script), "Alice: one\n");
      const first = snapshotScriptWrite(dir, script, "Alice: two\n");
      fs.writeFileSync(path.join(dir, script), "Alice: two\n");
      assert.equal(first.skipped, false);
      assert.ok(first.id);

      const skip = snapshotScriptWrite(dir, script, "Alice: two\n");
      assert.equal(skip, null);

      fs.writeFileSync(path.join(dir, script), "Alice: two\n");
      const second = snapshotScriptWrite(dir, script, "Alice: three\n");
      fs.writeFileSync(path.join(dir, script), "Alice: three\n");
      assert.equal(second.skipped, false);

      const listed = listScriptHistory(dir, script);
      assert.ok(listed.length >= 2);
      assert.ok(listed[0].id);
      assert.match(listed[0].createdAt, /T/);

      const restored = restoreScriptSnapshot(dir, script, listed[listed.length - 1].id);
      assert.equal(restored.ok, true);
      assert.equal(restored.text, "Alice: one\n");
      assert.equal(fs.readFileSync(path.join(dir, script), "utf8"), "Alice: one\n");
      const after = listScriptHistory(dir, script);
      assert.ok(after.length >= listed.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshot ids are filesystem-safe ISO stamps", () => {
    const id = snapshotIdFromDate(new Date("2026-10-10T17:15:22.000Z"));
    assert.equal(id, "2026-10-10T17-15-22.000Z");
    assert.equal(id.includes(":"), false);
  });
});
