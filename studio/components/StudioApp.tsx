"use client";

import { useCallback, useEffect, useState } from "react";
import AssetsPanel from "@/components/AssetsPanel";
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
  { id: "script", label: "Script", ready: false },
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
    try {
      const result = await startRender(project);
      setRenderResult(result);
      const silent = result.estimatedSilent ? ` ${result.estimatedSilent.message}.` : "";
      setRenderStatus(`Done.${silent}`);
    } catch (err) {
      setRenderStatus(err instanceof Error ? err.message : "Render failed");
    } finally {
      setRendering(false);
    }
  }

  const active = TABS.find((item) => item.id === tab)!;

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
              {renderResult?.url && project ? (
                <>
                  {" "}
                  <a
                    className="text-studio-accent hover:underline"
                    href={renderVideoUrl(project, Date.now())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open mp4
                  </a>
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
        {tab === "stage" ? <StagePanel project={project} workerUp={workerUp === true} /> : null}
        {!active.ready ? <PlaceholderPage name={active.label} /> : null}
      </main>
    </div>
  );
}

function PlaceholderPage({ name }: { name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-medium text-white">{name}</p>
      <p className="max-w-md text-sm text-studio-muted">
        Placeholder for a later PR. This tab is not wired up yet — Assets and Stage are the v1 surfaces.
      </p>
    </div>
  );
}
