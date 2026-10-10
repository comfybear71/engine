"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AssetsPanel from "@/components/AssetsPanel";
import EngineStatus from "@/components/EngineStatus";
import ImagineDock from "@/components/ImagineDock";
import ScriptPanel from "@/components/ScriptPanel";
import StagePanel from "@/components/StagePanel";
import StudioSettings from "@/components/StudioSettings";
import {
  checkWorker,
  loadScripts,
  loadShow,
  renderVideoUrl,
  setActiveShowId,
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

export default function StudioApp({
  projectName,
  showId,
}: {
  projectName: string;
  showId?: string;
}) {
  const project = projectName;
  const [showName, setShowName] = useState<string | null>(showId || null);
  const [tab, setTab] = useState<TabId>("stage");
  const [scripts, setScripts] = useState<string[]>([]);
  const [script, setScript] = useState<string>("script.txt");
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResponse | null>(null);
  const [videoBust, setVideoBust] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [selectedScriptLine, setSelectedScriptLine] = useState<number | null>(null);
  const [scriptEpoch, setScriptEpoch] = useState(0);
  const [imagineOpen, setImagineOpen] = useState(false);
  const [imagineNeedId, setImagineNeedId] = useState<string | null>(null);
  const [assetCharacterId, setAssetCharacterId] = useState<string | null>(null);
  const [assetEpoch, setAssetEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setActiveShowId(showId || null);
    return () => setActiveShowId(null);
  }, [showId]);

  useEffect(() => {
    if (!showId) return;
    void loadShow(showId)
      .then((body) => setShowName(body.show.name))
      .catch(() => setShowName(showId));
  }, [showId]);

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) return;
    try {
      const names = await loadScripts(project);
      setScripts(names);
      setScript((current) => {
        if (current && names.includes(current)) return current;
        return names.includes("script.txt") ? "script.txt" : names[0] ?? "script.txt";
      });
    } catch {
      setWorkerUp(false);
    }
  }, [project]);

  useEffect(() => {
    void refresh();
    const ms = workerUp === true ? 4000 : 2000;
    const id = window.setInterval(() => void refresh(), ms);
    return () => window.clearInterval(id);
  }, [refresh, workerUp]);

  async function onRender() {
    if (!project || rendering) return;
    setRendering(true);
    setRenderStatus("Rendering…");
    setRenderResult(null);
    setShowVideo(false);
    try {
      const result = await startRender(project, script);
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
  const videoSrc = project && videoBust ? renderVideoUrl(project, videoBust, script) : null;

  return (
    <div className="flex h-screen flex-col bg-studio-bg">
      <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-studio-border bg-studio-panel px-3">
        <div className="flex items-center gap-3">
          <Link
            href={showId ? `/s/${encodeURIComponent(showId)}` : "/"}
            className="text-xs text-studio-muted hover:text-white"
            data-testid="back-home"
          >
            {showId ? "← Show" : "← Home"}
          </Link>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-studio-accent text-xs font-bold text-black">▶</span>
            <span className="text-sm font-semibold tracking-wide text-white">Engine Studio</span>
          </div>
          <span className="truncate text-sm text-neutral-200" data-testid="project-name">
            {showId ? (
              <>
                <Link href={`/s/${encodeURIComponent(showId)}`} className="hover:text-studio-accent">
                  {showName || showId}
                </Link>
                <span className="px-1 text-studio-muted">›</span>
                {project}
              </>
            ) : (
              project
            )}
          </span>
          <label className="flex items-center gap-2 text-xs text-studio-muted">
            Script
            <select
              className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
              value={script}
              onChange={(event) => {
                setScript(event.target.value);
                setSelectedScriptLine(null);
                setScriptEpoch((n) => n + 1);
              }}
              disabled={!workerUp || scripts.length === 0}
              data-testid="script-select"
            >
              {scripts.length === 0 ? <option value="script.txt">script.txt</option> : null}
              {scripts.map((name) => (
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
            data-testid="studio-settings"
            onClick={() => setSettingsOpen(true)}
            className="text-xs text-studio-muted hover:text-white"
          >
            Settings
          </button>
          <button
            type="button"
            data-testid="studio-render"
            onClick={() => void onRender()}
            disabled={!project || !workerUp || rendering}
            className="inline-flex items-center gap-2 rounded-md bg-studio-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-studio-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden>▶</span>
            {rendering ? "Rendering" : "Render"}
          </button>
        </div>
      </header>

      <EngineStatus workerUp={workerUp} onRetry={() => void refresh()} />

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "assets" ? (
          <AssetsPanel
            project={project}
            script={script}
            workerUp={workerUp === true}
            onLibraryChange={() => {
              setAssetEpoch((n) => n + 1);
              void refresh();
            }}
            selectedId={assetCharacterId}
            onSelectId={setAssetCharacterId}
            onOpenImagine={(opts) => {
              if (opts?.characterId) setAssetCharacterId(opts.characterId);
              if (opts?.needId) setImagineNeedId(opts.needId);
              setImagineOpen(true);
            }}
            refreshToken={assetEpoch}
          />
        ) : null}
        {tab === "stage" ? (
          <StagePanel
            project={project}
            script={script}
            workerUp={workerUp === true}
            scriptEpoch={scriptEpoch}
            selectedLine={selectedScriptLine}
            onSelectLine={setSelectedScriptLine}
            onSaved={() => setScriptEpoch((n) => n + 1)}
            renderNonce={videoBust}
            onOpenImagine={(opts) => {
              setAssetCharacterId(opts.characterId);
              setImagineNeedId(opts.needId);
              setImagineOpen(true);
            }}
          />
        ) : null}
        {tab === "script" ? (
          <ScriptPanel
            project={project}
            script={script}
            workerUp={workerUp === true}
            scriptEpoch={scriptEpoch}
            selectedLine={selectedScriptLine}
            onSelectLine={setSelectedScriptLine}
            onSaved={() => setScriptEpoch((n) => n + 1)}
          />
        ) : null}
        {!active.ready ? <PlaceholderPage name={active.label} /> : null}
      </main>

      <StudioSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChanged={() => setAssetEpoch((n) => n + 1)}
      />

      <ImagineDock
        project={project}
        workerUp={workerUp === true}
        open={imagineOpen}
        characterId={assetCharacterId}
        needId={imagineNeedId}
        onOpenChange={setImagineOpen}
        onCharacterId={setAssetCharacterId}
        onNeedId={setImagineNeedId}
        refreshToken={assetEpoch}
        onChanged={() => {
          setAssetEpoch((n) => n + 1);
          void refresh();
        }}
      />

      {showVideo && videoSrc ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-4xl rounded-md border border-studio-border bg-studio-panel p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-white">Render · {script}</h2>
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
            {renderResult?.url ? (
              <p className="mt-1 font-mono text-[11px] text-studio-muted">{renderResult.url}</p>
            ) : null}
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
