"use strict";

/**
 * Real media duration. WAV files are read from the RIFF header (no spawn).
 * Anything else uses ffprobe, spawned with an argument array (never a
 * shell string -- no `exec("ffprobe " + path)`, which is both an injection
 * risk and how Gemini's draft reportedly got a typo that made every line
 * come out as exactly 1 second). Results are cached by path + mtime + size.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { readWavDurationSeconds } = require("./wavDuration");

const durationCache = new Map();

function cacheKey(absPath) {
  const resolved = path.resolve(absPath);
  const stat = fs.statSync(resolved);
  return `${resolved}|${stat.mtimeMs}|${stat.size}`;
}

function cachedDuration(absPath) {
  try {
    const key = cacheKey(absPath);
    if (durationCache.has(key)) return durationCache.get(key);
  } catch {
    /* missing file */
  }
  return undefined;
}

function rememberDuration(absPath, seconds) {
  try {
    durationCache.set(cacheKey(absPath), seconds);
  } catch {
    /* ignore */
  }
  return seconds;
}

function ffprobeDurationSeconds(absAudioPath) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_entries", "format=duration", "-of", "json", absAudioPath];
    const proc = spawn("ffprobe", args);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code} for ${absAudioPath}: ${stderr.trim()}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format && data.format.duration);
        if (!Number.isFinite(duration)) {
          reject(new Error(`ffprobe returned no usable duration for ${absAudioPath}`));
          return;
        }
        resolve(duration);
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output for ${absAudioPath}: ${err.message}`));
      }
    });
  });
}

async function probeDurationSeconds(absAudioPath) {
  const hit = cachedDuration(absAudioPath);
  if (hit !== undefined) return hit;

  if (/\.wav$/i.test(String(absAudioPath))) {
    const fromHeader = readWavDurationSeconds(absAudioPath);
    if (Number.isFinite(fromHeader) && fromHeader > 0) {
      return rememberDuration(absAudioPath, fromHeader);
    }
  }

  const probed = await ffprobeDurationSeconds(absAudioPath);
  return rememberDuration(absAudioPath, probed);
}

function resetDurationCache() {
  durationCache.clear();
}

module.exports = { probeDurationSeconds, resetDurationCache, readWavDurationSeconds };
