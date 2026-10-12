"use strict";

/**
 * Open a project-relative folder in the desktop file manager.
 * Used by the Assets factory "Open folder" button.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function openError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function openProjectRel(projectDir, rel) {
  const root = path.resolve(projectDir);
  const raw = String(rel || ".").replace(/\\/g, "/");
  if (raw.includes("..") || raw.startsWith("/")) throw openError("Invalid folder path");
  const abs = path.resolve(root, raw);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) throw openError("Invalid folder path");
  if (!fs.existsSync(abs)) throw openError("Folder not found", "ENOENT");
  const target = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const platform = process.platform;
  const child =
    platform === "win32"
      ? spawn("explorer", [target], { detached: true, stdio: "ignore" })
      : platform === "darwin"
        ? spawn("open", [target], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
  child.unref();
  return { ok: true, path: target };
}

module.exports = { openProjectRel };
