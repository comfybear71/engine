import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const LOCAL_WORKER_PORT = Number(process.env.WORKER_PORT || 4100);
export const LOCAL_STUDIO_ORIGIN = process.env.STUDIO_ORIGIN || "http://localhost:3001";

export const ENGINE_START_FAILED =
  "Couldn't start the engine. Try opening Engine Studio from the desktop shortcut.";

export const ENGINE_RESTART_FAILED =
  "Couldn't restart the engine. Try the Engine Studio shortcut.";

export const ENGINE_NOT_ON_THIS_COMPUTER =
  "The engine runs on this computer, not on the web. Open Engine Studio from the desktop shortcut.";

export function resolveWorkerDir(cwd = process.cwd()): string | null {
  const candidates = [path.resolve(cwd, "worker"), path.resolve(cwd, "..", "worker")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "server.js"))) return dir;
  }
  return null;
}

export function resolveEngineRoot(cwd = process.cwd()): string | null {
  const workerDir = resolveWorkerDir(cwd);
  return workerDir ? path.dirname(workerDir) : null;
}

export function resolveWorkerPidFile(cwd = process.cwd()): string {
  if (process.env.ENGINE_WORKER_PID_FILE) return process.env.ENGINE_WORKER_PID_FILE;
  const root = resolveEngineRoot(cwd);
  return path.join(root || path.resolve(cwd), ".engine-worker.pid");
}

export function workerHealthUrl(port = LOCAL_WORKER_PORT): string {
  return `http://127.0.0.1:${port}/health`;
}

export function isHostedStudio(): boolean {
  return Boolean(process.env.VERCEL);
}

export function readWorkerPid(cwd = process.cwd()): number | null {
  const file = resolveWorkerPidFile(cwd);
  if (!fs.existsSync(file)) return null;
  const raw = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

export function writeWorkerPid(pid: number, cwd = process.cwd()): string {
  const file = resolveWorkerPidFile(cwd);
  fs.writeFileSync(file, `${pid}\n`);
  return file;
}

export function killWorkerPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

export function checkLocalWorker(port = LOCAL_WORKER_PORT, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(workerHealthUrl(port), (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => Promise<boolean>, want: boolean, tries = 20, gapMs = 150): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await check()) === want) return true;
    await sleep(gapMs);
  }
  return (await check()) === want;
}

export async function startLocalWorker(cwd = process.cwd()): Promise<
  { ok: true; alreadyRunning?: boolean; started?: boolean } | { ok: false; error: string }
> {
  if (isHostedStudio()) {
    return { ok: false, error: ENGINE_NOT_ON_THIS_COMPUTER };
  }
  if (await checkLocalWorker()) {
    return { ok: true, alreadyRunning: true };
  }
  const workerDir = resolveWorkerDir(cwd);
  if (!workerDir) {
    return { ok: false, error: ENGINE_START_FAILED };
  }
  try {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: workerDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        WORKER_PORT: String(LOCAL_WORKER_PORT),
        STUDIO_ORIGIN: LOCAL_STUDIO_ORIGIN,
        ENGINE_WORKER_PID_FILE: resolveWorkerPidFile(cwd),
      },
    });
    child.on("error", () => {
      /* spawn failures surface as !running on the next health check */
    });
    if (child.pid) writeWorkerPid(child.pid, cwd);
    child.unref();
    return { ok: true, started: true };
  } catch {
    return { ok: false, error: ENGINE_START_FAILED };
  }
}

export async function restartLocalWorker(cwd = process.cwd()): Promise<
  { ok: true; restarted?: boolean; started?: boolean; alreadyRunning?: boolean } | { ok: false; error: string }
> {
  if (isHostedStudio()) {
    return { ok: false, error: ENGINE_NOT_ON_THIS_COMPUTER };
  }
  const pid = readWorkerPid(cwd);
  if (pid) killWorkerPid(pid);
  await waitUntil(() => checkLocalWorker(), false);
  const started = await startLocalWorker(cwd);
  if (!started.ok) {
    return { ok: false, error: started.error || ENGINE_RESTART_FAILED };
  }
  return { ok: true, restarted: true, started: started.started, alreadyRunning: started.alreadyRunning };
}
