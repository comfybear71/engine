"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import EngineStatus from "@/components/EngineStatus";
import {
  CardMenu,
  DeleteModal,
  EmptyTrashModal,
  NameForm,
  RenameModal,
  formatBytes,
  formatDeletedAt,
  formatDuration,
  formatRenderTime,
  startDownload,
} from "@/components/homeChrome";
import {
  WorkerUnreachableError,
  assetUrl,
  checkWorker,
  createProject,
  createShow,
  downloadProjectUrl,
  downloadShowUrl,
  duplicateProject,
  duplicateShow,
  emptyTrash,
  fetchPreviewFrame,
  listProjects,
  listShows,
  listTrash,
  moveProjectToShow,
  renameProject,
  renameShow,
  restoreTrash,
  showAssetUrl,
  trashProject,
  trashShow,
  type ProjectSummary,
  type ShowSummary,
  type TrashItem,
} from "@/lib/worker";

export default function HomeScreen() {
  const router = useRouter();
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [shows, setShows] = useState<ShowSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newShowName, setNewShowName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewShow, setShowNewShow] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "project" | "show"; name: string; displayName?: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: "project" | "show"; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [emptyConfirm, setEmptyConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) {
      setShows([]);
      setProjects([]);
      setTrash([]);
      return;
    }
    try {
      const [showList, list, trashList] = await Promise.all([listShows(), listProjects(), listTrash()]);
      setShows(showList);
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

  const workerUpRef = useRef(workerUp);
  workerUpRef.current = workerUp;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function onFocus() {
      if (document.visibilityState === "visible") void refresh();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const ms = workerUp === true ? 4000 : 2000;
    const id = window.setInterval(async () => {
      const up = await checkWorker();
      if (!up) {
        setWorkerUp(false);
        return;
      }
      if (workerUpRef.current !== true) {
        await refresh();
        return;
      }
      setWorkerUp(true);
    }, ms);
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

  async function onCreateProject(event: React.FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
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

  async function onCreateShow(event: React.FormEvent) {
    event.preventDefault();
    const name = newShowName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createShow(name);
      router.push(`/s/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create show");
    } finally {
      setCreating(false);
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
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        <section className="mb-10">
          <h1 className="mb-4 text-2xl font-semibold text-white">Shows</h1>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {shows.map((show) => {
              const src = showAssetUrl(show.id, show.thumbRel, { thumb: true, v: show.thumbMtime });
              return (
                <article
                  key={show.id}
                  className="group relative overflow-hidden rounded-lg border border-studio-border bg-studio-panel hover:border-studio-accent/70"
                  data-testid={`show-card-${show.id}`}
                >
                  <Link href={`/s/${encodeURIComponent(show.id)}`} className="block text-left">
                    <div className="aspect-[21/9] bg-studio-raised">
                      {src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={src} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-studio-muted">No preview</div>
                      )}
                    </div>
                    <div className="space-y-1 px-3 py-2.5 pr-10">
                      <p className="truncate text-sm font-medium text-white group-hover:text-studio-accent">{show.name}</p>
                      <p className="text-xs text-studio-muted">
                        {show.episodeCount} episode{show.episodeCount === 1 ? "" : "s"}
                        {show.durationSeconds ? ` · ${formatDuration(show.durationSeconds)}` : ""}
                      </p>
                    </div>
                  </Link>
                  <CardMenu
                    name={show.id}
                    open={menuFor === `show:${show.id}`}
                    disabled={busy || workerUp !== true}
                    onToggle={() => setMenuFor((current) => (current === `show:${show.id}` ? null : `show:${show.id}`))}
                    onClose={() => setMenuFor(null)}
                    items={[
                      {
                        label: "Duplicate",
                        onClick: () => {
                          setMenuFor(null);
                          setBusy(true);
                          duplicateShow(show.id)
                            .then(() => refresh())
                            .catch((err: Error) => setError(err.message))
                            .finally(() => setBusy(false));
                        },
                      },
                      {
                        label: "Rename",
                        onClick: () => {
                          setMenuFor(null);
                          setRenameTarget({ kind: "show", name: show.id });
                        },
                      },
                      {
                        label: "Download",
                        onClick: () => {
                          setMenuFor(null);
                          startDownload(downloadShowUrl(show.id));
                        },
                      },
                      {
                        label: "Delete",
                        danger: true,
                        onClick: () => {
                          setMenuFor(null);
                          setDeleteTarget({ kind: "show", name: show.id, displayName: show.name });
                        },
                      },
                    ]}
                  />
                </article>
              );
            })}
            <div className="overflow-hidden rounded-lg border border-dashed border-studio-border bg-studio-panel">
              {showNewShow ? (
                <NameForm
                  label="Show name"
                  placeholder="Sunny Banks"
                  submitLabel="Create"
                  value={newShowName}
                  onChange={setNewShowName}
                  onSubmit={() => void onCreateShow({ preventDefault() {} } as React.FormEvent)}
                  onCancel={() => {
                    setShowNewShow(false);
                    setNewShowName("");
                  }}
                  busy={creating}
                  disabled={workerUp !== true}
                  testId="new-show"
                />
              ) : (
                <button
                  type="button"
                  className="flex h-full min-h-[140px] w-full flex-col items-center justify-center gap-2 text-studio-muted hover:text-white"
                  onClick={() => setShowNewShow(true)}
                  disabled={workerUp !== true}
                  data-testid="new-show-card"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-current text-2xl leading-none">
                    +
                  </span>
                  <span className="text-sm font-medium">New show</span>
                </button>
              )}
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-1 text-2xl font-semibold text-white">Experiments</h2>
          <p className="mb-4 text-xs text-studio-muted">
            Ungrouped projects. Move one into a show when it becomes an episode.
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {projects.map((project) => {
              const src =
                previews[project.name] ||
                assetUrl(project.name, project.thumbRel, { thumb: true, v: project.thumbMtime });
              return (
                <article
                  key={project.name}
                  className="group relative overflow-hidden rounded-lg border border-studio-border bg-studio-panel hover:border-studio-accent/70"
                  data-testid={`project-card-${project.name}`}
                >
                  <Link href={`/p/${encodeURIComponent(project.name)}`} className="block text-left">
                    <div className="aspect-video bg-studio-raised">
                      {src ? (
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
                    open={menuFor === `project:${project.name}`}
                    disabled={busy || workerUp !== true}
                    onToggle={() =>
                      setMenuFor((current) => (current === `project:${project.name}` ? null : `project:${project.name}`))
                    }
                    onClose={() => setMenuFor(null)}
                    items={[
                      {
                        label: "Move into a show",
                        onClick: () => {
                          setMenuFor(null);
                          setMoveTarget(project.name);
                        },
                      },
                      {
                        label: "Duplicate",
                        onClick: () => {
                          setMenuFor(null);
                          setBusy(true);
                          duplicateProject(project.name)
                            .then(() => refresh())
                            .catch((err: Error) => setError(err.message))
                            .finally(() => setBusy(false));
                        },
                      },
                      {
                        label: "Rename",
                        onClick: () => {
                          setMenuFor(null);
                          setRenameTarget({ kind: "project", name: project.name });
                        },
                      },
                      {
                        label: "Download",
                        onClick: () => {
                          setMenuFor(null);
                          startDownload(downloadProjectUrl(project.name));
                        },
                      },
                      {
                        label: "Delete",
                        danger: true,
                        onClick: () => {
                          setMenuFor(null);
                          setDeleteTarget({ kind: "project", name: project.name });
                        },
                      },
                    ]}
                  />
                </article>
              );
            })}

            <div className="overflow-hidden rounded-lg border border-dashed border-studio-border bg-studio-panel">
              {showNewProject ? (
                <NameForm
                  label="Project name"
                  placeholder="episode_01"
                  submitLabel="Create"
                  value={newProjectName}
                  onChange={setNewProjectName}
                  onSubmit={() => void onCreateProject({ preventDefault() {} } as React.FormEvent)}
                  onCancel={() => {
                    setShowNewProject(false);
                    setNewProjectName("");
                  }}
                  busy={creating}
                  disabled={workerUp !== true}
                  testId="new-project"
                />
              ) : (
                <button
                  type="button"
                  className="flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 text-studio-muted hover:text-white"
                  onClick={() => setShowNewProject(true)}
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
        </section>

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
            <p className="text-sm text-studio-muted">Trash is empty. Deleted shows, episodes, and experiments land here so they can be restored.</p>
          ) : (
            <ul className="divide-y divide-studio-border rounded-lg border border-studio-border bg-studio-panel">
              {trash.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{item.originalName}</p>
                    <p className="truncate text-[11px] text-studio-muted">
                      {item.kind === "show" ? "Show" : item.kind === "episode" ? `Episode${item.showId ? ` · ${item.showId}` : ""}` : "Experiment"}
                      {" · "}
                      {formatDeletedAt(item.deletedAt)} · {formatBytes(item.bytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-studio-border px-2 py-1 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
                    disabled={busy || workerUp !== true}
                    onClick={() => {
                      setBusy(true);
                      restoreTrash(item.id)
                        .then(() => refresh())
                        .catch((err: Error) => setError(err.message))
                        .finally(() => setBusy(false));
                    }}
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
          name={deleteTarget.name}
          kind={deleteTarget.kind}
          showId={deleteTarget.kind === "show" ? deleteTarget.name : undefined}
          displayName={deleteTarget.displayName}
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (typed) => {
            setBusy(true);
            setError(null);
            try {
              if (deleteTarget.kind === "show") await trashShow(deleteTarget.name, typed);
              else await trashProject(deleteTarget.name, typed);
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
          name={renameTarget.name}
          busy={busy}
          label={renameTarget.kind === "show" ? "Display name or folder id" : "New name"}
          onCancel={() => setRenameTarget(null)}
          onConfirm={async (next) => {
            setBusy(true);
            setError(null);
            try {
              if (renameTarget.kind === "show") {
                const looksLikeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next);
                await renameShow(renameTarget.name, looksLikeId ? { id: next, displayName: next } : { displayName: next });
              } else {
                await renameProject(renameTarget.name, next);
              }
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

      {moveTarget ? (
        <MoveToShowModal
          projectName={moveTarget}
          shows={shows}
          busy={busy}
          onCancel={() => setMoveTarget(null)}
          onConfirm={async (showId, create, displayName) => {
            setBusy(true);
            setError(null);
            try {
              const result = await moveProjectToShow(moveTarget, showId, { create, displayName });
              setMoveTarget(null);
              router.push(`/s/${encodeURIComponent(result.show.id)}/e/${encodeURIComponent(result.episode.name)}`);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not move");
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

function MoveToShowModal({
  projectName,
  shows,
  busy,
  onCancel,
  onConfirm,
}: {
  projectName: string;
  shows: ShowSummary[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (showId: string, create: boolean, displayName?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"existing" | "new">(shows.length ? "existing" : "new");
  const [showId, setShowId] = useState(shows[0]?.id || "");
  const [newName, setNewName] = useState("");
  const canSubmit = mode === "existing" ? Boolean(showId) : Boolean(newName.trim());

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-studio-border bg-studio-panel p-4 shadow-2xl">
        <h2 className="text-sm font-semibold text-white">Move {projectName} into a show</h2>
        <p className="mt-2 text-xs text-studio-muted">
          The folder is renamed into <code className="font-mono">shows/…/episodes/</code>. You can move it back to Experiments later.
        </p>
        <div className="mt-3 flex gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-200">
            <input type="radio" checked={mode === "existing"} disabled={!shows.length} onChange={() => setMode("existing")} />
            Existing show
          </label>
          <label className="flex items-center gap-1.5 text-neutral-200">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            New show
          </label>
        </div>
        {mode === "existing" ? (
          <select
            className="mt-3 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
            value={showId}
            onChange={(event) => setShowId(event.target.value)}
            data-testid="move-show-select"
          >
            {shows.map((show) => (
              <option key={show.id} value={show.id}>
                {show.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            autoFocus
            className="mt-3 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white outline-none focus:border-studio-accent"
            placeholder="Sunny Banks"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            data-testid="move-show-new-name"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            data-testid="move-show-confirm"
            onClick={() =>
              void onConfirm(
                mode === "existing" ? showId : newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
                mode === "new",
                mode === "new" ? newName.trim() : undefined
              )
            }
          >
            {busy ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}
