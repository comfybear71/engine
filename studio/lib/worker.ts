export const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:4100").replace(
  /\/$/,
  ""
);

export const WORKER_START_COMMAND = "cd worker && npm start";

export class WorkerUnreachableError extends Error {
  constructor() {
    super(`Worker is not running. Start it with: ${WORKER_START_COMMAND}`);
    this.name = "WorkerUnreachableError";
  }
}

export type Drawing = { name: string; rel: string };
export type SlotCycle = { drawings: string[]; fps: number };
export type CharacterSlot = {
  name: string;
  owner: string | null;
  default_drawing: string | null;
  drawings: Drawing[];
  cycles: Record<string, SlotCycle>;
};
export type Character = {
  id: string;
  display_name: string;
  aliases: string[];
  source: "global" | "project";
  z: number;
  thumbRel: string | null;
  slots: CharacterSlot[];
};
export type Background = { id: string; source: "global" | "project"; thumbRel: string | null };
export type PropAsset = {
  id: string;
  location: string;
  z: number;
  x: number | null;
  y: number | null;
  scale: number;
  anchor: string;
  thumbRel: string | null;
};
export type Mark = { x: number; y: number; scale?: number; flip_x?: boolean };
export type Staging = {
  backgrounds: Background[];
  props: PropAsset[];
  marksByLocation: Record<string, Record<string, Mark>>;
};
export type StageLayer = {
  id: string;
  z: number;
  kind: "character" | "prop";
  character_id: string | null;
  prop_id: string | null;
  start_frame: number;
  end_frame: number | null;
};
export type StageScene = { id: string; location: string | null; layers: StageLayer[] };
export type StageInfo = {
  series?: string;
  episode?: string | number;
  fps: number;
  canvas: { width: number; height: number };
  scenes: StageScene[];
  marksByLocation: Record<string, Record<string, Mark>>;
};
export type PreviewMeta = {
  frame: number;
  totalFrames: number;
  fps: number;
  canvasWidth: number;
  canvasHeight: number;
  sceneId: string | null;
};
export type EstimatedSilent = { estimated: number; total: number; message: string };
export type RenderResponse = {
  ok: boolean;
  outputPath?: string;
  url?: string;
  estimatedSilent?: EstimatedSilent;
  error?: string;
};
export type LintIssue = { level: "error" | "warning"; line: number | null; message: string };
export type LintResult = { ok: boolean; lint: { errors: LintIssue[]; warnings: LintIssue[] }; saved?: boolean };
export type LaneId = "action" | "dialogue" | "audio" | "sfx" | "camera";
export type LaneBlock = {
  id: string;
  lane: LaneId;
  label: string;
  startFrame: number;
  endFrame: number;
  scriptLine: number | null;
  sceneId: string;
};
export type LaneScene = { id: string; startFrame: number; endFrame: number; frames: number };
export type LanesResponse = {
  fps: number;
  totalFrames: number;
  lanes: LaneId[];
  scenes: LaneScene[];
  blocks: LaneBlock[];
};
export type ProjectSummary = {
  name: string;
  scripts: string[];
  thumbRel: string | null;
  durationSeconds: number | null;
  sceneCount: number;
  lastRenderAt: string | null;
};
export type LibraryResponse = {
  characters: Character[];
  added: string[];
};

function withScript(path: string, script?: string | null): string {
  if (!script) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}script=${encodeURIComponent(script)}`;
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${WORKER_URL}${path}`, init);
  } catch {
    throw new WorkerUnreachableError();
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

export async function checkWorker(): Promise<boolean> {
  try {
    const res = await workerFetch("/health");
    return res.ok;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const res = await workerFetch("/api/projects");
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { projects: ProjectSummary[] };
  return body.projects;
}

export async function createProject(name: string): Promise<ProjectSummary> {
  const res = await workerFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as { project?: ProjectSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Create failed (${res.status})`);
  if (!body.project) throw new Error("Create failed");
  return body.project;
}

export async function loadScripts(name: string): Promise<string[]> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/scripts`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { scripts: string[] };
  return body.scripts;
}

export async function loadLibrary(name: string): Promise<LibraryResponse> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/library`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<LibraryResponse>;
}

export async function addLibraryCharacter(name: string, characterId: string): Promise<void> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function loadCharacters(name: string): Promise<Character[]> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/characters`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { characters: Character[] };
  return body.characters;
}

export async function loadStaging(name: string): Promise<Staging> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/staging`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<Staging>;
}

export async function loadStage(name: string, script?: string | null): Promise<StageInfo> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/stage`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StageInfo>;
}

export function assetUrl(project: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  return `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/asset?rel=${encodeURIComponent(rel)}`;
}

export async function fetchPreviewFrame(
  name: string,
  frame: number,
  signal?: AbortSignal,
  script?: string | null
): Promise<{ blob: Blob; meta: PreviewMeta }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/preview-frame`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frame }),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  const blob = await res.blob();
  const meta: PreviewMeta = {
    frame: Number(res.headers.get("X-Engine-Frame") ?? frame),
    totalFrames: Number(res.headers.get("X-Engine-Total-Frames") ?? 0),
    fps: Number(res.headers.get("X-Engine-Fps") ?? 24),
    canvasWidth: Number(res.headers.get("X-Engine-Canvas-Width") ?? 1920),
    canvasHeight: Number(res.headers.get("X-Engine-Canvas-Height") ?? 1080),
    sceneId: res.headers.get("X-Engine-Scene-Id"),
  };
  return { blob, meta };
}

export async function loadScript(name: string, script?: string | null): Promise<string> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/script`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.text();
}

export async function saveScript(name: string, text: string, script?: string | null): Promise<LintResult> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/script`, script), {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: text,
  });
  const body = (await res.json().catch(() => ({}))) as LintResult & { error?: string };
  if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
  return body;
}

export async function lintScript(name: string, text?: string, script?: string | null): Promise<LintResult> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/lint`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(text == null ? {} : { text }),
  });
  const body = (await res.json().catch(() => ({}))) as LintResult & { error?: string };
  if (!res.ok) throw new Error(body.error || `Lint failed (${res.status})`);
  return body;
}

export async function loadLanes(name: string, script?: string | null): Promise<LanesResponse> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/lanes`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<LanesResponse>;
}

export async function startRender(name: string, script?: string | null): Promise<RenderResponse> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/render`, script), {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as RenderResponse;
  if (!res.ok) {
    throw new Error(body.error || `Render failed (${res.status})`);
  }
  return body;
}

export function renderOutputFile(script?: string | null): string {
  const base = (script || "script.txt").replace(/\.txt$/i, "") || "script";
  return `${base}.mp4`;
}

export function renderVideoUrl(name: string, bust?: number, script?: string | null): string {
  const file = renderOutputFile(script);
  const qs = bust ? `?t=${bust}` : "";
  return `${WORKER_URL}/api/projects/${encodeURIComponent(name)}/renders/${encodeURIComponent(file)}${qs}`;
}
