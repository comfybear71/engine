"use strict";

/**
 * Spawns the Python compositor (`python -m compositor <projectDir>`) as a
 * child process. This is the entire job of the Node orchestrator for a
 * single render: Node does no image/video work itself, it just shells out.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { previewViaSession } = require("./previewSession");

const ESTIMATED_SILENT_RE = /(\d+) of (\d+) lines are estimated\/silent/;

function parseEstimatedSilent(text) {
  const match = String(text || "").match(ESTIMATED_SILENT_RE);
  if (!match) return null;
  return {
    estimated: Number(match[1]),
    total: Number(match[2]),
    message: match[0],
  };
}

function spawnCompositor(projectDir, extraArgs, options = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = ["-m", "compositor", resolvedProjectDir, ...extraArgs];
  const echo = options.echo !== false;

  return new Promise((resolve, reject) => {
    const chunks = { stdout: "", stderr: "" };
    let settled = false;
    const child = spawn(pythonBin, args, {
      cwd: PYTHON_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (d) => {
      const s = d.toString();
      chunks.stdout += s;
      if (echo) process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      chunks.stderr += s;
      if (echo) process.stderr.write(s);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Failed to spawn Python compositor (${pythonBin}): ${err.message}. ` +
            "Did you create worker/python/venv and install requirements.txt? See README.md."
        )
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const estimatedSilent = parseEstimatedSilent(`${chunks.stdout}\n${chunks.stderr}`);
      const result = {
        code,
        stdout: chunks.stdout,
        stderr: chunks.stderr,
        estimatedSilent,
      };
      if (code === 0) {
        resolve(result);
      } else {
        const detail = (chunks.stderr || chunks.stdout).trim().split("\n").pop() || `exited with code ${code}`;
        const err = new Error(`Python compositor exited with code ${code}: ${detail}`);
        err.result = result;
        reject(err);
      }
    });
  });
}

/**
 * @param {string} projectDir Absolute or cwd-relative path to a project
 *   folder containing timeline.json.
 * @param {{codec?: string, output?: string, pythonBin?: string}} [options]
 */
function renderProject(projectDir, options = {}) {
  const extra = [];
  if (options.timeline) extra.push("--timeline", path.resolve(options.timeline));
  if (options.codec) extra.push("--codec", options.codec);
  if (options.output) extra.push("--output", path.resolve(options.output));
  if (options.width) extra.push("--width", String(options.width));
  if (options.height) extra.push("--height", String(options.height));
  return spawnCompositor(projectDir, extra, options);
}

/**
 * Compose one global frame to a PNG using the existing compositor.
 * @param {string} projectDir
 * @param {number} frame
 * @param {string} outputPath
 * @param {{pythonBin?: string}} [options]
 */
async function previewFrame(projectDir, frame, outputPath, options = {}) {
  const format = options.format === "jpeg" || options.format === "jpg" ? "jpeg" : "png";
  const quality = options.quality || 85;
  if (options.persistent !== false) {
    try {
      const msg = await previewViaSession(projectDir, frame, outputPath, {
        ...options,
        format,
        quality,
        width: options.width,
        height: options.height,
      });
      return {
        code: 0,
        stdout: JSON.stringify(msg),
        stderr: "",
        estimatedSilent: null,
        meta: msg,
      };
    } catch {
      /* fall through to a one-shot spawn */
    }
  }
  const extra = [];
  if (options.timeline) extra.push("--timeline", path.resolve(options.timeline));
  extra.push("--preview-frame", String(frame), "--output", path.resolve(outputPath));
  extra.push("--format", format);
  if (format === "jpeg") extra.push("--jpeg-quality", String(quality));
  const result = await spawnCompositor(projectDir, extra, { ...options, echo: false });
  let meta = null;
  const trimmed = result.stdout.trim();
  if (trimmed) {
    try {
      meta = JSON.parse(trimmed.split("\n").pop());
    } catch {
      meta = null;
    }
  }
  return { ...result, meta };
}

module.exports = { renderProject, previewFrame, parseEstimatedSilent };
