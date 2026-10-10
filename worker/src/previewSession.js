"use strict";

/**
 * One long-lived Python compositor process for Studio preview-frame.
 * Avoids re-importing numpy/cv2 on every scrub. Falls back to a one-shot
 * spawn when the session is unavailable.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

let child = null;
let starting = null;
let nextId = 1;
const pending = new Map();
let stdoutBuf = "";

function rejectAll(err) {
  for (const waiter of pending.values()) waiter.reject(err);
  pending.clear();
}

function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.ok) waiter.resolve(msg);
  else waiter.reject(new Error(msg.error || "preview session failed"));
}

function attach(proc) {
  stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });
  proc.stderr.on("data", () => {
    /* compositor logs stay quiet for preview */
  });
  proc.on("exit", () => {
    if (child === proc) child = null;
    rejectAll(new Error("preview session exited"));
  });
  proc.on("error", (err) => {
    if (child === proc) child = null;
    rejectAll(err);
  });
}

function spawnSession(options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  const proc = spawn(pythonBin, ["-m", "compositor.preview_server"], {
    cwd: PYTHON_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  attach(proc);
  return proc;
}

async function ensureSession(options = {}) {
  if (child && !child.killed) return child;
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    try {
      const proc = spawnSession(options);
      child = proc;
      resolve(proc);
    } catch (err) {
      reject(err);
    } finally {
      starting = null;
    }
  });
  return starting;
}

function previewViaSession(projectDir, frame, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    ensureSession(options)
      .then((proc) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("preview session timed out"));
        }, options.timeoutMs || 60_000);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        const payload = {
          id,
          projectDir: path.resolve(projectDir),
          timeline: options.timeline ? path.resolve(options.timeline) : null,
          frame,
          output: path.resolve(outputPath),
          format: options.format || "png",
          quality: options.quality || 85,
        };
        proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (err) {
            pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      })
      .catch(reject);
  });
}

function closePreviewSession() {
  rejectAll(new Error("preview session closed"));
  if (child && !child.killed) {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* ignore */
    }
  }
  child = null;
}

module.exports = { previewViaSession, closePreviewSession, ensureSession };
