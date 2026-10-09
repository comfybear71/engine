"use strict";

/**
 * Spawns the Python compositor (`python -m compositor <projectDir>`) as a
 * child process. This is the entire job of the Node orchestrator for a
 * single render: Node does no image/video work itself, it just shells out.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

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

/**
 * @param {string} projectDir Absolute or cwd-relative path to a project
 *   folder containing timeline.json.
 * @param {{codec?: string, output?: string, pythonBin?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, estimatedSilent: {estimated: number, total: number, message: string}|null}>}
 */
function renderProject(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const pythonBin = options.pythonBin || resolvePythonBin();
  const args = ["-m", "compositor", resolvedProjectDir];

  if (options.codec) {
    args.push("--codec", options.codec);
  }
  if (options.output) {
    args.push("--output", path.resolve(options.output));
  }

  return new Promise((resolve, reject) => {
    const chunks = { stdout: "", stderr: "" };
    let settled = false;
    const child = spawn(pythonBin, args, {
      cwd: PYTHON_DIR, // so `python -m compositor` resolves the package
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (d) => {
      const s = d.toString();
      chunks.stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      chunks.stderr += s;
      process.stderr.write(s);
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
      const estimatedSilent = parseEstimatedSilent(chunks.stdout + "\n" + chunks.stderr);
      if (code === 0) {
        resolve({ code, stdout: chunks.stdout, stderr: chunks.stderr, estimatedSilent });
      } else {
        reject(new Error(`Python compositor exited with code ${code}`));
      }
    });
  });
}

module.exports = { renderProject, parseEstimatedSilent };
