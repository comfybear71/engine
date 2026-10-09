"use client";

import { useCallback, useEffect, useState } from "react";

import { Timeline } from "@/app/components/Timeline";
import {
  WORKER_START_COMMAND,
  WORKER_URL,
  WorkerUnreachableError,
  checkWorker,
  listProjects,
  loadScript,
  loadTimeline,
  renderVideoUrl,
  saveScript,
  startRender,
  type LintIssue,
  type TimelineDoc,
} from "@/lib/worker";

export default function StudioPage() {
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [script, setScript] = useState("");
  const [dirty, setDirty] = useState(false);
  const [lint, setLint] = useState<LintIssue[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [status, setStatus] = useState("");
  const [videoBust, setVideoBust] = useState<number | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  const refreshProjects = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) {
      setProjects([]);
      return;
    }
    const names = await listProjects();
    setProjects(names);
    setProject((current) => current || names[0] || "");
  }, []);

  useEffect(() => {
    refreshProjects().catch((err: unknown) => {
      setWorkerUp(false);
      setStatus(err instanceof Error ? err.message : String(err));
    });
  }, [refreshProjects]);

  useEffect(() => {
    if (!project || workerUp === false) return;
    let cancelled = false;
    (async () => {
      try {
        const [text, doc] = await Promise.all([loadScript(project), loadTimeline(project)]);
        if (cancelled) return;
        setScript(text);
        setDirty(false);
        setTimeline(doc);
        setLint([]);
        setVideoBust(Date.now());
        setVideoFailed(false);
        setStatus("");
      } catch (err) {
        if (err instanceof WorkerUnreachableError) setWorkerUp(false);
        setStatus(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, workerUp]);

  const onSave = useCallback(async () => {
    if (!project) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const result = await saveScript(project, script);
      const issues = [...result.lint.errors, ...result.lint.warnings];
      setLint(issues);
      setDirty(false);
      const doc = await loadTimeline(project);
      setTimeline(doc);
      setStatus(result.ok ? "Saved." : "Saved, with lint issues.");
    } catch (err) {
      if (err instanceof WorkerUnreachableError) setWorkerUp(false);
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [project, script]);

  const onRender = useCallback(async () => {
    if (!project) return;
    setRendering(true);
    setStatus("Rendering…");
    try {
      if (dirty) {
        const result = await saveScript(project, script);
        setLint([...result.lint.errors, ...result.lint.warnings]);
        setDirty(false);
        if (!result.ok) {
          setStatus("Fix lint errors before rendering.");
          setRendering(false);
          return;
        }
      }
      const result = await startRender(project);
      setVideoBust(Date.now());
      setVideoFailed(false);
      const silent = result.estimatedSilent?.message || "";
      setStatus([result.outputPath ? `Wrote ${result.outputPath}` : "Render done.", silent].filter(Boolean).join(" · "));
      const doc = await loadTimeline(project);
      setTimeline(doc);
    } catch (err) {
      if (err instanceof WorkerUnreachableError) setWorkerUp(false);
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setRendering(false);
    }
  }, [dirty, project, script]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  const workerDown = workerUp === false;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">Engine Studio</h1>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          Project
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
            value={project}
            disabled={workerDown || projects.length === 0}
            onChange={(event) => setProject(event.target.value)}
          >
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void onRender()}
          disabled={workerDown || !project || rendering}
          className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-700"
        >
          {rendering ? "Rendering…" : "Render"}
        </button>
        <div className="ml-auto text-xs text-neutral-500">worker {WORKER_URL}</div>
      </header>

      {workerDown ? (
        <div className="border-b border-amber-900 bg-amber-950/60 px-4 py-3 text-sm text-amber-100">
          Worker is not running. Start it with: <code className="font-mono">{WORKER_START_COMMAND}</code>
          <span className="ml-2 text-amber-200/70">
            ({WORKER_URL} — that command runs <code className="font-mono">node src/server.js</code> from worker/)
          </span>
        </div>
      ) : null}

      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <section className="flex min-h-0 flex-col border-r border-neutral-800">
          <div className="flex items-center justify-between px-3 py-2 text-xs text-neutral-400">
            <span>script.txt {dirty ? "· unsaved" : ""}</span>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={workerDown || !project || saving}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-500"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <textarea
            className="min-h-0 flex-1 resize-none bg-neutral-950 px-3 py-2 font-mono text-sm leading-6 text-neutral-100 outline-none"
            spellCheck={false}
            value={script}
            disabled={workerDown || !project}
            onChange={(event) => {
              setScript(event.target.value);
              setDirty(true);
            }}
          />
          <div className="max-h-40 overflow-auto border-t border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs">
            {lint.length === 0 ? (
              <div className="text-neutral-500">No lint issues.</div>
            ) : (
              <ul className="space-y-1">
                {lint.map((issue, index) => (
                  <li
                    key={`${issue.level}-${issue.line}-${index}`}
                    className={issue.level === "error" ? "text-red-400" : "text-amber-300"}
                  >
                    {issue.level === "error" ? "error" : "warning"}
                    {issue.line != null ? ` · line ${issue.line}` : ""}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Timeline timeline={timeline} />
          </div>
          <div className="shrink-0 border-t border-neutral-800 bg-black p-3">
            {project && videoBust && !videoFailed ? (
              <video
                key={videoBust}
                className="max-h-64 w-full bg-black"
                controls
                src={renderVideoUrl(project, videoBust)}
                onError={() => setVideoFailed(true)}
              />
            ) : (
              <div className="py-8 text-center text-xs text-neutral-500">
                No render yet. Use Render to write renders/output.mp4.
              </div>
            )}
            {status ? <div className="mt-2 text-xs text-neutral-400">{status}</div> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
