"use client";

import { useMemo, useState } from "react";
import { groupScripts, nextNewScriptName, normalizeNewScriptName } from "@/lib/factoryAssets";

export default function ScriptFileList({
  scripts,
  selected,
  disabled,
  onOpen,
  onCreate,
}: {
  scripts: string[];
  selected: string;
  disabled?: boolean;
  onOpen: (name: string) => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const groups = useMemo(() => groupScripts(scripts), [scripts]);
  const [testsOpen, setTestsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggested = nextNewScriptName(scripts);

  function startNew() {
    setCreating(true);
    setError(null);
    setDraft(suggested.replace(/^script_/, "").replace(/\.txt$/i, ""));
  }

  async function submitNew() {
    const name = normalizeNewScriptName(draft) || suggested;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create script");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="flex w-52 shrink-0 flex-col border-r border-studio-border bg-studio-panel"
      data-testid="script-file-list"
    >
      <div className="flex items-center justify-between gap-2 border-b border-studio-border px-2 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Scripts</h2>
        <button
          type="button"
          data-testid="script-new"
          onClick={startNew}
          disabled={disabled || busy}
          className="rounded-md border border-studio-border px-2 py-0.5 text-[11px] font-semibold text-neutral-200 hover:text-white disabled:opacity-40"
        >
          + New
        </button>
      </div>
      {creating ? (
        <form
          className="border-b border-studio-border px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNew();
          }}
        >
          <label className="block text-[10px] uppercase tracking-wide text-studio-muted">
            Name
            <input
              data-testid="script-new-name"
              className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 font-mono text-[11px] text-white"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="walk"
              autoFocus
              disabled={busy}
            />
          </label>
          <p className="mt-1 truncate font-mono text-[10px] text-studio-muted">
            {normalizeNewScriptName(draft) || suggested}
          </p>
          {error ? <p className="mt-1 text-[11px] text-amber-300">{error}</p> : null}
          <div className="mt-2 flex gap-1">
            <button
              type="submit"
              data-testid="script-new-create"
              disabled={busy}
              className="rounded-md bg-studio-accent px-2 py-0.5 text-[11px] font-semibold text-black disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
              className="rounded-md border border-studio-border px-2 py-0.5 text-[11px] text-neutral-200"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        <ul className="space-y-0.5">
          {groups.pinned.map((name) => (
            <ScriptRow key={name} name={name} selected={name === selected} onOpen={onOpen} disabled={disabled} />
          ))}
        </ul>
        {groups.tests.length ? (
          <div className="mt-2">
            <button
              type="button"
              data-testid="script-tests-toggle"
              onClick={() => setTestsOpen((open) => !open)}
              className="flex w-full items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-studio-muted hover:text-neutral-200"
            >
              <span>tests</span>
              <span>{testsOpen ? "▾" : "▸"}</span>
            </button>
            {testsOpen ? (
              <ul className="space-y-0.5" data-testid="script-tests">
                {groups.tests.map((name) => (
                  <ScriptRow key={name} name={name} selected={name === selected} onOpen={onOpen} disabled={disabled} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ScriptRow({
  name,
  selected,
  disabled,
  onOpen,
}: {
  name: string;
  selected: boolean;
  disabled?: boolean;
  onOpen: (name: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="script-file"
        data-name={name}
        onClick={() => onOpen(name)}
        disabled={disabled}
        className={`w-full truncate rounded-md px-2 py-1 text-left font-mono text-[11px] ${
          selected ? "bg-studio-accent/20 text-white" : "text-neutral-300 hover:bg-studio-raised hover:text-white"
        }`}
      >
        {name}
      </button>
    </li>
  );
}
