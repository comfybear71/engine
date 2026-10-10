"use strict";

/**
 * Split a long imported WAV into ~30–60 s chunks at silences.
 * Cuts use word timings (and Rhubarb X rests). Existing words.json /
 * rhubarb.json are sliced — ElevenLabs is never called.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SPLIT_OVER_SEC = 60;
const CHUNK_MIN_SEC = 30;
const CHUNK_MAX_SEC = 60;
const MIN_GAP_SEC = 0.12;
const TARGET_SEC = 45;

function formatChunkAtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 0.005) return "0s";
  const rounded = Math.round(s * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded}s`;
}

function chunkLabel(baseLabel, index) {
  const base = String(baseLabel || "take")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "take";
  return `${base}_${String(index + 1).padStart(2, "0")}`;
}

function chunkRelPaths(label, characterId) {
  const stem = `001_${characterId}`;
  const dir = `audio/${label}`;
  return {
    dir,
    wav: `${dir}/${stem}.wav`,
    cues: `${dir}/${stem}.wav.rhubarb.json`,
    words: `${dir}/${stem}.words.json`,
  };
}

function wordsPathForWav(wavRel) {
  return String(wavRel || "").replace(/\.wav$/i, ".words.json");
}

function cuesPathForWav(wavRel) {
  return `${wavRel}.rhubarb.json`;
}

function labelFromWavRel(wavRel) {
  const posix = String(wavRel || "").replace(/\\/g, "/");
  const parts = posix.split("/");
  return parts.length >= 2 ? parts[1] : "";
}

function characterIdFromWavRel(wavRel) {
  const base = path.basename(String(wavRel || ""), ".wav");
  const match = base.match(/^\d+_(.+)$/);
  return match ? match[1] : null;
}

function silenceGaps(words, durationSec) {
  const list = Array.isArray(words)
    ? words
        .filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
        .slice()
        .sort((a, b) => Number(a.start) - Number(b.start))
    : [];
  const gaps = [];
  let cursor = 0;
  for (const word of list) {
    const start = Number(word.start);
    const end = Number(word.end);
    if (start - cursor >= MIN_GAP_SEC) {
      gaps.push({ start: cursor, end: start, mid: (cursor + start) / 2 });
    }
    cursor = Math.max(cursor, end);
  }
  if (durationSec - cursor >= MIN_GAP_SEC) {
    gaps.push({ start: cursor, end: durationSec, mid: (cursor + durationSec) / 2 });
  }
  return gaps;
}

function restGaps(cues) {
  const list = Array.isArray(cues) ? cues : [];
  const gaps = [];
  for (const cue of list) {
    const value = String(cue.value || cue.shape || "").toUpperCase();
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (value === "X" && Number.isFinite(start) && Number.isFinite(end) && end - start >= MIN_GAP_SEC) {
      gaps.push({ start, end, mid: (start + end) / 2 });
    }
  }
  return gaps;
}

function pickCut(from, durationSec, words, gaps) {
  const remain = durationSec - from;
  if (remain <= CHUNK_MAX_SEC + 0.5) return durationSec;
  const windowLo = from + CHUNK_MIN_SEC;
  const windowHi = Math.min(durationSec, from + CHUNK_MAX_SEC);
  const candidates = gaps.filter((gap) => gap.mid > windowLo + 1e-6 && gap.mid <= windowHi + 1e-6);
  if (candidates.length) {
    candidates.sort((a, b) => {
      const lenA = a.end - a.start;
      const lenB = b.end - b.start;
      if (Math.abs(lenB - lenA) > 0.05) return lenB - lenA;
      return Math.abs(a.mid - (from + TARGET_SEC)) - Math.abs(b.mid - (from + TARGET_SEC));
    });
    return Math.min(durationSec, Math.max(from + 1, candidates[0].mid));
  }
  const list = Array.isArray(words) ? words : [];
  let lastEnd = 0;
  for (const word of list) {
    const end = Number(word.end);
    if (end > windowLo && end <= windowHi) lastEnd = end;
  }
  if (lastEnd > from + 1) return lastEnd;
  return Math.min(durationSec, windowHi);
}

/** Plan [start, end) ranges in seconds. One range when duration <= 60 s. */
function planSilenceCuts(durationSec, words, cues) {
  const duration = Math.max(0, Number(durationSec) || 0);
  if (duration <= SPLIT_OVER_SEC + 0.01) {
    return duration > 0 ? [{ start: 0, end: duration }] : [];
  }
  const gaps = silenceGaps(words, duration).concat(restGaps(cues));
  const ranges = [];
  let from = 0;
  while (from < duration - 0.01) {
    const cut = pickCut(from, duration, words, gaps);
    ranges.push({ start: from, end: cut });
    if (cut >= duration - 0.01) break;
    from = cut;
  }
  return ranges;
}

function sliceWords(words, start, end) {
  if (!Array.isArray(words)) return [];
  return words
    .filter((word) => word && Number(word.end) > start && Number(word.start) < end)
    .map((word) => ({
      ...word,
      start: Math.max(0, Math.round((Number(word.start) - start) * 1000) / 1000),
      end: Math.max(0, Math.round((Number(word.end) - start) * 1000) / 1000),
    }));
}

function sliceCues(cues, start, end) {
  const list = Array.isArray(cues) ? cues : [];
  return list
    .filter((cue) => Number(cue.end) > start && Number(cue.start) < end)
    .map((cue) => ({
      start: Math.max(0, Math.round((Number(cue.start) - start) * 1000) / 1000),
      end: Math.min(end - start, Math.max(0, Number(cue.end) - start)),
      value: cue.value || cue.shape || "X",
    }))
    .filter((cue) => cue.end > cue.start);
}

function readJsonFile(abs) {
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function readWords(abs) {
  const data = readJsonFile(abs);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.words)) return data.words;
  return [];
}

function readCues(abs) {
  const data = readJsonFile(abs);
  if (!data) return [];
  if (Array.isArray(data.mouthCues)) return data.mouthCues;
  if (Array.isArray(data)) return data;
  return [];
}

function spawnCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", (err) => reject(new Error(`Failed to spawn ${command}: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve();
    });
  });
}

function extractWavSlice(srcAbs, destAbs, startSeconds, durationSeconds) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  return spawnCommand("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(startSeconds),
    "-t",
    String(durationSeconds),
    "-i",
    srcAbs,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    destAbs,
  ]);
}

function writeCueFile(abs, cues) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ mouthCues: cues }, null, 2) + "\n");
}

function writeWordsFile(abs, words) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(words, null, 2) + "\n");
}

/**
 * Write chunk WAVs + sliced words/cues. Does not change the script.
 */
async function writeAudioChunks(opts) {
  const projectDir = path.resolve(opts.projectDir);
  const sourceWavAbs = path.resolve(opts.sourceWavAbs);
  const characterId = String(opts.characterId || "").trim();
  const baseLabel = String(opts.baseLabel || "take");
  const durationSec = Math.max(0, Number(opts.durationSec) || 0);
  const words = Array.isArray(opts.words) ? opts.words : [];
  const cues = Array.isArray(opts.cues) ? opts.cues : [];
  const extract = opts.extractWavSlice || extractWavSlice;
  if (!characterId) throw new Error("character is required to split audio");
  if (!fs.existsSync(sourceWavAbs)) throw new Error(`Audio file not found: ${sourceWavAbs}`);

  const ranges = planSilenceCuts(durationSec, words, cues);
  if (ranges.length <= 1) return { chunks: [], ranges };
  const chunks = [];
  const t0 = Date.now();
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const label = chunkLabel(baseLabel, i);
    const rel = chunkRelPaths(label, characterId);
    const wavAbs = path.join(projectDir, rel.wav);
    await extract(sourceWavAbs, wavAbs, range.start, range.end - range.start);
    if (!fs.existsSync(wavAbs) || fs.statSync(wavAbs).size < 44) {
      try {
        if (fs.existsSync(wavAbs)) fs.unlinkSync(wavAbs);
      } catch {
        /* ignore */
      }
      continue;
    }
    const chunkWords = sliceWords(words, range.start, range.end);
    if (chunkWords.length) writeWordsFile(path.join(projectDir, rel.words), chunkWords);
    const chunkCues = sliceCues(cues, range.start, range.end);
    if (chunkCues.length) writeCueFile(path.join(projectDir, rel.cues), chunkCues);
    chunks.push({
      label,
      offsetSec: range.start,
      durationSec: range.end - range.start,
      wavPath: rel.wav,
      cuesPath: rel.cues,
      wordsPath: rel.words,
      wordCount: chunkWords.length,
      cueCount: chunkCues.length,
    });
  }
  return { chunks, ranges, elapsedMs: Date.now() - t0 };
}

async function splitExistingAudio(projectDir, opts = {}) {
  const rel = String(opts.rel || "").replace(/\\/g, "/");
  if (!rel.startsWith("audio/") || !/\.wav$/i.test(rel) || rel.includes("..")) {
    throw new Error("rel must be a project audio/*.wav path");
  }
  const wavAbs = path.join(path.resolve(projectDir), rel);
  if (!fs.existsSync(wavAbs) || !fs.statSync(wavAbs).isFile()) {
    throw new Error(`Audio file not found: ${rel}`);
  }
  const characterId = String(opts.characterId || characterIdFromWavRel(rel) || "").trim();
  const baseLabel = String(opts.label || labelFromWavRel(rel) || "take");
  const { probeDurationSeconds } = require("./parser/ffprobeDuration");
  const probe = opts.probeDuration || probeDurationSeconds;
  const probed = await probe(wavAbs);
  const requested = opts.durationSec != null ? Number(opts.durationSec) : probed;
  const durationSec =
    Number.isFinite(probed) && probed > 0 && Number.isFinite(requested)
      ? Math.min(requested, probed)
      : Number.isFinite(requested) && requested > 0
        ? requested
        : probed;
  const words = readWords(path.join(projectDir, wordsPathForWav(rel)));
  const cues = readCues(path.join(projectDir, cuesPathForWav(rel)));
  if (durationSec <= SPLIT_OVER_SEC + 0.01) {
    return {
      ok: true,
      split: false,
      durationSeconds: durationSec,
      chunks: [],
      reason: "already short",
    };
  }
  const written = await writeAudioChunks({
    projectDir,
    sourceWavAbs: wavAbs,
    characterId,
    baseLabel,
    durationSec,
    words,
    cues,
    extractWavSlice: opts.extractWavSlice,
  });
  return {
    ok: true,
    split: written.chunks.length > 1,
    durationSeconds: durationSec,
    originalRel: rel,
    originalLabel: baseLabel,
    character: characterId,
    chunks: written.chunks,
    elapsedMs: written.elapsedMs,
    reusedWords: words.length > 0,
    reusedCues: cues.length > 0,
  };
}

function shouldSplitLongAudio(durationSec, splitLong) {
  if (splitLong === false) return false;
  return Number(durationSec) > SPLIT_OVER_SEC + 0.01;
}

module.exports = {
  SPLIT_OVER_SEC,
  CHUNK_MIN_SEC,
  CHUNK_MAX_SEC,
  formatChunkAtTime,
  chunkLabel,
  chunkRelPaths,
  wordsPathForWav,
  cuesPathForWav,
  labelFromWavRel,
  characterIdFromWavRel,
  planSilenceCuts,
  sliceWords,
  sliceCues,
  writeAudioChunks,
  splitExistingAudio,
  shouldSplitLongAudio,
  extractWavSlice,
  readWords,
  readCues,
};
