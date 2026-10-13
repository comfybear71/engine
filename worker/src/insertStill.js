"use strict";

/**
 * Insert still: a timeline clip that holds one PNG over a start/end frame
 * range. Script tag:
 *   [Insert: image=inserts/tongue_closeup.png at_time=942 for=11]
 *   [Insert: image=inserts/tongue_closeup.png at_time=942 to=952]
 */

const fs = require("fs");
const path = require("path");

const { encodeRgbaPng } = require("./pngFlip");
const { setDrawingState } = require("./characterStatus");
const { posixJoin } = require("./assetIngest");
const { decodeRgbaFile } = require("./factoryThumb");

function slugInsertId(text) {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "shot"
  );
}

function insertDurationFrames(startFrame, endFrameInclusive) {
  const start = Math.max(0, Math.floor(Number(startFrame) || 0));
  const last = Math.max(start, Math.floor(Number(endFrameInclusive) || start));
  return { startFrame: start, endFrame: last + 1, frames: last - start + 1, lastFrame: last };
}

function insertStillTag({ image, startFrame, endFrame, durationFrames }) {
  const rel = String(image || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const span = durationFrames
    ? insertDurationFrames(startFrame, Number(startFrame) + Number(durationFrames) - 1)
    : insertDurationFrames(startFrame, endFrame);
  return `[Insert: image=${rel} at_time=${span.startFrame} for=${span.frames}]`;
}

function applyInsertToScript(script, tag) {
  const lines = String(script || "").split("\n");
  const already = lines.some((line) => line.trim() === tag);
  if (already) return { script: lines.join("\n"), inserted: false };
  let loc = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[Location:/i.test(lines[i])) loc = i;
  }
  const at = loc >= 0 ? loc + 1 : lines.length;
  lines.splice(at, 0, tag);
  return { script: lines.join("\n"), inserted: true };
}

function fillEllipse(rgba, width, height, cx, cy, rx, ry, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  const rr = rx * rx || 1;
  const hh = ry * ry || 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x - cx) * (x - cx) / rr;
      const dy = (y - cy) * (y - cy) / hh;
      if (dx + dy > 1) continue;
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

function sampleSkin(rgba, width, height) {
  const probes = [
    [460, 280],
    [560, 280],
    [512, 300],
    [480, 330],
  ];
  for (const [x, y] of probes) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const o = (y * width + x) * 4;
    if (rgba[o + 3] > 128) return [rgba[o], rgba[o + 1], rgba[o + 2]];
  }
  return [196, 140, 96];
}

/** Transparent 1024 overlay: skin patch over the default mouth + a big cheeky tongue. Never a head. */
function drawTongueMouthRgba(width = 1024, height = 1024, skin = [196, 140, 96]) {
  const rgba = Buffer.alloc(width * height * 4);
  const [sr, sg, sb] = skin;
  // Cover the baked closed-mouth marks on head_base (~y 360–404) so the still is one mouth.
  fillEllipse(rgba, width, height, 512, 372, 72, 42, sr, sg, sb, 255);
  fillEllipse(rgba, width, height, 512, 378, 58, 28, sr, sg, sb, 255);
  // Open mouth cavity sitting where the Front mouth slot lives.
  fillEllipse(rgba, width, height, 512, 378, 56, 30, 48, 18, 16, 255);
  fillEllipse(rgba, width, height, 512, 384, 46, 22, 90, 30, 28, 255);
  // Big tongue sticking out of that one opening — cheeky / rude.
  fillEllipse(rgba, width, height, 512, 468, 40, 96, 220, 70, 90, 255);
  fillEllipse(rgba, width, height, 512, 492, 30, 74, 236, 96, 110, 255);
  fillEllipse(rgba, width, height, 512, 458, 7, 66, 190, 50, 70, 255);
  fillEllipse(rgba, width, height, 512, 548, 22, 18, 240, 120, 130, 255);
  return rgba;
}

function compositeRgba(base, overlay) {
  const out = Buffer.from(base);
  const n = out.length / 4;
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

function opaqueBox(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return { x: 0, y: 0, w: width, h: height };
  const pad = 24;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    x,
    y,
    w: Math.min(width - x, maxX - minX + 1 + pad * 2),
    h: Math.min(height - y, maxY - minY + 1 + pad * 2),
  };
}

function scaleIntoCanvas(src, srcW, srcH, destW, destH) {
  const dest = Buffer.alloc(destW * destH * 4);
  const scale = Math.min(destW / srcW, destH / srcH) * 1.35;
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const ox = Math.floor((destW - dw) / 2);
  const oy = Math.floor((destH - dh) / 2 - destH * 0.04);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y / dh) * srcH));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x / dw) * srcW));
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= destW || dy >= destH) continue;
      const so = (sy * srcW + sx) * 4;
      const d = (dy * destW + dx) * 4;
      dest[d] = src[so];
      dest[d + 1] = src[so + 1];
      dest[d + 2] = src[so + 2];
      dest[d + 3] = src[so + 3];
    }
  }
  return dest;
}

function readRgba(abs) {
  if (!abs || !fs.existsSync(abs)) return null;
  return decodeRgbaFile(abs);
}

function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Write a Front mouth overlay (draft) + a close-up insert still, and the
 * script tag covering frames 942-952 inclusive.
 */
function installRodneyTongueInsert(projectDir, options = {}) {
  const characterId = options.characterId || "rodney";
  const startFrame = options.startFrame == null ? 942 : options.startFrame;
  const endFrame = options.endFrame == null ? 952 : options.endFrame;
  const charDir = path.join(projectDir, "characters", characterId);
  const mouthDir = path.join(charDir, "mouth_front");
  fs.mkdirSync(mouthDir, { recursive: true });
  const headAbs = firstExisting(path.join(charDir, "head_base"), ["neutral.png", "head_base.png", "head.png"]);
  const eyesAbs = firstExisting(path.join(charDir, "eyes_front"), ["open.png", "neutral.png"]);
  const head = headAbs ? readRgba(headAbs) : null;
  const skin =
    head && head.width === 1024 && head.height === 1024
      ? sampleSkin(head.rgba, head.width, head.height)
      : [196, 140, 96];
  const mouthRgba = drawTongueMouthRgba(1024, 1024, skin);
  const mouthAbs = path.join(mouthDir, "tongue.png");
  fs.writeFileSync(mouthAbs, encodeRgbaPng(1024, 1024, mouthRgba));
  setDrawingState(projectDir, characterId, "mouth_front/tongue", "draft");

  let composite = mouthRgba;
  if (head && head.width === 1024 && head.height === 1024) {
    // Blank the default mouth on the head, then overlay eyes + tongue mouth. Never two heads.
    const blanked = Buffer.from(head.rgba);
    fillEllipse(blanked, 1024, 1024, 512, 372, 72, 42, skin[0], skin[1], skin[2], 255);
    composite = compositeRgba(blanked, mouthRgba);
    const eyes = eyesAbs ? readRgba(eyesAbs) : null;
    if (eyes && eyes.width === 1024) composite = compositeRgba(composite, eyes.rgba);
    composite = compositeRgba(composite, mouthRgba);
  }
  const box = opaqueBox(composite, 1024, 1024);
  const cropped = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) {
    const src = ((box.y + y) * 1024 + box.x) * 4;
    composite.copy(cropped, y * box.w * 4, src, src + box.w * 4);
  }
  const still = scaleIntoCanvas(cropped, box.w, box.h, 1920, 1080);
  const insertRel = posixJoin("inserts", "tongue_closeup.png");
  const insertAbs = path.join(projectDir, insertRel);
  fs.mkdirSync(path.dirname(insertAbs), { recursive: true });
  fs.writeFileSync(insertAbs, encodeRgbaPng(1920, 1080, still));

  const tag = insertStillTag({ image: insertRel, startFrame, endFrame });
  const scriptName = options.scriptName || "script.txt";
  const scriptAbs = path.join(projectDir, scriptName);
  const current = fs.existsSync(scriptAbs) ? fs.readFileSync(scriptAbs, "utf8") : "";
  const next = applyInsertToScript(current, tag);
  fs.writeFileSync(scriptAbs, next.script.endsWith("\n") ? next.script : `${next.script}\n`);
  return {
    mouthRel: posixJoin("characters", characterId, "mouth_front", "tongue.png"),
    insertRel,
    tag,
    startFrame,
    endFrame,
    inserted: next.inserted,
  };
}

module.exports = {
  slugInsertId,
  insertDurationFrames,
  insertStillTag,
  applyInsertToScript,
  drawTongueMouthRgba,
  installRodneyTongueInsert,
};
