"use client";

import { useState } from "react";

const START_FAILED = "Couldn't start the engine. Try opening Engine Studio from the desktop shortcut.";
const RESTART_FAILED = "Couldn't restart the engine. Try the Engine Studio shortcut.";

export default function EngineStatus({
  workerUp,
  onRetry,
}: {
  workerUp: boolean | null;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const up = workerUp === true;
  const unknown = workerUp == null;

  async function postEngine(path: "/api/engine/start" | "/api/engine/restart", failed: string) {
    if (busy) return;
    setBusy(true);
    setFail(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        setFail(typeof body.error === "string" && body.error ? body.error : failed);
      } else {
        onRetry();
      }
    } catch {
      setFail(failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="worker-status">
      <span
        data-testid="worker-status-dot"
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          up ? "bg-emerald-400" : unknown ? "bg-neutral-500" : "bg-red-500"
        }`}
        title={up ? "Worker running" : unknown ? "Checking worker" : "Worker down"}
        aria-label={up ? "Worker running" : unknown ? "Checking worker" : "Worker down"}
      />
      <span className="text-[11px] text-studio-muted">
        {up ? "Worker" : unknown ? "Worker…" : "Worker down"}
      </span>
      <button
        type="button"
        data-testid="restart-worker"
        onClick={() => void postEngine("/api/engine/restart", RESTART_FAILED)}
        disabled={busy}
        className="rounded-md border border-studio-border px-2 py-0.5 text-[11px] text-neutral-200 hover:text-white disabled:opacity-40"
      >
        {busy ? "Restarting…" : "Restart worker"}
      </button>
      {workerUp === false ? (
        <button
          type="button"
          data-testid="start-engine"
          onClick={() => void postEngine("/api/engine/start", START_FAILED)}
          disabled={busy}
          className="rounded-md bg-studio-accent px-2 py-0.5 text-[11px] font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
        >
          {busy ? "Starting…" : "Start engine"}
        </button>
      ) : null}
      {fail ? <span className="max-w-[220px] truncate text-[11px] text-amber-200">{fail}</span> : null}
    </div>
  );
}
