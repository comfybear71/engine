"use strict";

/**
 * Run Rhubarb after a newly recorded WAV. Cues are written where the
 * parser/compositor already look: `<audio_path>.rhubarb.json`
 * (e.g. audio/<scene>/<nnn>_<character>.wav.rhubarb.json).
 *
 * Missing binary or a failed run: warn, write no cues, continue.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function findRhubarbBinary(env = process.env) {
  if (env.RHUBARB_PATH) {
    const fromEnv = path.resolve(env.RHUBARB_PATH);
    if (fs.existsSync(fromEnv)) return fromEnv;
  }

  const names = process.platform === "win32" ? ["rhubarb.exe", "rhubarb"] : ["rhubarb"];
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function removeIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ ok: boolean, reason?: "missing"|"failed", message?: string, cuesPath?: string }}
 */
function runRhubarbOnWav({ wavPath, cuesPath, text, rhubarbBin }) {
  const binary = rhubarbBin || findRhubarbBinary();
  if (!binary) {
    return { ok: false, reason: "missing" };
  }

  fs.mkdirSync(path.dirname(cuesPath), { recursive: true });
  // Drop any previous cues so a failed re-run cannot leave stale timings
  // against a newly recorded WAV. The renderer already falls back to X.
  removeIfExists(cuesPath);

  const dialogPath = path.join(os.tmpdir(), `engine-rhubarb-dialog-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(dialogPath, text == null ? "" : String(text), "utf8");

  try {
    const result = spawnSync(binary, ["-f", "json", "-o", cuesPath, "-d", dialogPath, wavPath], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      removeIfExists(cuesPath);
      const detail = String(result.stderr || result.stdout || result.error || "").trim();
      return { ok: false, reason: "failed", message: detail || `rhubarb exited ${result.status}` };
    }
    if (!fs.existsSync(cuesPath)) {
      return { ok: false, reason: "failed", message: "rhubarb exited 0 but wrote no cues file" };
    }
    return { ok: true, cuesPath };
  } catch (err) {
    removeIfExists(cuesPath);
    return { ok: false, reason: "failed", message: err.message };
  } finally {
    removeIfExists(dialogPath);
  }
}

module.exports = { findRhubarbBinary, runRhubarbOnWav };
