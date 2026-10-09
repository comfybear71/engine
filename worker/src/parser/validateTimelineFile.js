"use strict";

/**
 * Validates a timeline.json file by spawning the Python compositor's
 * validate-only entry point. This reuses the *exact* same JSON Schema
 * validator (and full semantic loader -- asset paths, audio probing,
 * lip-sync resolution) the real renderer uses, instead of maintaining a
 * second JSON Schema implementation on the Node side that could drift from
 * the Python one.
 */

const { spawn } = require("child_process");
const path = require("path");

const { resolvePythonBin, PYTHON_DIR } = require("../pythonRuntime");

function validateTimelineFile(timelinePath, options = {}) {
  return new Promise((resolve) => {
    const pythonBin = resolvePythonBin();
    const args = ["-m", "compositor.validate_cli", path.resolve(timelinePath)];
    if (options.projectDir) {
      args.push("--project-dir", path.resolve(options.projectDir));
    }
    const proc = spawn(pythonBin, args, {
      cwd: PYTHON_DIR,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("error", (err) => {
      resolve({ ok: false, message: `Failed to spawn Python validator (${pythonBin}): ${err.message}` });
    });

    proc.on("close", (code) => {
      resolve({ ok: code === 0, message: (stdout + stderr).trim() });
    });
  });
}

module.exports = { validateTimelineFile };
