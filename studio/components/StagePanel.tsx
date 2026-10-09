"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TimelineLanes from "@/components/TimelineLanes";
import {
  fetchPreviewFrame,
  loadLanes,
  loadScript,
  loadStage,
  type LanesResponse,
  type Mark,
  type StageInfo,
  type StageLayer,
} from "@/lib/worker";

function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(fps, 1);
  const ff = Math.floor(frame % safeFps);
  const totalSeconds = Math.floor(frame / safeFps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

export default function StagePanel({
  project,
  workerUp,
  scriptEpoch,
  selectedLine,
  onSelectLine,
}: {
  project: string | null;
  workerUp: boolean;
  scriptEpoch: number;
  selectedLine: number | null;
  onSelectLine: (line: number | null) => void;
}) {
  const [stage, setStage] = useState<StageInfo | null>(null);
  const [lanes, setLanes] = useState<LanesResponse | null>(null);
  const [scriptLines, setScriptLines] = useState<string[]>([]);
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(1);
  const [fps, setFps] = useState(24);
  const [canvas, setCanvas] = useState({ width: 1920, height: 1080 });
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedMark, setSelectedMark] = useState<{ location: string; name: string; mark: Mark } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFrame(0);
    setSelectedMark(null);
    Promise.all([loadStage(project), loadLanes(project), loadScript(project)])
      .then(([info, nextLanes, script]) => {
        if (cancelled) return;
        setStage(info);
        setLanes(nextLanes);
        setScriptLines(script.split("\n"));
        setFps(info.fps);
        setCanvas(info.canvas);
        setSceneId(info.scenes[0]?.id ?? null);
        if (nextLanes.totalFrames > 0) setTotalFrames(nextLanes.totalFrames);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, scriptEpoch]);

  useEffect(() => {
    if (!project || !workerUp) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchPreviewFrame(project, frame, controller.signal)
        .then(({ blob, meta }) => {
          const url = URL.createObjectURL(blob);
          if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = url;
          setPreviewUrl(url);
          if (meta.totalFrames > 0) setTotalFrames(meta.totalFrames);
          if (meta.fps) setFps(meta.fps);
          if (meta.canvasWidth && meta.canvasHeight) {
            setCanvas({ width: meta.canvasWidth, height: meta.canvasHeight });
          }
          if (meta.sceneId) setSceneId(meta.sceneId);
          setError(null);
        })
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          setError(err.message);
        });
    }, 80);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [project, workerUp, frame]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const currentScene = useMemo(
    () => stage?.scenes.find((s) => s.id === sceneId) || stage?.scenes[0] || null,
    [stage, sceneId]
  );

  const locationMarks = useMemo(() => {
    if (!stage) return [] as { location: string; name: string; mark: Mark }[];
    const out: { location: string; name: string; mark: Mark }[] = [];
    const locations = currentScene?.location
      ? [currentScene.location]
      : Object.keys(stage.marksByLocation);
    for (const location of locations) {
      const marks = stage.marksByLocation[location] || {};
      for (const [name, mark] of Object.entries(marks)) {
        out.push({ location, name, mark });
      }
    }
    return out;
  }, [stage, currentScene]);

  const layers: StageLayer[] = currentScene?.layers || [];
  const maxFrame = Math.max(0, totalFrames - 1);
  const scriptListRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    if (selectedLine == null || !scriptListRef.current) return;
    const el = scriptListRef.current.querySelector(`[data-script-line="${selectedLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [selectedLine]);

  if (!project) {
    return <div className="flex flex-1 items-center justify-center text-sm text-studio-muted">Pick a project to open the stage.</div>;
  }

  function seekTo(nextFrame: number, scriptLine: number | null) {
    setFrame(nextFrame);
    onSelectLine(scriptLine);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col bg-black/40">
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="relative inline-block max-h-full max-w-full">
            {previewUrl ? (
              // Worker-served preview PNG
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={`Frame ${frame}`}
                className="max-h-[calc(100vh-340px)] max-w-full rounded-sm object-contain shadow-2xl"
              />
            ) : (
              <div className="flex h-[360px] w-[640px] max-w-full items-center justify-center rounded-sm border border-studio-border bg-studio-raised text-sm text-studio-muted">
                {loading ? "Parsing script…" : "Waiting for preview…"}
              </div>
            )}
            {previewUrl && selectedMark ? (
              <div
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-studio-accent shadow"
                style={{
                  left: `${(selectedMark.mark.x / canvas.width) * 100}%`,
                  top: `${(selectedMark.mark.y / canvas.height) * 100}%`,
                }}
                title={selectedMark.name}
              >
                <span className="absolute left-4 top-[-6px] whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {selectedMark.name}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-studio-border bg-studio-panel px-4 py-3">
          {error ? <p className="mb-2 text-xs text-red-400">{error}</p> : null}
          <div className="mb-2 flex items-center justify-between text-xs text-studio-muted">
            <span>
              {formatTimecode(frame, fps)} / {formatTimecode(maxFrame, fps)}
            </span>
            <span>
              frame {frame} · {fps} fps
              {sceneId ? ` · ${sceneId}` : ""}
            </span>
          </div>
          <input
            className="studio-scrubber w-full"
            type="range"
            min={0}
            max={maxFrame}
            value={Math.min(frame, maxFrame)}
            onChange={(event) => setFrame(Number(event.target.value))}
          />
        </div>
      </div>

      <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-studio-border bg-studio-panel">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Marks</h3>
          <p className="mb-2 text-[11px] text-studio-muted">
            {currentScene?.location ? `Location ${currentScene.location}` : "All locations"}
          </p>
          <ul className="space-y-1">
            {locationMarks.map((item) => {
              const active = selectedMark?.location === item.location && selectedMark?.name === item.name;
              return (
                <li key={`${item.location}:${item.name}`}>
                  <button
                    type="button"
                    onClick={() => setSelectedMark(active ? null : item)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                      active ? "bg-studio-accent/20 text-white" : "text-neutral-300 hover:bg-studio-raised"
                    }`}
                  >
                    <span>{item.name}</span>
                    <span className="text-[11px] text-studio-muted">
                      {Math.round(item.mark.x)}, {Math.round(item.mark.y)}
                    </span>
                  </button>
                </li>
              );
            })}
            {locationMarks.length === 0 ? <li className="text-sm text-studio-muted">No marks.</li> : null}
          </ul>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-studio-border p-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Layers</h3>
          <p className="mb-2 text-[11px] text-studio-muted">Read-only z order (front at top). Dragging comes later.</p>
          <ul className="space-y-1">
            {layers.map((layer) => (
              <li
                key={layer.id}
                className="flex items-center gap-2 rounded-md bg-studio-raised px-2 py-1.5 text-sm"
              >
                <span className="w-8 text-right font-mono text-[11px] text-studio-muted">{layer.z}</span>
                <span className="flex-1 truncate text-neutral-200">{layer.id}</span>
                <span className="rounded bg-black/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-studio-muted">
                  {layer.kind}
                </span>
              </li>
            ))}
            {layers.length === 0 ? <li className="text-sm text-studio-muted">No layers in this scene.</li> : null}
          </ul>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-studio-border p-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Script</h3>
          <p className="mb-2 text-[11px] text-studio-muted">Click a timeline block to seek and highlight its line.</p>
          <ol ref={scriptListRef} className="space-y-0.5 font-mono text-[11px] leading-5">
            {scriptLines.map((line, index) => {
              const n = index + 1;
              const active = selectedLine === n;
              return (
                <li key={n}>
                  <button
                    type="button"
                    data-script-line={n}
                    onClick={() => {
                      const hit = (lanes?.blocks || []).find((b) => b.scriptLine === n);
                      if (hit) seekTo(hit.startFrame, n);
                      else onSelectLine(n);
                    }}
                    className={`flex w-full gap-2 rounded px-1 text-left ${
                      active ? "bg-studio-accent/25 text-white" : "text-neutral-400 hover:bg-studio-raised"
                    }`}
                  >
                    <span className="w-6 shrink-0 text-right text-studio-muted">{n}</span>
                    <span className="truncate">{line || " "}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </aside>
    </div>
      <TimelineLanes lanes={lanes} frame={frame} selectedLine={selectedLine} onSeek={seekTo} />
    </div>
  );
}
