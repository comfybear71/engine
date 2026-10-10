"use client";

import { useEffect, useRef, useState } from "react";
import { loadProjectContents, loadShowContents, type ProjectContents } from "@/lib/worker";

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function formatDuration(seconds: number | null, sceneCount = 0): string {
  if (seconds != null && seconds > 0) {
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m <= 0) return `${s}s`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  if (sceneCount > 0) return `${sceneCount} scene${sceneCount === 1 ? "" : "s"}`;
  return "Empty";
}

export function formatRenderTime(iso: string | null): string {
  if (!iso) return "Never rendered";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never rendered";
  return `Rendered ${date.toLocaleString()}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function startDownload(url: string) {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  window.setTimeout(() => iframe.remove(), 60_000);
}

export function ModalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-studio-border bg-studio-panel p-4 shadow-2xl">{children}</div>
    </div>
  );
}

export function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`block w-full px-3 py-1.5 text-left text-xs ${
        danger ? "text-red-400 hover:bg-red-950/50" : "text-neutral-200 hover:bg-studio-raised"
      }`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="3" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="11" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function CardMenu({
  name,
  open,
  disabled,
  items,
  onToggle,
  onClose,
}: {
  name: string;
  open: boolean;
  disabled: boolean;
  items: { label: string; onClick: () => void; danger?: boolean }[];
  onToggle: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={rootRef} className="absolute right-1.5 top-1.5 z-10">
      <button
        type="button"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-testid={`project-menu-${name}`}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/80 disabled:opacity-40"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 w-44 overflow-hidden rounded-md border border-studio-border bg-studio-panel py-1 shadow-xl"
        >
          {items.map((item) => (
            <MenuItem key={item.label} label={item.label} onClick={item.onClick} danger={item.danger} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DeleteModal({
  name,
  kind,
  showId,
  displayName,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  kind: "project" | "episode" | "show";
  showId?: string;
  displayName?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typed: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [contents, setContents] = useState<ProjectContents | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load =
      kind === "show" && showId
        ? loadShowContents(showId)
        : loadProjectContents(name, kind === "episode" ? showId : undefined);
    load
      .then((next) => {
        if (!cancelled) setContents(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [name, kind, showId]);

  const canSubmit = (typed === name || (displayName ? typed === displayName : false)) && !busy;
  const where =
    kind === "show"
      ? "the show folder (episodes, shared assets, final cuts)"
      : kind === "episode"
        ? "this episode folder"
        : "the project folder";

  return (
    <ModalShell>
      <h2 className="text-sm font-semibold text-white">Delete {name}?</h2>
      <p className="mt-2 text-xs text-studio-muted">
        {where} moves to <code className="font-mono">projects/_trash</code>. Shared art in{" "}
        <code className="font-mono">_global_assets</code> is not touched. This is a move, not a hard delete.
      </p>
      {loadError ? <p className="mt-2 text-xs text-red-400">{loadError}</p> : null}
      {contents ? (
        <ul className="mt-3 space-y-1 text-xs text-neutral-300">
          <li>
            Scripts: {contents.scripts.length ? contents.scripts.join(", ") : "none"} ({formatBytes(contents.scriptBytes)})
          </li>
          <li>
            Audio: {contents.audio.files} file{contents.audio.files === 1 ? "" : "s"} ({formatBytes(contents.audio.bytes)})
          </li>
          <li>
            Renders: {contents.renders.files} file{contents.renders.files === 1 ? "" : "s"} ({formatBytes(contents.renders.bytes)})
          </li>
          <li>
            Local assets: {contents.localAssets.files} file{contents.localAssets.files === 1 ? "" : "s"} (
            {formatBytes(contents.localAssets.bytes)})
          </li>
          <li className="pt-1 text-studio-muted">Total {formatBytes(contents.totalBytes)}</li>
        </ul>
      ) : (
        <p className="mt-3 text-xs text-studio-muted">Listing files…</p>
      )}
      <label className="mt-4 block text-xs text-studio-muted">
        Type <span className="font-mono text-white">{name}</span> to confirm
        <input
          autoFocus
          className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white outline-none focus:border-studio-accent"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          data-testid="delete-confirm-name"
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40"
          data-testid="delete-confirm"
          onClick={() => void onConfirm(typed)}
        >
          {busy ? "Moving…" : "Move to trash"}
        </button>
      </div>
    </ModalShell>
  );
}

export function RenameModal({
  name,
  busy,
  label = "New name",
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  label?: string;
  onCancel: () => void;
  onConfirm: (next: string) => Promise<void>;
}) {
  const [next, setNext] = useState(name);
  const trimmed = next.trim();
  const valid = (SAFE_NAME.test(trimmed) || trimmed.includes(" ")) && trimmed !== name && !busy && trimmed.length > 0;

  return (
    <ModalShell>
      <h2 className="text-sm font-semibold text-white">Rename {name}</h2>
      <label className="mt-3 block text-xs text-studio-muted">
        {label}
        <input
          autoFocus
          className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white outline-none focus:border-studio-accent"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          data-testid="rename-input"
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!valid}
          className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
          data-testid="rename-confirm"
          onClick={() => void onConfirm(trimmed)}
        >
          {busy ? "Renaming…" : "Rename"}
        </button>
      </div>
    </ModalShell>
  );
}

export function EmptyTrashModal({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ModalShell>
      <h2 className="text-sm font-semibold text-white">Empty trash?</h2>
      <p className="mt-2 text-xs text-studio-muted">
        This permanently deletes {count} item{count === 1 ? "" : "s"} in trash. This cannot be undone.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40"
          data-testid="empty-trash-confirm"
          onClick={() => void onConfirm()}
        >
          {busy ? "Emptying…" : "Empty trash"}
        </button>
      </div>
    </ModalShell>
  );
}

export function NameForm({
  label,
  placeholder,
  submitLabel,
  extra,
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  disabled,
  testId,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  extra?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex h-full flex-col justify-center gap-3 p-4"
    >
      <label className="text-xs text-studio-muted">
        {label}
        <input
          autoFocus
          className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white outline-none focus:border-studio-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-testid={`${testId}-name`}
        />
      </label>
      {extra}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!value.trim() || busy || disabled}
          className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
          data-testid={`${testId}-submit`}
        >
          {busy ? "Working…" : submitLabel}
        </button>
        <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
