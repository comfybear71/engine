"use strict";

/**
 * Stream a zip of a project folder (scripts, audio, renders, local
 * assets, library.json, and the rest of the folder). Skips node/venv/temp.
 */

const path = require("path");
const archiver = require("archiver");

const ZIP_IGNORE = [
  "**/node_modules/**",
  "node_modules/**",
  "**/venv/**",
  "venv/**",
  "**/.venv/**",
  ".venv/**",
  "**/tmp/**",
  "tmp/**",
  "**/temp/**",
  "temp/**",
  "**/__pycache__/**",
  "__pycache__/**",
  "**/.git/**",
  ".git/**",
];

function streamProjectZip(projectDir, projectName, res) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const filename = `${projectName}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  archive.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.destroy(err);
    }
  });
  archive.pipe(res);
  archive.glob("**/*", {
    cwd: projectDir,
    ignore: ZIP_IGNORE,
    dot: false,
  });
  return archive.finalize();
}

module.exports = { streamProjectZip, ZIP_IGNORE };
