"use strict";

/**
 * Builds a rodney_test-shaped project for factory visual checks:
 * 1024 canvases with small opaque islands so uncropped thumbs look empty.
 */

const fs = require("fs");
const path = require("path");
const { encodeRgbaPng } = require("../../src/pngFlip");

function fillRect(rgba, width, x, y, w, h, r, g, b, a) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, x0 + Math.round(w));
  const y1 = Math.min(rgba.length / (width * 4), y0 + Math.round(h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const o = (yy * width + xx) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

function writePng(filePath, rgba, width = 1024, height = 1024) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encodeRgbaPng(width, height, rgba));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeWav(filePath) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, header);
}

function headRgba(view) {
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  const skin = view === "back" ? [90, 50, 30] : [196, 140, 96];
  fillRect(rgba, 1024, 430, 210, 170, 46, 122, 32, 28, 255);
  fillRect(rgba, 1024, 448, 248, 136, 150, ...skin, 255);
  if (view !== "back") {
    fillRect(rgba, 1024, 470, 360, 90, 18, 70, 40, 28, 255);
    fillRect(rgba, 1024, 488, 390, 52, 14, 90, 40, 40, 255);
  }
  fillRect(rgba, 1024, 492, 410, 44, 70, ...skin, 255);
  return rgba;
}

function eyesRgba(kind) {
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  const open = kind !== "closed";
  const h = kind === "surprised" ? 22 : kind === "half" ? 8 : 14;
  fillRect(rgba, 1024, 468, 318, 28, h, 20, 18, 16, open ? 255 : 0);
  fillRect(rgba, 1024, 532, 318, 28, h, 20, 18, 16, open ? 255 : 0);
  if (kind === "surprised") {
    fillRect(rgba, 1024, 476, 322, 12, 12, 240, 240, 240, 255);
    fillRect(rgba, 1024, 540, 322, 12, 12, 240, 240, 240, 255);
  }
  if (kind === "closed") {
    fillRect(rgba, 1024, 468, 324, 28, 4, 40, 24, 18, 255);
    fillRect(rgba, 1024, 532, 324, 28, 4, 40, 24, 18, 255);
  }
  return rgba;
}

function mouthRgba(kind) {
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  const open = kind === "D" || kind === "C";
  fillRect(rgba, 1024, 490, 392, 48, open ? 28 : 10, 90, 30, 36, 255);
  if (open) fillRect(rgba, 1024, 498, 398, 32, 14, 40, 10, 16, 255);
  return rgba;
}

function torsoRgba(kind) {
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  fillRect(rgba, 1024, 430, 470, 170, 220, 150, 28, 28, 255);
  if (kind !== "armless_L") fillRect(rgba, 1024, 390, 500, 40, 90, 176, 92, 48, 255);
  if (kind !== "armless_R") fillRect(rgba, 1024, 600, 500, 40, 90, 176, 92, 48, 255);
  fillRect(rgba, 1024, 458, 620, 114, 70, 120, 24, 28, 255);
  return rgba;
}

function walkSideRgba(phase) {
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  // 8-phase walk: contact A → passing → contact B → passing. Figure is
  // ~252px tall so Factory proof cells stay readable (>=240px).
  const strides = [36, 18, 0, -18, -36, -18, 0, 18];
  const stride = strides[((phase % 8) + 8) % 8];
  const x = 420;
  const y = 290;
  fillRect(rgba, 1024, x + 6, y + 52, 24, 170, 180, 20, 20, 255);
  fillRect(rgba, 1024, x + 72 + Math.min(stride, 10), y + 4, 50, 22, 40, 20, 16, 255);
  fillRect(rgba, 1024, x + 78 + Math.min(stride, 10), y + 24, 38, 38, 196, 140, 96, 255);
  fillRect(rgba, 1024, x + 52, y + 62, 64, 100, 150, 28, 28, 255);
  fillRect(rgba, 1024, x + 40 + stride, y + 162, 22, 76, 140, 70, 40, 255);
  fillRect(rgba, 1024, x + 90 - stride, y + 162, 22, 76, 140, 70, 40, 255);
  fillRect(rgba, 1024, x + 32 + stride, y + 234, 30, 22, 70, 40, 24, 255);
  fillRect(rgba, 1024, x + 84 - stride, y + 234, 30, 22, 70, 40, 24, 255);
  return rgba;
}

function buildRodneyTestProject(projectDir) {
  const rodney = path.join(projectDir, "characters", "rodney");
  writeJson(path.join(projectDir, "studio.json"), { independent: true });
  fs.writeFileSync(
    path.join(projectDir, "script.txt"),
    [
      "[Scene: Bedroom]",
      "[Location: bedroom]",
      "[Cast: Rodney]",
      "",
      "Rodney: hello there",
      "[Action: Rodney eyes=surprised]",
      "",
    ].join("\n")
  );

  writePng(path.join(rodney, "blank.png"), Buffer.alloc(64 * 64 * 4), 64, 64);
  writePng(path.join(rodney, "head_base", "neutral.png"), headRgba("front"));
  writePng(path.join(rodney, "head_base_back", "neutral.png"), headRgba("back"));
  for (const name of ["open", "half", "closed", "surprised"]) {
    writePng(path.join(rodney, "eyes_front", `${name}.png`), eyesRgba(name));
  }
  for (const name of ["A", "B", "C", "D", "X"]) {
    writePng(path.join(rodney, "mouth_front", `${name}.png`), mouthRgba(name));
  }
  for (const name of ["neutral", "walk", "armless_L", "approach"]) {
    writePng(path.join(rodney, "torso", `${name}.png`), torsoRgba(name));
  }
  writePng(path.join(rodney, "torso_right_side", "neutral.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 470, 470, 90, 220, 150, 28, 28, 255);
    fillRect(rgba, 1024, 430, 500, 40, 90, 176, 92, 48, 255);
    fillRect(rgba, 1024, 488, 620, 70, 70, 120, 24, 28, 255);
    return rgba;
  })());
  const walkNames = [];
  for (let i = 1; i <= 8; i += 1) {
    const name = `walk_side_${String(i).padStart(2, "0")}`;
    walkNames.push(name);
    writePng(path.join(rodney, "body", `${name}.png`), walkSideRgba(i - 1));
  }
  writePng(path.join(rodney, "body", "walk.png"), torsoRgba("walk"));
  writePng(path.join(rodney, "legs_right_side", "walk_side_01.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 450, 700, 30, 90, 40, 20, 10, 255);
    fillRect(rgba, 1024, 520, 700, 30, 90, 40, 20, 10, 255);
    return rgba;
  })());
  writePng(path.join(rodney, "parts", "torso_rig.png"), torsoRgba("neutral"));
  writePng(path.join(rodney, "parts", "shirt.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 450, 490, 130, 80, 210, 200, 180, 255);
    return rgba;
  })());
  writePng(path.join(rodney, "parts", "shorts.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 468, 640, 90, 48, 150, 24, 28, 255);
    return rgba;
  })());
  writePng(path.join(rodney, "parts", "arm_upper.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 560, 500, 28, 90, 176, 92, 48, 255);
    return rgba;
  })());
  writePng(path.join(rodney, "hand", "open.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 580, 600, 36, 40, 196, 140, 96, 255);
    return rgba;
  })());
  writePng(path.join(rodney, "legs", "none.png"), (() => {
    const rgba = Buffer.alloc(1024 * 1024 * 4);
    fillRect(rgba, 1024, 468, 700, 36, 90, 90, 50, 30, 255);
    fillRect(rgba, 1024, 524, 700, 36, 90, 90, 50, 30, 255);
    return rgba;
  })());

  writeJson(path.join(rodney, "character.json"), {
    id: "rodney",
    display_name: "Rodney",
    aliases: ["Rodney"],
    asset: "blank.png",
    z: 10,
    default_scale: 1.66,
    groups: { head: ["head_base", "eyes", "mouth"] },
    slots: {
      head_base: {
        drawings_dir: "head_base",
        default_drawing: "neutral",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
      eyes: {
        drawings_dir: "eyes",
        default_drawing: "open",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
      mouth: {
        drawings_dir: "mouth",
        canvas: { w: 1024, h: 1024, pivot: { x: 509, y: 457 } },
      },
      torso: { drawings_dir: "torso", default_drawing: "neutral" },
      body: {
        drawings_dir: "body",
        default_drawing: "walk",
        cycles: { walk_side: { drawings: walkNames, fps: 12 } },
      },
      hand: { drawings_dir: "hand", default_drawing: "open" },
      legs: { drawings_dir: "legs", default_drawing: "none" },
    },
    children: [
      { id: "torso_rig", asset: "parts/torso_rig.png", z: 0, offset: { x: 0, y: 0 } },
      { id: "shirt_overlay", asset: "parts/shirt.png", z: 1, offset: { x: 0, y: 0 } },
      { id: "shorts", asset: "parts/shorts.png", z: 1, offset: { x: 0, y: 0 } },
      { id: "arm_upper_L", asset: "parts/arm_upper.png", z: 2, offset: { x: 10, y: -20 }, pivot: { x: 582, y: 546 } },
    ],
  });
  writeJson(path.join(rodney, "actions", "walk_side.json"), {
    id: "walk_side",
    view: "right_side",
    fps: 12,
    frames: 8,
    slot_frames: { body: walkNames },
  });
  writeJson(path.join(rodney, "status.json"), {
    "head_base/neutral": "ticked",
    "eyes_front/open": "ticked",
    "eyes_front/surprised": "ticked",
    "mouth_front/A": "draft",
    "torso/neutral": "ticked",
    "body/walk_side_01": "ticked",
    "body/walk_side_02": "ticked",
    "body/walk_side_03": "ticked",
    "body/walk_side_04": "ticked",
    "body/walk_side_05": "ticked",
    "body/walk_side_06": "ticked",
    "body/walk_side_07": "ticked",
    "body/walk_side_08": "ticked",
    _redos: { "mouth_front/A": "wider smile, keep the fedora lined up" },
  });
  writeWav(path.join(projectDir, "audio", "big_red_nude_truck", "001_rodney.wav"));
  writeWav(path.join(projectDir, "audio", "big_red_nude_truck", "002_rodney.wav"));
  writeWav(path.join(projectDir, "audio", "rodney_jepps", "001_rodney.wav"));
  return { characterId: "rodney" };
}

module.exports = { buildRodneyTestProject };
