#!/usr/bin/env node
"use strict";

/**
 * Starts the local worker and Studio together, restarts either if it
 * exits, and opens the browser. No extra npm packages.
 *
 * Double-click start-studio.bat on Windows (minimised). From a checkout:
 * `node launcher.js`.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname);
const DEFAULTS = {
  workerPort: 4100,
  studioPort: 3001,
  studioOrigin: "http://localhost:3001",
};

function readEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveEnginePaths(rootDir) {
  const root = path.resolve(rootDir);
  const workerDir = path.join(root, "worker");
  const studioDir = path.join(root, "studio");
  const workerEntry = path.join(workerDir, "src", "server.js");
  const nextBin = path.join(studioDir, "node_modules", "next", "dist", "bin", "next");
  return { root, workerDir, studioDir, workerEntry, nextBin };
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tryOnce, 500);
      });
      req.setTimeout(1500, () => {
        req.destroy();
      });
    };
    tryOnce();
  });
}

function openBrowser(url) {
  const opts = { detached: true, stdio: "ignore", windowsHide: true };
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], opts).unref();
    return;
  }
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], opts).unref();
}

function spawnChild(label, args, cwd, env, onExit) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.error(`[${label}] ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    onExit(code, signal);
  });
  return child;
}

function createSupervisor(options) {
  const paths = resolveEnginePaths(options.root || ROOT);
  const workerPort = String(options.workerPort || DEFAULTS.workerPort);
  const studioPort = String(options.studioPort || DEFAULTS.studioPort);
  const studioOrigin = options.studioOrigin || `http://localhost:${studioPort}`;
  const envFile = readEnvFile(path.join(paths.root, ".env"));
  const baseEnv = {
    ...process.env,
    ...envFile,
    WORKER_PORT: envFile.WORKER_PORT || workerPort,
    STUDIO_ORIGIN: studioOrigin,
  };

  const stopping = { value: false };
  const children = { worker: null, studio: null };
  const delays = { worker: 1000, studio: 1000 };
  let openedBrowser = false;

  function restartDelay(name) {
    const next = Math.min(delays[name] * 2, 8000);
    const current = delays[name];
    delays[name] = next;
    return current;
  }

  function startWorker() {
    if (stopping.value) return;
    if (!fs.existsSync(paths.workerEntry)) {
      console.error("The engine files are missing. Ask whoever set this computer up to finish the Engine Studio install.");
      return;
    }
    children.worker = spawnChild("engine", [paths.workerEntry], paths.workerDir, baseEnv, () => {
      children.worker = null;
      if (stopping.value) return;
      const wait = restartDelay("worker");
      console.error(`Engine stopped. Starting it again in ${Math.round(wait / 1000)}s…`);
      setTimeout(startWorker, wait);
    });
    delays.worker = 1000;
  }

  function startStudio() {
    if (stopping.value) return;
    if (!fs.existsSync(paths.nextBin)) {
      console.error("Studio isn't installed on this computer yet. Ask whoever set this computer up to finish the Engine Studio install.");
      return;
    }
    children.studio = spawnChild(
      "studio",
      [paths.nextBin, "dev", "-p", studioPort],
      paths.studioDir,
      { ...baseEnv, PORT: studioPort },
      () => {
        children.studio = null;
        if (stopping.value) return;
        const wait = restartDelay("studio");
        console.error(`Studio stopped. Starting it again in ${Math.round(wait / 1000)}s…`);
        setTimeout(startStudio, wait);
      }
    );
    delays.studio = 1000;
  }

  async function start() {
    startWorker();
    startStudio();
    const ready = await waitForHttp(studioOrigin, 90_000);
    if (!openedBrowser) {
      openedBrowser = true;
      openBrowser(studioOrigin);
      if (!ready) {
        console.error("Studio is still starting. The browser was opened anyway — wait a moment and refresh if the page is blank.");
      }
    }
  }

  function stop() {
    stopping.value = true;
    for (const child of Object.values(children)) {
      if (child && !child.killed) child.kill();
    }
  }

  return { start, stop, paths, baseEnv };
}

if (require.main === module) {
  const supervisor = createSupervisor({});
  supervisor.start().catch((err) => {
    console.error(err instanceof Error ? err.message : "Could not start Engine Studio.");
    process.exitCode = 1;
  });
  const quit = () => {
    supervisor.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

module.exports = {
  DEFAULTS,
  readEnvFile,
  resolveEnginePaths,
  waitForHttp,
  createSupervisor,
};
