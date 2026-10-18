"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeRgbaPng } = require("../src/pngFlip");
const { importStill } = require("../src/importStill");

function png() {
  const rgba = Buffer.alloc(8 * 8 * 4, 255);
  return encodeRgbaPng(8, 8, rgba);
}

describe("import still PNG", () => {
  test("prop and background land in this project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-still-"));
    try {
      fs.writeFileSync(path.join(root, "studio.json"), `${JSON.stringify({ independent: true }, null, 2)}\n`);
      fs.mkdirSync(path.join(root, "backgrounds", "bedroom"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "backgrounds", "bedroom", "staging.json"),
        `${JSON.stringify({ marks: { centre: { x: 960, y: 1080, scale: 1 } }, props: {} }, null, 2)}\n`
      );
      const imageBase64 = `data:image/png;base64,${png().toString("base64")}`;
      const bg = importStill(root, null, { kind: "background", name: "alley.png", imageBase64 });
      assert.equal(bg.id, "alley");
      assert.equal(fs.existsSync(path.join(root, bg.rel)), true);
      const prop = importStill(root, null, {
        kind: "prop",
        name: "speaker.png",
        location: "bedroom",
        imageBase64,
      });
      assert.equal(prop.id, "speaker");
      assert.equal(prop.location, "bedroom");
      assert.equal(fs.existsSync(path.join(root, prop.rel)), true);
      const staging = JSON.parse(fs.readFileSync(path.join(root, "backgrounds", "bedroom", "staging.json"), "utf8"));
      assert.ok(staging.props.speaker);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("character upload creates a library character with the image as its reference", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-still-"));
    try {
      fs.writeFileSync(path.join(root, "studio.json"), `${JSON.stringify({ independent: true }, null, 2)}\n`);
      const imageBase64 = `data:image/png;base64,${png().toString("base64")}`;
      const first = importStill(root, null, { kind: "character", name: "Colonel Klink", imageBase64 });
      assert.equal(first.id, "colonel_klink");
      assert.equal(fs.existsSync(path.join(root, first.rel)), true);
      const json = JSON.parse(fs.readFileSync(path.join(root, "characters", "colonel_klink", "character.json"), "utf8"));
      assert.equal(json.display_name, "Colonel Klink");
      assert.equal(json.reference, "_reference/full.png");
      const second = importStill(root, null, { kind: "character", name: "Colonel Klink", imageBase64 });
      assert.equal(second.id, "colonel_klink_2");
      const library = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf8"));
      assert.deepEqual(library.characters, ["colonel_klink", "colonel_klink_2"]);
      assert.throws(() => importStill(root, null, { kind: "character", name: "  ", imageBase64 }), /name/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
