"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseScript } = require("./scriptParser");
const { validateTimelineFile } = require("./validateTimelineFile");
const { ScriptError } = require("./errors");

const DEFAULT_GLOBAL_ASSETS_DIR_NAME = "_global_assets";

function resolveGlobalAssetsDir(projectDir) {
  // projects/<name>/ -> projects/_global_assets/
  return path.join(path.dirname(projectDir), DEFAULT_GLOBAL_ASSETS_DIR_NAME);
}

/**
 * Parses `<projectDir>/<scriptFilename>` into a timeline.json object + a
 * lines.json manifest. Does not write anything to disk -- see
 * `parseProjectToFiles` for that.
 */
async function parseProject(projectDir, options = {}) {
  const scriptFilename = options.script || "script.txt";
  const scriptPath = path.join(projectDir, scriptFilename);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const globalAssetsDir = options.globalAssetsDir || resolveGlobalAssetsDir(projectDir);

  return parseScript(projectDir, globalAssetsDir, scriptText, options);
}

/**
 * Parses the project's script and writes timeline.json + lines.json, then
 * validates the written timeline.json (schema + full load) via the Python
 * validator. Returns the same shape as `parseProject` plus the output paths
 * and validation result.
 */
async function parseProjectToFiles(projectDir, options = {}) {
  const { timeline, lines, warnings, errors } = await parseProject(projectDir, options);

  const outFilename = options.out || "timeline.json";
  const timelinePath = path.join(projectDir, outFilename);
  const linesPath = path.join(projectDir, "lines.json");

  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2) + "\n");
  fs.writeFileSync(linesPath, JSON.stringify({ lines }, null, 2) + "\n");

  const validation = options.skipValidate ? { ok: true, message: "(validation skipped)" } : await validateTimelineFile(timelinePath);

  return { timeline, lines, warnings, errors: errors || [], timelinePath, linesPath, validation };
}

/**
 * Parse the script into a throwaway timeline file under os.tmpdir().
 * Never writes the project's timeline.json or lines.json -- Studio
 * preview / stage must use this. Caller must delete `tmpDir` when done.
 */
async function parseProjectToTemp(projectDir, options = {}) {
  const { timeline, lines, warnings, errors } = await parseProject(projectDir, options);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-timeline-"));
  const timelinePath = path.join(tmpDir, "timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2) + "\n");

  const validation = options.skipValidate
    ? { ok: true, message: "(validation skipped)" }
    : await validateTimelineFile(timelinePath, { projectDir });

  return { timeline, lines, warnings, errors: errors || [], timelinePath, tmpDir, validation };
}

module.exports = { parseProject, parseProjectToFiles, parseProjectToTemp, resolveGlobalAssetsDir, ScriptError };
