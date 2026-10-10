"use strict";

/**
 * Per-line lip-sync state and on-demand Rhubarb.
 *
 * Dialogue exists first. Cues are generated per line (Studio Sync / Redo,
 * or automatically after voices / import-audio unless studio.json says
 * lipSync: "manual"). State is derived from the cues file + WAV + text.
 */

const fs = require("fs");
const path = require("path");

const { runRhubarbOnWav } = require("./rhubarb");

const STUDIO_SETTINGS_FILE = "studio.json";
const SYNC_STATES = ["not_synced", "synced", "stale"];
const MTIME_SLOP_MS = 50;

function studioSettingsPath(projectDir) {
  return path.join(projectDir, STUDIO_SETTINGS_FILE);
}

function readStudioSettings(projectDir) {
  const filePath = studioSettingsPath(projectDir);
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8")) || {};
    } catch {
      data = {};
    }
  }
  return {
    lipSync: data.lipSync === "manual" ? "manual" : "auto",
  };
}

function writeStudioSettings(projectDir, patch) {
  const current = readStudioSettings(projectDir);
  const next = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
  next.lipSync = next.lipSync === "manual" ? "manual" : "auto";
  fs.writeFileSync(studioSettingsPath(projectDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function shouldAutoLipSync(projectDir) {
  return readStudioSettings(projectDir).lipSync !== "manual";
}

function stampCuesMeta(cuesPath, { text, wavPath } = {}) {
  if (!cuesPath || !fs.existsSync(cuesPath)) return null;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(cuesPath, "utf8")) || {};
  } catch {
    return null;
  }
  const stat = wavPath && fs.existsSync(wavPath) ? fs.statSync(wavPath) : null;
  data.engine = {
    text: text == null ? "" : String(text),
    wavSize: stat ? stat.size : null,
    wavMtimeMs: stat ? stat.mtimeMs : null,
  };
  fs.writeFileSync(cuesPath, `${JSON.stringify(data, null, 2)}\n`);
  return data.engine;
}

function readCuesFile(cuesAbs) {
  if (!cuesAbs || !fs.existsSync(cuesAbs)) return null;
  try {
    return JSON.parse(fs.readFileSync(cuesAbs, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @returns {"not_synced"|"synced"|"stale"}
 */
function computeSyncState({ projectDir, cuesRel, wavRel, text } = {}) {
  if (!projectDir || !cuesRel) return "not_synced";
  const cuesAbs = path.join(projectDir, cuesRel);
  const data = readCuesFile(cuesAbs);
  const cues = data && Array.isArray(data.mouthCues) ? data.mouthCues : [];
  if (!data || cues.length === 0) return "not_synced";

  const wavAbs = wavRel ? path.join(projectDir, wavRel) : null;
  if (!wavAbs || !fs.existsSync(wavAbs)) return "stale";

  const wavStat = fs.statSync(wavAbs);
  const cuesStat = fs.statSync(cuesAbs);
  const engine = data.engine && typeof data.engine === "object" ? data.engine : null;
  if (engine) {
    if (String(engine.text || "") !== String(text || "")) return "stale";
    if (engine.wavSize != null && Number(engine.wavSize) !== wavStat.size) return "stale";
  }
  if (wavStat.mtimeMs > cuesStat.mtimeMs + MTIME_SLOP_MS) return "stale";
  return "synced";
}

function collectDialogueTargets(laneEvents) {
  const seen = new Set();
  const targets = [];
  for (const event of laneEvents || []) {
    if (!event || event.lane !== "dialogue") continue;
    const cuesRel = event.cuesRel;
    const wavRel = event.audioRel;
    if (!cuesRel || !wavRel) continue;
    if (seen.has(cuesRel)) continue;
    seen.add(cuesRel);
    targets.push({
      scriptLine: event.scriptLine,
      wavRel,
      cuesRel,
      text: event.syncText || "",
      sync: event.sync || "not_synced",
    });
  }
  return targets;
}

/**
 * Run Rhubarb for the given dialogue targets (one WAV/cues pair each).
 * @returns {Promise<{ ok: boolean, results: object[] }>}
 */
async function syncDialogueLines({ projectDir, targets, force = false, runRhubarb } = {}) {
  const run = runRhubarb || runRhubarbOnWav;
  const results = [];
  for (const target of targets || []) {
    const wavAbs = path.join(projectDir, target.wavRel);
    const cuesAbs = path.join(projectDir, target.cuesRel);
    if (!target.wavRel || !fs.existsSync(wavAbs)) {
      results.push({
        scriptLine: target.scriptLine,
        ok: false,
        reason: "no_audio",
        message: "No WAV for this line yet.",
        sync: "not_synced",
      });
      continue;
    }
    const state = computeSyncState({
      projectDir,
      cuesRel: target.cuesRel,
      wavRel: target.wavRel,
      text: target.text,
    });
    if (!force && state === "synced") {
      results.push({
        scriptLine: target.scriptLine,
        ok: true,
        skipped: true,
        sync: "synced",
      });
      continue;
    }
    const rhubarb = run({
      wavPath: wavAbs,
      cuesPath: cuesAbs,
      text: target.text,
    });
    if (!rhubarb.ok) {
      const message =
        rhubarb.reason === "missing"
          ? "Rhubarb is not installed (set RHUBARB_PATH or add rhubarb to PATH)."
          : rhubarb.message || "Rhubarb failed.";
      results.push({
        scriptLine: target.scriptLine,
        ok: false,
        reason: rhubarb.reason || "failed",
        message,
        sync: state,
      });
      continue;
    }
    stampCuesMeta(cuesAbs, { text: target.text, wavPath: wavAbs });
    results.push({
      scriptLine: target.scriptLine,
      ok: true,
      sync: "synced",
      cuesPath: target.cuesRel,
    });
  }
  return {
    ok: results.every((item) => item.ok),
    results,
  };
}

module.exports = {
  STUDIO_SETTINGS_FILE,
  SYNC_STATES,
  computeSyncState,
  stampCuesMeta,
  collectDialogueTargets,
  syncDialogueLines,
  readStudioSettings,
  writeStudioSettings,
  shouldAutoLipSync,
};
