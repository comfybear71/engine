"use strict";

/**
 * Long-lived Python compositor processes for Studio preview.
 * One process serves single frames (scrub). A second process renders
 * proxy segments so play buffering never blocks scrub.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

function makePool() {
  return { child: null, starting: null, nextId: 1, pending: new Map(), stdoutBuf: "" };
}

const framePool = makePool();
const segmentPool = makePool();

function rejectAll(pool, err) {
  for (const waiter of pool.pending.values()) waiter.reject(err);
  pool.pending.clear();
}

function handleLine(pool, line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pool.pending.get(msg.id);
  if (!waiter) return;
  pool.pending.delete(msg.id);
  if (msg.ok) waiter.resolve(msg);
  else waiter.reject(new Error(msg.error || "preview session failed"));
}

function attach(pool, proc) {
  pool.stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    pool.stdoutBuf += chunk.toString();
    let idx;
    while ((idx = pool.stdoutBuf.indexOf("\n")) >= 0) {
      const line = pool.stdoutBuf.slice(0, idx);
      pool.stdoutBuf = pool.stdoutBuf.slice(idx + 1);
      handleLine(pool, line);
    }
  });
  proc.stderr.on("data", () => {
    /* compositor logs stay quiet for preview */
  });
  proc.on("exit", () => {
    if (pool.child === proc) pool.child = null;
    rejectAll(pool, new Error("preview session exited"));
  });
  proc.on("error", (err) => {
    if (pool.child === proc) pool.child = null;
    rejectAll(pool, err);
  });
}

function spawnSession(options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return spawn(pythonBin, ["-m", "compositor.preview_server"], {
    cwd: PYTHON_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

async function ensurePool(pool, options = {}) {
  if (pool.child && !pool.child.killed) return pool.child;
  if (pool.starting) return pool.starting;
  pool.starting = new Promise((resolve, reject) => {
    try {
      const proc = spawnSession(options);
      attach(pool, proc);
      pool.child = proc;
      resolve(proc);
    } catch (err) {
      reject(err);
    } finally {
      pool.starting = null;
    }
  });
  return pool.starting;
}

function requestViaPool(pool, payload, options = {}) {
  return new Promise((resolve, reject) => {
    ensurePool(pool, options)
      .then((proc) => {
        const id = pool.nextId++;
        const timer = setTimeout(() => {
          pool.pending.delete(id);
          reject(new Error("preview session timed out"));
        }, options.timeoutMs || 60_000);
        pool.pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (err) => {
          if (err) {
            pool.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      })
      .catch(reject);
  });
}

function previewViaSession(projectDir, frame, outputPath, options = {}) {
  return requestViaPool(
    framePool,
    {
      projectDir: path.resolve(projectDir),
      timeline: options.timeline ? path.resolve(options.timeline) : null,
      frame,
      output: path.resolve(outputPath),
      format: options.format || "png",
      quality: options.quality || 85,
      width: options.width || null,
      height: options.height || null,
    },
    options
  );
}

function segmentViaSession(projectDir, options = {}) {
  return requestViaPool(
    segmentPool,
    {
      cmd: "segment",
      projectDir: path.resolve(projectDir),
      timeline: options.timeline ? path.resolve(options.timeline) : null,
      startFrame: options.startFrame || 0,
      frames: options.frames,
      output: path.resolve(options.output),
      progressPath: options.progressPath ? path.resolve(options.progressPath) : null,
      width: options.width || 960,
      height: options.height || 540,
    },
    { ...options, timeoutMs: options.timeoutMs || 10 * 60 * 1000 }
  );
}

function killPool(pool) {
  rejectAll(pool, new Error("preview session closed"));
  if (pool.child && !pool.child.killed) {
    try {
      pool.child.stdin.end();
      pool.child.kill();
    } catch {
      /* ignore */
    }
  }
  pool.child = null;
}

function closePreviewSession() {
  killPool(framePool);
  killPool(segmentPool);
}

module.exports = {
  previewViaSession,
  segmentViaSession,
  closePreviewSession,
  ensureSession: (options) => ensurePool(framePool, options),
};
