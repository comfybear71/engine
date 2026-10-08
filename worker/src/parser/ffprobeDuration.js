"use strict";

/**
 * Real audio duration via ffprobe, spawned with an argument array (never a
 * shell string -- no `exec("ffprobe " + path)`, which is both an injection
 * risk and how Gemini's draft reportedly got a typo that made every line
 * come out as exactly 1 second).
 */

const { spawn } = require("child_process");

function probeDurationSeconds(absAudioPath) {
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

module.exports = { probeDurationSeconds };
