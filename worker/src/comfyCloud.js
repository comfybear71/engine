"use strict";

/**
 * Comfy Cloud client for the LTX 2.3 image+audio-to-video (IA2V) workflow in
 * worker/workflow/LTX_2.3_IA2V_Cloud.json (an API-format export of the
 * workflow that lip-syncs a still to an audio clip).
 *
 * Endpoints, as used by the deck app: POST /api/upload/image (the form field
 * is "image" for audio too), POST /api/prompt, GET /api/jobs/{id} (plural
 * "jobs", not /api/history), GET /api/view (302 to a signed URL that must be
 * fetched without the key). COMFY_CLOUD_API_KEY is sent only as X-API-Key and
 * is never logged.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TEMPLATE_PATH = path.resolve(__dirname, "..", "workflow", "LTX_2.3_IA2V_Cloud.json");
const DEFAULT_BASE_URL = "https://cloud.comfy.org";
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_POLL_FAILURES = 10;
const DEFAULT_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly";

const NODE = {
  image: "269",
  audio: "276",
  save: "341",
  prompt: "340:319",
  duration: "340:331",
  negative: "340:314",
  refine: "340:296",
  promptEnhance: "340:349",
  baseSeed: "340:285",
  refineSeed: "340:286",
};

function comfyError(message, code) {
  const err = new Error(message);
  err.code = code || "ECOMFY";
  return err;
}

function resolveCredentials(env = process.env) {
  const apiKey = String(env.COMFY_CLOUD_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = String(env.COMFY_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

function requireCredentials(env = process.env) {
  const creds = resolveCredentials(env);
  if (!creds) throw comfyError("COMFY_CLOUD_API_KEY is not configured. Add it to the engine .env file.", "ENOKEY");
  return creds;
}

function httpMessage(status) {
  if (status === 401 || status === 403) return "Comfy Cloud rejected the API key (check COMFY_CLOUD_API_KEY and that the account has an active plan/credits)";
  if (status === 402) return "Comfy Cloud says the account is out of credits";
  if (status === 429) return "Comfy Cloud is rate limiting requests";
  return `Comfy Cloud returned HTTP ${status}`;
}

function errorText(payload) {
  const err = payload && payload.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  return "";
}

function networkReason(err) {
  const cause = err && err.cause;
  const code = (cause && (cause.code || cause.name)) || (err && (err.code || err.name)) || "";
  const detail = (cause && cause.message) || (err && err.message) || "network error";
  return code && !detail.includes(code) ? `${detail} (${code})` : detail;
}

/** fetch with a timeout; network failures become errors that say what actually broke. */
async function request(fetchFn, url, init, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const error = comfyError(`Could not reach Comfy Cloud while ${label}: ${networkReason(err)}`, "ENETWORK");
    error.cause = err;
    throw error;
  }
}

function randomSeed() {
  return crypto.randomBytes(6).readUIntBE(0, 6);
}

function loadTemplate() {
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));
}

function patch(graph, id, values) {
  const node = graph[id];
  if (!node || !node.inputs) throw comfyError(`LTX workflow template is missing node ${id}`, "ETEMPLATE");
  Object.assign(node.inputs, values);
}

/** Copy of the template with this clip's image, audio, prompt and length filled in. */
function buildWorkflow({ imageName, audioName, prompt, durationSec, negativePrompt, filenamePrefix }) {
  const graph = loadTemplate();
  patch(graph, NODE.image, { image: imageName });
  patch(graph, NODE.audio, { audio: audioName });
  patch(graph, NODE.prompt, { value: prompt });
  patch(graph, NODE.duration, { value: durationSec });
  patch(graph, NODE.save, { filename_prefix: filenamePrefix || "video/engine_ltx_head" });
  if (negativePrompt) patch(graph, NODE.negative, { text: `${DEFAULT_NEGATIVE}, ${negativePrompt}` });
  patch(graph, NODE.refine, { strength: 0.6 });
  patch(graph, NODE.promptEnhance, { value: false });
  patch(graph, NODE.baseSeed, { noise_seed: randomSeed() });
  patch(graph, NODE.refineSeed, { noise_seed: randomSeed() });
  return graph;
}

async function uploadInput(creds, bytes, filename, mimeType, fetchFn) {
  const form = new FormData();
  form.set("image", new Blob([bytes], { type: mimeType }), filename);
  form.set("type", "input");
  form.set("overwrite", "true");
  const res = await request(fetchFn, `${creds.baseUrl}/api/upload/image`, {
    method: "POST",
    headers: { "X-API-Key": creds.apiKey },
    body: form,
  }, `uploading ${filename}`, TRANSFER_TIMEOUT_MS);
  if (!res.ok) throw comfyError(`${httpMessage(res.status)} while uploading ${filename}`);
  const body = await res.json().catch(() => ({}));
  return typeof body.name === "string" && body.name ? body.name : filename;
}

async function submitWorkflow(creds, workflow, fetchFn) {
  const res = await request(fetchFn, `${creds.baseUrl}/api/prompt`, {
    method: "POST",
    headers: { "X-API-Key": creds.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  }, "submitting the workflow");
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = errorText(payload);
    throw comfyError(`${httpMessage(res.status)} while submitting the workflow${detail ? `: ${detail}` : ""}`);
  }
  const detail = errorText(payload);
  if (detail) throw comfyError(`Comfy Cloud rejected the workflow: ${detail}`);
  if (!payload || typeof payload.prompt_id !== "string" || !payload.prompt_id) {
    throw comfyError("Comfy Cloud accepted the workflow but returned no prompt_id");
  }
  return payload.prompt_id;
}

function pickVideo(outputs) {
  const found = [];
  for (const node of Object.values(outputs || {})) {
    if (!node) continue;
    for (const v of node.video || []) found.push(v);
    for (const v of node.videos || []) found.push(v);
    for (const f of [...(node.gifs || []), ...(node.images || [])]) {
      if (/\.mp4$/i.test((f && f.filename) || "")) found.push(f);
    }
  }
  if (!found.length) return null;
  return found.find((v) => /ltx|ia2v|video/i.test(`${v.subfolder || ""}/${v.filename}`)) || found[0];
}

function transientStatus(status) {
  return status === 429 || status >= 500;
}

async function pollJob(creds, promptId, { fetchFn, intervalMs, timeoutMs, isCancelled }) {
  const started = Date.now();
  let failures = 0;
  for (;;) {
    if (typeof isCancelled === "function" && isCancelled()) throw comfyError("Stopped", "ECANCEL");
    let job = null;
    try {
      const res = await request(fetchFn, `${creds.baseUrl}/api/jobs/${encodeURIComponent(promptId)}`, {
        headers: { "X-API-Key": creds.apiKey },
      }, `checking job ${promptId}`);
      if (res.status === 404) throw comfyError(`Comfy Cloud no longer has job ${promptId}`, "ENOJOB");
      if (!res.ok) {
        const err = comfyError(`${httpMessage(res.status)} while checking job ${promptId}`, transientStatus(res.status) ? "ETRANSIENT" : "ECOMFY");
        throw err;
      }
      job = (await res.json().catch(() => null)) || {};
      failures = 0;
    } catch (err) {
      if (err.code !== "ENETWORK" && err.code !== "ETRANSIENT") throw err;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw comfyError(`${err.message}. Gave up after ${failures} tries; job ${promptId} may still finish on Comfy Cloud, so Retry will pick it up instead of paying again.`, "ENETWORK");
      }
    }
    if (job) {
      const status = String(job.status || "unknown").toLowerCase();
      if (status === "failed" || status === "error" || status === "cancelled") {
        const exec = job.execution_error || {};
        const detail = exec.exception_message || exec.message || (typeof job.error === "string" && job.error) || status;
        throw comfyError(`Comfy Cloud job failed: ${detail}`, "EJOBFAILED");
      }
      if (status === "completed" || status === "success") {
        const video = pickVideo(job.outputs);
        if (!video) throw comfyError("Comfy Cloud finished the job but reported no video output", "EJOBFAILED");
        return video;
      }
      if (Date.now() - started + intervalMs >= timeoutMs) {
        throw comfyError(`Comfy Cloud job ${promptId} was still ${status} after ${Math.round(timeoutMs / 60000)} minutes. It may still finish on Comfy's side; Retry will pick it up.`, "ETIMEOUT");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, job ? intervalMs : Math.min(intervalMs * 4, 15000)));
  }
}

async function downloadOutput(creds, file, destPath, fetchFn) {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || "",
    type: file.type || "output",
  });
  let res = await request(fetchFn, `${creds.baseUrl}/api/view?${params}`, {
    headers: { "X-API-Key": creds.apiKey },
    redirect: "manual",
  }, "downloading the clip", TRANSFER_TIMEOUT_MS);
  if ([301, 302, 307, 308].includes(res.status)) {
    const location = res.headers.get("location");
    if (!location) throw comfyError("Comfy Cloud download redirect had no location");
    res = await request(fetchFn, location, {}, "downloading the clip from its signed URL", TRANSFER_TIMEOUT_MS);
  }
  if (!res.ok) throw comfyError(`Downloading the clip from Comfy Cloud returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * Run one LTX 2.3 IA2V render and write the mp4 to destPath.
 * imageBytes must already be 1280x720 (see padImageTo16x9 in shots.js).
 */
async function generateLtxVideo({ imageBytes, audioBytes, prompt, durationSec, destPath, onSubmitted, resumePromptId, options = {} }) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const creds = requireCredentials(options.env || process.env);
  let promptId = resumePromptId || "";
  if (!promptId) {
    const stamp = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const imageName = await uploadInput(creds, imageBytes, `engine_${stamp}.png`, "image/png", fetchFn);
    const audioName = await uploadInput(creds, audioBytes, `engine_${stamp}.wav`, "audio/wav", fetchFn);
    const workflow = buildWorkflow({ imageName, audioName, prompt, durationSec, negativePrompt: options.negativePrompt });
    if (typeof options.isCancelled === "function" && options.isCancelled()) throw comfyError("Stopped", "ECANCEL");
    promptId = await submitWorkflow(creds, workflow, fetchFn);
    if (typeof onSubmitted === "function") onSubmitted(promptId);
  }
  const file = await pollJob(creds, promptId, {
    fetchFn,
    intervalMs: Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    isCancelled: options.isCancelled,
  });
  await downloadOutput(creds, file, destPath, fetchFn);
  return { promptId };
}

module.exports = {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  NODE,
  resolveCredentials,
  buildWorkflow,
  pickVideo,
  generateLtxVideo,
};
