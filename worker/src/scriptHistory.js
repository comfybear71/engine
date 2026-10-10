"use strict";

/**
 * Timestamped snapshots of script files written from Studio.
 * Stored at projects/<p>/.history/<script>/<ISO-timestamp>.txt
 * so an accidental delete or overwrite can be restored.
 */

const fs = require("fs");
const path = require("path");

const HISTORY_DIR_NAME = ".history";
const MAX_SNAPSHOTS = 200;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SAFE_SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z$/;

function historyRoot(projectDir) {
  return path.join(projectDir, HISTORY_DIR_NAME);
}

function historyDirForScript(projectDir, scriptName) {
  return path.join(historyRoot(projectDir), path.basename(scriptName));
}

function snapshotIdFromDate(date = new Date()) {
  return date.toISOString().replace(/:/g, "-");
}

function createdAtFromId(id) {
  const restored = String(id).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const ms = Date.parse(restored);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isSafeSnapshotId(id) {
  return typeof id === "string" && SAFE_SNAPSHOT_ID.test(id);
}

function listSnapshotFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".txt") && isSafeSnapshotId(name.slice(0, -4)))
    .map((name) => {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      return {
        id: name.slice(0, -4),
        name,
        abs,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
}

function pruneSnapshots(dir) {
  const files = listSnapshotFiles(dir);
  const now = Date.now();
  for (let i = 0; i < files.length; i++) {
    const tooMany = i >= MAX_SNAPSHOTS;
    const tooOld = now - files[i].mtimeMs > MAX_AGE_MS;
    if (tooMany || tooOld) {
      try {
        fs.unlinkSync(files[i].abs);
      } catch {
        /* ignore missing */
      }
    }
  }
}

function snapshotScriptWrite(projectDir, scriptName, nextText) {
  if (!projectDir || !scriptName) return null;
  const scriptPath = path.join(projectDir, scriptName);
  let current = null;
  if (fs.existsSync(scriptPath)) {
    current = fs.readFileSync(scriptPath, "utf8");
  }
  if (current == null) return null;
  if (current === nextText) return null;

  const dir = historyDirForScript(projectDir, scriptName);
  fs.mkdirSync(dir, { recursive: true });
  const latest = listSnapshotFiles(dir)[0];
  if (latest) {
    try {
      if (fs.readFileSync(latest.abs, "utf8") === current) {
        pruneSnapshots(dir);
        return { skipped: true, id: latest.id };
      }
    } catch {
      /* write a fresh snapshot */
    }
  }

  let id = snapshotIdFromDate();
  let dest = path.join(dir, `${id}.txt`);
  if (fs.existsSync(dest)) {
    id = snapshotIdFromDate(new Date(Date.now() + 1));
    dest = path.join(dir, `${id}.txt`);
  }
  fs.writeFileSync(dest, current);
  pruneSnapshots(dir);
  return { skipped: false, id, path: dest };
}

function listScriptHistory(projectDir, scriptName) {
  const dir = historyDirForScript(projectDir, scriptName);
  return listSnapshotFiles(dir).map((file) => {
    let preview = "";
    try {
      const text = fs.readFileSync(file.abs, "utf8");
      preview = text.split("\n").slice(0, 2).join(" ").trim().slice(0, 80);
    } catch {
      preview = "";
    }
    return {
      id: file.id,
      createdAt: createdAtFromId(file.id) || new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
      preview,
    };
  });
}

function readScriptSnapshot(projectDir, scriptName, id) {
  if (!isSafeSnapshotId(id)) return null;
  const abs = path.join(historyDirForScript(projectDir, scriptName), `${id}.txt`);
  const root = path.resolve(historyDirForScript(projectDir, scriptName));
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved, "utf8");
}

function restoreScriptSnapshot(projectDir, scriptName, id) {
  const text = readScriptSnapshot(projectDir, scriptName, id);
  if (text == null) return { ok: false, error: "Snapshot not found" };
  snapshotScriptWrite(projectDir, scriptName, text);
  fs.writeFileSync(path.join(projectDir, scriptName), text);
  return { ok: true, text, id };
}

module.exports = {
  HISTORY_DIR_NAME,
  MAX_SNAPSHOTS,
  MAX_AGE_MS,
  snapshotIdFromDate,
  snapshotScriptWrite,
  listScriptHistory,
  readScriptSnapshot,
  restoreScriptSnapshot,
  pruneSnapshots,
};
