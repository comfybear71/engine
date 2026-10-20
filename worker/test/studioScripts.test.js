"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listScriptRecords, newestScriptName, normalizeNewScriptName, nextNewScriptName, createScriptFile, trashScriptFile } = require("../src/studioProjects");

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

  test("createScriptFile writes script_new.txt and rejects a duplicate or unsafe name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-scripts-"));
    fs.writeFileSync(path.join(dir, "script.txt"), "old\n");
    assert.equal(normalizeNewScriptName("walk"), "script_walk.txt");
    assert.equal(nextNewScriptName(["script.txt"]), "script_new.txt");
    const created = createScriptFile(dir, "");
    assert.equal(created, "script_new.txt");
    assert.ok(fs.existsSync(path.join(dir, "script_new.txt")));
    assert.throws(() => createScriptFile(dir, "script_new.txt"), (err) => err && err.code === "SCRIPT_EXISTS");
    assert.throws(() => createScriptFile(dir, "../secret.txt"), (err) => err && err.code === "INVALID_SCRIPT");
    const named = createScriptFile(dir, "walk");
    assert.equal(named, "script_walk.txt");
  });
});

describe("trashScriptFile", () => {
  function projectWith(...names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-scripts-"));
    for (const name of names) fs.writeFileSync(path.join(dir, name), `${name}\n`);
    return dir;
  }

  test("moves the script into _trash/scripts instead of deleting it", () => {
    const dir = projectWith("script.txt", "script_old.txt");
    const moved = trashScriptFile(dir, "script_old.txt");
    assert.equal(moved.name, "script_old.txt");
    assert.ok(!fs.existsSync(path.join(dir, "script_old.txt")));
    assert.deepEqual(
      listScriptRecords(dir).map((item) => item.name),
      ["script.txt"]
    );
    const kept = path.join(dir, moved.trashedTo);
    assert.ok(moved.trashedTo.startsWith("_trash/scripts/"));
    assert.equal(fs.readFileSync(kept, "utf8"), "script_old.txt\n");
  });

  test("two deletes of the same name never overwrite each other", () => {
    const dir = projectWith("script.txt", "script_a.txt");
    const first = trashScriptFile(dir, "script_a.txt");
    fs.writeFileSync(path.join(dir, "script_a.txt"), "second\n");
    const second = trashScriptFile(dir, "script_a.txt");
    assert.notEqual(first.trashedTo, second.trashedTo);
    assert.equal(fs.readdirSync(path.join(dir, "_trash", "scripts")).length, 2);
  });

  test("refuses the last script, a missing script and unsafe names", () => {
    const dir = projectWith("script.txt");
    assert.throws(() => trashScriptFile(dir, "script.txt"), (err) => err && err.code === "LAST_SCRIPT");
    assert.ok(fs.existsSync(path.join(dir, "script.txt")));
    fs.writeFileSync(path.join(dir, "script_b.txt"), "b\n");
    assert.throws(() => trashScriptFile(dir, "script_nope.txt"), (err) => err && err.code === "SCRIPT_MISSING");
    assert.throws(() => trashScriptFile(dir, "../secret.txt"), (err) => err && err.code === "INVALID_SCRIPT");
    assert.throws(() => trashScriptFile(dir, "notes.txt"), (err) => err && err.code === "INVALID_SCRIPT");
  });
});

