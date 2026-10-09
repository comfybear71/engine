"use strict";

/**
 * Credit-guard sidecar next to each generated WAV:
 *   audio/<scene>/<nnn>_<character>.wav.json
 *
 * Skip a line only when the WAV exists and the sidecar sha256 still matches
 * text + voice_id + model_id. Any change (or --force) re-records.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function fingerprint({ text, voiceId, modelId }) {
  const payload = `${text}\0${voiceId}\0${modelId}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function sidecarPathForWav(wavPath) {
  return `${wavPath}.json`;
}

function readSidecar(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  } catch {
    return null;
  }
}

function writeSidecar(sidecarPath, { text, voiceId, modelId, timestamp }) {
  const sha256 = fingerprint({ text, voiceId, modelId });
  const data = {
    sha256,
    text,
    voice_id: voiceId,
    model_id: modelId,
    timestamp: timestamp || new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2) + "\n");
  return data;
}

function shouldSkipLine({ wavPath, text, voiceId, modelId, force = false }) {
  if (force) return false;
  if (!wavPath || !fs.existsSync(wavPath)) return false;
  const sidecar = readSidecar(sidecarPathForWav(wavPath));
  if (!sidecar || typeof sidecar.sha256 !== "string") return false;
  return sidecar.sha256 === fingerprint({ text, voiceId, modelId });
}

module.exports = {
  fingerprint,
  sidecarPathForWav,
  readSidecar,
  writeSidecar,
  shouldSkipLine,
};
