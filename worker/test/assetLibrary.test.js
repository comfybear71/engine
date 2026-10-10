"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const assetLibrary = require("../src/parser/assetLibrary");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");

const fixture = createFixtureLibrary();
after(() => fixture.cleanup());

describe("resolveAsset", () => {
  test("resolves a global asset when no project override exists", () => {
    const resolved = assetLibrary.resolveAsset(fixture.projectDir, fixture.globalAssetsDir, "characters/alice/body.png");
    assert.ok(resolved);
    assert.equal(resolved.source, "global");
    assert.equal(resolved.timelinePath, "../_global_assets/characters/alice/body.png");
  });

  test("a project-local file with the same relative path overrides the global one", () => {
    const overridePath = path.join(fixture.projectDir, "characters", "alice", "body.png");
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, "override");

    const resolved = assetLibrary.resolveAsset(fixture.projectDir, fixture.globalAssetsDir, "characters/alice/body.png");
    assert.equal(resolved.source, "project");
    assert.equal(resolved.timelinePath, "characters/alice/body.png");

    fs.rmSync(overridePath);
  });

  test("returns null when the asset exists in neither location", () => {
    const resolved = assetLibrary.resolveAsset(fixture.projectDir, fixture.globalAssetsDir, "characters/nobody/body.png");
    assert.equal(resolved, null);
  });
});

describe("scanDrawingsDir", () => {
  test("lists every drawing in a global slot folder by filename (no extension)", () => {
    const drawings = assetLibrary.scanDrawingsDir(fixture.projectDir, fixture.globalAssetsDir, "characters/alice/mouth");
    assert.deepEqual([...drawings.keys()].sort(), ["A", "B", "C", "D", "E", "F", "G", "H", "X"]);
  });

  test("a project-local drawing with the same name overrides the global one for that name only", () => {
    const overridePath = path.join(fixture.projectDir, "characters", "alice", "mouth", "A.png");
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, "override-A");

    const drawings = assetLibrary.scanDrawingsDir(fixture.projectDir, fixture.globalAssetsDir, "characters/alice/mouth");
    assert.equal(drawings.get("A").timelinePath, "characters/alice/mouth/A.png");
    assert.equal(drawings.get("B").timelinePath, "../_global_assets/characters/alice/mouth/B.png");

    fs.rmSync(overridePath);
  });
});

describe("loadStaging", () => {
  test("location marks are available, merged with library-wide defaults", () => {
    const staging = assetLibrary.loadStaging(fixture.projectDir, fixture.globalAssetsDir, "room_a");
    assert.equal(staging.marks.left.x, 450);
    // "off_left" only exists in staging_defaults.json, not room_a's own staging.json.
    assert.equal(staging.marks.off_left.x, -100);
  });

  test("two locations with different staging profiles resolve the same mark name differently", () => {
    const room_a = assetLibrary.loadStaging(fixture.projectDir, fixture.globalAssetsDir, "room_a");
    const room_b = assetLibrary.loadStaging(fixture.projectDir, fixture.globalAssetsDir, "room_b");
    assert.notEqual(room_a.marks.left.x, room_b.marks.left.x);
    assert.notEqual(room_a.marks.centre.scale, room_b.marks.centre.scale);
  });

  test("auto_order is read from the location's staging.json", () => {
    const staging = assetLibrary.loadStaging(fixture.projectDir, fixture.globalAssetsDir, "room_a");
    assert.deepEqual(staging.autoOrder, ["left", "right"]);
  });

  test("falls back to the engine default auto_order when a location has no staging.json at all", () => {
    const staging = assetLibrary.loadStaging(fixture.projectDir, fixture.globalAssetsDir, "nonexistent_location");
    assert.deepEqual(staging.autoOrder, assetLibrary.DEFAULT_AUTO_ORDER);
    assert.equal(staging.hasLocationProfile, false);
  });
});

describe("episode -> show -> global resolution", () => {
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "engine-show-assets-"));
  const globalAssetsDir = path.join(tmp, "_global_assets");
  const showDir = path.join(tmp, "shows", "sunny_banks");
  const episodeDir = path.join(showDir, "episodes", "pilot");
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(path.join(globalAssetsDir, "characters", "alice", "mouth"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "characters", "alice", "mouth"), { recursive: true });
  fs.mkdirSync(path.join(episodeDir, "characters", "alice", "mouth"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "characters", "rodney"), { recursive: true });
  fs.writeFileSync(path.join(showDir, "show.json"), JSON.stringify({ name: "Sunny Banks" }));
  fs.writeFileSync(path.join(globalAssetsDir, "characters", "alice", "body.png"), "global-body");
  fs.writeFileSync(path.join(showDir, "characters", "alice", "body.png"), "show-body");
  fs.writeFileSync(path.join(episodeDir, "characters", "alice", "body.png"), "episode-body");
  fs.writeFileSync(path.join(globalAssetsDir, "characters", "alice", "mouth", "A.png"), "global-A");
  fs.writeFileSync(path.join(showDir, "characters", "alice", "mouth", "A.png"), "show-A");
  fs.writeFileSync(path.join(showDir, "characters", "alice", "mouth", "B.png"), "show-B");
  fs.writeFileSync(path.join(globalAssetsDir, "characters", "alice", "mouth", "C.png"), "global-C");
  fs.writeFileSync(path.join(showDir, "characters", "rodney", "character.json"), JSON.stringify({ id: "rodney" }));

  test("episode file wins over show and global", () => {
    const resolved = assetLibrary.resolveAsset(episodeDir, globalAssetsDir, "characters/alice/body.png");
    assert.equal(resolved.source, "project");
    assert.equal(fs.readFileSync(resolved.absPath, "utf8"), "episode-body");
    assert.equal(resolved.timelinePath, "characters/alice/body.png");
  });

  test("show file wins over global when the episode has no override", () => {
    fs.rmSync(path.join(episodeDir, "characters", "alice", "body.png"));
    const resolved = assetLibrary.resolveAsset(episodeDir, globalAssetsDir, "characters/alice/body.png");
    assert.equal(resolved.source, "show");
    assert.equal(fs.readFileSync(resolved.absPath, "utf8"), "show-body");
    assert.match(resolved.timelinePath, /characters\/alice\/body\.png$/);
    assert.match(resolved.timelinePath, /\.\.\//);
    fs.writeFileSync(path.join(episodeDir, "characters", "alice", "body.png"), "episode-body");
  });

  test("global is still used when neither episode nor show has the file", () => {
    const resolved = assetLibrary.resolveAsset(episodeDir, globalAssetsDir, "characters/alice/mouth/C.png");
    assert.equal(resolved.source, "global");
  });

  test("scanDrawingsDir merges global then show then episode", () => {
    fs.writeFileSync(path.join(episodeDir, "characters", "alice", "mouth", "A.png"), "episode-A");
    const drawings = assetLibrary.scanDrawingsDir(episodeDir, globalAssetsDir, "characters/alice/mouth");
    assert.equal(fs.readFileSync(drawings.get("A").absPath, "utf8"), "episode-A");
    assert.equal(fs.readFileSync(drawings.get("B").absPath, "utf8"), "show-B");
    assert.equal(fs.readFileSync(drawings.get("C").absPath, "utf8"), "global-C");
  });

  test("show-only characters are known to the episode", () => {
    const ids = assetLibrary.listKnownCharacterIds(episodeDir, globalAssetsDir);
    assert.ok(ids.includes("rodney"));
    assert.ok(ids.includes("alice"));
  });

  test("flat projects still ignore a sibling shows folder", () => {
    const flat = path.join(tmp, "experiment");
    fs.mkdirSync(flat, { recursive: true });
    const resolved = assetLibrary.resolveAsset(flat, globalAssetsDir, "characters/alice/body.png");
    assert.equal(resolved.source, "global");
    assert.equal(assetLibrary.resolveShowAssetsDir(flat), null);
  });
});

describe("loadCharacter / listKnownCharacterIds", () => {
  test("loads a character.json by id", () => {
    const alice = assetLibrary.loadCharacter(fixture.projectDir, fixture.globalAssetsDir, "alice");
    assert.equal(alice.display_name, "Alice");
  });

  test("returns null for an unknown character id", () => {
    assert.equal(assetLibrary.loadCharacter(fixture.projectDir, fixture.globalAssetsDir, "nobody"), null);
  });

  test("lists every known character id across project + global", () => {
    const ids = assetLibrary.listKnownCharacterIds(fixture.projectDir, fixture.globalAssetsDir);
    assert.deepEqual(ids, ["alice", "bob"]);
  });
});
