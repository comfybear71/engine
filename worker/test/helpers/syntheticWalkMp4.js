"use strict";

/**
 * Tiny headless walk MP4 for Factory Import. Intro stand/turn, then a gait
 * cycle starting at source frame 76 — same layout as Stuart's Grok clip.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
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

function paintHeadless(rgba, width, height, stride, { island = false } = {}) {
  fillRect(rgba, width, 0, 0, width, height, 0, 0, 0, 255);
  const x = Math.round(width * 0.42);
  const y = Math.round(height * 0.12);
  fillRect(rgba, width, x - 10, y, 44, 14, 16, 16, 18, 255);
  fillRect(rgba, width, x - 6, y + 4, 36, 22, 150, 28, 28, 255);
  fillRect(rgba, width, x, y + 24, 24, 28, 160, 36, 36, 255);
  fillRect(rgba, width, x + 2 - stride, y + 50, 8, 36, 140, 70, 40, 255);
  fillRect(rgba, width, x + 14 + stride, y + 50, 8, 36, 140, 70, 40, 255);
  fillRect(rgba, width, x - stride, y + 84, 12, 10, 36, 38, 42, 255);
  fillRect(rgba, width, x + 12 + stride, y + 84, 12, 10, 36, 38, 42, 255);
  if (island) fillRect(rgba, width, 4, 4, 8, 8, 200, 40, 40, 255);
}

function strideForFrame(index, walkStart, period) {
  if (index < walkStart) return index % 20 > 10 ? 1 : 0;
  const phase = ((index - walkStart) / period) * Math.PI * 2;
  return Math.round(6 * Math.sin(phase));
}

function encodePngSequence(dir, { count = 150, width = 96, height = 144, walkStart = 76, period = 24 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const rgba = Buffer.alloc(width * height * 4);
    paintHeadless(rgba, width, height, strideForFrame(i, walkStart, period), { island: i === 4 });
    const name = `frame_${String(i + 1).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(dir, name), encodeRgbaPng(width, height, rgba));
    names.push(name);
  }
  return names;
}

function ffmpegMp4(framesDir, dest, fps = 24) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(framesDir, "frame_%04d.png"),
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "28",
      dest,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 32) {
    throw new Error((result.stderr || result.stdout || "ffmpeg failed").split("\n").pop());
  }
  return dest;
}

function writeSyntheticWalkMp4(dest, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-import-mp4-"));
  try {
    encodePngSequence(tmp, options);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return ffmpegMp4(tmp, dest, options.fps || 24);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { writeSyntheticWalkMp4, encodePngSequence, paintHeadless, fillRect };
