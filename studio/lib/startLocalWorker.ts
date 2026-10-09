import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const LOCAL_WORKER_PORT = Number(process.env.WORKER_PORT || 4100);
export const LOCAL_STUDIO_ORIGIN = process.env.STUDIO_ORIGIN || "http://localhost:3001";

export const ENGINE_START_FAILED =
  "Couldn't start the engine. Try opening Engine Studio from the desktop shortcut.";

export const ENGINE_NOT_ON_THIS_COMPUTER =
  "The engine runs on this computer, not on the web. Open Engine Studio from the desktop shortcut.";

export function resolveWorkerDir(cwd = process.cwd()): string | null {
  const candidates = [path.resolve(cwd, "worker"), path.resolve(cwd, "..", "worker")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "server.js"))) return dir;
  }
  return null;
}

export function workerHealthUrl(port = LOCAL_WORKER_PORT): string {
  return `http://127.0.0.1:${port}/health`;
}

export function isHostedStudio(): boolean {
  return Boolean(process.env.VERCEL);
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
      },
    });
    child.on("error", () => {
      /* spawn failures surface as !running on the next health check */
    });
    child.unref();
    return { ok: true, started: true };
  } catch {
    return { ok: false, error: ENGINE_START_FAILED };
  }
}
