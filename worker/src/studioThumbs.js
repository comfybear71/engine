"use strict";

/**
 * Cached thumbnails and Stage preview textures.
 *
 * Background cards get a 16:9 cover JPEG (same crop as CLI `fit_to_canvas`
 * cover). Other thumbs stay width-scaled. Preview textures (`?preview=1`)
 * never pad or crop — they only shrink, keeping source aspect so Stage
 * can `drawImage` them into `backgroundDestRect`.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 270;
const PREVIEW_TEXTURE_MAX = 512;

function cacheDir() {
  const dir = path.join(os.tmpdir(), "engine-studio-thumbs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isBackgroundAssetPath(absPath) {
  const normalized = String(absPath || "").replace(/\\/g, "/");
  return /\/backgrounds\//.test(normalized) || /\/bg\.png$/i.test(normalized);
}

function cachePathFor(absPath, stat, kind) {
  const key = crypto.createHash("sha1").update(`${kind}|${absPath}|${stat.mtimeMs}|${stat.size}`).digest("hex");
  return path.join(cacheDir(), `${key}.jpg`);
}

function runFfmpeg(args, dest) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
        reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
        return;
      }
      resolve(dest);
    });
  });
}

function generateJpegThumb(src, dest, { cover169 = false } = {}) {
  const vf = cover169
    ? `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=increase,crop=${THUMB_WIDTH}:${THUMB_HEIGHT},setsar=1`
    : `scale=${THUMB_WIDTH}:-2,setsar=1`;
  return runFfmpeg(
    ["-y", "-i", src, "-vf", vf, "-frames:v", "1", "-update", "1", "-q:v", "5", dest],
    dest
  );
}

async function cachedBackgroundThumb(absPath, { cover169 } = {}) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const useCover = cover169 === true || (cover169 !== false && isBackgroundAssetPath(absPath));
  const stat = fs.statSync(absPath);
  const dest = cachePathFor(absPath, stat, useCover ? "cover16x9" : "scale480");
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const tmp = `${dest}.${process.pid}.tmp.jpg`;
  try {
    await generateJpegThumb(absPath, tmp, { cover169: useCover });
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function previewCachePathFor(absPath, stat) {
  const key = crypto
    .createHash("sha1")
    .update(`preview512-aspect|${absPath}|${stat.mtimeMs}|${stat.size}`)
    .digest("hex");
  return path.join(cacheDir(), `${key}.png`);
}

function generatePngPreview(src, dest) {
  return runFfmpeg(
    [
      "-y",
      "-i",
      src,
      "-vf",
      `scale='min(${PREVIEW_TEXTURE_MAX}\\,iw)':-2,setsar=1`,
      "-frames:v",
      "1",
      "-update",
      "1",
      dest,
    ],
    dest
  );
}

async function cachedPreviewTexture(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  if (stat.size > 0 && stat.size < 80 * 1024) return absPath;
  const dest = previewCachePathFor(absPath, stat);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const tmp = `${dest}.${process.pid}.tmp.png`;
  try {
    await generatePngPreview(absPath, tmp);
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return absPath;
  }
}

module.exports = {
  cachedBackgroundThumb,
  cachedPreviewTexture,
  generateJpegThumb,
  generatePngPreview,
  isBackgroundAssetPath,
  THUMB_WIDTH,
  THUMB_HEIGHT,
  PREVIEW_TEXTURE_MAX,
};
