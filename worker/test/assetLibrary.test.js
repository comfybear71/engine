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
