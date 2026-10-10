"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_LIPSYNC_SETTINGS,
  loadStudioSettings,
  saveStudioSettings,
  type LipSyncNaturalSettings,
} from "@/lib/worker";

function mergeLipsync(raw: LipSyncNaturalSettings | undefined): LipSyncNaturalSettings {
  return {
    ...DEFAULT_LIPSYNC_SETTINGS,
    ...(raw && typeof raw === "object" ? raw : {}),
  };
}

export default function LipSyncSettings({
  project,
  open,
  onClose,
  onChanged,
}: {
  project: string;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [settings, setSettings] = useState<LipSyncNaturalSettings>(DEFAULT_LIPSYNC_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setError(null);
    setSaved(false);
    loadStudioSettings(project)
      .then((next) => setSettings(mergeLipsync(next.lipsync)))
      .catch(() => setSettings(DEFAULT_LIPSYNC_SETTINGS));
  }, [open, project]);

  if (!open) return null;

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const next = await saveStudioSettings(project, { lipsync: settings });
      setSettings(mergeLipsync(next.lipsync));
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save lip-sync settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-24" data-testid="lipsync-settings">
      <div className="w-full max-w-sm rounded-md border border-studio-border bg-studio-panel p-3 shadow-2xl">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Lip sync</h2>
            <p className="text-[11px] text-studio-muted">Applies to Stage preview and Render. Missing drawings stay on the normal shape.</p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>

        <label className="mt-2 block text-[11px] text-studio-muted">
          Smoothing
          <select
            className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-xs text-neutral-200"
            value={settings.smoothing}
            onChange={(event) => {
              setSettings((current) => ({ ...current, smoothing: event.target.value as LipSyncNaturalSettings["smoothing"] }));
              setSaved(false);
            }}
            data-testid="lipsync-smoothing"
          >
            <option value="off">Off</option>
            <option value="light">Light</option>
            <option value="medium">Medium</option>
          </select>
        </label>

        <label className="mt-2 block text-[11px] text-studio-muted">
          Head bob
          <select
            className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-xs text-neutral-200"
            value={settings.head_bob}
            onChange={(event) => {
              setSettings((current) => ({ ...current, head_bob: event.target.value as LipSyncNaturalSettings["head_bob"] }));
              setSaved(false);
            }}
            data-testid="lipsync-head-bob"
          >
            <option value="off">Off</option>
            <option value="subtle">Subtle</option>
            <option value="strong">Strong</option>
          </select>
        </label>

        <label className="mt-2 flex items-center gap-2 text-[11px] text-studio-muted">
          <input
            type="checkbox"
            checked={settings.blinks}
            onChange={(event) => {
              setSettings((current) => ({ ...current, blinks: event.target.checked }));
              setSaved(false);
            }}
            data-testid="lipsync-blinks"
          />
          Auto blinks (needs an eyes/closed drawing)
        </label>

        <label className="mt-2 block text-[11px] text-studio-muted">
          Loud threshold
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={settings.loud_threshold}
            onChange={(event) => {
              setSettings((current) => ({ ...current, loud_threshold: Number(event.target.value) }));
              setSaved(false);
            }}
            className="studio-scrubber mt-1 w-full"
            data-testid="lipsync-loud-threshold"
          />
          <span className="text-neutral-300">{Math.round(settings.loud_threshold * 100)}th percentile</span>
        </label>

        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        {saved ? <p className="mt-2 text-[12px] text-emerald-300">Saved to studio.json.</p> : null}

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
            data-testid="lipsync-settings-save"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LipSyncSettingsPage({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-medium text-white">Lip sync</p>
      <p className="max-w-md text-sm text-studio-muted">
        Smoothing, head bob, blinks, and the loud-mouth threshold. Stage preview uses the same compositor path as Render.
      </p>
      <button
        type="button"
        className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
        data-testid="lipsync-settings-open"
        onClick={() => setOpen(true)}
      >
        Lip sync settings
      </button>
      <LipSyncSettings project={project} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
