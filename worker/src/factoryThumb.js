"use strict";

/**
 * Factory Assets thumbnails: crop a PNG to its opaque pixels (plus padding).
 * Eyes/mouth overlay the same-view head_base first, then crop the composite.
 */

const fs = require("fs");
const { decodePng, encodeRgbaPng } = require("./pngFlip");

const DEFAULT_PAD_RATIO = 0.12;
const MIN_PAD = 16;

function toRgba(decoded) {
  const { width, height, colorType, pixels, extras } = decoded;
  if (colorType === 6) return { width, height, rgba: Buffer.from(pixels) };
  const rgba = Buffer.alloc(width * height * 4);
  const palette = extras && extras.find((item) => item.type === "PLTE");
  const trns = extras && extras.find((item) => item.type === "tRNS");
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (colorType === 0) {
      const v = pixels[i];
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    } else if (colorType === 2) {
      const s = i * 3;
      rgba[o] = pixels[s];
      rgba[o + 1] = pixels[s + 1];
      rgba[o + 2] = pixels[s + 2];
      rgba[o + 3] = 255;
    } else if (colorType === 4) {
      const s = i * 2;
      rgba[o] = pixels[s];
      rgba[o + 1] = pixels[s];
      rgba[o + 2] = pixels[s];
      rgba[o + 3] = pixels[s + 1];
    } else if (colorType === 3 && palette) {
      const idx = pixels[i];
      rgba[o] = palette.data[idx * 3] || 0;
      rgba[o + 1] = palette.data[idx * 3 + 1] || 0;
      rgba[o + 2] = palette.data[idx * 3 + 2] || 0;
      rgba[o + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
    } else {
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function decodeRgbaFile(absPath) {
  return toRgba(decodePng(fs.readFileSync(absPath)));
}

function alphaBounds(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height, empty: true };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false };
}

function padBox(box, width, height, pad) {
  const extra = Number.isFinite(pad)
    ? Math.max(0, Math.round(pad))
    : Math.max(MIN_PAD, Math.round(Math.max(box.w, box.h) * DEFAULT_PAD_RATIO));
  const x = Math.max(0, box.x - extra);
  const y = Math.max(0, box.y - extra);
  const x2 = Math.min(width, box.x + box.w + extra);
  const y2 = Math.min(height, box.y + box.h + extra);
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

function cropRgba(rgba, width, height, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) {
    const src = ((box.y + y) * width + box.x) * 4;
    rgba.copy(out, y * box.w * 4, src, src + box.w * 4);
  }
  return out;
}

function compositeRgba(base, overlay, width, height) {
  const out = Buffer.from(base);
  const n = width * height;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const oa = overlay[o + 3] / 255;
    if (oa <= 0) continue;
    const ia = 1 - oa;
    out[o] = Math.round(overlay[o] * oa + out[o] * ia);
    out[o + 1] = Math.round(overlay[o + 1] * oa + out[o + 1] * ia);
    out[o + 2] = Math.round(overlay[o + 2] * oa + out[o + 2] * ia);
    out[o + 3] = Math.round(Math.min(255, overlay[o + 3] + out[o + 3] * ia));
  }
  return out;
}

function sameSize(a, b) {
  return a && b && a.width === b.width && a.height === b.height;
}

function renderFactoryThumb({ piecePath, basePath, pad } = {}) {
  if (!piecePath || !fs.existsSync(piecePath)) {
    throw new Error("Factory thumb is missing a piece file");
  }
  const piece = decodeRgbaFile(piecePath);
  let rgba = piece.rgba;
  let width = piece.width;
  let height = piece.height;
  if (basePath && fs.existsSync(basePath)) {
    const base = decodeRgbaFile(basePath);
    if (sameSize(base, piece)) {
      rgba = compositeRgba(base.rgba, piece.rgba, width, height);
    }
  }
  const bounds = alphaBounds(rgba, width, height);
  const box = padBox(bounds, width, height, pad);
  return {
    png: encodeRgbaPng(box.w, box.h, cropRgba(rgba, width, height, box)),
    bounds,
    crop: box,
    width: box.w,
    height: box.h,
  };
}

module.exports = {
  DEFAULT_PAD_RATIO,
  MIN_PAD,
  toRgba,
  decodeRgbaFile,
  alphaBounds,
  padBox,
  cropRgba,
  compositeRgba,
  renderFactoryThumb,
};
