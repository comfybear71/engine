"use strict";

/**
 * Per-line lip-sync state and on-demand Rhubarb.
 *
 * Dialogue exists first. Cues are generated per line (Studio Sync / Redo,
 * or automatically after voices / import-audio unless studio.json says
 * lipSync: "manual"). State is derived from the cues file + WAV + text.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runRhubarbOnWav } = require("./rhubarb");
const { extractWavSlice } = require("../splitLongAudio");

const STUDIO_SETTINGS_FILE = "studio.json";
const SYNC_STATES = ["not_synced", "synced", "stale"];
const MTIME_SLOP_MS = 50;

function studioSettingsPath(projectDir) {
  return path.join(projectDir, STUDIO_SETTINGS_FILE);
}

const SMOOTHING_MODES = new Set(["off", "light", "medium"]);
const HEAD_BOB_MODES = new Set(["off", "subtle", "strong"]);
const DEFAULT_LIPSYNC = {
  smoothing: "light",
  head_bob: "subtle",
  blinks: true,
  loud_threshold: 0.75,
};

function normalizeLipsync(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const smoothing = SMOOTHING_MODES.has(src.smoothing) ? src.smoothing : DEFAULT_LIPSYNC.smoothing;
  const headBob = HEAD_BOB_MODES.has(src.head_bob) ? src.head_bob : DEFAULT_LIPSYNC.head_bob;
  let blinks = DEFAULT_LIPSYNC.blinks;
  if (src.blinks === false || src.blinks === "off") blinks = false;
  else if (src.blinks === true || src.blinks === "on") blinks = true;
  let loud = DEFAULT_LIPSYNC.loud_threshold;
  if (typeof src.loud_threshold === "number" && Number.isFinite(src.loud_threshold)) {
    loud = src.loud_threshold > 1 ? src.loud_threshold / 100 : src.loud_threshold;
    loud = Math.min(1, Math.max(0, loud));
  }
  return {
    smoothing,
    head_bob: headBob,
    blinks,
    loud_threshold: loud,
  };
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
    lipsync: normalizeLipsync(data.lipsync),
    independent: data.independent !== false,
  };
}

function writeStudioSettings(projectDir, patch) {
  const current = readStudioSettings(projectDir);
  const incoming = patch && typeof patch === "object" ? patch : {};
  const next = {
    lipSync: incoming.lipSync === "manual" || incoming.lipSync === "auto" ? incoming.lipSync : current.lipSync,
    lipsync: normalizeLipsync({
      ...current.lipsync,
      ...(incoming.lipsync && typeof incoming.lipsync === "object" ? incoming.lipsync : {}),
    }),
    independent:
      incoming.independent === true || incoming.independent === false
        ? incoming.independent
        : current.independent,
  };
  next.lipSync = next.lipSync === "manual" ? "manual" : "auto";
  next.independent = next.independent !== false;
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
  writeJsonAtomic(cuesPath, data);
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

function sourceWindowFromEvent(event, fps) {
  const safeFps = Math.max(1, Number(fps) || 24);
  const trimIn = Number(event && event.trim && event.trim.inFrames) || 0;
  const start = Number(event && event.startFrame) || 0;
  const end = Number(event && event.endFrame) || start + 1;
  const sourceStart = event && event.sourceStartFrame != null ? Number(event.sourceStartFrame) : start;
  const localIn = Math.max(0, (start - sourceStart) / safeFps);
  const localOut = Math.max(localIn + 1 / safeFps, (end - sourceStart) / safeFps);
  return {
    inSec: Math.round((trimIn / safeFps + localIn) * 1000) / 1000,
    outSec: Math.round((trimIn / safeFps + localOut) * 1000) / 1000,
  };
}

function collectDialogueTargets(laneEvents, opts = {}) {
  const uniqueCuesRel = opts.uniqueCuesRel !== false;
  const fps = opts.fps;
  const seen = new Set();
  const targets = [];
  for (const event of laneEvents || []) {
    if (!event || event.lane !== "dialogue") continue;
    const cuesRel = event.cuesRel;
    const wavRel = event.audioRel;
    if (!cuesRel || !wavRel) continue;
    const key = uniqueCuesRel ? cuesRel : `${cuesRel}:${event.scriptLine}:${event.startFrame}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const window = sourceWindowFromEvent(event, fps);
    targets.push({
      scriptLine: event.scriptLine,
      startFrame: event.startFrame,
      wavRel,
      cuesRel,
      text: event.syncText || "",
      sync: event.sync || "not_synced",
      inSec: uniqueCuesRel ? 0 : window.inSec,
      outSec: uniqueCuesRel ? null : window.outSec,
    });
  }
  return targets;
}

function mergeMouthCues(existing, incoming, inSec, outSec) {
  const kept = (Array.isArray(existing) ? existing : []).filter((cue) => {
    const start = Number(cue.start);
    const end = Number(cue.end);
    return end <= inSec + 1e-6 || start >= outSec - 1e-6;
  });
  const shifted = (Array.isArray(incoming) ? incoming : [])
    .map((cue) => ({
      start: Math.round((Number(cue.start) + inSec) * 1000) / 1000,
      end: Math.round((Math.min(outSec, Number(cue.end) + inSec)) * 1000) / 1000,
      value: cue.value || cue.shape || "X",
      ...(cue.pinned ? { pinned: true } : {}),
    }))
    .filter((cue) => cue.end > cue.start);
  return kept.concat(shifted).sort((a, b) => a.start - b.start);
}

function writeJsonAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, abs);
}

function writeMouthCues(abs, cues, engine) {
  const data = { mouthCues: cues };
  if (engine) data.engine = engine;
  writeJsonAtomic(abs, data);
}

function windowHasCues(cues, inSec, outSec) {
  const from = Number(inSec) || 0;
  const to = Number(outSec);
  if (!Number.isFinite(to)) {
    return Array.isArray(cues) && cues.length > 0;
  }
  return (Array.isArray(cues) ? cues : []).some((cue) => Number(cue.end) > from && Number(cue.start) < to);
}

function isWindowedTarget(target) {
  const inSec = Number(target && target.inSec) || 0;
  const outSec = Number(target && target.outSec);
  return Number.isFinite(outSec) && outSec - inSec >= 0.04;
}

const MAX_SYNC_WINDOW_SEC = 8;

function expandSyncTargets(targets) {
  const out = [];
  for (const target of targets || []) {
    if (!isWindowedTarget(target)) {
      out.push(target);
      continue;
    }
    const inSec = Number(target.inSec) || 0;
    const outSec = Number(target.outSec);
    if (outSec - inSec <= MAX_SYNC_WINDOW_SEC + 1e-6) {
      out.push(target);
      continue;
    }
    for (let start = inSec; start < outSec - 0.04; start += MAX_SYNC_WINDOW_SEC) {
      const end = Math.round(Math.min(outSec, start + MAX_SYNC_WINDOW_SEC) * 1000) / 1000;
      out.push({
        ...target,
        inSec: Math.round(start * 1000) / 1000,
        outSec: end,
      });
    }
  }
  return out;
}

/**
 * Run Rhubarb for the given dialogue targets (one WAV/cues pair each).
 * @returns {Promise<{ ok: boolean, results: object[] }>}
 */
async function syncDialogueLines({ projectDir, targets, force = false, runRhubarb, extractSlice } = {}) {
  const run = runRhubarb || runRhubarbOnWav;
  const extract = extractSlice || extractWavSlice;
  const results = [];
  for (const target of expandSyncTargets(targets)) {
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
    const windowed = isWindowedTarget(target);
    if (!force && !windowed && state === "synced") {
      results.push({
        scriptLine: target.scriptLine,
        ok: true,
        skipped: true,
        sync: "synced",
      });
      continue;
    }
    if (!force && windowed) {
      const existing = readCuesFile(cuesAbs);
      if (windowHasCues(existing && existing.mouthCues, target.inSec, target.outSec)) {
        results.push({
          scriptLine: target.scriptLine,
          ok: true,
          skipped: true,
          sync: state === "stale" ? "stale" : "synced",
          windowed: true,
          cuesPath: target.cuesRel,
          inSec: target.inSec,
          outSec: target.outSec,
          mouthCues: existing && Array.isArray(existing.mouthCues) ? existing.mouthCues : [],
        });
        continue;
      }
    }
    let slicePath = null;
    let tempCues = null;
    try {
      let wavPath = wavAbs;
      let cuesPath = cuesAbs;
      if (windowed) {
        slicePath = path.join(os.tmpdir(), `engine-lipsync-${process.pid}-${Date.now()}-${results.length}.wav`);
        tempCues = `${slicePath}.rhubarb.json`;
        await extract(wavAbs, slicePath, target.inSec, target.outSec - target.inSec);
        wavPath = slicePath;
        cuesPath = tempCues;
      }
      const rhubarb = run({
        wavPath,
        cuesPath,
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
      let keepText = target.text;
      if (windowed) {
        const incoming = readCuesFile(tempCues);
        const existing = readCuesFile(cuesAbs);
        keepText = (existing && existing.engine && existing.engine.text) || target.text;
        const merged = mergeMouthCues(
          existing && existing.mouthCues,
          incoming && incoming.mouthCues,
          target.inSec,
          target.outSec
        );
        writeMouthCues(cuesAbs, merged);
      }
      stampCuesMeta(cuesAbs, {
        text: keepText,
        wavPath: wavAbs,
      });
      const saved = readCuesFile(cuesAbs);
      results.push({
        scriptLine: target.scriptLine,
        ok: true,
        sync: "synced",
        cuesPath: target.cuesRel,
        inSec: windowed ? target.inSec : 0,
        outSec: windowed ? target.outSec : null,
        mouthCues: saved && Array.isArray(saved.mouthCues) ? saved.mouthCues : [],
        windowed,
      });
    } finally {
      if (slicePath) {
        try {
          fs.unlinkSync(slicePath);
        } catch {
          /* ignore */
        }
      }
      if (tempCues) {
        try {
          fs.unlinkSync(tempCues);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    ok: results.every((item) => item.ok),
    results,
  };
}

const CUES_REL_RE = /^audio\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav\.rhubarb\.json$/i;
const WAV_REL_RE = /^audio\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/i;

function isSafeRel(rel, pattern) {
  if (typeof rel !== "string" || !rel) return false;
  const posix = rel.replace(/\\/g, "/");
  if (posix.includes("..") || posix.startsWith("/") || posix.includes("//")) return false;
  return pattern.test(posix);
}

function isSafeCuesRel(rel) {
  return isSafeRel(rel, CUES_REL_RE);
}

function isSafeWavRel(rel) {
  return isSafeRel(rel, WAV_REL_RE);
}

function resolveProjectCues(projectDir, rel) {
  if (!isSafeCuesRel(rel)) return null;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, rel);
  const inside = path.relative(root, resolved);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function clearDialogueLipSync({ projectDir, targets } = {}) {
  const results = [];
  for (const target of targets || []) {
    const rel = target && target.cuesRel;
    const abs = rel ? resolveProjectCues(projectDir, rel) : null;
    if (abs) {
      try {
        fs.unlinkSync(abs);
      } catch {
        /* already gone */
      }
    }
    results.push({
      scriptLine: target && target.scriptLine,
      ok: true,
      cleared: true,
      sync: "not_synced",
      cuesPath: rel || null,
    });
  }
  return { ok: true, results };
}

function patchMouthCue(projectDir, { rel, start, end, value, shape, pinned } = {}) {
  const abs = resolveProjectCues(projectDir, rel);
  if (!abs) return { ok: false, error: "Cues file not found" };
  const data = readCuesFile(abs);
  if (!data || !Array.isArray(data.mouthCues)) return { ok: false, error: "Invalid cues file" };
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { ok: false, error: "Cue start/end must be increasing numbers." };
  }
  const idx = data.mouthCues.findIndex(
    (cue) => Math.abs(Number(cue.start) - from) < 1e-3 && Math.abs(Number(cue.end) - to) < 1e-3
  );
  if (idx < 0) return { ok: false, error: "No mouth cue at that time" };
  const cue = { ...data.mouthCues[idx] };
  if (value != null || shape != null) {
    const next = String(value || shape).trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(next)) return { ok: false, error: "Invalid mouth shape" };
    cue.value = next;
  }
  if (pinned === true) cue.pinned = true;
  if (pinned === false) delete cue.pinned;
  data.mouthCues[idx] = cue;
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  return {
    ok: true,
    cue: { start: Number(cue.start) || 0, end: Number(cue.end) || 0, value: String(cue.value || "X"), pinned: Boolean(cue.pinned) },
  };
}

module.exports = {
  STUDIO_SETTINGS_FILE,
  SYNC_STATES,
  computeSyncState,
  stampCuesMeta,
  sourceWindowFromEvent,
  collectDialogueTargets,
  mergeMouthCues,
  windowHasCues,
  expandSyncTargets,
  MAX_SYNC_WINDOW_SEC,
  syncDialogueLines,
  isSafeWavRel,
  readStudioSettings,
  writeStudioSettings,
  isSafeCuesRel,
  resolveProjectCues,
  patchMouthCue,
  clearDialogueLipSync,
  shouldAutoLipSync,
};
