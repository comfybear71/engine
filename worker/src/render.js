"use strict";

/**
 * Spawns the Python compositor (`python -m compositor <projectDir>`) as a
 * child process. This is the entire job of the Node orchestrator for a
 * single render: Node does no image/video work itself, it just shells out.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");

/**
 * @param {string} projectDir Absolute or cwd-relative path to a project
 *   folder containing timeline.json.
 * @param {{codec?: string, output?: string, pythonBin?: string}} [options]
 * @returns {Promise<{code: number}>}
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
    const child = spawn(pythonBin, args, {
      cwd: PYTHON_DIR, // so `python -m compositor` resolves the package
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn Python compositor (${pythonBin}): ${err.message}. ` +
            "Did you create worker/python/venv and install requirements.txt? See README.md."
        )
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code });
      } else {
        reject(new Error(`Python compositor exited with code ${code}`));
      }
    });
  });
}

module.exports = { renderProject };
