export const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:4100").replace(
  /\/$/,
  ""
);

export const WORKER_START_COMMAND = "cd worker && npm start";

export type LintIssue = {
  level: "error" | "warning";
  line: number | null;
  message: string;
};

export type LintReport = {
  errors: LintIssue[];
  warnings: LintIssue[];
};

export type TimelineSummary = {
  series?: string;
  episode?: string | number;
  fps?: number;
  sceneCount: number;
  scenes: { id: string; layerCount: number; dialogueCount: number }[];
};

export type LinesSummary = {
  total: number;
  missing: number;
  ok: number;
};

export type SaveScriptResponse = {
  ok: boolean;
  saved: boolean;
  lint: LintReport;
  timeline: TimelineSummary | null;
  lines: LinesSummary | null;
};

export type EstimatedSilent = {
  estimated: number;
  total: number;
  message: string;
};

export type RenderResponse = {
  ok: boolean;
  outputPath?: string;
  estimatedSilent?: EstimatedSilent;
  error?: string;
};

export type DialogueClip = {
  audio: string;
  start_frame: number;
  text?: string;
  estimated?: boolean;
  estimated_duration_seconds?: number;
};

export type TimelineLayer = {
  id: string;
  character_id?: string;
  dialogue?: DialogueClip[];
  timing?: { start_frame?: number; end_frame?: number };
};

export type TimelineScene = {
  id: string;
  duration?: { frames?: number; padding_frames?: number; from_dialogue?: boolean };
  layers?: TimelineLayer[];
};

export type TimelineDoc = {
  series?: string;
  episode?: string | number;
  fps: number;
  scenes: TimelineScene[];
};

export class WorkerUnreachableError extends Error {
  constructor() {
    super(`Worker is not running. Start it with: ${WORKER_START_COMMAND}`);
    this.name = "WorkerUnreachableError";
  }
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${WORKER_URL}${path}`, init);
  } catch {
    throw new WorkerUnreachableError();
  }
}

export async function checkWorker(): Promise<boolean> {
  try {
    const res = await workerFetch("/health");
    return res.ok;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<string[]> {
  const res = await workerFetch("/api/projects");
  if (!res.ok) throw new Error(`Failed to list projects (${res.status})`);
  const body = (await res.json()) as { projects: { name: string }[] };
  return body.projects.map((p) => p.name);
}

export async function loadScript(name: string): Promise<string> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/script`);
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`Failed to load script (${res.status})`);
  return res.text();
}

export async function saveScript(name: string, script: string): Promise<SaveScriptResponse> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/script`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: script,
  });
  if (!res.ok) throw new Error(`Failed to save script (${res.status})`);
  return res.json() as Promise<SaveScriptResponse>;
}

export async function loadTimeline(name: string): Promise<TimelineDoc | null> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/timeline`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load timeline (${res.status})`);
  return res.json() as Promise<TimelineDoc>;
}

export async function startRender(name: string): Promise<RenderResponse> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/render`, {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as RenderResponse;
  if (!res.ok) {
    throw new Error(body.error || `Render failed (${res.status})`);
  }
  return body;
}

export function renderVideoUrl(name: string, bust?: number): string {
  const qs = bust ? `?t=${bust}` : "";
  return `${WORKER_URL}/api/projects/${encodeURIComponent(name)}/renders/output.mp4${qs}`;
}
