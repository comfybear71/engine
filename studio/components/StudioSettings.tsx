"use client";

import { useEffect, useState } from "react";
import { loadEngineSettings, saveEngineXaiKey } from "@/lib/worker";

export default function StudioSettings({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey("");
    setError(null);
    setSaved(false);
    loadEngineSettings()
      .then((settings) => setConfigured(settings.xaiKeyConfigured))
      .catch(() => setConfigured(false));
  }, [open]);

  if (!open) return null;

  async function onSave() {
    if (!key.trim()) {
      setError("Paste an xAI API key. It is stored on this PC and never shown back.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveEngineXaiKey(key.trim());
      setKey("");
      setConfigured(true);
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-md border border-studio-border bg-studio-panel p-4 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Settings</h2>
            <p className="text-[11px] text-studio-muted">Engine keys stay in the .env on this PC.</p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="block text-[11px] text-studio-muted">
          xAI API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={configured ? "Key is set — paste a new one to replace" : "Paste xAI API key"}
            onChange={(event) => {
              setKey(event.target.value);
              setSaved(false);
            }}
            className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-xs text-neutral-200"
            data-testid="settings-xai-key"
          />
        </label>
        <p className="mt-1.5 text-[11px] text-studio-muted">
          Stored as XAI_API_KEY. Never shown back. Used by Generate in Grok Imagine.
        </p>
        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        {saved ? <p className="mt-2 text-[12px] text-emerald-300">Saved.</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            disabled={busy}
            onClick={() => void onSave()}
            data-testid="settings-xai-save"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
