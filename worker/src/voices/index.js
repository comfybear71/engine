"use strict";

/**
 * `node src/cli.js voices <project> [--dry-run] [--force]`
 *
 * Re-parses the script so every dialogue line is considered (not only
 * missing WAVs), records through ElevenLabs when the credit-guard hash
 * does not match, then re-parses so timings come from the real files.
 *
 * The watcher must never call this module.
 */

const fs = require("fs");
const path = require("path");

const { parseProject, parseProjectToFiles, resolveGlobalAssetsDir } = require("../parser");
const { resolveAsset } = require("../parser/assetLibrary");
const { pcmToWav } = require("./wavHeader");
const { sidecarPathForWav, writeSidecar, shouldSkipLine } = require("./creditGuard");
const { synthesizePcm, resolveModelId, resolveApiKey, resolveOutputFormat, VoicesFatalError } = require("./elevenlabs");
const { runRhubarbOnWav } = require("./rhubarb");

function padLineNumber(n) {
  return String(n).padStart(3, "0");
}

function lineLabel(line) {
  return `${line.scene_id}/${padLineNumber(line.line_number)}_${line.character}`;
}

function atomicWriteFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, contents);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err2) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err2;
    }
  }
}

/**
 * Voice ID from character.json via the existing asset library
 * (project override, then `_global_assets`).
 */
function resolveVoiceId(projectDir, globalAssetsDir, characterId) {
  const relPath = `characters/${characterId}/character.json`;
  const resolved = resolveAsset(projectDir, globalAssetsDir, relPath);
  if (!resolved) {
    return {
      error: `Character "${characterId}" has no character.json (looked in project override, then _global_assets).`,
    };
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolved.absPath, "utf8"));
  } catch (err) {
    return { error: `Character "${characterId}": failed to read ${resolved.timelinePath}: ${err.message}` };
  }
  const voiceId = config && config.voice_id;
  if (typeof voiceId !== "string" || !voiceId.trim()) {
    return {
      error: `Character "${characterId}" has no voice_id in ${resolved.timelinePath}.`,
      characterPath: resolved.timelinePath,
    };
  }
  return { voiceId: voiceId.trim(), characterPath: resolved.timelinePath };
}

function printSummary(io, { dryRun, recorded, skipped, failed, totalChars }) {
  if (dryRun) {
    io.log(
      `Dry run: ${recorded} line(s) to record, ${skipped} skipped, ${failed} failed. ` +
        `Total characters: ${totalChars} (~${totalChars} credits estimated; ` +
        `~1 credit per character on standard ElevenLabs models — this is an estimate).`
    );
    return;
  }
  io.log(`Recorded: ${recorded}`);
  io.log(`Skipped: ${skipped}`);
  io.log(`Failed: ${failed}`);
}

function makeIo(options) {
  return {
    log: options.log || console.log,
    warn: options.warn || console.warn,
    error: options.error || console.error,
  };
}

async function recordOneLine(line, ctx) {
  const { projectDir, modelId, apiKey, outputFormat, sampleRate, io, options } = ctx;
  const wavAbs = path.join(projectDir, line.audio_path);
  const cuesAbs = path.join(projectDir, line.cues_path);
  const sidecarAbs = sidecarPathForWav(wavAbs);

  const pcm = await synthesizePcm({
    voiceId: line.voiceId,
    text: line.text,
    modelId,
    apiKey,
    outputFormat,
    fetchFn: options.fetch,
    sleepFn: options.sleep,
    backoffMs: options.backoffMs,
  });

  atomicWriteFile(wavAbs, pcmToWav(pcm, { sampleRate }));
  writeSidecar(sidecarAbs, {
    text: line.text,
    voiceId: line.voiceId,
    modelId,
  });

  const rhubarb = (options.runRhubarb || runRhubarbOnWav)({
    wavPath: wavAbs,
    cuesPath: cuesAbs,
    text: line.text,
    rhubarbBin: options.rhubarbBin,
  });
  if (!rhubarb.ok) {
    if (rhubarb.reason === "missing") {
      io.warn(
        `warning: Rhubarb not found on PATH (or RHUBARB_PATH). Skipping cues for ${lineLabel(line)}; renderer will fall back.`
      );
    } else {
      io.warn(
        `warning: Rhubarb failed for ${lineLabel(line)} (${rhubarb.message || "unknown error"}). No cues written; renderer will fall back.`
      );
    }
  }
}

/**
 * @param {string} projectDir
 * @param {{
 *   dryRun?: boolean,
 *   force?: boolean,
 *   script?: string,
 *   globalAssetsDir?: string,
 *   skipValidate?: boolean,
 *   fetch?: Function,
 *   sleep?: Function,
 *   backoffMs?: number[],
 *   runRhubarb?: Function,
 *   rhubarbBin?: string,
 *   parseAfter?: boolean,
 *   log?: Function,
 *   warn?: Function,
 *   error?: Function,
 * }} [options]
 */
async function runVoices(projectDir, options = {}) {
  const io = makeIo(options);
  const resolvedProjectDir = path.resolve(projectDir);
  const globalAssetsDir = options.globalAssetsDir || resolveGlobalAssetsDir(resolvedProjectDir);
  const dryRun = !!options.dryRun;
  const force = !!options.force;
  const modelId = resolveModelId();
  const apiKey = resolveApiKey();
  const { outputFormat, sampleRate } = resolveOutputFormat();

  const parsed = await parseProject(resolvedProjectDir, {
    script: options.script,
    globalAssetsDir,
  });

  const result = {
    ok: true,
    recorded: 0,
    skipped: 0,
    failed: 0,
    totalChars: 0,
    toRecord: [],
    errors: [],
    dryRun,
    modelId,
    parse: null,
  };

  const voiceCache = new Map();
  const missingVoiceCharacters = new Set();

  for (const line of parsed.lines) {
    if (!voiceCache.has(line.character)) {
      voiceCache.set(line.character, resolveVoiceId(resolvedProjectDir, globalAssetsDir, line.character));
    }
    const voice = voiceCache.get(line.character);
    if (voice.error) {
      if (!missingVoiceCharacters.has(line.character)) {
        missingVoiceCharacters.add(line.character);
        io.error(voice.error);
        result.errors.push(voice.error);
      }
      result.failed += 1;
      result.ok = false;
      continue;
    }

    const wavAbs = path.join(resolvedProjectDir, line.audio_path);
    const skip = shouldSkipLine({
      wavPath: wavAbs,
      text: line.text,
      voiceId: voice.voiceId,
      modelId,
      force,
    });
    if (skip) {
      result.skipped += 1;
      continue;
    }

    const chars = String(line.text).length;
    result.toRecord.push({
      ...line,
      voiceId: voice.voiceId,
      chars,
    });
    result.totalChars += chars;
  }

  if (dryRun) {
    if (result.toRecord.length === 0) {
      io.log("No lines to record.");
    } else {
      io.log("Would record:");
      for (const line of result.toRecord) {
        io.log(
          `  ${line.scene_id}  ${padLineNumber(line.line_number)}  ${line.character}  ${line.chars} chars`
        );
      }
    }
    result.recorded = result.toRecord.length;
    printSummary(io, {
      dryRun: true,
      recorded: result.recorded,
      skipped: result.skipped,
      failed: result.failed,
      totalChars: result.totalChars,
    });
    return result;
  }

  if (result.toRecord.length > 0 && !apiKey) {
    throw new VoicesFatalError("ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key.");
  }

  const ctx = { projectDir: resolvedProjectDir, modelId, apiKey, outputFormat, sampleRate, io, options };
  try {
    for (const line of result.toRecord) {
      io.log(`Recording ${lineLabel(line)} (${line.chars} chars)...`);
      try {
        await recordOneLine(line, ctx);
        result.recorded += 1;
      } catch (err) {
        if (err instanceof VoicesFatalError) throw err;
        result.failed += 1;
        result.ok = false;
        io.error(`Failed ${lineLabel(line)}: ${err.message}`);
        result.errors.push(err.message);
      }
    }
  } catch (err) {
    result.ok = false;
    if (err instanceof VoicesFatalError && result.recorded > 0 && options.parseAfter !== false) {
      result.parse = await parseProjectToFiles(resolvedProjectDir, {
        script: options.script,
        skipValidate: options.skipValidate,
      });
    }
    printSummary(io, result);
    throw err;
  }

  printSummary(io, result);

  if (options.parseAfter !== false) {
    result.parse = await parseProjectToFiles(resolvedProjectDir, {
      script: options.script,
      skipValidate: options.skipValidate,
    });
  }

  return result;
}

module.exports = {
  runVoices,
  resolveVoiceId,
  padLineNumber,
  lineLabel,
  VoicesFatalError,
};
