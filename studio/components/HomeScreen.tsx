"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  WORKER_START_COMMAND,
  assetUrl,
  checkWorker,
  createProject,
  fetchPreviewFrame,
  listProjects,
  type ProjectSummary,
} from "@/lib/worker";

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

export default function HomeScreen() {
  const router = useRouter();
  const [workerUp, setWorkerUp] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const up = await checkWorker();
    setWorkerUp(up);
    if (!up) {
      setProjects([]);
      return;
    }
    try {
      const list = await listProjects();
      setProjects(list);
      setError(null);
    } catch (err) {
      setWorkerUp(false);
      setError(err instanceof Error ? err.message : "Failed to load projects");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

      {workerUp === false ? (
        <div className="border-b border-amber-700/60 bg-amber-950/80 px-4 py-2 text-sm text-amber-100">
          Worker is not running. Start it with: <code className="font-mono">{WORKER_START_COMMAND}</code>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <h1 className="mb-6 text-2xl font-semibold text-white">Projects</h1>
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {projects.map((project) => {
            const src = previews[project.name] || assetUrl(project.name, project.thumbRel);
            return (
              <Link
                key={project.name}
                href={`/p/${encodeURIComponent(project.name)}`}
                className="group overflow-hidden rounded-lg border border-studio-border bg-studio-panel text-left hover:border-studio-accent/70"
                data-testid={`project-card-${project.name}`}
              >
                <div className="aspect-video bg-studio-raised">
                  {src ? (
                    // Worker-served PNG / preview blob
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-studio-muted">No preview</div>
                  )}
                </div>
                <div className="space-y-1 px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-white group-hover:text-studio-accent">{project.name}</p>
                  <p className="text-xs text-studio-muted">{formatDuration(project.durationSeconds, project.sceneCount)}</p>
                  <p className="truncate text-[11px] text-studio-muted">{formatRenderTime(project.lastRenderAt)}</p>
                </div>
              </Link>
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
      </main>
    </div>
  );
}
