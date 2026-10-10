"use strict";

/**
 * ElevenLabs Speech-to-Text (Scribe). The API key is sent only as the
 * `xi-api-key` header -- never interpolated into a URL, a shell command,
 * or a log line. Single-speaker only: diarize is always false.
 */

const fs = require("fs");
const path = require("path");

const { VoicesFatalError, isFatalAuthOrQuota, isOutputFormatNotAllowed } = require("./elevenlabs");

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const STT_MODEL_ID = "scribe_v1";
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
const MAX_ERROR_BODY_CHARS = 200;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateBody(text) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
}

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

function fatalSttMessage(status, bodyText) {
  const excerpt = truncateBody(bodyText);
  if (status === 401) {
    return "ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY in .env.";
  }
  if (status === 402 || /quota_exceeded|quota exceeded|out of credits|payment_required|payment required/i.test(bodyText || "")) {
    return `ElevenLabs quota/payment error (${status}). Transcription stopped.${excerpt ? ` ${excerpt}` : ""}`;
  }
  return `ElevenLabs Speech-to-Text fatal error (${status}). Transcription stopped.${excerpt ? ` ${excerpt}` : ""}`;
}

/**
 * Turn a Scribe response into `[{word,start,end}]`. Skips spacing / audio
 * events. Accepts either `word` or `text` on each item.
 */
function normalizeWords(payload) {
  const raw = payload && Array.isArray(payload.words) ? payload.words : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const type = item.type == null ? "word" : String(item.type);
    if (type !== "word") continue;
    const word = String(item.word != null ? item.word : item.text != null ? item.text : "").trim();
    const start = Number(item.start);
    const end = Number(item.end);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ word, start, end });
  }
  return out;
}

function mergeChunkWords(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const offset = Number(chunk.offsetSeconds) || 0;
    for (const item of chunk.words || []) {
      const start = item.start + offset;
      const end = item.end + offset;
      if (out.length > 0 && start < out[out.length - 1].end - 0.02) continue;
      out.push({ word: item.word, start, end });
    }
  }
  return out;
}

/**
 * POST /v1/speech-to-text as multipart/form-data.
 * Body fields: model_id=scribe_v1, timestamps_granularity=word, diarize=false, file.
 */
async function transcribeWav({ wavPath, apiKey, fetchFn, sleepFn, backoffMs }) {
  if (!apiKey) {
    throw new VoicesFatalError("ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new VoicesFatalError("No fetch implementation available (Node 18+ is required).");
  }
  if (!wavPath || !fs.existsSync(wavPath)) {
    throw new Error(`Audio file not found for transcription: ${wavPath}`);
  }

  const sleep = sleepFn || defaultSleep;
  const delays = backoffMs || DEFAULT_BACKOFF_MS;
  const maxAttempts = delays.length + 1;
  const bytes = fs.readFileSync(wavPath);
  const filename = path.basename(wavPath);

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const form = new FormData();
    form.append("model_id", STT_MODEL_ID);
    form.append("timestamps_granularity", "word");
    form.append("diarize", "false");
    form.append("file", new Blob([bytes], { type: "audio/wav" }), filename);

    let response;
    try {
      response = await fetchImpl(STT_URL, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
      });
    } catch (err) {
      lastError = new Error(`ElevenLabs Speech-to-Text request failed: ${err.message}`);
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt]);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      const payload = await response.json();
      return {
        text: payload && typeof payload.text === "string" ? payload.text : "",
        words: normalizeWords(payload),
        raw: payload,
      };
    }

    const bodyText = await response.text().catch(() => "");
    if (isOutputFormatNotAllowed(response.status, bodyText) || isFatalAuthOrQuota(response.status, bodyText)) {
      throw new VoicesFatalError(fatalSttMessage(response.status, bodyText));
    }

    lastError = new Error(
      `ElevenLabs Speech-to-Text failed (${response.status})${truncateBody(bodyText) ? `: ${truncateBody(bodyText)}` : ""}`
    );
    if (shouldRetry(response.status) && attempt < maxAttempts - 1) {
      await sleep(delays[attempt]);
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error("ElevenLabs Speech-to-Text request failed");
}

module.exports = {
  transcribeWav,
  normalizeWords,
  mergeChunkWords,
  STT_URL,
  STT_MODEL_ID,
};
