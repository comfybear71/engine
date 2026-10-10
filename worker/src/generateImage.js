"use strict";

/**
 * xAI Grok Imagine image generation for Studio.
 * Bearer XAI_API_KEY is sent only as an Authorization header — never
 * interpolated into a URL, a log line, or an error message.
 */

const fs = require("fs");
const path = require("path");

const { resolveAsset } = require("./parser/assetLibrary");
const { listCharacters } = require("./studioLibrary");
const { isSafeFolderName } = require("./studioProjects");
const { characterDir } = require("./characterLocal");
const { getNeed, expandNeed, fillNeedPrompt } = require("./assetNeeds");
const {
  packForCharacter,
  getPackSet,
  fillPackPrompt,
} = require("./promptPacks");

const DEFAULT_MODEL = "grok-imagine-image-2.0";
const GENERATIONS_URL = "https://api.x.ai/v1/images/generations";
const EDITS_URL = "https://api.x.ai/v1/images/edits";
const USD_TICKS_PER_DOLLAR = 10_000_000_000;
const MAX_N = 10;
const MAX_ERROR_BODY_CHARS = 240;
const GENERIC_CREDIT_NOTE = "This uses xAI credits.";

// Published 1K · Low output price for grok-imagine-image-2.0 (docs.x.ai/developers/pricing).
// Auto quality is currently low for generation and medium for edits.
const PRICING = {
  "grok-imagine-image-2.0": {
    outputLow: 0.04,
    outputMedium: 0.06,
    inputImage: 0.01,
  },
};

class GenerateImageError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "GenerateImageError";
    this.code = code || "EINVAL";
    this.status = status || null;
  }
}

function resolveApiKey(env = process.env) {
  return (env.XAI_API_KEY || "").trim();
}

function resolveModelId(env = process.env) {
  return (env.XAI_IMAGE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function clampN(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_N, n);
}

function truncateBody(text) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
}

function dollarsFromTicks(ticks) {
  const n = Number(ticks);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / USD_TICKS_PER_DOLLAR;
}

function formatDollars(amount) {
  if (amount == null || !Number.isFinite(amount)) return null;
  return `$${amount.toFixed(amount >= 1 ? 2 : 3)}`;
}

function estimateCost({ model, n, referenceCount, useEdits }) {
  const table = PRICING[model];
  if (!table) return null;
  const outputEach = useEdits ? table.outputMedium : table.outputLow;
  const refs = useEdits ? Math.max(0, Number(referenceCount) || 0) : 0;
  return n * outputEach + refs * table.inputImage;
}

function creditNote({ model, n, referenceCount, useEdits, estimatedCost }) {
  const table = PRICING[model];
  if (!table || estimatedCost == null) {
    return `${GENERIC_CREDIT_NOTE} ${n} image${n === 1 ? "" : "s"} with ${model}.`;
  }
  const kind = useEdits ? "image edit" : "image";
  const refs =
    useEdits && referenceCount > 0
      ? ` ${referenceCount} reference image${referenceCount === 1 ? "" : "s"} attached (about ${formatDollars(table.inputImage)} each).`
      : "";
  return (
    `${GENERIC_CREDIT_NOTE} About ${formatDollars(useEdits ? table.outputMedium : table.outputLow)} per ${kind} ` +
    `at 1K (${useEdits ? "medium" : "low"}). ${n} variant${n === 1 ? "" : "s"} ≈ ${formatDollars(estimatedCost)}.` +
    refs
  );
}

function explainXaiStatus(status, bodyText) {
  const lower = String(bodyText || "").toLowerCase();
  if (status === 401) {
    return "xAI rejected the API key. Open Settings and paste a valid key, or check XAI_API_KEY in the engine .env file.";
  }
  if (status === 402 || /quota|out of credits|payment_required|insufficient/.test(lower)) {
    return "xAI credits are used up. Add credits on the xAI console, then try again.";
  }
  if (status === 429 || /rate.?limit/.test(lower)) {
    return "xAI rate limit — wait a minute and try again.";
  }
  if (
    status === 400 &&
    /content.?polic|refus|moderat|safety|prohibited|not.?allowed/.test(lower)
  ) {
    return "xAI refused this prompt (content policy). Change the prompt and try again.";
  }
  if (/content.?polic|refus|moderat|safety|prohibited/.test(lower)) {
    return "xAI refused this prompt (content policy). Change the prompt and try again.";
  }
  const excerpt = truncateBody(bodyText);
  return `xAI image request failed (${status}).${excerpt ? ` ${excerpt}` : ""}`;
}

function mimeFromBuffer(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

function extForMime(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

function dataUrlFor(buf, mime) {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function posixJoin(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/");
}

function collectReferences(projectDir, globalAssetsDir, character) {
  const refs = [];
  const seen = new Set();
  const add = (kind, rel) => {
    if (!rel || seen.has(rel)) return;
    const resolved = resolveAsset(projectDir, globalAssetsDir, rel);
    if (!resolved) return;
    seen.add(rel);
    const buf = fs.readFileSync(resolved.absPath);
    if (buf.length < 8) return;
    const mime = mimeFromBuffer(buf);
    refs.push({ kind, rel, mime, dataUrl: dataUrlFor(buf, mime) });
  };
  add("reference", character.referenceRel);
  add("body", character.bodyRel);
  return refs;
}

function resolvePrompt({ character, needId, prompt, frames }) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (trimmed) return trimmed;

  const pack = packForCharacter(character);
  const found = getPackSet(needId);
  if (pack && found && found.pack.id === pack.id) {
    return fillPackPrompt(found.set, {
      styleBlock: pack.styleBlock,
      name: character.display_name || character.id,
    });
  }

  const need = getNeed(needId);
  if (!need) {
    throw new GenerateImageError("Unknown set or need", "EINVAL");
  }
  return fillNeedPrompt(need, {
    name: character.display_name || character.id,
    style: character.style,
    frames,
  });
}

function attachReferenceSentence(prompt, references) {
  if (!references.length) return prompt;
  const labels = references.map((ref, index) => {
    const tag = `<IMAGE_${index}>`;
    return ref.kind === "reference"
      ? `${tag} is the full-body likeness`
      : `${tag} is the production body`;
  });
  return (
    `${prompt} Match the attached reference image${references.length === 1 ? "" : "s"} ` +
    `for likeness, costume, proportions, pose, and crop. ${labels.join("; ")}.`
  );
}

function aspectRatioForNeed(needId) {
  const need = getNeed(needId);
  if (need && need.id === "background") return "16:9";
  return "1:1";
}

async function callXai({ url, apiKey, body, fetchFn }) {
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GenerateImageError("No fetch implementation available (Node 18+ is required).", "EFATAL");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GenerateImageError(
      `Could not reach xAI (${err.message || "network error"}). Check this PC is online.`,
      "ENETWORK"
    );
  }

  const text = await response.text().catch(() => "");
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const message = explainXaiStatus(response.status, text);
    const code = response.status === 401 ? "EAUTH" : response.status === 429 ? "ERATE" : "EXAI";
    throw new GenerateImageError(message, code, response.status);
  }
  return json || {};
}

function decodeGeneratedImage(item) {
  if (item && typeof item.b64_json === "string" && item.b64_json) {
    const buf = Buffer.from(item.b64_json, "base64");
    if (buf.length < 8) throw new GenerateImageError("xAI returned an empty image", "EXAI");
    const mime = item.mime_type || mimeFromBuffer(buf);
    return { buf, mime, url: item.url || null };
  }
  return null;
}

async function downloadImage(url, fetchFn) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new GenerateImageError("Could not download the generated image from xAI.", "EXAI");
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 8) throw new GenerateImageError("xAI returned an empty image", "EXAI");
  const mime = mimeFromBuffer(buf);
  return { buf, mime, url };
}

function saveLibrarySheet(projectDir, characterId, needId, index, buf, mime) {
  const libDir = path.join(characterDir(projectDir, characterId), "_library");
  fs.mkdirSync(libDir, { recursive: true });
  const ext = extForMime(mime);
  const filename = `${stamp()}_${needId}_${index}${ext}`;
  const rel = posixJoin("characters", characterId, "_library", filename);
  const abs = path.join(projectDir, rel);
  fs.writeFileSync(abs, buf);
  return rel;
}

function findCharacter(projectDir, globalAssetsDir, characterId) {
  if (!isSafeFolderName(characterId)) {
    throw new GenerateImageError("Invalid character id", "EINVAL");
  }
  const characters = listCharacters(projectDir, globalAssetsDir);
  const character = characters.find((item) => item.id === characterId);
  if (!character) {
    throw new GenerateImageError(`Unknown character: ${characterId}`, "ENOTFOUND");
  }
  return character;
}

function dryRunResult({
  character,
  needId,
  prompt,
  n,
  model,
  references,
  keyConfigured,
}) {
  const useEdits = references.length > 0;
  const estimatedCost = estimateCost({
    model,
    n,
    referenceCount: references.length,
    useEdits,
  });
  return {
    ok: true,
    dryRun: true,
    model,
    n,
    needId,
    prompt,
    keyConfigured,
    references: references.map((ref) => ({ kind: ref.kind, rel: ref.rel })),
    estimatedCost,
    estimatedCostLabel: formatDollars(estimatedCost),
    creditNote: creditNote({
      model,
      n,
      referenceCount: references.length,
      useEdits,
      estimatedCost,
    }),
    characterId: character.id,
  };
}

async function generateProjectImage(projectDir, globalAssetsDir, body, options = {}) {
  const env = options.env || process.env;
  const characterId = body && body.characterId;
  const needId = (body && (body.needId || body.setId)) || "";
  if (!needId) throw new GenerateImageError("needId is required", "EINVAL");

  const character = findCharacter(projectDir, globalAssetsDir, characterId);
  const n = clampN(body && body.n);
  const model = resolveModelId(env);
  const need = getNeed(needId);
  if (!need) throw new GenerateImageError("Unknown set or need", "EINVAL");
  expandNeed(need, body && body.frames);

  const references = collectReferences(projectDir, globalAssetsDir, character);
  const built = resolvePrompt({
    character,
    needId,
    prompt: body && body.prompt,
    frames: body && body.frames,
  });
  const prompt = attachReferenceSentence(built, references);
  const key = resolveApiKey(env);
  const keyConfigured = Boolean(key);

  if (body && body.dryRun) {
    return dryRunResult({ character, needId, prompt, n, model, references, keyConfigured });
  }

  if (!key) {
    throw new GenerateImageError(
      "The xAI API key is missing. Open Settings and paste your key, or add XAI_API_KEY to the engine .env file.",
      "EAUTH",
      400
    );
  }

  const useEdits = references.length > 0;
  const payload = {
    model,
    prompt,
    n,
    response_format: "b64_json",
    aspect_ratio: aspectRatioForNeed(needId),
  };
  let url = GENERATIONS_URL;
  if (useEdits) {
    url = EDITS_URL;
    if (references.length === 1) {
      payload.image = { url: references[0].dataUrl, type: "image_url" };
    } else {
      payload.images = references.map((ref) => ({ url: ref.dataUrl, type: "image_url" }));
    }
  }

  const json = await callXai({
    url,
    apiKey: key,
    body: payload,
    fetchFn: options.fetchFn,
  });

  const rows = Array.isArray(json.data) ? json.data : [];
  if (rows.length === 0) {
    throw new GenerateImageError("xAI returned no images.", "EXAI");
  }

  const images = [];
  for (let i = 0; i < rows.length; i += 1) {
    let decoded = decodeGeneratedImage(rows[i]);
    if (!decoded && rows[i] && rows[i].url) {
      decoded = await downloadImage(rows[i].url, options.fetchFn);
    }
    if (!decoded) {
      throw new GenerateImageError("xAI returned an image we could not read.", "EXAI");
    }
    const libraryRel = saveLibrarySheet(projectDir, character.id, needId, i + 1, decoded.buf, decoded.mime);
    images.push({
      index: i,
      url: decoded.url,
      mimeType: decoded.mime,
      libraryRel,
      imageBase64: dataUrlFor(decoded.buf, decoded.mime),
    });
  }

  const usageCost = json.usage ? dollarsFromTicks(json.usage.cost_in_usd_ticks) : null;
  const estimatedCost = estimateCost({
    model,
    n: images.length,
    referenceCount: references.length,
    useEdits,
  });

  return {
    ok: true,
    dryRun: false,
    model: json.model || model,
    n: images.length,
    needId,
    prompt,
    keyConfigured: true,
    references: references.map((ref) => ({ kind: ref.kind, rel: ref.rel })),
    estimatedCost,
    estimatedCostLabel: formatDollars(usageCost != null ? usageCost : estimatedCost),
    cost: usageCost,
    creditNote: creditNote({
      model,
      n: images.length,
      referenceCount: references.length,
      useEdits,
      estimatedCost: usageCost != null ? usageCost : estimatedCost,
    }),
    images,
    characterId: character.id,
  };
}

module.exports = {
  GenerateImageError,
  DEFAULT_MODEL,
  GENERATIONS_URL,
  EDITS_URL,
  GENERIC_CREDIT_NOTE,
  resolveApiKey,
  resolveModelId,
  clampN,
  estimateCost,
  creditNote,
  explainXaiStatus,
  dollarsFromTicks,
  formatDollars,
  generateProjectImage,
  attachReferenceSentence,
  resolvePrompt,
};
