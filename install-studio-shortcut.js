#!/usr/bin/env node
"use strict";

/**
 * Writes a Windows .lnk for Engine Studio (desktop or Startup folder).
 * Called by the double-clickable .bat helpers — Stuart does not type this.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function targetFolder(kind) {
  if (kind === "startup") {
    return path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  return path.join(os.homedir(), "Desktop");
}

function createShortcut(kind) {
  if (process.platform !== "win32") {
    console.error("This shortcut helper is for Windows.");
    return 1;
  }
  const root = path.resolve(__dirname);
  const bat = path.join(root, "start-studio.bat");
  if (!fs.existsSync(bat)) {
    console.error("start-studio.bat is missing. Engine Studio isn't installed completely.");
    return 1;
  }
  const folder = targetFolder(kind);
  if (!folder || !fs.existsSync(folder)) {
    console.error("Couldn't find the Desktop or Startup folder on this PC.");
    return 1;
  }
  const linkPath = path.join(folder, "Engine Studio.lnk");
  const vbsPath = path.join(os.tmpdir(), `engine-studio-shortcut-${process.pid}.vbs`);
  const vbs = [
    'Set oWS = WScript.CreateObject("WScript.Shell")',
    `sLinkFile = "${linkPath.replace(/\\/g, "\\\\")}"`,
    "Set oLink = oWS.CreateShortcut(sLinkFile)",
    `oLink.TargetPath = "${bat.replace(/\\/g, "\\\\")}"`,
    `oLink.WorkingDirectory = "${root.replace(/\\/g, "\\\\")}"`,
    "oLink.WindowStyle = 7",
    'oLink.Description = "Engine Studio"',
    "oLink.Save",
    "",
  ].join("\r\n");
  fs.writeFileSync(vbsPath, vbs);
  const result = spawnSync("cscript", ["//nologo", vbsPath], { windowsHide: true });
  try {
    fs.unlinkSync(vbsPath);
  } catch {
    /* ignore */
  }
  if (result.status !== 0) {
    console.error("Couldn't create the shortcut.");
    return 1;
  }
  if (kind === "startup") {
    console.log("Engine Studio will start when you sign in to Windows (minimised).");
  } else {
    console.log("Created an Engine Studio shortcut on your desktop.");
  }
  return 0;
}

if (require.main === module) {
  const kind = process.argv[2] === "startup" ? "startup" : "desktop";
  process.exitCode = createShortcut(kind);
}

module.exports = { createShortcut, targetFolder };
