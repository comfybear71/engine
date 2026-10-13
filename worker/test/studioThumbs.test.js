"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  cachedBackgroundThumb,
  generateJpegThumb,
  generatePngPreview,
  isBackgroundAssetPath,
  THUMB_WIDTH,
  THUMB_HEIGHT,
  PREVIEW_TEXTURE_MAX,
} = require("../src/studioThumbs");

function probe(file) {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  assert.equal(out.status, 0, out.stderr);
  const [width, height] = out.stdout.trim().split(",").map(Number);
  return { width, height };
}

function writeSolidPng(dest, width, height) {
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `color=c=0x6b2d6b:s=${width}x${height}`, "-frames:v", "1", dest],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
}

describe("studio thumbs and preview textures", () => {
  test("isBackgroundAssetPath matches backgrounds/bg.png", () => {
    assert.equal(isBackgroundAssetPath("/projects/rodney/backgrounds/curtain/bg.png"), true);
    assert.equal(isBackgroundAssetPath("/projects/rodney/characters/rodney/body.png"), false);
  });

  test("16:9 source thumb is 480x270 cover and preview keeps 16:9", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-thumbs-"));
    const src = path.join(dir, "backgrounds", "curtain", "bg.png");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    writeSolidPng(src, 1920, 1080);
    const thumb = path.join(dir, "thumb.jpg");
    const preview = path.join(dir, "preview.png");
    await generateJpegThumb(src, thumb, { cover169: true });
    await generatePngPreview(src, preview);
    assert.deepEqual(probe(src), { width: 1920, height: 1080 });
    assert.deepEqual(probe(thumb), { width: THUMB_WIDTH, height: THUMB_HEIGHT });
    assert.deepEqual(probe(preview), { width: PREVIEW_TEXTURE_MAX, height: 288 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("square source background thumb is 16:9 cover, not a letterboxed square", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-thumbs-"));
    const src = path.join(dir, "backgrounds", "bedroom", "bg.png");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    writeSolidPng(src, 1024, 1024);
    const cached = await cachedBackgroundThumb(src);
    assert.ok(cached);
    assert.deepEqual(probe(cached), { width: 480, height: 270 });
    const preview = path.join(dir, "preview.png");
    await generatePngPreview(src, preview);
    assert.deepEqual(probe(preview), { width: 512, height: 512 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("preview texture never pads a 16:9 PNG to a square", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-thumbs-"));
    const src = path.join(dir, "curtain.png");
    writeSolidPng(src, 1920, 1080);
    const dest = path.join(dir, "out.png");
    await generatePngPreview(src, dest);
    const size = probe(dest);
    assert.equal(size.width / size.height, 16 / 9);
    assert.ok(size.height < size.width);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
