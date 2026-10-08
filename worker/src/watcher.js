"use strict";

/**
 * Optional chokidar-based watcher: re-renders a project whenever the file
 * that drives it changes. With `fromScript`, that's script.txt (re-parsed
 * into timeline.json, then rendered); otherwise it's timeline.json directly
 * (e.g. hand-edited, or written by a future Studio app).
 */

const path = require("path");
const chokidar = require("chokidar");

const { renderProject } = require("./render");
const { parseProjectToFiles } = require("./parser");

/**
 * @param {string} projectDir
 * @param {{codec?: string, output?: string, fromScript?: boolean, script?: string}} [options]
 */
function watchProject(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const watchedPath = options.fromScript
    ? path.join(resolvedProjectDir, options.script || "script.txt")
    : path.join(resolvedProjectDir, "timeline.json");

  let rendering = false;
  let pending = false;

  const triggerRender = async () => {
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    console.log(`[watch] ${path.basename(watchedPath)} changed, rendering ${resolvedProjectDir} ...`);
    try {
      if (options.fromScript) {
        const result = await parseProjectToFiles(resolvedProjectDir, { script: options.script });
        for (const w of result.warnings) console.warn(`[watch] warning: ${w}`);
        if (!result.validation.ok) {
          throw new Error(`timeline.json failed validation after parsing:\n${result.validation.message}`);
        }
      }
      await renderProject(resolvedProjectDir, { codec: options.codec, output: options.output });
      console.log("[watch] render complete.");
    } catch (err) {
      console.error(`[watch] render failed: ${err.message}`);
    } finally {
      rendering = false;
      if (pending) {
        pending = false;
        triggerRender();
      }
    }
  };

  const watcher = chokidar.watch(watchedPath, { ignoreInitial: false });
  watcher.on("add", triggerRender);
  watcher.on("change", triggerRender);

  console.log(`[watch] watching ${watchedPath} for changes (Ctrl+C to stop)`);
  return watcher;
}

module.exports = { watchProject };
