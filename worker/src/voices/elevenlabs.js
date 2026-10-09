"use strict";

/**
 * ElevenLabs text-to-speech. The API key is sent only as the `xi-api-key`
 * header via Node's native fetch -- never interpolated into a URL, a shell
 * command, or a log line.
 */

const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "pcm_24000";
const TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
const MAX_ERROR_BODY_CHARS = 200;
const PCM_FORMAT_RE = /^pcm_(\d+)$/;

class VoicesFatalError extends Error {
  constructor(message) {
    super(message);
    this.name = "VoicesFatalError";
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateBody(text) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
}

function isQuotaError(status, bodyText) {
  const lower = String(bodyText || "").toLowerCase();
  if (status === 402) return true;
  return /quota_exceeded|quota exceeded|out of credits|payment_required|payment required/.test(lower);
}

function isFatalAuthOrQuota(status, bodyText) {
  if (status === 401 || status === 402) return true;
  return isQuotaError(status, bodyText);
}

function isOutputFormatNotAllowed(status, bodyText) {
  return status === 403 && /output_format_not_allowed/i.test(String(bodyText || ""));
}

function parseOutputFormat(value) {
  const raw = value == null || String(value).trim() === "" ? DEFAULT_OUTPUT_FORMAT : String(value).trim();
  const match = PCM_FORMAT_RE.exec(raw);
  const sampleRate = match ? Number(match[1]) : NaN;
  if (!match || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new VoicesFatalError(
      `Invalid ELEVENLABS_OUTPUT_FORMAT "${raw}". Expected pcm_<rate> (e.g. pcm_16000, pcm_22050, pcm_24000, pcm_44100).`
    );
  }
  return { outputFormat: raw, sampleRate };
}

function resolveOutputFormat(env = process.env) {
  return parseOutputFormat(env.ELEVENLABS_OUTPUT_FORMAT);
}

function fatalMessage(status, bodyText) {
  const excerpt = truncateBody(bodyText);
  if (status === 401) {
    return "ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY in .env.";
  }
  if (isOutputFormatNotAllowed(status, bodyText)) {
    return (
      "ElevenLabs rejected the output format (403 output_format_not_allowed). " +
      "Set ELEVENLABS_OUTPUT_FORMAT=pcm_24000 or lower in .env."
    );
  }
  if (status === 402 || isQuotaError(status, bodyText)) {
    return `ElevenLabs quota/payment error (${status}). Voice recording stopped.${excerpt ? ` ${excerpt}` : ""}`;
  }
  return `ElevenLabs fatal error (${status}). Voice recording stopped.${excerpt ? ` ${excerpt}` : ""}`;
}

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

/**
 * POST /v1/text-to-speech/{voice_id}?output_format=pcm_<rate>
 * Body: { text, model_id }. Response is raw 16-bit LE mono PCM at that rate.
 */
async function synthesizePcm({ voiceId, text, modelId, apiKey, outputFormat, fetchFn, sleepFn, backoffMs }) {
  if (!apiKey) {
    throw new VoicesFatalError("ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new VoicesFatalError("No fetch implementation available (Node 18+ is required).");
  }
  const sleep = sleepFn || defaultSleep;
  const delays = backoffMs || DEFAULT_BACKOFF_MS;
  const format = parseOutputFormat(outputFormat ?? process.env.ELEVENLABS_OUTPUT_FORMAT);
  const url = `${TTS_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format.outputFormat)}`;
  const maxAttempts = delays.length + 1;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/octet-stream",
        },
        body: JSON.stringify({ text, model_id: modelId }),
      });
    } catch (err) {
      lastError = new Error(`ElevenLabs request failed: ${err.message}`);
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt]);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new Error("ElevenLabs returned an empty audio body");
      }
      return bytes;
    }

    const bodyText = await response.text().catch(() => "");
    if (isOutputFormatNotAllowed(response.status, bodyText) || isFatalAuthOrQuota(response.status, bodyText)) {
      throw new VoicesFatalError(fatalMessage(response.status, bodyText));
    }

    lastError = new Error(
      `ElevenLabs request failed (${response.status})${truncateBody(bodyText) ? `: ${truncateBody(bodyText)}` : ""}`
    );
    if (shouldRetry(response.status) && attempt < maxAttempts - 1) {
      await sleep(delays[attempt]);
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error("ElevenLabs request failed");
}

function resolveModelId(env = process.env) {
  return env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;
}

function resolveApiKey(env = process.env) {
  return env.ELEVENLABS_API_KEY || "";
}

module.exports = {
  synthesizePcm,
  resolveModelId,
  resolveApiKey,
  resolveOutputFormat,
  parseOutputFormat,
  VoicesFatalError,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  isFatalAuthOrQuota,
  isOutputFormatNotAllowed,
};
