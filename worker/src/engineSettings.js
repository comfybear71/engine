"use strict";

/**
 * Engine-wide settings stored in the repo-root .env (same file dotenv
 * loads for ELEVENLABS_API_KEY). The xAI key is written here so Studio
 * can set it once. The value is never returned to the browser and must
 * never be logged.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_ENV_PATH = path.resolve(__dirname, "..", "..", ".env");
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function defaultEnvPath() {
  return DEFAULT_ENV_PATH;
}

function resolveEnvPath(options = {}) {
  if (options.envPath) return path.resolve(options.envPath);
  return DEFAULT_ENV_PATH;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function upsertEnvVar(filePath, key, value) {
  if (!ENV_KEY.test(key)) {
    const err = new Error("Invalid settings key");
    err.code = "EINVAL";
    throw err;
  }
  if (typeof value !== "string" || !value.trim()) {
    const err = new Error("Value is empty");
    err.code = "EINVAL";
    throw err;
  }
  const trimmed = value.trim();
  let text = readEnvFile(filePath);
  const line = `${key}=${trimmed}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text && !text.endsWith("\n")) text += "\n";
    if (text) text += "\n";
    text += `${line}\n`;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
  process.env[key] = trimmed;
  return filePath;
}

function saveXaiApiKey(apiKey, options = {}) {
  const filePath = resolveEnvPath(options);
  upsertEnvVar(filePath, "XAI_API_KEY", apiKey);
  return { ok: true, xaiKeyConfigured: true };
}

function describeEngineSettings(env = process.env, options = {}) {
  const key = typeof env.XAI_API_KEY === "string" ? env.XAI_API_KEY.trim() : "";
  return {
    xaiKeyConfigured: Boolean(key),
    xaiImageModel: env.XAI_IMAGE_MODEL || "grok-imagine-image-2.0",
    envPath: resolveEnvPath(options),
  };
}

module.exports = {
  DEFAULT_ENV_PATH,
  defaultEnvPath,
  resolveEnvPath,
  upsertEnvVar,
  saveXaiApiKey,
  describeEngineSettings,
};
