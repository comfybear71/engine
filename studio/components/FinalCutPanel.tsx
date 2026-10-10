"use client";

import { useCallback, useEffect, useState } from "react";
import {
  finalCutVideoUrl,
  loadEpisodeStage,
  planFinalCut,
  renderFinalCut,
  saveFinalCut,
  type FinalCut,
  type FinalCutItem,
  type FinalCutPlan,
  type ProjectSummary,
} from "@/lib/worker";

function newId() {
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function FinalCutPanel({
  showId,
  episodes,
  workerUp,
  onError,
}: {
  showId: string;
  episodes: ProjectSummary[];
  workerUp: boolean;
  onError: (message: string | null) => void;
}) {
  const [cut, setCut] = useState<FinalCut>({ name: "final", gapSeconds: 0, fadeSeconds: 0, items: [] });
  const [plan, setPlan] = useState<FinalCutPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [videoFile, setVideoFile] = useState<string | null>(null);
  const [videoBust, setVideoBust] = useState<number | null>(null);
  const [addEpisode, setAddEpisode] = useState(episodes[0]?.name || "");
  const [sceneEpisode, setSceneEpisode] = useState("");
  const [scenes, setScenes] = useState<{ id: string }[]>([]);
  const [addScene, setAddScene] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const refreshPlan = useCallback(async () => {
    try {
      setPlan(await planFinalCut(showId));
    } catch {
      setPlan(null);
    }
  }, [showId]);

  useEffect(() => {
    void (async () => {
      try {
        const next = await planFinalCut(showId);
        setCut(next.cut);
        setPlan(next);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Couldn't load final cut");
      }
    })();
  }, [showId, onError]);

  useEffect(() => {
    if (episodes[0] && !addEpisode) setAddEpisode(episodes[0].name);
  }, [episodes, addEpisode]);

  async function persist(next: FinalCut) {
    setCut(next);
    setSaving(true);
    try {
      const saved = await saveFinalCut(showId, next);
      setCut(saved);
      await refreshPlan();
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save final cut");
    } finally {
      setSaving(false);
    }
  }

  function updateItem(index: number, patch: Partial<FinalCutItem>) {
    const items = cut.items.map((item, i) => (i === index ? { ...item, ...patch } : item));
    void persist({ ...cut, items });
  }

  function moveItem(from: number, to: number) {
    if (to < 0 || to >= cut.items.length || from === to) return;
    const items = [...cut.items];
    const [removed] = items.splice(from, 1);
    items.splice(to, 0, removed);
    void persist({ ...cut, items });
  }

  async function loadScenes(episodeId: string) {
    setSceneEpisode(episodeId);
    setScenes([]);
    setAddScene("");
    if (!episodeId) return;
    try {
      const episode = episodes.find((item) => item.name === episodeId);
      const stage = await loadEpisodeStage(showId, episodeId, episode?.scripts[0]);
      setScenes(stage.scenes.map((scene) => ({ id: scene.id })));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't load scenes");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-studio-muted">
            Add episode
            <span className="mt-1 flex gap-2">
              <select
                className="rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
                value={addEpisode}
                onChange={(event) => setAddEpisode(event.target.value)}
              >
                {episodes.map((episode) => (
                  <option key={episode.name} value={episode.name}>
                    {episode.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!addEpisode || !workerUp}
                className="rounded-md bg-studio-accent px-2 py-1 text-xs font-semibold text-black disabled:opacity-40"
                onClick={() => {
                  if (!addEpisode) return;
                  void persist({
                    ...cut,
                    items: [
                      ...cut.items,
                      {
                        id: newId(),
                        kind: "episode",
                        episodeId: addEpisode,
                        script: episodes.find((item) => item.name === addEpisode)?.scripts[0] || "script.txt",
                        trimIn: 0,
                        trimOut: null,
                      },
                    ],
                  });
                }}
              >
                Add
              </button>
            </span>
          </label>
          <label className="text-xs text-studio-muted">
            Add scene
            <span className="mt-1 flex gap-2">
              <select
                className="rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
                value={sceneEpisode}
                onChange={(event) => void loadScenes(event.target.value)}
              >
                <option value="">Episode…</option>
                {episodes.map((episode) => (
                  <option key={episode.name} value={episode.name}>
                    {episode.name}
                  </option>
                ))}
              </select>
              <select
                className="rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
                value={addScene}
                onChange={(event) => setAddScene(event.target.value)}
                disabled={!scenes.length}
              >
                <option value="">Scene…</option>
                {scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!sceneEpisode || !addScene || !workerUp}
                className="rounded-md border border-studio-border px-2 py-1 text-xs text-neutral-200 disabled:opacity-40"
                onClick={() => {
                  if (!sceneEpisode || !addScene) return;
                  void persist({
                    ...cut,
                    items: [
                      ...cut.items,
                      {
                        id: newId(),
                        kind: "scene",
                        episodeId: sceneEpisode,
                        sceneId: addScene,
                        script: episodes.find((item) => item.name === sceneEpisode)?.scripts[0] || "script.txt",
                        trimIn: 0,
                        trimOut: null,
                      },
                    ],
                  });
                }}
              >
                Add
              </button>
            </span>
          </label>
        </div>

        <ol className="divide-y divide-studio-border rounded-lg border border-studio-border bg-studio-panel">
          {cut.items.length === 0 ? (
            <li className="px-3 py-6 text-sm text-studio-muted">Add episodes (or a scene from one) to build the final sequence.</li>
          ) : (
            cut.items.map((item, index) => {
              const planned = plan?.items.find((entry) => entry.id === item.id);
              return (
                <li
                  key={item.id}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex != null) moveItem(dragIndex, index);
                    setDragIndex(null);
                  }}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <span className="cursor-grab text-studio-muted" title="Drag to reorder">
                    ⋮⋮
                  </span>
                  <div className="min-w-[140px] flex-1">
                    <p className="text-sm text-white">{item.kind === "scene" ? `${item.episodeId} · ${item.sceneId}` : item.episodeId}</p>
                    <p className="text-[11px] text-studio-muted">
                      {planned?.willRender ? "Will re-render" : planned?.stale ? "Stale" : planned?.durationSeconds != null ? `${Math.round(planned.durationSeconds)}s` : "—"}
                    </p>
                  </div>
                  <label className="text-[11px] text-studio-muted">
                    In
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="ml-1 w-16 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-xs text-white"
                      value={item.trimIn ?? 0}
                      onChange={(event) => updateItem(index, { trimIn: Number(event.target.value) || 0 })}
                    />
                  </label>
                  <label className="text-[11px] text-studio-muted">
                    Out
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="ml-1 w-16 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-xs text-white"
                      value={item.trimOut ?? ""}
                      placeholder="end"
                      onChange={(event) =>
                        updateItem(index, { trimOut: event.target.value === "" ? null : Number(event.target.value) })
                      }
                    />
                  </label>
                  <button type="button" className="text-xs text-red-400 hover:text-red-300" onClick={() => void persist({ ...cut, items: cut.items.filter((_, i) => i !== index) })}>
                    Remove
                  </button>
                </li>
              );
            })
          )}
        </ol>
      </div>

      <aside className="space-y-3 rounded-lg border border-studio-border bg-studio-panel p-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-studio-muted">Render final</h2>
        <label className="block text-xs text-studio-muted">
          Output name
          <input
            className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-white"
            value={cut.name}
            onChange={(event) => setCut({ ...cut, name: event.target.value })}
            onBlur={() => void persist(cut)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-studio-muted">
            Gap (s)
            <input
              type="number"
              min={0}
              step={0.1}
              className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-sm text-white"
              value={cut.gapSeconds}
              onChange={(event) => setCut({ ...cut, gapSeconds: Number(event.target.value) || 0 })}
              onBlur={() => void persist(cut)}
            />
          </label>
          <label className="text-xs text-studio-muted">
            Fade (s)
            <input
              type="number"
              min={0}
              step={0.1}
              className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-sm text-white"
              value={cut.fadeSeconds}
              onChange={(event) => setCut({ ...cut, fadeSeconds: Number(event.target.value) || 0 })}
              onBlur={() => void persist(cut)}
            />
          </label>
        </div>
        {plan ? (
          <div className="space-y-1 text-xs text-neutral-300">
            {plan.items.map((item) => (
              <p key={item.id}>
                {item.label}
                {item.willRender ? " — re-render" : item.missing ? " — missing" : ""}
              </p>
            ))}
            <p className="pt-1 text-studio-muted">{plan.note}</p>
          </div>
        ) : null}
        <button
          type="button"
          disabled={!workerUp || rendering || cut.items.length === 0}
          className="w-full rounded-md bg-studio-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
          data-testid="render-final"
          onClick={() => {
            setRendering(true);
            onError(null);
            renderFinalCut(showId, cut.name)
              .then((result) => {
                setVideoFile(result.file);
                setVideoBust(Date.now());
                setPlan(result.plan || plan);
              })
              .catch((err: Error) => onError(err.message))
              .finally(() => setRendering(false));
          }}
        >
          {rendering ? "Rendering…" : saving ? "Saving…" : "Render final"}
        </button>
        {videoFile && videoBust ? (
          <video className="w-full rounded bg-black" controls src={finalCutVideoUrl(showId, videoFile, videoBust)} />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded bg-studio-raised text-xs text-studio-muted">
            Slim preview after render
          </div>
        )}
      </aside>
    </div>
  );
}
