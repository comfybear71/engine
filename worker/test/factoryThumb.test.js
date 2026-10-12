"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { encodeRgbaPng } = require("../src/pngFlip");
const { alphaBounds, compositeRgba, renderFactoryThumb } = require("../src/factoryThumb");
const fs = require("fs");
const os = require("os");
const path = require("path");

function fillRect(rgba, width, x, y, w, h, r, g, b, a) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const o = (yy * width + xx) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

describe("factory thumbs", () => {
  test("crops a small opaque island plus padding instead of the full 1024 canvas", () => {
    const width = 1024;
    const height = 1024;
    const rgba = Buffer.alloc(width * height * 4);
    fillRect(rgba, width, 480, 400, 40, 30, 20, 20, 20, 255);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-thumb-"));
    const piece = path.join(tmp, "eyes.png");
    fs.writeFileSync(piece, encodeRgbaPng(width, height, rgba));
    const rendered = renderFactoryThumb({ piecePath: piece, pad: 8 });
    assert.ok(rendered.width < 80);
    assert.ok(rendered.height < 60);
    assert.equal(rendered.bounds.x, 480);
    assert.equal(rendered.bounds.y, 400);
    assert.equal(rendered.bounds.w, 40);
    assert.equal(rendered.bounds.h, 30);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("composites an overlay over head_base before cropping", () => {
    const width = 64;
    const height = 64;
    const head = Buffer.alloc(width * height * 4);
    const eyes = Buffer.alloc(width * height * 4);
    fillRect(head, width, 10, 10, 40, 40, 180, 80, 40, 255);
    fillRect(eyes, width, 18, 18, 8, 6, 0, 0, 0, 255);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-comp-"));
    const headPath = path.join(tmp, "head.png");
    const eyesPath = path.join(tmp, "eyes.png");
    fs.writeFileSync(headPath, encodeRgbaPng(width, height, head));
    fs.writeFileSync(eyesPath, encodeRgbaPng(width, height, eyes));
    const rendered = renderFactoryThumb({ piecePath: eyesPath, basePath: headPath, pad: 2 });
    assert.ok(rendered.width >= 40);
    assert.ok(rendered.height >= 40);
    const blended = compositeRgba(head, eyes, width, height);
    const box = alphaBounds(blended, width, height);
    assert.equal(box.x, 10);
    assert.equal(box.y, 10);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
