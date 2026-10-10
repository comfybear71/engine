#!/usr/bin/env node
"use strict";

/**
 * Starts the local worker and Studio together, restarts either if it
 * exits, and opens the browser. No extra npm packages.
 *
 * Double-click start-studio.bat on Windows (minimised). From a checkout:
 * `node launcher.js`.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname);
const DEFAULTS = {
  workerPort: 4100,
  studioPort: 3001,
  studioOrigin: "http://localhost:3001",
};

const LAUNCHER_ERR_LOG = "launcher.err.log";
const BUILD_RETRY_MS = 30_000;

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

function isStudioDev(env = process.env) {
  const value = env.STUDIO_DEV || env.ENGINE_STUDIO_DEV;
  return value === "1" || /^true$/i.test(String(value || ""));
}

function studioLaunchArgs(nextBin, port, { dev } = {}) {
  return dev ? [nextBin, "dev", "-p", String(port)] : [nextBin, "start", "-p", String(port)];
}

const STUDIO_SOURCE_ENTRIES = [
  "app",
  "components",
  "lib",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "next.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "postcss.config.js",
  "postcss.config.mjs",
];

function newestMtime(absPath, maxDepth = 6) {
  if (!fs.existsSync(absPath)) return 0;
  const stat = fs.statSync(absPath);
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory() || maxDepth <= 0) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  let entries;
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
    const child = newestMtime(path.join(absPath, entry.name), maxDepth - 1);
    if (child > newest) newest = child;
  }
  return newest;
}

function studioSourceMtime(studioDir) {
  let newest = 0;
  for (const entry of STUDIO_SOURCE_ENTRIES) {
    const mtime = newestMtime(path.join(studioDir, entry));
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function readGitHead(rootDir) {
  const headPath = path.join(rootDir, ".git", "HEAD");
  if (!fs.existsSync(headPath)) return null;
  const raw = fs.readFileSync(headPath, "utf8").trim();
  if (raw.startsWith("ref:")) {
    const refPath = path.join(rootDir, ".git", raw.slice(4).trim());
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim();
  }
  return raw || null;
}

function buildStampPath(studioDir) {
  return path.join(studioDir, ".next", "engine-build-stamp.json");
}

function readBuildStamp(studioDir) {
  const file = buildStampPath(studioDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeBuildStamp(paths) {
  const stamp = {
    gitHead: readGitHead(paths.root),
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(paths.studioDir, ".next"), { recursive: true });
  fs.writeFileSync(buildStampPath(paths.studioDir), JSON.stringify(stamp) + "\n");
}

function launcherErrLogPath(rootDir) {
  return path.join(rootDir, LAUNCHER_ERR_LOG);
}

function appendLauncherError(rootDir, text) {
  const body = String(text || "").trimEnd();
  fs.appendFileSync(launcherErrLogPath(rootDir), `[${new Date().toISOString()}]\n${body}\n\n`);
}

function buildFailureStampPath(studioDir) {
  return path.join(studioDir, ".next", "engine-build-failure.json");
}

function readBuildFailureStamp(studioDir) {
  const file = buildFailureStampPath(studioDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeBuildFailureStamp(paths) {
  const stamp = {
    sourceMtime: studioSourceMtime(paths.studioDir),
    failedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(paths.studioDir, ".next"), { recursive: true });
  fs.writeFileSync(buildFailureStampPath(paths.studioDir), JSON.stringify(stamp) + "\n");
  return stamp;
}

function clearBuildFailureStamp(studioDir) {
  const file = buildFailureStampPath(studioDir);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function sourceUnchangedSinceBuildFailure(paths) {
  const failure = readBuildFailureStamp(paths.studioDir);
  if (!failure || typeof failure.sourceMtime !== "number") return false;
  return studioSourceMtime(paths.studioDir) <= failure.sourceMtime;
}

function formatSpawnOutput(result) {
  const chunks = [];
  if (result.stdout) chunks.push(String(result.stdout));
  if (result.stderr) chunks.push(String(result.stderr));
  if (result.error) chunks.push(result.error.stack || result.error.message);
  return chunks.join("\n").trim();
}

function studioNeedsRebuild(paths) {
  const buildId = path.join(paths.studioDir, ".next", "BUILD_ID");
  if (!fs.existsSync(buildId)) return true;
  const stamp = readBuildStamp(paths.studioDir);
  const gitHead = readGitHead(paths.root);
  if (gitHead && (!stamp || stamp.gitHead !== gitHead)) return true;
  const buildMtime = fs.statSync(buildId).mtimeMs;
  return studioSourceMtime(paths.studioDir) > buildMtime;
}

function ensureStudioBuild(paths, env) {
  if (isStudioDev(env)) return { built: false, skipped: true, useDev: false };
  if (!studioNeedsRebuild(paths)) return { built: false, skipped: true, useDev: false };
  if (sourceUnchangedSinceBuildFailure(paths)) {
    return { built: false, skipped: true, useDev: true };
  }
  console.log("Building Studio…");
  const result = spawnSync(process.execPath, [paths.nextBin, "build"], {
    cwd: paths.studioDir,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const output = formatSpawnOutput(result) || `Studio build exited with status ${result.status}.`;
    writeBuildFailureStamp(paths);
    appendLauncherError(
      paths.root,
      `Studio production build failed (status ${result.status == null ? "error" : result.status}).\n${output}`
    );
    if (output) console.error(output);
    const err = new Error("Studio build failed.");
    err.code = "STUDIO_BUILD";
    err.output = output;
    throw err;
  }
  clearBuildFailureStamp(paths.studioDir);
  writeBuildStamp(paths);
  return { built: true, useDev: false };
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
  let buildRetryTimer = null;
  let studioDevFallback = false;

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

  function clearBuildRetryTimer() {
    if (buildRetryTimer) {
      clearTimeout(buildRetryTimer);
      buildRetryTimer = null;
    }
  }

  function scheduleProductionBuildRetry() {
    if (stopping.value || buildRetryTimer) return;
    buildRetryTimer = setTimeout(() => {
      buildRetryTimer = null;
      if (stopping.value || !studioDevFallback) return;
      if (sourceUnchangedSinceBuildFailure(paths)) {
        scheduleProductionBuildRetry();
        return;
      }
      console.log("Studio source changed. Retrying the production build…");
      if (children.studio && !children.studio.killed) {
        children.studio.kill();
        return;
      }
      startStudio();
    }, BUILD_RETRY_MS);
  }

  function startStudio() {
    if (stopping.value) return;
    if (!fs.existsSync(paths.nextBin)) {
      console.error("Studio isn't installed on this computer yet. Ask whoever set this computer up to finish the Engine Studio install.");
      return;
    }
    const studioEnv = { ...baseEnv, PORT: studioPort };
    let dev = isStudioDev(studioEnv);
    studioDevFallback = false;
    if (!dev) {
      try {
        const result = ensureStudioBuild(paths, studioEnv);
        if (result.useDev) {
          dev = true;
          studioDevFallback = true;
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : "Studio build failed.");
        console.error(
          `Starting next dev on port ${studioPort} so Studio stays up. The production build error is in ${LAUNCHER_ERR_LOG}. It will be retried when Studio source changes.`
        );
        dev = true;
        studioDevFallback = true;
      }
    }
    if (studioDevFallback) scheduleProductionBuildRetry();
    else clearBuildRetryTimer();
    children.studio = spawnChild(
      "studio",
      studioLaunchArgs(paths.nextBin, studioPort, { dev }),
      paths.studioDir,
      studioEnv,
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
    clearBuildRetryTimer();
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
  isStudioDev,
  studioLaunchArgs,
  studioNeedsRebuild,
  studioSourceMtime,
  ensureStudioBuild,
  appendLauncherError,
  launcherErrLogPath,
  sourceUnchangedSinceBuildFailure,
  readBuildFailureStamp,
};
