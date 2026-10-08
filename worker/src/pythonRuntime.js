"use strict";

/**
 * Locates the Python interpreter to run the compositor with, preferring the
 * project's own venv (created per README.md / `python3 -m venv venv`) over
 * whatever `python`/`python3` happens to be on PATH, so renders always use
 * the pinned dependency versions in worker/python/requirements.txt.
 */

const fs = require("fs");
const path = require("path");

const PYTHON_DIR = path.resolve(__dirname, "..", "python");

function venvPythonCandidates() {
  return [
    path.join(PYTHON_DIR, "venv", "bin", "python3"),
    path.join(PYTHON_DIR, "venv", "bin", "python"),
    path.join(PYTHON_DIR, "venv", "Scripts", "python.exe"), // Windows
  ];
}

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }
  for (const candidate of venvPythonCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

module.exports = { resolvePythonBin, PYTHON_DIR };
