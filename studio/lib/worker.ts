export const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:4100").replace(
  /\/$/,
  ""
);

export class WorkerUnreachableError extends Error {
  constructor() {
    super("The engine isn't running yet.");
    this.name = "WorkerUnreachableError";
  }
}

export type Drawing = { name: string; rel: string; mtime?: number | null; view?: string };
export type SlotCycle = { drawings: string[]; fps: number };
export type SlotView = { id: string; drawingsDir: string; drawings: Drawing[] };
export type CharacterSlot = {
  name: string;
  owner: string | null;
  default_drawing: string | null;
  drawings: Drawing[];
  views?: SlotView[];
  cycles: Record<string, SlotCycle>;
  offset: { x: number; y: number };
  scale: number;
  rotation: number;
};
export type Character = {
  id: string;
  display_name: string;
  aliases: string[];
  source: "global" | "show" | "project";
  z: number;
  style: string;
  asset: string | null;
  thumbRel: string | null;
  bodyRel: string | null;
  mtime?: number | null;
  reference: string | null;
  referenceRel: string | null;
  referenceMtime?: number | null;
  slots: CharacterSlot[];
};
export type Background = {
  id: string;
  source: "global" | "show" | "project";
  thumbRel: string | null;
  mtime?: number | null;
};
export type PropAsset = {
  id: string;
  location: string;
  z: number;
  x: number | null;
  y: number | null;
  scale: number;
  anchor: string;
  thumbRel: string | null;
  mtime?: number | null;
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
export type LaneId = "body" | "face" | "props" | "dialogue" | "mouth" | "audio" | "sfx" | "camera";
export type LaneTimingKind = "over" | "for" | "pin" | "audio" | "dialogue";
export type LaneTimingAttr = "over" | "for" | "hold" | "at_time" | "start" | null;
export type LaneTiming = {
  kind: LaneTimingKind;
  tag: string;
  attr: LaneTimingAttr;
  movable: boolean;
};
export type LaneBlock = {
  id: string;
  lane: LaneId;
  label: string;
  startFrame: number;
  endFrame: number;
  scriptLine: number | null;
  sceneId: string;
  rel: string | null;
  row?: number;
  tag?: string | null;
  sourceStartFrame?: number;
  timing?: LaneTiming | null;
  movable?: boolean;
  cues?: { shape: string; start: number; end: number; pinned?: boolean }[];
  view?: string | null;
  marriedId?: string | null;
  role?: "mouth" | "pin" | null;
  implicitHold?: boolean;
  faceOverridesMouth?: boolean;
  trim?: { inFrames: number; outFrames: number };
  sourceDurationFrames?: number;
  words?: { word: string; start: number; end: number }[];
  audioRel?: string | null;
  cuesRel?: string | null;
  sync?: "not_synced" | "synced" | "stale" | null;
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
  showId?: string | null;
  scripts: string[];
  thumbRel: string | null;
  thumbMtime?: number | null;
  durationSeconds: number | null;
  sceneCount: number;
  lastRenderAt: string | null;
};
export type ByteCount = { files: number; bytes: number };
export type ProjectContents = {
  scripts: string[];
  scriptBytes: number;
  audio: ByteCount;
  renders: ByteCount;
  localAssets: ByteCount;
  libraryJsonBytes: number;
  totalBytes: number;
};
export type TrashItem = {
  id: string;
  originalName: string;
  deletedAt: string;
  bytes: number;
  kind?: "project" | "episode" | "show";
  showId?: string | null;
};
export type LibraryResponse = {
  characters: Character[];
  added: string[];
};

let activeShowId: string | null = null;

export function setActiveShowId(showId: string | null | undefined) {
  activeShowId = showId && showId.trim() ? showId.trim() : null;
}

export function getActiveShowId(): string | null {
  return activeShowId;
}

function withShow(path: string): string {
  if (!activeShowId) return path;
  if (/[?&]show=/.test(path)) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}show=${encodeURIComponent(activeShowId)}`;
}

function withScript(path: string, script?: string | null): string {
  if (!script) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}script=${encodeURIComponent(script)}`;
}

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const next = path.startsWith("/api/projects/") ? withShow(path) : path;
  try {
    return await fetch(`${WORKER_URL}${next}`, init);
  } catch (err) {
    if (init?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
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

export type IngestCell = {
  index: number;
  suggestedName: string;
  empty: boolean;
  width: number;
  height: number;
  pngBase64: string;
};

export type IngestPreview = {
  ok: boolean;
  sessionId: string;
  libraryRel: string;
  needId: string;
  grid: { cols: number; rows: number } | null;
  cells: IngestCell[];
};

export type IngestConfirmResult = {
  ok: boolean;
  written: { name: string; rel: string }[];
  characterId: string;
};

export async function addLibraryCharacter(name: string, characterId: string): Promise<void> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function saveCharacterStyle(name: string, characterId: string, style: string): Promise<void> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style }),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
}

export type CharacterReferenceResult = { ok: boolean; reference: string; referenceRel: string };

export async function saveCharacterReference(
  name: string,
  characterId: string,
  body: { imageBase64: string; filename?: string }
): Promise<CharacterReferenceResult> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/reference`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<CharacterReferenceResult>;
}

export type SlotAlignment = {
  offset: { x: number; y: number };
  scale: number;
  rotation: number;
};

export async function saveSlotAlignment(
  name: string,
  characterId: string,
  slotName: string,
  body: Partial<SlotAlignment>
): Promise<SlotAlignment & { ok: boolean; slot: string }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/slots/${encodeURIComponent(slotName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<SlotAlignment & { ok: boolean; slot: string }>;
}

export async function previewCharacterIngest(
  name: string,
  characterId: string,
  body: { needId: string; imageBase64: string; filename?: string; frames?: number }
): Promise<IngestPreview> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/ingest`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<IngestPreview>;
}

export async function confirmCharacterIngest(
  name: string,
  characterId: string,
  body: { sessionId: string; assignments: { index: number; name: string }[] }
): Promise<IngestConfirmResult> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/ingest/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<IngestConfirmResult>;
}

export async function cancelCharacterIngest(name: string, characterId: string, sessionId: string): Promise<void> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/ingest/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }
  );
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

export type ProjectAudioFile = {
  kind: "imported" | "generated";
  label: string;
  sceneId: string | null;
  characterId: string;
  characterName: string;
  rel: string;
  durationSeconds: number | null;
  mtime?: number | null;
};

export async function loadProjectAudio(name: string): Promise<ProjectAudioFile[]> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/audio`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { files?: ProjectAudioFile[] };
  return body.files || [];
}

export async function loadStage(name: string, script?: string | null): Promise<StageInfo> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/stage`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StageInfo>;
}

export function assetUrl(
  project: string,
  rel: string | null | undefined,
  opts?: { thumb?: boolean; v?: number | string | null }
): string | null {
  if (!rel) return null;
  const params = new URLSearchParams({ rel });
  if (opts?.thumb) params.set("thumb", "1");
  if (opts?.v != null && opts.v !== "") params.set("v", String(opts.v));
  return `${WORKER_URL}${withShow(`/api/projects/${encodeURIComponent(project)}/asset?${params.toString()}`)}`;
}

function showQuery(showId?: string | null): string {
  return showId ? `?show=${encodeURIComponent(showId)}` : "";
}

export async function loadProjectContents(name: string, showId?: string | null): Promise<ProjectContents> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/contents${showQuery(showId)}`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { contents: ProjectContents };
  return body.contents;
}

export async function trashProject(name: string, confirmName: string, showId?: string | null): Promise<void> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/trash${showQuery(showId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmName }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function renameProject(name: string, newName: string, showId?: string | null): Promise<ProjectSummary> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/rename${showQuery(showId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  const body = (await res.json().catch(() => ({}))) as { project?: ProjectSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Rename failed (${res.status})`);
  if (!body.project) throw new Error("Rename failed");
  return body.project;
}

export async function duplicateProject(name: string, showId?: string | null): Promise<ProjectSummary> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/duplicate${showQuery(showId)}`, {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as { project?: ProjectSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Duplicate failed (${res.status})`);
  if (!body.project) throw new Error("Duplicate failed");
  return body.project;
}

export function downloadProjectUrl(name: string, showId?: string | null): string {
  const show = showId || activeShowId;
  const path = `/api/projects/${encodeURIComponent(name)}/download`;
  return `${WORKER_URL}${show ? `${path}?show=${encodeURIComponent(show)}` : path}`;
}

export async function listTrash(): Promise<TrashItem[]> {
  const res = await workerFetch("/api/trash");
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { trash: TrashItem[] };
  return body.trash;
}

export async function restoreTrash(id: string): Promise<{ project?: ProjectSummary; show?: ShowSummary }> {
  const res = await workerFetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as {
    project?: ProjectSummary;
    show?: ShowSummary;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `Restore failed (${res.status})`);
  if (!body.project && !body.show) throw new Error("Restore failed");
  return body;
}

export async function emptyTrash(): Promise<void> {
  const res = await workerFetch("/api/trash/empty", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "empty" }),
  });
  if (!res.ok) throw new Error(await readError(res));
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

export type ScriptHistorySnapshot = {
  id: string;
  createdAt: string;
  bytes: number;
  preview: string;
};

export async function loadScriptHistory(
  name: string,
  script?: string | null
): Promise<{ script: string; snapshots: ScriptHistorySnapshot[] }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/script-history`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ script: string; snapshots: ScriptHistorySnapshot[] }>;
}

export async function restoreScriptHistory(
  name: string,
  id: string,
  script?: string | null
): Promise<LintResult & { text?: string; restored?: boolean; id?: string }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/script-history/restore`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = (await res.json().catch(() => ({}))) as LintResult & {
    error?: string;
    text?: string;
    restored?: boolean;
    id?: string;
  };
  if (!res.ok) throw new Error(body.error || `Restore failed (${res.status})`);
  return body;
}

export async function saveScript(
  name: string,
  text: string,
  script?: string | null,
  opts?: { parse?: boolean }
): Promise<LintResult> {
  const path = withScript(`/api/projects/${encodeURIComponent(name)}/script`, script);
  const url = opts?.parse === false ? `${path}${path.includes("?") ? "&" : "?"}parse=0` : path;
  const res = await workerFetch(url, {
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

export type LipSyncNaturalSettings = {
  smoothing: "off" | "light" | "medium";
  head_bob: "off" | "subtle" | "strong";
  blinks: boolean;
  loud_threshold: number;
};

export type StudioSettings = {
  lipSync: "auto" | "manual";
  lipsync?: LipSyncNaturalSettings;
};

export const DEFAULT_LIPSYNC_SETTINGS: LipSyncNaturalSettings = {
  smoothing: "light",
  head_bob: "subtle",
  blinks: true,
  loud_threshold: 0.75,
};
export type LipSyncResult = {
  scriptLine: number;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  message?: string;
  sync?: "not_synced" | "synced" | "stale";
  cuesPath?: string;
};

export async function loadStudioSettings(name: string): Promise<StudioSettings> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/settings`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StudioSettings>;
}

export async function saveStudioSettings(name: string, patch: Partial<StudioSettings>): Promise<StudioSettings> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StudioSettings>;
}

export async function syncDialogue(
  name: string,
  body: { all?: boolean; scriptLine?: number; scriptLines?: number[]; force?: boolean; clear?: boolean },
  script?: string | null
): Promise<{ ok: boolean; lipSync: "auto" | "manual"; results: LipSyncResult[] }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/lipsync`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    lipSync?: "auto" | "manual";
    results?: LipSyncResult[];
    error?: string;
  };
  if (!res.ok) throw new Error(payload.error || `Lip-sync failed (${res.status})`);
  return {
    ok: payload.ok !== false,
    lipSync: payload.lipSync === "manual" ? "manual" : "auto",
    results: payload.results || [],
  };
}

export type MouthCuePatch = {
  rel: string;
  start: number;
  end: number;
  value?: string;
  pinned?: boolean;
};

export async function saveMouthCue(name: string, patch: MouthCuePatch): Promise<{ ok: boolean; cue: { start: number; end: number; value: string; pinned: boolean } }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/cues`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    cue?: { start: number; end: number; value: string; pinned: boolean };
    error?: string;
  };
  if (!res.ok || !payload.cue) throw new Error(payload.error || `Cue save failed (${res.status})`);
  return { ok: payload.ok !== false, cue: payload.cue };
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

export function renderVideoUrl(
  name: string,
  bust?: number,
  script?: string | null,
  file?: string | null
): string {
  const output = file || renderOutputFile(script);
  const qs = bust ? `?t=${bust}` : "";
  return `${WORKER_URL}${withShow(`/api/projects/${encodeURIComponent(name)}/renders/${encodeURIComponent(output)}${qs}`)}`;
}

export function mediaUrl(name: string, rel: string): string {
  return `${WORKER_URL}${withShow(`/api/projects/${encodeURIComponent(name)}/media?rel=${encodeURIComponent(rel)}`)}`;
}

export type PlaybackVideoInfo = { file: string; upToDate: boolean };
export type PlaybackAudioInfo = {
  rel: string;
  startFrame: number;
  endFrame: number;
  exists: boolean;
  durationSeconds?: number | null;
  trimInSec?: number;
  trimOutSec?: number | null;
};

export type PreviewSegmentStatus = {
  ok: boolean;
  ready: boolean;
  progress: number;
  framesDone: number;
  framesTotal: number;
  startFrame: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  file: string | null;
  url: string | null;
  error?: string;
};
export type PlaybackStatus = {
  fps: number;
  totalFrames: number;
  render: PlaybackVideoInfo | null;
  proxy: PlaybackVideoInfo | null;
  audio: PlaybackAudioInfo[];
};

export async function loadPlayback(name: string, script?: string | null): Promise<PlaybackStatus> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/playback`, script));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<PlaybackStatus>;
}

export function previewSegmentUrl(name: string, file: string): string {
  return `${WORKER_URL}${withShow(`/api/projects/${encodeURIComponent(name)}/preview-segments/${encodeURIComponent(file)}`)}`;
}

export async function requestPreviewSegment(
  name: string,
  body: { startFrame: number; durationSec?: number; frames?: number; width?: number; height?: number },
  script?: string | null
): Promise<PreviewSegmentStatus> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/preview-segment`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as PreviewSegmentStatus & { error?: string };
  if (!res.ok && res.status !== 202) {
    throw new Error(json.error || `Preview segment failed (${res.status})`);
  }
  return json;
}

export async function waitForPreviewSegment(
  name: string,
  body: { startFrame: number; durationSec?: number; frames?: number },
  script?: string | null,
  onProgress?: (status: PreviewSegmentStatus) => void
): Promise<PreviewSegmentStatus> {
  let status = await requestPreviewSegment(name, body, script);
  onProgress?.(status);
  const started = Date.now();
  while (!status.ready) {
    if (status.error) throw new Error(status.error);
    if (Date.now() - started > 10 * 60 * 1000) throw new Error("Preview segment timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await loadPreviewSegment(name, { startFrame: body.startFrame, durationSec: body.durationSec, frames: body.frames }, script);
    onProgress?.(status);
  }
  return status;
}

export async function loadPreviewSegment(
  name: string,
  query: { startFrame: number; durationSec?: number; frames?: number },
  script?: string | null
): Promise<PreviewSegmentStatus> {
  const params = new URLSearchParams({ startFrame: String(query.startFrame) });
  if (query.durationSec) params.set("durationSec", String(query.durationSec));
  if (query.frames) params.set("frames", String(query.frames));
  const res = await workerFetch(
    withScript(`/api/projects/${encodeURIComponent(name)}/preview-segment?${params.toString()}`, script)
  );
  const json = (await res.json().catch(() => ({}))) as PreviewSegmentStatus & { error?: string };
  if (!res.ok && res.status !== 202) {
    throw new Error(json.error || `Preview segment failed (${res.status})`);
  }
  return json;
}

export async function startPreviewRender(name: string, script?: string | null): Promise<RenderResponse> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/preview-render`, script), {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as RenderResponse;
  if (!res.ok) {
    throw new Error(body.error || `Preview render failed (${res.status})`);
  }
  return body;
}

export async function renderExists(name: string, script?: string | null): Promise<boolean> {
  try {
    const res = await workerFetch(
      `/api/projects/${encodeURIComponent(name)}/renders/${encodeURIComponent(renderOutputFile(script))}`,
      { method: "HEAD" }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export type ImportAudioResponse = {
  ok: boolean;
  dryRun: boolean;
  noTranscribe: boolean;
  label: string;
  character: string;
  durationSeconds: number;
  creditNote: string;
  wavPath?: string;
  cuesPath?: string;
  wordsPath?: string;
  transcribed?: boolean;
  tag?: string;
  estimatedCost?: string | number | null;
  cost?: string | number | null;
  estimatedCredits?: string | number | null;
  creditEstimate?: string | number | null;
};

export type EngineSettings = {
  xaiKeyConfigured: boolean;
  xaiImageModel: string;
};

export async function loadEngineSettings(): Promise<EngineSettings> {
  const res = await workerFetch("/api/engine/settings");
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<EngineSettings>;
}

export async function saveEngineXaiKey(xaiApiKey: string): Promise<EngineSettings> {
  const res = await workerFetch("/api/engine/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xaiApiKey }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return { xaiKeyConfigured: true, xaiImageModel: "" };
}

export type PromptPackSummary = {
  id: string;
  displayName: string;
  characterIds: string[];
  sets: { id: string; label: string; description: string; group: string | null; needId: string }[];
};

export async function loadPromptPacks(characterId?: string): Promise<{
  packs: PromptPackSummary[];
  pack: PromptPackSummary | null;
}> {
  const qs = characterId ? `?character=${encodeURIComponent(characterId)}` : "";
  const res = await workerFetch(`/api/prompt-packs${qs}`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { packs?: PromptPackSummary[]; pack?: PromptPackSummary | null };
  return { packs: body.packs || [], pack: body.pack || null };
}

export type GenerateImageRef = { kind: "reference" | "body" | string; rel: string };
export type GeneratedImage = {
  index: number;
  url: string | null;
  mimeType: string;
  libraryRel: string;
  imageBase64: string;
};
export type GenerateImageResponse = {
  ok: boolean;
  dryRun: boolean;
  model: string;
  n: number;
  needId: string;
  prompt: string;
  keyConfigured: boolean;
  references: GenerateImageRef[];
  estimatedCost?: number | null;
  estimatedCostLabel?: string | null;
  cost?: number | null;
  creditNote: string;
  images?: GeneratedImage[];
  characterId: string;
};

export async function generateProjectImage(
  body: {
    project: string;
    characterId: string;
    needId: string;
    n?: number;
    prompt?: string;
    frames?: number;
    dryRun?: boolean;
  }
): Promise<GenerateImageResponse> {
  const res = await workerFetch("/api/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, showId: activeShowId || undefined }),
  });
  const payload = (await res.json().catch(() => ({}))) as GenerateImageResponse & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Generate failed (${res.status})`);
  return payload;
}

export async function importProjectAudio(
  name: string,
  file: File,
  options: { character: string; name?: string; dryRun?: boolean; noTranscribe?: boolean }
): Promise<ImportAudioResponse> {
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("character", options.character);
  if (options.name) body.append("name", options.name);
  if (options.dryRun) body.append("dryRun", "true");
  if (options.noTranscribe) body.append("noTranscribe", "true");
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/import-audio`, {
    method: "POST",
    body,
  });
  const payload = (await res.json().catch(() => ({}))) as ImportAudioResponse & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Import failed (${res.status})`);
  return payload;
}

export type ShowSummary = {
  id: string;
  name: string;
  description: string;
  thumbnail: string | null;
  thumbRel: string | null;
  thumbMtime?: number | null;
  episodeCount: number;
  durationSeconds: number | null;
  lastRenderAt: string | null;
  episodes?: ProjectSummary[];
};

export type FinalCutItem = {
  id: string;
  kind: "episode" | "scene";
  episodeId: string;
  script?: string;
  sceneId?: string | null;
  trimIn?: number | null;
  trimOut?: number | null;
};

export type FinalCut = {
  name: string;
  gapSeconds: number;
  fadeSeconds: number;
  items: FinalCutItem[];
};

export type FinalCutPlanItem = {
  id: string;
  kind: string;
  episodeId: string;
  script: string;
  sceneId?: string | null;
  label: string;
  stale: boolean;
  missing: boolean;
  willRender: boolean;
  durationSeconds: number | null;
  trimInSec: number;
  trimOutSec: number | null;
};

export type FinalCutPlan = {
  cut: FinalCut;
  items: FinalCutPlanItem[];
  staleCount: number;
  missingCount: number;
  estimatedSeconds: number;
  note: string;
};

export type ShowAssets = {
  characters: Character[];
  backgrounds: Background[];
  props: PropAsset[];
};

export function showAssetUrl(
  showId: string,
  rel: string | null | undefined,
  opts?: { thumb?: boolean; v?: number | string | null }
): string | null {
  if (!rel) return null;
  const params = new URLSearchParams({ rel });
  if (opts?.thumb) params.set("thumb", "1");
  if (opts?.v != null && opts.v !== "") params.set("v", String(opts.v));
  return `${WORKER_URL}/api/shows/${encodeURIComponent(showId)}/asset?${params.toString()}`;
}

export function downloadShowUrl(showId: string): string {
  return `${WORKER_URL}/api/shows/${encodeURIComponent(showId)}/download`;
}

export function finalCutVideoUrl(showId: string, file: string, bust?: number): string {
  const qs = bust ? `?t=${bust}` : "";
  return `${WORKER_URL}/api/shows/${encodeURIComponent(showId)}/final/${encodeURIComponent(file)}${qs}`;
}

export async function listShows(): Promise<ShowSummary[]> {
  const res = await workerFetch("/api/shows");
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { shows: ShowSummary[] };
  return body.shows;
}

export async function createShow(name: string, description = ""): Promise<ShowSummary> {
  const res = await workerFetch("/api/shows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  const body = (await res.json().catch(() => ({}))) as { show?: ShowSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Create show failed (${res.status})`);
  if (!body.show) throw new Error("Create show failed");
  return body.show;
}

export async function loadShow(showId: string): Promise<{
  show: ShowSummary;
  assets: ShowAssets;
  finalCut: FinalCut;
  library: { added: string[] };
}> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{
    show: ShowSummary;
    assets: ShowAssets;
    finalCut: FinalCut;
    library: { added: string[] };
  }>;
}

export async function loadShowContents(showId: string): Promise<ProjectContents> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/contents`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { contents: ProjectContents };
  return body.contents;
}

export async function trashShow(showId: string, confirmName: string): Promise<void> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/trash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmName }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function renameShow(
  showId: string,
  next: { id?: string; displayName?: string; name?: string }
): Promise<ShowSummary> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  const body = (await res.json().catch(() => ({}))) as { show?: ShowSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Rename failed (${res.status})`);
  if (!body.show) throw new Error("Rename failed");
  return body.show;
}

export async function duplicateShow(showId: string): Promise<ShowSummary> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/duplicate`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { show?: ShowSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Duplicate failed (${res.status})`);
  if (!body.show) throw new Error("Duplicate failed");
  return body.show;
}

export async function createEpisode(
  showId: string,
  name: string,
  duplicateFrom?: string
): Promise<ProjectSummary> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(duplicateFrom ? { name, duplicateFrom } : { name }),
  });
  const body = (await res.json().catch(() => ({}))) as { episode?: ProjectSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Create episode failed (${res.status})`);
  if (!body.episode) throw new Error("Create episode failed");
  return body.episode;
}

export async function moveProjectToShow(
  projectName: string,
  showId: string,
  options?: { create?: boolean; displayName?: string }
): Promise<{ show: ShowSummary; episode: ProjectSummary }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(projectName)}/move-to-show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showId, create: options?.create, displayName: options?.displayName }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    show?: ShowSummary;
    episode?: ProjectSummary;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `Move failed (${res.status})`);
  if (!body.show || !body.episode) throw new Error("Move failed");
  return { show: body.show, episode: body.episode };
}

export async function moveEpisodeToExperiments(showId: string, episodeId: string): Promise<ProjectSummary> {
  const res = await workerFetch(
    `/api/shows/${encodeURIComponent(showId)}/episodes/${encodeURIComponent(episodeId)}/move-to-experiments`,
    { method: "POST" }
  );
  const body = (await res.json().catch(() => ({}))) as { project?: ProjectSummary; error?: string };
  if (!res.ok) throw new Error(body.error || `Move failed (${res.status})`);
  if (!body.project) throw new Error("Move failed");
  return body.project;
}

export async function loadShowLibrary(showId: string): Promise<LibraryResponse> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/library`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<LibraryResponse>;
}

export async function addShowLibraryCharacter(showId: string, characterId: string): Promise<void> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function saveFinalCut(showId: string, cut: FinalCut): Promise<FinalCut> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/final-cut`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cut }),
  });
  const body = (await res.json().catch(() => ({}))) as { cut?: FinalCut; error?: string };
  if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
  if (!body.cut) throw new Error("Save failed");
  return body.cut;
}

export async function planFinalCut(showId: string): Promise<FinalCutPlan> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/final-cut/plan`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<FinalCutPlan>;
}

export async function renderFinalCut(
  showId: string,
  name?: string
): Promise<{ ok: boolean; file: string; url: string; note?: string; plan?: FinalCutPlan }> {
  const res = await workerFetch(`/api/shows/${encodeURIComponent(showId)}/final-cut/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    file?: string;
    url?: string;
    note?: string;
    plan?: FinalCutPlan;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `Final render failed (${res.status})`);
  return {
    ok: body.ok !== false,
    file: body.file || "final.mp4",
    url: body.url || "",
    note: body.note,
    plan: body.plan,
  };
}

export async function loadEpisodeStage(showId: string, episodeId: string, script?: string | null): Promise<StageInfo> {
  const res = await workerFetch(
    withScript(`/api/projects/${encodeURIComponent(episodeId)}/stage?show=${encodeURIComponent(showId)}`, script)
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StageInfo>;
}
