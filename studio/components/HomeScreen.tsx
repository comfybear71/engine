"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import EngineStatus from "@/components/EngineStatus";
import {
  WorkerUnreachableError,
  assetUrl,
  checkWorker,
  createProject,
  downloadProjectUrl,
  duplicateProject,
  emptyTrash,
  fetchPreviewFrame,
  listProjects,
  listTrash,
  loadProjectContents,
  renameProject,
  restoreTrash,
  trashProject,
  type ProjectContents,
  type ProjectSummary,
  type TrashItem,
} from "@/lib/worker";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function formatDuration(seconds: number | null, sceneCount: number): string {
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

function formatRenderTime(iso: string | null): string {
  if (!iso) return "Never rendered";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never rendered";
  return `Rendered ${date.toLocaleString()}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function startDownload(name: string) {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = downloadProjectUrl(name);
  document.body.appendChild(iframe);
  window.setTimeout(() => iframe.remove(), 60_000);
}

export default function HomeScreen() {
  const router = useRouter();
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [emptyConfirm, setEmptyConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) {
      setProjects([]);
      setTrash([]);
      return;
    }
    try {
      const [list, trashList] = await Promise.all([listProjects(), listTrash()]);
      setProjects(list);
      setTrash(trashList);
      setError(null);
    } catch (err) {
      setWorkerUp(false);
      if (!(err instanceof WorkerUnreachableError)) {
        setError(err instanceof Error ? err.message : "Couldn't load projects.");
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const ms = workerUp === true ? 4000 : 2000;
    const id = window.setInterval(() => void refresh(), ms);
    return () => window.clearInterval(id);
  }, [refresh, workerUp]);

  useEffect(() => {
    const urls: string[] = [];
    let cancelled = false;
    for (const project of projects) {
      const script = project.scripts[0] || "script.txt";
      fetchPreviewFrame(project.name, 0, undefined, script)
        .then(({ blob }) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((current) => ({ ...current, [project.name]: url }));
        })
        .catch(() => {
          /* keep background thumb */
        });
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [projects]);

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createProject(name);
      router.push(`/p/${encodeURIComponent(created.name)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setCreating(false);
    }
  }

  async function onDuplicate(name: string) {
    setBusy(true);
    setError(null);
    setMenuFor(null);
    try {
      await duplicateProject(name);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not duplicate");
    } finally {
      setBusy(false);
    }
  }

  async function onRestore(id: string) {
    setBusy(true);
    setError(null);
    try {
      await restoreTrash(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-studio-bg">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-studio-border bg-studio-panel px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-studio-accent text-xs font-bold text-black">
            ▶
          </span>
          <span className="text-sm font-semibold tracking-wide text-white">Engine Studio</span>
        </div>
      </header>

      <EngineStatus workerUp={workerUp} onRetry={() => void refresh()} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <h1 className="mb-6 text-2xl font-semibold text-white">Projects</h1>
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {projects.map((project) => {
            const src = previews[project.name] || assetUrl(project.name, project.thumbRel, { thumb: true });
            return (
              <article
                key={project.name}
                className="group relative overflow-hidden rounded-lg border border-studio-border bg-studio-panel hover:border-studio-accent/70"
                data-testid={`project-card-${project.name}`}
              >
                <Link href={`/p/${encodeURIComponent(project.name)}`} className="block text-left">
                  <div className="aspect-video bg-studio-raised">
                    {src ? (
                      // Worker-served JPEG thumb / preview blob
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={src} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-studio-muted">No preview</div>
                    )}
                  </div>
                  <div className="space-y-1 px-3 py-2.5 pr-10">
                    <p className="truncate text-sm font-medium text-white group-hover:text-studio-accent">{project.name}</p>
                    <p className="text-xs text-studio-muted">{formatDuration(project.durationSeconds, project.sceneCount)}</p>
                    <p className="truncate text-[11px] text-studio-muted">{formatRenderTime(project.lastRenderAt)}</p>
                  </div>
                </Link>
                <CardMenu
                  name={project.name}
                  open={menuFor === project.name}
                  disabled={busy || workerUp !== true}
                  onToggle={() => setMenuFor((current) => (current === project.name ? null : project.name))}
                  onClose={() => setMenuFor(null)}
                  onDuplicate={() => void onDuplicate(project.name)}
                  onRename={() => {
                    setMenuFor(null);
                    setRenameTarget(project.name);
                  }}
                  onDownload={() => {
                    setMenuFor(null);
                    startDownload(project.name);
                  }}
                  onDelete={() => {
                    setMenuFor(null);
                    setDeleteTarget(project.name);
                  }}
                />
              </article>
            );
          })}

          <div className="overflow-hidden rounded-lg border border-dashed border-studio-border bg-studio-panel">
            {showNewForm ? (
              <form onSubmit={(event) => void onCreate(event)} className="flex h-full flex-col justify-center gap-3 p-4">
                <label className="text-xs text-studio-muted">
                  Project name
                  <input
                    autoFocus
                    className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white outline-none focus:border-studio-accent"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="episode_01"
                    data-testid="new-project-name"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={!newName.trim() || creating || workerUp !== true}
                    className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
                    data-testid="new-project-submit"
                  >
                    {creating ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-studio-muted hover:text-white"
                    onClick={() => {
                      setShowNewForm(false);
                      setNewName("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 text-studio-muted hover:text-white"
                onClick={() => setShowNewForm(true)}
                disabled={workerUp !== true}
                data-testid="new-project-card"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-current text-2xl leading-none">
                  +
                </span>
                <span className="text-sm font-medium">New project</span>
              </button>
            )}
          </div>
        </div>

        <section className="mt-10 border-t border-studio-border pt-6" data-testid="trash-section">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-studio-muted">Trash</h2>
            {trash.length > 0 ? (
              <button
                type="button"
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                disabled={busy || workerUp !== true}
                onClick={() => setEmptyConfirm(true)}
                data-testid="empty-trash"
              >
                Empty trash
              </button>
            ) : null}
          </div>
          {trash.length === 0 ? (
            <p className="text-sm text-studio-muted">Trash is empty. Deleted projects land here so they can be restored.</p>
          ) : (
            <ul className="divide-y divide-studio-border rounded-lg border border-studio-border bg-studio-panel">
              {trash.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{item.originalName}</p>
                    <p className="truncate text-[11px] text-studio-muted">
                      {formatDeletedAt(item.deletedAt)} · {formatBytes(item.bytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-studio-border px-2 py-1 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
                    disabled={busy || workerUp !== true}
                    onClick={() => void onRestore(item.id)}
                    data-testid={`trash-restore-${item.id}`}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {deleteTarget ? (
        <DeleteModal
          name={deleteTarget}
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (typed) => {
            setBusy(true);
            setError(null);
            try {
              await trashProject(deleteTarget, typed);
              setDeleteTarget(null);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not delete");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {renameTarget ? (
        <RenameModal
          name={renameTarget}
          busy={busy}
          onCancel={() => setRenameTarget(null)}
          onConfirm={async (next) => {
            setBusy(true);
            setError(null);
            try {
              await renameProject(renameTarget, next);
              setRenameTarget(null);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not rename");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {emptyConfirm ? (
        <EmptyTrashModal
          count={trash.length}
          busy={busy}
          onCancel={() => setEmptyConfirm(false)}
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            try {
              await emptyTrash();
              setEmptyConfirm(false);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not empty trash");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function CardMenu({
  name,
  open,
  disabled,
  onToggle,
  onClose,
  onDuplicate,
  onRename,
  onDownload,
  onDelete,
}: {
  name: string;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
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
          className="absolute right-0 top-8 w-40 overflow-hidden rounded-md border border-studio-border bg-studio-panel py-1 shadow-xl"
        >
          <MenuItem label="Duplicate" onClick={onDuplicate} />
          <MenuItem label="Rename" onClick={onRename} />
          <MenuItem label="Download" onClick={onDownload} />
          <MenuItem label="Delete" onClick={onDelete} danger />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
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

function ModalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-studio-border bg-studio-panel p-4 shadow-2xl">{children}</div>
    </div>
  );
}

function DeleteModal({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typed: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [contents, setContents] = useState<ProjectContents | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadProjectContents(name)
      .then((next) => {
        if (!cancelled) setContents(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const canSubmit = typed === name && !busy;

  return (
    <ModalShell>
      <h2 className="text-sm font-semibold text-white">Delete {name}?</h2>
      <p className="mt-2 text-xs text-studio-muted">
        The folder moves to <code className="font-mono">projects/_trash</code>. Shared art in{" "}
        <code className="font-mono">_global_assets</code> is not touched.
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
          <li>library.json: {formatBytes(contents.libraryJsonBytes)}</li>
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

function RenameModal({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (next: string) => Promise<void>;
}) {
  const [next, setNext] = useState(name);
  const trimmed = next.trim();
  const valid = SAFE_NAME.test(trimmed) && trimmed !== name && !busy;

  return (
    <ModalShell>
      <h2 className="text-sm font-semibold text-white">Rename {name}</h2>
      <label className="mt-3 block text-xs text-studio-muted">
        New name
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

function EmptyTrashModal({
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
        This permanently deletes {count} project{count === 1 ? "" : "s"} in trash. This cannot be undone.
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
