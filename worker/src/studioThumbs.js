"use strict";

/**
 * Cached ~480px JPEG thumbnails for Studio background cards. Invalidates
 * when the source mtime or size changes. Uses ffmpeg on PATH (same as
 * ffprobe); falls back to null so the caller can serve the original.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const THUMB_WIDTH = 480;

function cacheDir() {
  const dir = path.join(os.tmpdir(), "engine-studio-thumbs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePathFor(absPath, stat) {
  const key = crypto.createHash("sha1").update(`${absPath}|${stat.mtimeMs}|${stat.size}`).digest("hex");
  return path.join(cacheDir(), `${key}.jpg`);
}

function generateJpegThumb(src, dest) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", src, "-vf", `scale=${THUMB_WIDTH}:-2`, "-q:v", "5", dest];
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

async function cachedBackgroundThumb(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  const dest = cachePathFor(absPath, stat);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const tmp = `${dest}.part-${process.pid}`;
  try {
    await generateJpegThumb(absPath, tmp);
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

module.exports = { cachedBackgroundThumb, THUMB_WIDTH };
