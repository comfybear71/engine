"use strict";

/**
 * Builds a tiny, throwaway asset library + project folder (under a fresh
 * os.tmpdir() directory) for parser unit tests, so they never touch the
 * real projects/_global_assets or projects/sample. The PNGs are a 1x1
 * transparent placeholder -- the parser never reads pixel data, only
 * checks file existence, so a minimal valid PNG is enough.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TRANSPARENT_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const MOUTH_SHAPES = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];

function writePng(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, TRANSPARENT_PNG_1X1);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * @returns {{ root: string, projectDir: string, globalAssetsDir: string, cleanup: () => void }}
 */
function createFixtureLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-parser-test-"));
  const globalAssetsDir = path.join(root, "_global_assets");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  // -- characters: alice (with a right_hand rig child) and bob (simple) --
  for (const id of ["alice", "bob"]) {
    const charDir = path.join(globalAssetsDir, "characters", id);
    writePng(path.join(charDir, "body.png"));
    for (const shape of MOUTH_SHAPES) writePng(path.join(charDir, "mouth", `${shape}.png`));
    writePng(path.join(charDir, "eyes", "open.png"));
    writePng(path.join(charDir, "eyes", "closed.png"));
  }

  writePng(path.join(globalAssetsDir, "characters", "alice", "parts", "arm.png"));
  writePng(path.join(globalAssetsDir, "characters", "alice", "right_hand", "fist.png"));
  writePng(path.join(globalAssetsDir, "characters", "alice", "right_hand", "point.png"));

  writeJson(path.join(globalAssetsDir, "characters", "alice", "character.json"), {
    id: "alice",
    display_name: "Alice",
    aliases: ["Alice"],
    asset: "body.png",
    z: 10,
    default_scale: 1.0,
    voice_id: null,
    slots: {
      mouth: { offset: { x: 0, y: -10 }, drawings_dir: "mouth" },
      eyes: { offset: { x: 0, y: -12 }, drawings_dir: "eyes", default_drawing: "open" },
    },
    children: [
      {
        id: "right_arm",
        asset: "parts/arm.png",
        z: 1,
        offset: { x: -5, y: -8 },
        pivot: "top-center",
        slots: {
          right_hand: { offset: { x: 0, y: 4 }, drawings_dir: "right_hand", default_drawing: "fist" },
        },
      },
    ],
  });

  writeJson(path.join(globalAssetsDir, "characters", "bob", "character.json"), {
    id: "bob",
    display_name: "Bob",
    aliases: ["Bob"],
    asset: "body.png",
    z: 10,
    default_scale: 1.0,
    voice_id: null,
    slots: {
      mouth: { offset: { x: 0, y: -10 }, drawings_dir: "mouth" },
      eyes: { offset: { x: 0, y: -12 }, drawings_dir: "eyes", default_drawing: "open" },
    },
    children: [],
  });

  // -- locations: room_a (marks close together) and room_b (marks wide apart) --
  writePng(path.join(globalAssetsDir, "backgrounds", "room_a", "bg.png"));
  writeJson(path.join(globalAssetsDir, "backgrounds", "room_a", "staging.json"), {
    marks: {
      centre: { x: 500, y: 1000, scale: 1.0 },
      left: { x: 450, y: 1000, scale: 1.0 },
      right: { x: 550, y: 1000, scale: 1.0, flip_x: true },
    },
    auto_order: ["left", "right"],
  });

  writePng(path.join(globalAssetsDir, "backgrounds", "room_b", "bg.png"));
  writeJson(path.join(globalAssetsDir, "backgrounds", "room_b", "staging.json"), {
    marks: {
      centre: { x: 500, y: 1000, scale: 0.7 },
      left: { x: 100, y: 1000, scale: 0.7 },
      right: { x: 900, y: 1000, scale: 0.7, flip_x: true },
    },
    auto_order: ["left", "right"],
  });

  // Deliberately has no "auto_order" of its own, so a location with no
  // staging.json at all exercises the engine-level DEFAULT_AUTO_ORDER.
  writeJson(path.join(globalAssetsDir, "staging_defaults.json"), {
    marks: {
      centre: { x: 500, y: 1000, scale: 1.0 },
      off_left: { x: -100, y: 1000, scale: 1.0 },
      off_right: { x: 1100, y: 1000, scale: 1.0, flip_x: true },
    },
  });

  function cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  function writeScript(scriptText, filename = "script.txt") {
    fs.writeFileSync(path.join(projectDir, filename), scriptText);
  }

  return { root, projectDir, globalAssetsDir, cleanup, writeScript, writePng, writeJson };
}

module.exports = { createFixtureLibrary, TRANSPARENT_PNG_1X1, MOUTH_SHAPES };
