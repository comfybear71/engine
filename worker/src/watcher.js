"use strict";

/**
 * Optional chokidar-based watcher: re-renders a project whenever its
 * timeline.json changes. Intended for local iteration while the Studio
 * (or a hand-edit) rewrites timeline.json.
 */

const path = require("path");
const chokidar = require("chokidar");

const { renderProject } = require("./render");

/**
 * @param {string} projectDir
 * @param {{codec?: string, output?: string}} [options]
 */
function watchProject(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const timelinePath = path.join(resolvedProjectDir, "timeline.json");

  let rendering = false;
  let pending = false;

  const triggerRender = async () => {
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    console.log(`[watch] timeline.json changed, rendering ${resolvedProjectDir} ...`);
    try {
      await renderProject(resolvedProjectDir, options);
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

  const watcher = chokidar.watch(timelinePath, { ignoreInitial: false });
  watcher.on("add", triggerRender);
  watcher.on("change", triggerRender);

  console.log(`[watch] watching ${timelinePath} for changes (Ctrl+C to stop)`);
  return watcher;
}

module.exports = { watchProject };
