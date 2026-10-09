"use client";

import { useState } from "react";

const START_FAILED = "Couldn't start the engine. Try opening Engine Studio from the desktop shortcut.";

export default function EngineStatus({
  workerUp,
  onRetry,
}: {
  workerUp: boolean | null;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  if (workerUp !== false) return null;

  async function onStart() {
    if (busy) return;
    setBusy(true);
    setFail(null);
    try {
      const res = await fetch("/api/engine/start", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        setFail(typeof body.error === "string" && body.error ? body.error : START_FAILED);
      } else {
        onRetry();
      }
    } catch {
      setFail(START_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-amber-700/60 bg-amber-950/80 px-4 py-2 text-sm text-amber-100"
      data-testid="engine-starting"
    >
      <span>{busy ? "Starting the engine…" : "Engine is starting…"}</span>
      <button
        type="button"
        data-testid="start-engine"
        onClick={() => void onStart()}
        disabled={busy}
        className="rounded-md bg-studio-accent px-2.5 py-1 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
      >
        {busy ? "Starting…" : "Start engine"}
      </button>
      {fail ? <span className="text-amber-50">{fail}</span> : null}
    </div>
  );
}
