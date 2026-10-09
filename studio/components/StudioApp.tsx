"use client";

import { useCallback, useEffect, useState } from "react";
import AssetsPanel from "@/components/AssetsPanel";
import ScriptPanel from "@/components/ScriptPanel";
import StagePanel from "@/components/StagePanel";
import {
  WORKER_START_COMMAND,
  checkWorker,
  listProjects,
  renderVideoUrl,
  startRender,
  type RenderResponse,
} from "@/lib/worker";

const TABS = [
  { id: "assets", label: "Assets", ready: true },
  { id: "stage", label: "Stage", ready: true },
  { id: "script", label: "Script", ready: true },
  { id: "edit", label: "Edit", ready: false },
  { id: "deliver", label: "Deliver", ready: false },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function StudioApp() {
  const [tab, setTab] = useState<TabId>("assets");
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResponse | null>(null);
  const [videoBust, setVideoBust] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [selectedScriptLine, setSelectedScriptLine] = useState<number | null>(null);
  const [scriptEpoch, setScriptEpoch] = useState(0);

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) {
      setProjects([]);
      return;
    }
    try {
      const names = await listProjects();
      setProjects(names);
      setProject((current) => {
        if (current && names.includes(current)) return current;
        return names.includes("sample") ? "sample" : names[0] ?? null;
      });
    } catch {
      setWorkerUp(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function onRender() {
    if (!project || rendering) return;
    setRendering(true);
    setRenderStatus("Rendering…");
    setRenderResult(null);
    setShowVideo(false);
    try {
      const result = await startRender(project);
      setRenderResult(result);
      setVideoBust(Date.now());
      setShowVideo(true);
      const silent = result.estimatedSilent ? ` ${result.estimatedSilent.message}.` : "";
      setRenderStatus(`Done.${silent}`);
    } catch (err) {
      setRenderStatus(err instanceof Error ? err.message : "Render failed");
    } finally {
      setRendering(false);
    }
  }

  const active = TABS.find((item) => item.id === tab)!;
  const videoSrc = project && videoBust ? renderVideoUrl(project, videoBust) : null;

  return (
    <div className="flex h-screen flex-col bg-studio-bg">
      <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-studio-border bg-studio-panel px-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-studio-accent text-xs font-bold text-black">▶</span>
            <span className="text-sm font-semibold tracking-wide text-white">Engine Studio</span>
          </div>
          <label className="flex items-center gap-2 text-xs text-studio-muted">
            Project
            <select
              className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
              value={project ?? ""}
              onChange={(event) => setProject(event.target.value || null)}
              disabled={!workerUp || projects.length === 0}
            >
              {projects.length === 0 ? <option value="">No projects</option> : null}
              {projects.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <nav className="flex items-end gap-1">
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

        <div className="flex items-center justify-end gap-3">
          {renderStatus ? (
            <span className="hidden max-w-[280px] truncate text-xs text-studio-muted lg:inline" title={renderStatus}>
              {renderStatus}
              {videoSrc ? (
                <>
                  {" "}
                  <button type="button" className="text-studio-accent hover:underline" onClick={() => setShowVideo(true)}>
                    show video
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void onRender()}
            disabled={!project || !workerUp || rendering}
            className="inline-flex items-center gap-2 rounded-md bg-studio-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-studio-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden>▶</span>
            {rendering ? "Rendering" : "Render"}
          </button>
        </div>
      </header>

      {workerUp === false ? (
        <div className="border-b border-amber-700/60 bg-amber-950/80 px-4 py-2 text-sm text-amber-100">
          Worker is not running. Start it with: <code className="font-mono">{WORKER_START_COMMAND}</code>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "assets" ? <AssetsPanel project={project} workerUp={workerUp === true} /> : null}
        {tab === "stage" ? (
          <StagePanel
            project={project}
            workerUp={workerUp === true}
            scriptEpoch={scriptEpoch}
            selectedLine={selectedScriptLine}
            onSelectLine={setSelectedScriptLine}
          />
        ) : null}
        {tab === "script" ? (
          <ScriptPanel
            project={project}
            workerUp={workerUp === true}
            selectedLine={selectedScriptLine}
            onSelectLine={setSelectedScriptLine}
            onSaved={() => setScriptEpoch((n) => n + 1)}
          />
        ) : null}
        {!active.ready ? <PlaceholderPage name={active.label} /> : null}
      </main>

      {showVideo && videoSrc ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-4xl rounded-md border border-studio-border bg-studio-panel p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-white">Render</h2>
              <button
                type="button"
                className="text-sm text-studio-muted hover:text-white"
                onClick={() => setShowVideo(false)}
              >
                Close
              </button>
            </div>
            <video key={videoBust || "render"} className="max-h-[70vh] w-full bg-black" controls src={videoSrc} />
            {renderStatus ? <p className="mt-2 text-xs text-studio-muted">{renderStatus}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PlaceholderPage({ name }: { name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-medium text-white">{name}</p>
      <p className="max-w-md text-sm text-studio-muted">
        Placeholder for a later PR. This tab is not wired up yet — Assets, Stage, and Script are the current surfaces.
      </p>
    </div>
  );
}
