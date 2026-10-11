"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseScript } = require("../src/parser/scriptParser");
const { findOverlapWarnings, findMouthSheetErrors, characterHasRigHead } = require("../src/parser/lint");
const { createFixtureLibrary, TRANSPARENT_PNG_1X1 } = require("./helpers/fixtureLibrary");

const fixture = createFixtureLibrary();
after(() => fixture.cleanup());

function writeCharacter(globalAssetsDir, id, displayName, { mouthShapes = null, slots } = {}) {
  const charDir = path.join(globalAssetsDir, "characters", id);
  fs.mkdirSync(charDir, { recursive: true });
  fs.writeFileSync(path.join(charDir, "body.png"), TRANSPARENT_PNG_1X1);
  if (mouthShapes) {
    for (const shape of mouthShapes) {
      fs.mkdirSync(path.join(charDir, "mouth"), { recursive: true });
      fs.writeFileSync(path.join(charDir, "mouth", `${shape}.png`), TRANSPARENT_PNG_1X1);
    }
  }
  const config = {
    id,
    display_name: displayName,
    aliases: [displayName],
    asset: "body.png",
    z: 10,
    default_scale: 1.0,
    voice_id: null,
    slots: slots !== undefined ? slots : { mouth: { offset: { x: 0, y: -10 }, drawings_dir: "mouth" } },
    children: [],
  };
  fs.writeFileSync(path.join(charDir, "character.json"), JSON.stringify(config, null, 2));
  return config;
}

describe("overlap warnings", () => {
  test("two characters on the same mark with the same z warn with the script line number", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice, Bob]",
      "[Action: Bob at=left]",
      "Alice: Sharing the mark now.",
    ].join("\n");
    const { warnings, errors } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);

    assert.equal(errors.length, 0);
    assert.ok(
      warnings.some((w) => w === "Line 4: Alice and Bob overlap on mark 'left' with the same z (10)."),
      `expected overlap warning, got: ${JSON.stringify(warnings)}`
    );
  });

  test("same mark but different z is not an overlap", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice, Bob]",
      "[Action: Alice at=left z=10]",
      "[Action: Bob at=left z=20]",
      "Alice: In front of you.",
    ].join("\n");
    const { warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    assert.equal(
      warnings.filter((w) => /overlap/.test(w)).length,
      0,
      `unexpected overlap warning: ${JSON.stringify(warnings)}`
    );
  });

  test("a character who moves off a mark only overlaps for the frames they actually share", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice at=left]",
      "Alice: I am leaving now.",
      "[Action: Alice at=right]",
      "[Action: Bob at=left]",
      "Bob: I arrived after you left.",
    ].join("\n");
    const { warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    assert.equal(
      warnings.filter((w) => /overlap/.test(w)).length,
      0,
      `Alice left 'left' before Bob arrived; got: ${JSON.stringify(warnings)}`
    );
  });

  test("they do overlap if the second character arrives while the first is still on the mark", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice, Bob]",
      "Alice: Still standing here on the left.",
      "[Action: Bob at=left]",
      "Bob: Now I am on left too.",
    ].join("\n");
    const { warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const overlap = warnings.filter((w) => /overlap/.test(w));
    assert.equal(overlap.length, 1);
    assert.match(overlap[0], /Line 5: Alice and Bob overlap on mark 'left' with the same z \(10\)\./);
  });

  test("findOverlapWarnings ignores intervals that only touch at an exclusive end frame", () => {
    const warnings = findOverlapWarnings([
      {
        sceneId: "intro",
        characterId: "alice",
        displayName: "Alice",
        markName: "left",
        z: 10,
        startFrame: 0,
        endFrame: 24,
        lineNumber: 4,
      },
      {
        sceneId: "intro",
        characterId: "bob",
        displayName: "Bob",
        markName: "left",
        z: 10,
        startFrame: 24,
        endFrame: Number.POSITIVE_INFINITY,
        lineNumber: 7,
      },
    ]);
    assert.deepEqual(warnings, []);
  });
});

describe("mouth sheet check", () => {
  test("complete A–H plus X does not error", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice, Bob]", "Alice: Hi."].join("\n");
    const { errors } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    assert.deepEqual(errors, []);
  });

  test("missing rest shape X errors with the character name, missing shapes, and what is there", async () => {
    const isolated = createFixtureLibrary();
    writeCharacter(isolated.globalAssetsDir, "cara", "Cara", {
      mouthShapes: ["A", "B", "C", "D", "E", "F", "G", "H"],
    });
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Cara]", "Cara: Hello there."].join("\n");
    const { errors } = await parseScript(isolated.projectDir, isolated.globalAssetsDir, script);
    isolated.cleanup();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Cara is missing mouth shape\(s\) X/);
    assert.match(errors[0], /Available: A, B, C, D, E, F, G, H/);
  });

  test("missing Rhubarb shapes A–H are listed", async () => {
    const isolated = createFixtureLibrary();
    writeCharacter(isolated.globalAssetsDir, "cara", "Cara", {
      mouthShapes: ["A", "B", "X"],
    });
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Cara]"].join("\n");
    const { errors } = await parseScript(isolated.projectDir, isolated.globalAssetsDir, script);
    isolated.cleanup();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Cara is missing mouth shape\(s\) C, D, E, F, G, H/);
    assert.match(errors[0], /Available: A, B, X/);
  });

  test("characters with no mouth slot at all are skipped", async () => {
    const isolated = createFixtureLibrary();
    writeCharacter(isolated.globalAssetsDir, "statue", "Statue", {
      mouthShapes: null,
      slots: {},
    });
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Statue]", "Statue: I have no mouth."].join("\n");
    const { errors } = await parseScript(isolated.projectDir, isolated.globalAssetsDir, script);
    isolated.cleanup();

    assert.deepEqual(errors, []);
  });

  test("an unused library character with a broken mouth sheet is not checked", async () => {
    const isolated = createFixtureLibrary();
    writeCharacter(isolated.globalAssetsDir, "cara", "Cara", { mouthShapes: ["A"] });
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi."].join("\n");
    const { errors } = await parseScript(isolated.projectDir, isolated.globalAssetsDir, script);
    isolated.cleanup();
    assert.deepEqual(errors, []);
  });

  test("findMouthSheetErrors lists (none) when the folder is empty", () => {
    const isolated = createFixtureLibrary();
    const config = writeCharacter(isolated.globalAssetsDir, "cara", "Cara", { mouthShapes: [] });
    const used = new Map([["cara", config]]);
    const errors = findMouthSheetErrors(used, isolated.projectDir, isolated.globalAssetsDir);
    isolated.cleanup();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Cara is missing mouth shape\(s\) X, A, B, C, D, E, F, G, H/);
    assert.match(errors[0], /Available: \(none\)/);
  });
});

describe("rig-head lint hook", () => {
  test("characterHasRigHead is opt-in via groups.head or canvas", () => {
    assert.equal(characterHasRigHead({ slots: { mouth: { drawings_dir: "mouth" } } }), false);
    assert.equal(characterHasRigHead({ groups: { head: ["head_base", "eyes"] } }), true);
    assert.equal(
      characterHasRigHead({
        slots: { eyes: { canvas: { w: 1024, h: 1024, pivot: { x: 512, y: 900 } } } },
      }),
      true
    );
  });
});

describe("shared library lint", () => {
  test("warns when a script resolves anything from _global_assets", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi."].join("\n");
    const { warnings, errors } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    assert.equal(errors.length, 0);
    assert.ok(
      warnings.some((w) => /Shared library/.test(w) && w.includes("_global_assets")),
      `expected a shared-library warning, got: ${JSON.stringify(warnings)}`
    );
  });

  test("Independent ON does not emit shared-library paths", async () => {
    const isolated = createFixtureLibrary();
    fs.cpSync(
      path.join(isolated.globalAssetsDir, "characters", "alice"),
      path.join(isolated.projectDir, "characters", "alice"),
      { recursive: true }
    );
    fs.cpSync(
      path.join(isolated.globalAssetsDir, "backgrounds", "room_a"),
      path.join(isolated.projectDir, "backgrounds", "room_a"),
      { recursive: true }
    );
    fs.copyFileSync(
      path.join(isolated.globalAssetsDir, "staging_defaults.json"),
      path.join(isolated.projectDir, "staging_defaults.json")
    );
    fs.writeFileSync(path.join(isolated.projectDir, "studio.json"), JSON.stringify({ independent: true }));
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi."].join("\n");
    const { warnings, errors, timeline } = await parseScript(
      isolated.projectDir,
      isolated.globalAssetsDir,
      script
    );
    isolated.cleanup();
    assert.equal(errors.length, 0);
    assert.equal(
      warnings.filter((w) => /Shared library/.test(w)).length,
      0,
      `unexpected shared-library warning: ${JSON.stringify(warnings)}`
    );
    const json = JSON.stringify(timeline);
    assert.equal(json.includes("_global_assets"), false);
  });
});
