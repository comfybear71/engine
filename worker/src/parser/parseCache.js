"use strict";

/**
 * In-process cache of parseProject results, keyed by project + script and
 * a mtime fingerprint of the script, library/character/staging json, and
 * audio files. Concurrent callers of the same key share one in-flight parse.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseProject, resolveGlobalAssetsDir, resolveShowAssetsDir } = require("./index");

const PARSE_INPUT = /\.(json|wav)$/i;
const SKIP_DIR_NAMES = new Set(["node_modules", "venv", ".venv", ".git", "__pycache__", "renders", ".history"]);

const cache = new Map();
const inflight = new Map();

function cacheKey(projectDir, scriptName) {
  return `${path.resolve(projectDir)}|${scriptName || "script.txt"}`;
}

function walkFingerprintFiles(dir, out, pred) {
  if (!dir || !fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (pred(dir)) out.push(dir);
    return;
  }
  if (!stat.isDirectory()) return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(child);
      } else if (entry.isFile() && pred(child)) {
        out.push(child);
      }
    }
  }
}

function collectParseInputFiles(projectDir, scriptName) {
  const files = [];
  const scriptPath = path.join(projectDir, scriptName);
  if (fs.existsSync(scriptPath)) files.push(scriptPath);
  const libraryPath = path.join(projectDir, "library.json");
  if (fs.existsSync(libraryPath)) files.push(libraryPath);

  const roots = [projectDir, resolveShowAssetsDir(projectDir), resolveGlobalAssetsDir(projectDir)].filter(Boolean);
  for (const root of roots) {
    walkFingerprintFiles(path.join(root, "characters"), files, (p) => PARSE_INPUT.test(p));
    walkFingerprintFiles(path.join(root, "backgrounds"), files, (p) => PARSE_INPUT.test(p));
    walkFingerprintFiles(path.join(root, "audio"), files, (p) => PARSE_INPUT.test(p));
    const defaults = path.join(root, "staging_defaults.json");
    if (fs.existsSync(defaults)) files.push(defaults);
  }
  return files;
}

function fingerprintParseInputs(projectDir, scriptName) {
  const files = collectParseInputFiles(projectDir, scriptName || "script.txt");
  files.sort();
  const parts = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      parts.push(`${file}\t${stat.mtimeMs}\t${stat.size}`);
    } catch {
      parts.push(`${file}\tmissing`);
    }
  }
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}

function fingerprintAssets(projectDir) {
  const files = [];
  const roots = [projectDir, resolveShowAssetsDir(projectDir), resolveGlobalAssetsDir(projectDir)].filter(Boolean);
  const pred = (p) => /\.(png|jpe?g|webp)$/i.test(p);
  for (const root of roots) {
    walkFingerprintFiles(path.join(root, "characters"), files, pred);
    walkFingerprintFiles(path.join(root, "backgrounds"), files, pred);
  }
  files.sort();
  const parts = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      parts.push(`${file}\t${stat.mtimeMs}\t${stat.size}`);
    } catch {
      parts.push(`${file}\tmissing`);
    }
  }
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}

function dropEntry(key) {
  const entry = cache.get(key);
  cache.delete(key);
  if (entry && entry.result && entry.result.tmpDir) {
    try {
      fs.rmSync(entry.result.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function parseFresh(projectDir, options, fingerprint) {
  const scriptName = options.script || "script.txt";
  const parsed = await parseProject(projectDir, options);
  const tmpDir = path.join(os.tmpdir(), "engine-parse-cache", fingerprint);
  fs.mkdirSync(tmpDir, { recursive: true });
  const timelinePath = path.join(tmpDir, "timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(parsed.timeline, null, 2) + "\n");
  return {
    timeline: parsed.timeline,
    lines: parsed.lines,
    warnings: parsed.warnings,
    errors: parsed.errors || [],
    laneEvents: parsed.laneEvents || [],
    sceneLengths: parsed.sceneLengths || [],
    timelinePath,
    tmpDir,
    validation: { ok: true, message: "(validation skipped)" },
    cached: true,
    fingerprint,
    scriptName,
  };
}

async function getCachedParse(projectDir, options = {}) {
  if (options.scriptText != null) {
    const { parseProjectToTemp } = require("./index");
    return parseProjectToTemp(projectDir, { ...options, skipValidate: true });
  }

  const scriptName = options.script || "script.txt";
  const key = cacheKey(projectDir, scriptName);
  const fingerprint = fingerprintParseInputs(projectDir, scriptName);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.result;

  if (inflight.has(key)) {
    const pending = await inflight.get(key);
    if (pending && pending.result && pending.fingerprint === fingerprintParseInputs(projectDir, scriptName)) {
      return pending.result;
    }
  }

  if (hit) dropEntry(key);

  let resolveInflight;
  const gate = new Promise((resolve) => {
    resolveInflight = resolve;
  });
  inflight.set(key, gate);
  try {
    const result = await parseFresh(projectDir, options, fingerprint);
    const entry = { fingerprint, result };
    cache.set(key, entry);
    resolveInflight(entry);
    return result;
  } catch (err) {
    resolveInflight({ fingerprint: "", result: null });
    throw err;
  } finally {
    if (inflight.get(key) === gate) inflight.delete(key);
  }
}

function resetParseCache() {
  for (const key of [...cache.keys()]) dropEntry(key);
  inflight.clear();
}

module.exports = {
  getCachedParse,
  resetParseCache,
  fingerprintParseInputs,
  fingerprintAssets,
  collectParseInputFiles,
};
