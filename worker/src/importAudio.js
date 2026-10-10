"use strict";

/**
 * Import a pre-recorded mp3/wav as a character's lip-synced dialogue track.
 *
 * Copies the source into projects/<p>/audio/<label>/, converts it to the
 * engine WAV (16-bit LE mono PCM @ 44100), runs Rhubarb for mouth cues,
 * and (unless --no-transcribe) calls ElevenLabs Speech-to-Text for
 * word-level timestamps. Watch / parse / render never call this.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const assetLibrary = require("./parser/assetLibrary");
const { probeDurationSeconds } = require("./parser/ffprobeDuration");
const { resolveApiKey, VoicesFatalError } = require("./voices/elevenlabs");
const { runRhubarbOnWav } = require("./voices/rhubarb");
const { transcribeWav, mergeChunkWords, STT_MODEL_ID } = require("./voices/speechToText");

function resolveGlobalAssetsDir(projectDir) {
  return path.join(path.dirname(projectDir), "_global_assets");
}

function slugifyLabel(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const ENGINE_SAMPLE_RATE = 44100;
const ENGINE_CHANNELS = 1;
const LINE_NUMBER = 1;
const ALLOWED_SOURCE_EXT = new Set([".mp3", ".wav"]);
const CHUNK_SECONDS = 8 * 60;
const CHUNK_OVERLAP_SECONDS = 0.25;
const SENTENCE_END_RE = /[.!?…]+["')\]]*$/;
const DEFAULT_PAUSE_SECONDS = 0.6;

function padLineNumber(n) {
  return String(n).padStart(3, "0");
}

function importedStem(characterId, lineNumber = LINE_NUMBER) {
  return `${padLineNumber(lineNumber)}_${characterId}`;
}

function importedRelPaths(label, characterId, lineNumber = LINE_NUMBER) {
  const stem = importedStem(characterId, lineNumber);
  const dir = `audio/${label}`;
  return {
    dir,
    wav: `${dir}/${stem}.wav`,
    cues: `${dir}/${stem}.wav.rhubarb.json`,
    words: `${dir}/${stem}.words.json`,
  };
}

function resolveImportedTrack(projectDir, label, characterId) {
  const rel = importedRelPaths(label, characterId);
  const wavAbs = path.join(projectDir, rel.wav);
  if (!fs.existsSync(wavAbs)) return null;
  const wordsAbs = path.join(projectDir, rel.words);
  let words = null;
  if (fs.existsSync(wordsAbs)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(wordsAbs, "utf8"));
      words = Array.isArray(parsed) ? parsed : null;
    } catch {
      words = null;
    }
  }
  return { wav: rel.wav, cues: rel.cues, wordsPath: rel.words, words };
}

function formatAudioLength(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(s);
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  const tenths = Math.round(s * 10) / 10;
  if (minutes <= 0) return `${tenths}s`;
  return `${minutes}m ${String(rem).padStart(2, "0")}s (${tenths} seconds)`;
}

function creditNote(durationSeconds, { noTranscribe = false } = {}) {
  const length = formatAudioLength(durationSeconds);
  if (noTranscribe) {
    return `Audio length: ${length}. Transcription skipped (--no-transcribe).`;
  }
  return (
    `Audio length: ${length}. Transcription uses ElevenLabs Speech-to-Text ` +
    `credits (${STT_MODEL_ID}, billed by audio duration). Use --no-transcribe to skip STT.`
  );
}

function wordsToSentences(words, { pauseSeconds = DEFAULT_PAUSE_SECONDS } = {}) {
  const list = Array.isArray(words) ? words.filter((w) => w && w.word) : [];
  const sentences = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    const text = current
      .map((w) => w.word)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1");
    sentences.push({
      text,
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
    });
    current = [];
  };
  for (let i = 0; i < list.length; i++) {
    current.push(list[i]);
    const next = list[i + 1];
    const ended = SENTENCE_END_RE.test(String(list[i].word));
    const pause = next && Number(next.start) - Number(list[i].end) >= pauseSeconds;
    if (ended || pause || !next) flush();
  }
  return sentences;
}

function transcriptFromWords(words) {
  if (!Array.isArray(words) || words.length === 0) return "";
  return words
    .map((w) => w.word)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

function resolveCharacterId(projectDir, globalAssetsDir, name) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return { error: "Character is required (--character <id>)." };
  const ids = assetLibrary.listKnownCharacterIds(projectDir, globalAssetsDir);
  const known = [];
  for (const id of ids) {
    const config = assetLibrary.loadCharacter(projectDir, globalAssetsDir, id);
    if (!config) continue;
    const names = [config.id, config.display_name, ...(config.aliases || [])].filter(Boolean);
    known.push(config.display_name || config.id);
    if (names.some((n) => String(n).toLowerCase() === needle)) {
      return { characterId: config.id, displayName: config.display_name || config.id };
    }
  }
  return { error: `Unknown character "${name}". Known characters: ${known.join(", ") || "(none)"}` };
}

function sanitizeLabel(value, fallback) {
  const raw = value == null || String(value).trim() === "" ? fallback : value;
  const label = slugifyLabel(String(raw || ""));
  if (!label) {
    throw new Error("Import label is empty. Pass --name <label> (letters, numbers, underscores).");
  }
  if (label.includes("..")) {
    throw new Error(`Invalid import label "${label}".`);
  }
  return label;
}

function assertSourceFile(sourcePath) {
  if (!sourcePath) throw new Error("Audio file path is required.");
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Audio file not found: ${sourcePath}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_SOURCE_EXT.has(ext)) {
    throw new Error(`Unsupported audio type "${ext || "(none)"}". Use .mp3 or .wav.`);
  }
  return resolved;
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

function convertToEngineWav(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  return spawnCommand("ffmpeg", [
    "-y",
    "-i",
    srcAbs,
    "-ac",
    String(ENGINE_CHANNELS),
    "-ar",
    String(ENGINE_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    destAbs,
  ]);
}

function extractWavSlice(srcAbs, destAbs, startSeconds, durationSeconds) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  return spawnCommand("ffmpeg", [
    "-y",
    "-ss",
    String(startSeconds),
    "-t",
    String(durationSeconds),
    "-i",
    srcAbs,
    "-ac",
    String(ENGINE_CHANNELS),
    "-ar",
    String(ENGINE_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    destAbs,
  ]);
}

function originalCopyName(sourceAbs, wavBasename) {
  const base = path.basename(sourceAbs);
  if (base.toLowerCase() === wavBasename.toLowerCase()) {
    return `original${path.extname(sourceAbs) || ".wav"}`;
  }
  return base;
}

function makeIo(options) {
  return {
    log: options.log || console.log,
    warn: options.warn || console.warn,
    error: options.error || console.error,
  };
}

function chunkStarts(durationSeconds, chunkSeconds) {
  const size = Math.max(1, Number(chunkSeconds) || CHUNK_SECONDS);
  if (durationSeconds <= size) return [{ start: 0, duration: durationSeconds }];
  const out = [];
  let start = 0;
  while (start < durationSeconds - 0.01) {
    const duration = Math.min(size, durationSeconds - start);
    out.push({ start, duration });
    if (start + duration >= durationSeconds) break;
    start += size - CHUNK_OVERLAP_SECONDS;
  }
  return out;
}

async function transcribePossiblyChunked(wavAbs, durationSeconds, ctx) {
  const chunks = chunkStarts(durationSeconds, ctx.chunkSeconds);
  if (chunks.length === 1) {
    const result = await transcribeWav({
      wavPath: wavAbs,
      apiKey: ctx.apiKey,
      fetchFn: ctx.fetchFn,
      sleepFn: ctx.sleepFn,
      backoffMs: ctx.backoffMs,
    });
    return result.words;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-stt-"));
  const collected = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const slice = chunks[i];
      const slicePath = path.join(tmpDir, `chunk-${String(i + 1).padStart(3, "0")}.wav`);
      await (ctx.extractWavSlice || extractWavSlice)(wavAbs, slicePath, slice.start, slice.duration);
      ctx.io.log(`Transcribing chunk ${i + 1}/${chunks.length} (${formatAudioLength(slice.duration)})...`);
      const result = await transcribeWav({
        wavPath: slicePath,
        apiKey: ctx.apiKey,
        fetchFn: ctx.fetchFn,
        sleepFn: ctx.sleepFn,
        backoffMs: ctx.backoffMs,
      });
      collected.push({ offsetSeconds: slice.start, words: result.words });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return mergeChunkWords(collected);
}

/**
 * @param {string} projectDir
 * @param {string} sourceFile
 * @param {{
 *   character: string,
 *   name?: string,
 *   dryRun?: boolean,
 *   noTranscribe?: boolean,
 *   globalAssetsDir?: string,
 *   fetch?: Function,
 *   sleep?: Function,
 *   backoffMs?: number[],
 *   probeDuration?: Function,
 *   convertToEngineWav?: Function,
 *   extractWavSlice?: Function,
 *   runRhubarb?: Function,
 *   rhubarbBin?: string,
 *   chunkSeconds?: number,
 *   log?: Function,
 *   warn?: Function,
 *   error?: Function,
 * }} [options]
 */
async function runImportAudio(projectDir, sourceFile, options = {}) {
  const io = makeIo(options);
  const resolvedProjectDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedProjectDir) || !fs.statSync(resolvedProjectDir).isDirectory()) {
    throw new Error(`Project folder not found: ${projectDir}`);
  }
  const globalAssetsDir = options.globalAssetsDir || resolveGlobalAssetsDir(resolvedProjectDir);
  const sourceAbs = assertSourceFile(sourceFile);
  const character = resolveCharacterId(resolvedProjectDir, globalAssetsDir, options.character);
  if (character.error) throw new Error(character.error);

  const label = sanitizeLabel(options.name, path.basename(sourceAbs, path.extname(sourceAbs)));
  const rel = importedRelPaths(label, character.characterId);
  const dryRun = !!options.dryRun;
  const noTranscribe = !!options.noTranscribe;
  const probe = options.probeDuration || probeDurationSeconds;
  const durationSeconds = await probe(sourceAbs);
  const note = creditNote(durationSeconds, { noTranscribe });

  io.log(note);

  const result = {
    ok: true,
    dryRun,
    noTranscribe,
    label,
    character: character.characterId,
    durationSeconds,
    creditNote: note,
    sourcePath: sourceAbs,
    wavPath: rel.wav,
    cuesPath: rel.cues,
    wordsPath: rel.words,
    words: null,
    transcribed: false,
  };

  if (dryRun) {
    io.log("Dry run: no files written.");
    return result;
  }

  const destDir = path.join(resolvedProjectDir, rel.dir);
  fs.mkdirSync(destDir, { recursive: true });
  const wavAbs = path.join(resolvedProjectDir, rel.wav);
  const originalName = originalCopyName(sourceAbs, path.basename(rel.wav));
  const originalAbs = path.join(destDir, originalName);
  if (path.resolve(sourceAbs) !== path.resolve(originalAbs)) {
    fs.copyFileSync(sourceAbs, originalAbs);
  }
  result.originalPath = path.posix.join(rel.dir, originalName);

  io.log(`Converting to engine WAV (16-bit mono ${ENGINE_SAMPLE_RATE} Hz)...`);
  const convert = options.convertToEngineWav || convertToEngineWav;
  await convert(sourceAbs, wavAbs);
  if (!fs.existsSync(wavAbs)) {
    throw new Error(`ffmpeg did not write ${rel.wav}`);
  }

  let words = null;
  if (!noTranscribe) {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new VoicesFatalError("ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key.");
    }
    io.log("Transcribing with ElevenLabs Speech-to-Text (scribe_v1, single speaker)...");
    words = await transcribePossiblyChunked(wavAbs, durationSeconds, {
      apiKey,
      fetchFn: options.fetch,
      sleepFn: options.sleep,
      backoffMs: options.backoffMs,
      chunkSeconds: options.chunkSeconds || CHUNK_SECONDS,
      extractWavSlice: options.extractWavSlice,
      io,
    });
    const wordsAbs = path.join(resolvedProjectDir, rel.words);
    fs.writeFileSync(wordsAbs, JSON.stringify(words, null, 2) + "\n");
    result.transcribed = true;
    result.words = words;
    io.log(`Wrote ${rel.words} (${words.length} word(s)).`);
  }

  const cuesAbs = path.join(resolvedProjectDir, rel.cues);
  const dialogText = transcriptFromWords(words);
  const rhubarb = (options.runRhubarb || runRhubarbOnWav)({
    wavPath: wavAbs,
    cuesPath: cuesAbs,
    text: dialogText,
    rhubarbBin: options.rhubarbBin,
  });
  if (!rhubarb.ok) {
    if (rhubarb.reason === "missing") {
      io.warn(
        `warning: Rhubarb not found on PATH (or RHUBARB_PATH). Skipping cues for ${rel.wav}; renderer will fall back.`
      );
    } else {
      io.warn(
        `warning: Rhubarb failed for ${rel.wav} (${rhubarb.message || "unknown error"}). No cues written; renderer will fall back.`
      );
    }
  } else {
    io.log(`Wrote ${rel.cues}`);
  }

  io.log(`Imported ${rel.wav} for ${character.characterId} (${formatAudioLength(durationSeconds)}).`);
  io.log(`Use in a script: [Audio: ${character.displayName} file=${label}]`);
  return result;
}

function parseBooleanFlag(value) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0" || value == null) return false;
  return Boolean(value);
}

/**
 * Minimal multipart parser for one file field plus text fields.
 * Used by POST /api/projects/:name/import-audio.
 */
function parseMultipartBuffer(buffer, contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    const err = new Error("multipart boundary missing");
    err.status = 400;
    throw err;
  }
  const boundary = `--${(match[1] || match[2]).trim()}`;
  const parts = [];
  let offset = 0;
  const boundBuf = Buffer.from(boundary);
  while (offset < buffer.length) {
    const start = buffer.indexOf(boundBuf, offset);
    if (start === -1) break;
    const after = start + boundBuf.length;
    if (buffer.slice(after, after + 2).toString("ascii") === "--") break;
    const headerEnd = buffer.indexOf("\r\n\r\n", after);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(boundBuf, headerEnd + 4);
    if (next === -1) break;
    const header = buffer.slice(after + 2, headerEnd).toString("utf8");
    let body = buffer.slice(headerEnd + 4, next);
    if (body.length >= 2 && body.slice(-2).toString("ascii") === "\r\n") {
      body = body.slice(0, -2);
    }
    const nameMatch = header.match(/name="([^"]+)"/i);
    const fileMatch = header.match(/filename="([^"]*)"/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: fileMatch ? fileMatch[1] : "",
      data: body,
    });
    offset = next;
  }
  return parts;
}

function collectRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error("Upload too large (max 200MB)");
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readImportAudioRequest(req) {
  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    const buffer = await collectRawBody(req, 200 * 1024 * 1024);
    const parts = parseMultipartBuffer(buffer, ctype);
    const fields = {};
    let upload = null;
    for (const part of parts) {
      if (part.filename) {
        upload = part;
      } else {
        fields[part.name] = part.data.toString("utf8");
      }
    }
    let sourcePath = (fields.path || fields.file || "").trim();
    let cleanup = null;
    if (upload && upload.data.length > 0) {
      const ext = path.extname(upload.filename || "").toLowerCase() || ".wav";
      const tmp = path.join(os.tmpdir(), `engine-import-${process.pid}-${Date.now()}${ext}`);
      fs.writeFileSync(tmp, upload.data);
      sourcePath = tmp;
      cleanup = () => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      };
    }
    return {
      sourcePath,
      character: (fields.character || "").trim(),
      name: (fields.name || "").trim() || undefined,
      dryRun: parseBooleanFlag(fields.dryRun || fields["dry-run"]),
      noTranscribe: parseBooleanFlag(fields.noTranscribe || fields["no-transcribe"]),
      cleanup,
    };
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  return {
    sourcePath: String(body.path || body.file || "").trim(),
    character: String(body.character || "").trim(),
    name: body.name ? String(body.name).trim() : undefined,
    dryRun: parseBooleanFlag(body.dryRun || body["dry-run"]),
    noTranscribe: parseBooleanFlag(body.noTranscribe || body["no-transcribe"] || (body.transcribe === false ? true : false)),
    cleanup: null,
  };
}

module.exports = {
  runImportAudio,
  resolveImportedTrack,
  importedRelPaths,
  importedStem,
  wordsToSentences,
  transcriptFromWords,
  creditNote,
  formatAudioLength,
  sanitizeLabel,
  resolveCharacterId,
  readImportAudioRequest,
  parseMultipartBuffer,
  ENGINE_SAMPLE_RATE,
  CHUNK_SECONDS,
  VoicesFatalError,
};
