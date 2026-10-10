"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import EngineStatus from "@/components/EngineStatus";
import FinalCutPanel from "@/components/FinalCutPanel";
import {
  CardMenu,
  DeleteModal,
  NameForm,
  RenameModal,
  formatDuration,
  formatRenderTime,
  startDownload,
} from "@/components/homeChrome";
import {
  WorkerUnreachableError,
  addShowLibraryCharacter,
  assetUrl,
  checkWorker,
  createEpisode,
  downloadProjectUrl,
  duplicateProject,
  fetchPreviewFrame,
  loadShow,
  loadShowLibrary,
  moveEpisodeToExperiments,
  renameProject,
  setActiveShowId,
  showAssetUrl,
  trashProject,
  type Character,
  type LibraryResponse,
  type ProjectSummary,
  type ShowAssets,
  type ShowSummary,
} from "@/lib/worker";

const TABS = [
  { id: "episodes", label: "Episodes" },
  { id: "assets", label: "Assets" },
  { id: "final", label: "Final cut" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ShowScreen({ showId }: { showId: string }) {
  const router = useRouter();
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [show, setShow] = useState<ShowSummary | null>(null);
  const [assets, setAssets] = useState<ShowAssets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("episodes");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [duplicateFrom, setDuplicateFrom] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) return;
    try {
      const body = await loadShow(showId);
      setShow(body.show);
      setAssets(body.assets);
      setError(null);
    } catch (err) {
      if (!(err instanceof WorkerUnreachableError)) {
        setError(err instanceof Error ? err.message : "Couldn't load show.");
      }
    }
  }, [showId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const episodes = show?.episodes || [];
    const urls: string[] = [];
    let cancelled = false;
    setActiveShowId(showId);
    for (const episode of episodes) {
      const script = episode.scripts[0] || "script.txt";
      fetchPreviewFrame(episode.name, 0, undefined, script)
        .then(({ blob }) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((current) => ({ ...current, [episode.name]: url }));
        })
        .catch(() => {
          /* keep thumb */
        });
    }
    return () => {
      cancelled = true;
      setActiveShowId(null);
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [showId, show?.episodes]);

  const episodes = show?.episodes || [];

  async function onCreateEpisode() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createEpisode(showId, name, duplicateFrom || undefined);
      router.push(`/s/${encodeURIComponent(showId)}/e/${encodeURIComponent(created.name)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create episode");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-studio-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-studio-border bg-studio-panel px-4">
        <Link href="/" className="text-xs text-studio-muted hover:text-white" data-testid="back-home">
          ← Home
        </Link>
        <span className="flex h-6 w-6 items-center justify-center rounded bg-studio-accent text-xs font-bold text-black">▶</span>
        <span className="text-sm font-semibold tracking-wide text-white">Engine Studio</span>
        <span className="text-sm text-neutral-200" data-testid="show-name">
          {show?.name || showId}
        </span>
        <nav className="ml-4 flex items-end gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-3 text-sm ${
                tab === item.id
                  ? "border-b-2 border-studio-accent font-medium text-white"
                  : "border-b-2 border-transparent text-studio-muted hover:text-neutral-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <EngineStatus workerUp={workerUp} onRetry={() => void refresh()} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        {tab === "episodes" ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {episodes.map((episode) => {
              const src =
                previews[episode.name] ||
                assetUrl(episode.name, episode.thumbRel, { thumb: true, v: episode.thumbMtime });
              return (
                <article
                  key={episode.name}
                  className="group relative overflow-hidden rounded-lg border border-studio-border bg-studio-panel hover:border-studio-accent/70"
                  data-testid={`episode-card-${episode.name}`}
                >
                  <Link
                    href={`/s/${encodeURIComponent(showId)}/e/${encodeURIComponent(episode.name)}`}
                    className="block text-left"
                  >
                    <div className="aspect-video bg-studio-raised">
                      {src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={src} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-studio-muted">No preview</div>
                      )}
                    </div>
                    <div className="space-y-1 px-3 py-2.5 pr-10">
                      <p className="truncate text-sm font-medium text-white group-hover:text-studio-accent">{episode.name}</p>
                      <p className="text-xs text-studio-muted">{formatDuration(episode.durationSeconds, episode.sceneCount)}</p>
                      <p className="truncate text-[11px] text-studio-muted">{formatRenderTime(episode.lastRenderAt)}</p>
                    </div>
                  </Link>
                  <CardMenu
                    name={episode.name}
                    open={menuFor === episode.name}
                    disabled={busy || workerUp !== true}
                    onToggle={() => setMenuFor((current) => (current === episode.name ? null : episode.name))}
                    onClose={() => setMenuFor(null)}
                    items={[
                      {
                        label: "Duplicate",
                        onClick: () => {
                          setMenuFor(null);
                          setBusy(true);
                          duplicateProject(episode.name, showId)
                            .then(() => refresh())
                            .catch((err: Error) => setError(err.message))
                            .finally(() => setBusy(false));
                        },
                      },
                      {
                        label: "Rename",
                        onClick: () => {
                          setMenuFor(null);
                          setRenameTarget(episode.name);
                        },
                      },
                      {
                        label: "Move to Experiments",
                        onClick: () => {
                          setMenuFor(null);
                          setBusy(true);
                          moveEpisodeToExperiments(showId, episode.name)
                            .then(() => refresh())
                            .catch((err: Error) => setError(err.message))
                            .finally(() => setBusy(false));
                        },
                      },
                      {
                        label: "Download",
                        onClick: () => {
                          setMenuFor(null);
                          startDownload(downloadProjectUrl(episode.name, showId));
                        },
                      },
                      {
                        label: "Delete",
                        danger: true,
                        onClick: () => {
                          setMenuFor(null);
                          setDeleteTarget(episode.name);
                        },
                      },
                    ]}
                  />
                </article>
              );
            })}
            <div className="overflow-hidden rounded-lg border border-dashed border-studio-border bg-studio-panel">
              {showNew ? (
                <NameForm
                  label="Episode name"
                  placeholder="pilot"
                  submitLabel="Create"
                  value={newName}
                  onChange={setNewName}
                  extra={
                    episodes.length ? (
                      <label className="text-xs text-studio-muted">
                        Duplicate from
                        <select
                          className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
                          value={duplicateFrom}
                          onChange={(event) => setDuplicateFrom(event.target.value)}
                        >
                          <option value="">Blank episode</option>
                          {episodes.map((episode) => (
                            <option key={episode.name} value={episode.name}>
                              {episode.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null
                  }
                  onSubmit={() => void onCreateEpisode()}
                  onCancel={() => {
                    setShowNew(false);
                    setNewName("");
                    setDuplicateFrom("");
                  }}
                  busy={creating}
                  disabled={workerUp !== true}
                  testId="new-episode"
                />
              ) : (
                <button
                  type="button"
                  className="flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 text-studio-muted hover:text-white"
                  onClick={() => setShowNew(true)}
                  disabled={workerUp !== true}
                  data-testid="new-episode-card"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-current text-2xl leading-none">
                    +
                  </span>
                  <span className="text-sm font-medium">New episode</span>
                </button>
              )}
            </div>
          </div>
        ) : null}

        {tab === "assets" ? (
          <ShowAssetsGrid
            showId={showId}
            assets={assets}
            workerUp={workerUp === true}
            onOpenLibrary={async () => {
              setLibraryOpen(true);
              try {
                setLibrary(await loadShowLibrary(showId));
              } catch (err) {
                setError(err instanceof Error ? err.message : "Couldn't load library");
              }
            }}
          />
        ) : null}

        {tab === "final" ? (
          <FinalCutPanel showId={showId} episodes={episodes} workerUp={workerUp === true} onError={setError} />
        ) : null}
      </main>

      {libraryOpen ? (
        <div className="fixed inset-0 z-20 flex justify-end bg-black/50">
          <div className="flex h-full w-full max-w-md flex-col border-l border-studio-border bg-studio-panel">
            <div className="flex items-center justify-between border-b border-studio-border px-4 py-3">
              <h2 className="text-sm font-semibold text-white">Global library</h2>
              <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={() => setLibraryOpen(false)}>
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {(library?.characters || []).map((character) => (
                <div key={character.id} className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-sm text-neutral-200">{character.display_name}</span>
                  <button
                    type="button"
                    disabled={library?.added.includes(character.id)}
                    className="rounded-md border border-studio-border px-2 py-1 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
                    onClick={() => {
                      addShowLibraryCharacter(showId, character.id)
                        .then(() => refresh())
                        .then(() => loadShowLibrary(showId).then(setLibrary))
                        .catch((err: Error) => setError(err.message));
                    }}
                  >
                    {library?.added.includes(character.id) ? "Added" : "Add"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <DeleteModal
          name={deleteTarget}
          kind="episode"
          showId={showId}
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (typed) => {
            setBusy(true);
            setError(null);
            try {
              await trashProject(deleteTarget, typed, showId);
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
              await renameProject(renameTarget, next, showId);
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
    </div>
  );
}

function ShowAssetsGrid({
  showId,
  assets,
  workerUp,
  onOpenLibrary,
}: {
  showId: string;
  assets: ShowAssets | null;
  workerUp: boolean;
  onOpenLibrary: () => void;
}) {
  function thumb(rel: string | null | undefined, mtime?: number | null) {
    return showAssetUrl(showId, rel, { thumb: true, v: mtime });
  }
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <p className="text-xs text-studio-muted">Shared show art. Episode files override these; global library is underneath.</p>
        <button
          type="button"
          disabled={!workerUp}
          onClick={onOpenLibrary}
          className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
        >
          Library
        </button>
      </div>
      <AssetSection title="Characters" items={(assets?.characters || []).map((c: Character) => ({ id: c.id, label: c.display_name, src: thumb(c.thumbRel, c.mtime), badge: c.source }))} />
      <AssetSection title="Locations" items={(assets?.backgrounds || []).map((b) => ({ id: b.id, label: b.id, src: thumb(b.thumbRel, b.mtime) }))} />
      <AssetSection title="Props" items={(assets?.props || []).map((p) => ({ id: `${p.location || "show"}-${p.id}`, label: p.id, src: thumb(p.thumbRel, p.mtime) }))} />
    </div>
  );
}

function AssetSection({
  title,
  items,
}: {
  title: string;
  items: { id: string; label: string; src: string | null; badge?: string }[];
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] text-studio-muted">
        {title} <span className="text-studio-muted">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-studio-muted">None on this show yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((item) => (
            <div key={item.id} className="space-y-1">
              <div className="relative aspect-square overflow-hidden rounded-md border border-studio-border bg-studio-raised">
                {item.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.src} alt="" className="h-full w-full object-contain object-bottom" />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-studio-muted">No art</div>
                )}
                {item.badge && item.badge !== "global" ? (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] uppercase text-neutral-300">
                    {item.badge}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-xs text-neutral-300">{item.label}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
