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
export type SlotCanvas = { w: number; h: number; pivot: { x: number; y: number } | null };
export type CharacterSlot = {
  name: string;
  owner: string | null;
  default_drawing: string | null;
  drawingsDir?: string;
  drawings: Drawing[];
  views?: SlotView[];
  cycles: Record<string, SlotCycle>;
  offset: { x: number; y: number };
  scale: number;
  rotation: number;
  canvas?: SlotCanvas | null;
};
export type CharacterChild = {
  id: string;
  asset: string | null;
  rel: string | null;
  pivot: string | { x: number; y: number } | null;
  parent: string | null;
  z: number;
  offset: { x: number; y: number };
  mtime?: number | null;
};
export type Character = {
  id: string;
  display_name: string;
  aliases: string[];
  source: "global" | "show" | "project";
  z: number;
  default_scale?: number;
  style: string;
  asset: string | null;
  thumbRel: string | null;
  bodyRel: string | null;
  mtime?: number | null;
  reference: string | null;
  referenceRel: string | null;
  referenceMtime?: number | null;
  canvas?: { w: number; h: number; pivot: { x: number; y: number } } | null;
  groups?: { head?: string[] } | null;
  children?: CharacterChild[];
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
export type LaneId = "body" | "face" | "props" | "action" | "dialogue" | "mouth" | "audio" | "sfx" | "camera" | "inserts";
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

export function requireScriptName(script?: string | null): string {
  const name = (script || "").trim();
  if (!name) throw new Error("No script selected");
  return name;
}

export function withScript(path: string, script?: string | null): string {
  const name = (script || "").trim();
  if (!name) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}script=${encodeURIComponent(name)}`;
}

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const next = path.startsWith("/api/projects/") ? withShow(path) : path;
  try {
    return await fetch(`${WORKER_URL}${next}`, { ...init, cache: "no-store" });
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

export type ScriptFileInfo = { name: string; mtime?: number; birthtime?: number };
export type ScriptCatalog = { scripts: string[]; files: ScriptFileInfo[]; newest: string };

export async function loadScripts(name: string): Promise<string[]> {
  const catalog = await loadScriptCatalog(name);
  return catalog.scripts;
}

export async function loadScriptCatalog(name: string): Promise<ScriptCatalog> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/scripts`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as {
    scripts?: string[];
    files?: ScriptFileInfo[];
    default?: string;
  };
  const scripts = Array.isArray(body.scripts) ? body.scripts : [];
  const files = Array.isArray(body.files)
    ? body.files
    : scripts.map((scriptName) => ({ name: scriptName, mtime: 0 }));
  return {
    scripts,
    files,
    newest: body.default || files[0]?.name || "script.txt",
  };
}

export async function createScript(name: string, scriptName?: string | null): Promise<{ script: string; catalog: ScriptCatalog }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scriptName ? { name: scriptName } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    script?: string;
    scripts?: string[];
    files?: ScriptFileInfo[];
    default?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `Create script failed (${res.status})`);
  if (!body.script) throw new Error("Create script failed");
  const scripts = Array.isArray(body.scripts) ? body.scripts : [body.script];
  const files = Array.isArray(body.files) ? body.files : scripts.map((item) => ({ name: item, mtime: 0 }));
  return {
    script: body.script,
    catalog: {
      scripts,
      files,
      newest: body.default || files[0]?.name || body.script,
    },
  };
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
  warning?: "empty" | "small" | "large" | null;
  width: number;
  height: number;
  pngBase64: string | null;
};

export type IngestPreview = {
  ok: boolean;
  sessionId: string;
  libraryRel: string;
  needId: string;
  grid: { cols: number; rows: number } | null;
  warnings?: string[];
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
  body: {
    needId: string;
    imageBase64?: string;
    filename?: string;
    frames?: number;
    sessionId?: string;
    grid?: { cols: number; rows: number };
    dest?: { kind: "slot"; slot: string; drawings_dir?: string };
  }
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
  body: { sessionId: string; assignments: { index: number; name: string }[]; flipAll?: boolean }
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

export type FactoryBadge = "ticked" | "locked" | "draft" | "missing";
export type FactoryPiece = {
  name: string;
  key: string;
  rel: string | null;
  drawingsDir: string | null;
  expected: boolean;
  optional?: boolean;
  missing: boolean;
  badge: FactoryBadge | null;
  mtime?: number | null;
  compositeRel?: string | null;
  faceGroup?: string | null;
  side?: "L" | "R" | string | null;
};
export type FactoryRow = {
  id: string;
  label: string;
  slot: string;
  owner: string | null;
  kind: "slot" | "child";
  drawings: FactoryPiece[];
};
export type FactoryUsage = {
  kind: string;
  script: string | null;
  line: number | null;
  text: string;
};
export type FactoryHistory = { rel: string; mtime: number | null };
export type FactoryBounds = { x: number; y: number; w: number; h: number; empty?: boolean };
export type FactoryInspector = {
  key: string;
  slot: string;
  label: string;
  drawing: string;
  view: string;
  rel: string | null;
  badge: FactoryBadge | null;
  missing: boolean;
  canvas: { w: number; h: number; pivot: { x: number; y: number } };
  pivot: { x: number; y: number };
  offset: { x: number; y: number };
  anchor: string;
  redo: string;
  compositeRel?: string | null;
  faceGroup?: string | null;
  bounds?: FactoryBounds | null;
  usages?: FactoryUsage[];
  history?: FactoryHistory[];
};
export type FactoryViewTab = { id: string; label: string; count?: number };
export type FactoryCharacter = {
  ok: boolean;
  characterId: string;
  displayName: string;
  view: string;
  views: FactoryViewTab[];
  status: Record<string, string>;
  redos: Record<string, string>;
  counts: { ticked: number; locked: number; draft: number; missing: number };
  canvas: { w: number; h: number; pivot: { x: number; y: number } };
  default_scale: number;
  groups: { head?: string[] } | null;
  children: CharacterChild[];
  rows: FactoryRow[];
  inspector: FactoryInspector | null;
};
export type ProjectAction = {
  id: string;
  name?: string;
  characterId: string | null;
  label: string;
  source: string;
  rel: string;
  thumbRel?: string | null;
  frames?: number;
  drawings?: number;
  still?: boolean;
  category?: string;
  view?: string | null;
  warnings?: string[];
  flagged?: boolean;
  baked?: boolean;
};

export type LibraryFrame = {
  index: number;
  rel: string;
  thumbRel?: string | null;
  kind?: string;
  view?: string;
  yaw?: number;
  action?: string;
  phase?: string;
  quality?: number;
  issues?: string[];
};

export type LibraryClip = {
  id: string;
  filename: string;
  kind: string;
  action: string;
  category: string;
  frameCount: number;
  view?: string;
  warnings: string[];
  issues: string[];
  frames: LibraryFrame[];
  ticked?: boolean;
  actionId?: string | null;
};

export type CharacterLibrary = {
  characterId: string;
  categories: { id: string; label: string }[];
  clips: LibraryClip[];
};

export type ActionFrameDetail = {
  actionId: string;
  characterId: string;
  category: string;
  view: string | null;
  frames: number;
  still: boolean;
  warnings: string[];
  libraryClip: string | null;
  drawings: { index: number; number: number; name: string; slot: string; rel: string | null; issues: string[] }[];
};

export async function loadFactoryCharacter(
  name: string,
  characterId: string,
  view?: string,
  key?: string
): Promise<FactoryCharacter> {
  const params = new URLSearchParams();
  if (view) params.set("view", view);
  if (key) params.set("key", key);
  const qs = params.toString();
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/status${qs ? `?${qs}` : ""}`
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<FactoryCharacter>;
}

export async function saveFactoryStatus(
  name: string,
  characterId: string,
  body: { key: string; state?: FactoryBadge; redo?: string; view?: string }
): Promise<FactoryCharacter> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<FactoryCharacter>;
}

export async function loadProjectActions(name: string): Promise<ProjectAction[]> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/actions`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { actions?: ProjectAction[] };
  return body.actions || [];
}

export async function loadCharacterLibrary(project: string, characterId: string): Promise<CharacterLibrary> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/library`
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<CharacterLibrary>;
}

export async function addActionCategory(project: string, characterId: string, label: string): Promise<{ id: string; label: string }[]> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/library/categories`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) }
  );
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { categories?: { id: string; label: string }[] };
  return body.categories || [];
}

export async function patchActionCategory(
  project: string,
  characterId: string,
  actionId: string,
  category: string
): Promise<void> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category }) }
  );
  if (!res.ok) throw new Error(await readError(res));
}

/** Project-relative paths of an Action Shot's baked frames (what a [Clip:] line plays). */
export async function loadClipFrames(project: string, characterId: string, actionId: string): Promise<{ fps: number | null; frames: string[] }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/clip-frames`
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ fps: number | null; frames: string[] }>;
}

export async function loadActionFrames(project: string, characterId: string, actionId: string): Promise<ActionFrameDetail> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/frames`
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<ActionFrameDetail>;
}

export async function flagActionFrame(
  project: string,
  characterId: string,
  actionId: string,
  index: number,
  issue: string
): Promise<ActionFrameDetail> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/frames/${index}/flag`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issue }) }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<ActionFrameDetail>;
}

export async function deleteActionFrame(
  project: string,
  characterId: string,
  actionId: string,
  index: number
): Promise<ActionFrameDetail> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/frames/${index}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<ActionFrameDetail>;
}

export async function saveLibraryFrameToSlot(
  project: string,
  characterId: string,
  clipId: string,
  index: number,
  slot: string,
  view?: string,
  name?: string,
  side?: string
): Promise<{ rel: string; name: string; state: string; slot: string }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/library/${encodeURIComponent(clipId)}/frames/${index}/save-slot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, view, name, side }),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ rel: string; name: string; state: string; slot: string }>;
}

export async function extractLibraryFace(
  project: string,
  characterId: string,
  clipId: string,
  kind: "mouth" | "eyes"
): Promise<{ drawings: { name: string; view: string; rel: string }[]; missing: { name: string; view: string }[]; scanned: number }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/library/${encodeURIComponent(clipId)}/extract-face`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{
    drawings: { name: string; view: string; rel: string }[];
    missing: { name: string; view: string }[];
    scanned: number;
  }>;
}

export async function tickLibraryClip(
  project: string,
  characterId: string,
  clipId: string
): Promise<{ actionId: string; frames: number; still: boolean }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/library/${encodeURIComponent(clipId)}/tick`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ actionId: string; frames: number; still: boolean }>;
}

export async function saveActionFrameToSlot(
  project: string,
  characterId: string,
  actionId: string,
  index: number,
  slot: string,
  view?: string
): Promise<{ rel: string; name: string; state: string }> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/frames/${index}/save-slot`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot, view }) }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ rel: string; name: string; state: string }>;
}

export function actionPreviewUrl(project: string, characterId: string | null | undefined, actionId: string): string | null {
  if (!project || !characterId || !actionId) return null;
  return `${WORKER_URL}${withShow(
    `/api/projects/${encodeURIComponent(project)}/actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionId)}/preview`
  )}`;
}

export function actionPosterUrl(project: string, characterId: string | null | undefined, actionId: string): string | null {
  const preview = actionPreviewUrl(project, characterId, actionId);
  return preview ? `${preview}?poster=1` : null;
}

export type FactoryJobDrawing = { name: string; imageBase64: string | null; problems: string[] };
export type FactoryJob = {
  ok: boolean;
  jobId: string;
  characterId: string;
  mode?: string;
  slot?: string | null;
  view?: string | null;
  name?: string | null;
  title?: string | null;
  actionId: string;
  prompt: string;
  hiddenPrompt: string;
  frames: number;
  grid: { cols: number; rows: number };
  dest: { kind: string; slot?: string; drawings_dir?: string };
  drawings: FactoryJobDrawing[];
  warnings: string[];
  previewRel: string | null;
  previewKind?: "image" | "video" | string | null;
  ticked: boolean;
  usedFixture: boolean;
  usedRig?: boolean;
  usedGrok?: boolean;
  styleBlock: string;
  rigRules: string[];
  greenScreen: string | null;
  walkSet?: boolean;
  jobs?: FactoryJob[];
  usedImport?: boolean;
  keepHead?: boolean;
  importMp4?: {
    background?: string;
    frameCount?: number;
    steady?: { start: number; end: number };
    cycle?: { start: number; end: number; period?: number };
    suggested?: Record<string, number[]>;
    selected?: number[];
    hasHead?: boolean;
    thumbs?: { index: number; rel: string; hasHead?: boolean; boots?: number; blobs?: number }[];
  } | null;
};

export function factoryStripUrl(project: string, characterId: string, jobId: string, name: string): string {
  return `${WORKER_URL}${withShow(
    `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/strip/${encodeURIComponent(name)}`
  )}`;
}

export async function importFactoryMp4(
  project: string,
  body: { characterId: string; file: File; prompt?: string; frames?: number; view?: string }
): Promise<FactoryJob> {
  const data = new FormData();
  data.append("characterId", body.characterId);
  data.append("file", body.file);
  if (body.prompt) data.append("prompt", body.prompt);
  if (body.frames) data.append("frames", String(body.frames));
  if (body.view) data.append("view", body.view);
  const res = await workerFetch(`/api/projects/${encodeURIComponent(project)}/factory/import-mp4`, {
    method: "POST",
    body: data,
  });
  const payload = (await res.json().catch(() => ({}))) as FactoryJob & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Import MP4 failed (${res.status})`);
  return payload;
}

export async function buildFactoryImportMp4(
  project: string,
  characterId: string,
  jobId: string,
  body: { indices: number[]; frames?: number }
): Promise<FactoryJob> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/import-mp4/build`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const payload = (await res.json().catch(() => ({}))) as FactoryJob & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Import MP4 build failed (${res.status})`);
  return payload;
}

export function factoryPreviewUrl(project: string, characterId: string, jobId: string): string {
  return `${WORKER_URL}${withShow(
    `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/preview`
  )}`;
}

export async function startFactoryJob(
  project: string,
  body: {
    mode?: string;
    characterId?: string;
    slot?: string;
    view?: string;
    label?: string;
    name?: string;
    prompt: string;
    frames?: number;
    advancedPrompt?: string;
    imageBase64?: string;
    dryRun?: boolean;
    walkSet?: boolean;
    useGrok?: boolean;
    useRigWalk?: boolean;
  }
): Promise<FactoryJob> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(project)}/factory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as FactoryJob & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Factory failed (${res.status})`);
  return payload;
}

export async function tickFactoryJob(project: string, characterId: string, jobId: string): Promise<FactoryJob> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/tick`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  const payload = (await res.json().catch(() => ({}))) as FactoryJob & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Tick failed (${res.status})`);
  return payload;
}

export async function redoFactoryJob(
  project: string,
  characterId: string,
  jobId: string,
  body: { prompt?: string; frames?: number; advancedPrompt?: string; imageBase64?: string; useGrok?: boolean; useRigWalk?: boolean } = {}
): Promise<FactoryJob> {
  const res = await workerFetch(
    `/api/projects/${encodeURIComponent(project)}/factory/${encodeURIComponent(characterId)}/${encodeURIComponent(jobId)}/redo`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const payload = (await res.json().catch(() => ({}))) as FactoryJob & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Redo failed (${res.status})`);
  return payload;
}

export type TrashUsage = { script: string; line: number; text?: string };
export type TrashAssetBody = {
  kind: "sound" | "background" | "prop" | "action" | "character";
  id?: string;
  label?: string;
  characterId?: string | null;
  location?: string;
  rel?: string;
  confirm: true;
  force?: boolean;
};

export async function importStillAsset(
  name: string,
  body: {
    kind: "prop" | "background" | "character";
    name?: string;
    location?: string;
    imageBase64: string;
    removeBackground?: boolean;
  }
): Promise<{ ok: boolean; id: string; rel: string; location?: string }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/assets/import-still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; rel?: string; location?: string; error?: string };
  if (!res.ok) throw new Error(json.error || `Import failed (${res.status})`);
  return { ok: true, id: json.id || "", rel: json.rel || "", location: json.location };
}

export async function trashProjectAsset(
  name: string,
  body: TrashAssetBody
): Promise<{ ok: boolean; trash?: string; usages?: TrashUsage[]; error?: string; code?: string }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/assets/trash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    trash?: string;
    usages?: TrashUsage[];
    error?: string;
    code?: string;
  };
  if (res.status === 409) return { ok: false, code: json.code || "EUSED", error: json.error, usages: json.usages || [] };
  if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
  return { ok: true, trash: json.trash, usages: json.usages || [] };
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
  peaks?: number[];
};

export async function loadProjectAudio(name: string): Promise<ProjectAudioFile[]> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/audio`);
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { files?: ProjectAudioFile[] };
  return body.files || [];
}

export async function loadStage(name: string, script?: string | null): Promise<StageInfo> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/stage`, requireScriptName(script)));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<StageInfo>;
}

export function assetUrl(
  project: string,
  rel: string | null | undefined,
  opts?: {
    thumb?: boolean;
    factory?: boolean;
    key?: boolean;
    over?: string | null;
    v?: number | string | null;
    library?: boolean;
    preview?: boolean;
    cover?: boolean;
  }
): string | null {
  if (!rel) return null;
  const params = new URLSearchParams({ rel });
  if (opts?.thumb) params.set("thumb", "1");
  if (opts?.factory) params.set("factory", "1");
  if (opts?.key) params.set("key", "1");
  if (opts?.over) params.set("over", opts.over);
  if (opts?.library) params.set("library", "1");
  if (opts?.preview) params.set("preview", "1");
  if (opts?.cover) params.set("cover", "1");
  if (opts?.v != null && opts.v !== "") params.set("v", String(opts.v));
  return `${WORKER_URL}${withShow(`/api/projects/${encodeURIComponent(project)}/asset?${params.toString()}`)}`;
}

export async function openProjectFolder(name: string, rel: string): Promise<{ ok: boolean; path?: string }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/open-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rel }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
  if (!res.ok) throw new Error(body.error || `Open folder failed (${res.status})`);
  return { ok: true, path: body.path };
}

export type MakeIndependentResult = {
  ok: boolean;
  independent: boolean;
  copied: {
    characters: string[];
    backgrounds: string[];
    stagingDefaults: boolean;
    files: number;
  };
};

export async function makeProjectIndependent(name: string): Promise<MakeIndependentResult> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/make-independent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<MakeIndependentResult>;
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
  script?: string | null,
  size?: { width?: number; height?: number }
): Promise<{ blob: Blob; meta: PreviewMeta }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/preview-frame`, script), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frame,
      ...(size?.width ? { width: size.width } : {}),
      ...(size?.height ? { height: size.height } : {}),
    }),
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

export type PreviewGraph = {
  fps: number;
  canvas: { width: number; height: number };
  totalFrames: number;
  scenes: unknown[];
};

export async function loadPreviewGraph(
  name: string,
  script?: string | null
): Promise<{ graph: PreviewGraph; fps: number; totalFrames: number; canvas: { width: number; height: number } }> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/preview-graph`, script));
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as {
    graph?: PreviewGraph;
    fps?: number;
    totalFrames?: number;
    canvas?: { width: number; height: number };
    error?: string;
  };
  if (!body.graph) throw new Error(body.error || "Preview graph missing");
  return {
    graph: body.graph,
    fps: body.fps || body.graph.fps || 24,
    totalFrames: body.totalFrames || body.graph.totalFrames || 1,
    canvas: body.canvas || body.graph.canvas || { width: 1920, height: 1080 },
  };
}

export async function loadScript(name: string, script?: string | null): Promise<string> {
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/script`, requireScriptName(script)));
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
  const path = withScript(`/api/projects/${encodeURIComponent(name)}/script`, requireScriptName(script));
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
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/lanes`, requireScriptName(script)));
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
  independent?: boolean;
  activeScript?: string;
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
  inSec?: number;
  outSec?: number | null;
  mouthCues?: { start: number; end: number; value?: string; shape?: string; pinned?: boolean }[];
  windowed?: boolean;
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
  body: {
    all?: boolean;
    scriptLine?: number;
    scriptLines?: number[];
    force?: boolean;
    clear?: boolean;
    startFrame?: number;
    endFrame?: number;
    wavRel?: string;
    cuesRel?: string;
    inSec?: number;
    outSec?: number;
    text?: string;
  },
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
  const res = await workerFetch(withScript(`/api/projects/${encodeURIComponent(name)}/playback`, requireScriptName(script)));
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
  body: { startFrame: number; durationSec?: number; frames?: number; width?: number; height?: number },
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
  tags?: string[];
  split?: boolean;
  willSplit?: boolean;
  estimatedChunks?: number | null;
  chunks?: AudioSplitChunk[];
  splitMs?: number | null;
  estimatedCost?: string | number | null;
  cost?: string | number | null;
  estimatedCredits?: string | number | null;
  creditEstimate?: string | number | null;
};

export type EngineSettings = {
  xaiKeyConfigured: boolean;
  comfyKeyConfigured?: boolean;
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

export type AudioSplitChunk = {
  label: string;
  offsetSec: number;
  durationSec: number;
  wavPath?: string;
  cuesPath?: string;
  wordsPath?: string;
};

export type SplitAudioResponse = {
  ok: boolean;
  split: boolean;
  durationSeconds: number;
  originalRel?: string;
  originalLabel?: string;
  character?: string;
  chunks: AudioSplitChunk[];
  tags?: string[];
  elapsedMs?: number;
  reusedWords?: boolean;
  reusedCues?: boolean;
  reason?: string;
};

export async function splitProjectAudio(
  name: string,
  body: { rel: string; character?: string; label?: string }
): Promise<SplitAudioResponse> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/split-audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as SplitAudioResponse & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Split failed (${res.status})`);
  return payload;
}

export async function saveAudioSlice(
  name: string,
  body: { rel: string; characterId?: string; label?: string; inSec?: number; durationSec?: number }
): Promise<{ ok: boolean; label: string; rel: string }> {
  const res = await workerFetch(`/api/projects/${encodeURIComponent(name)}/audio/save-slice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; label?: string; rel?: string; error?: string };
  if (!res.ok) throw new Error(payload.error || `Save slice failed (${res.status})`);
  return { ok: true, label: payload.label || "", rel: payload.rel || "" };
}

export type TalkWindow = {
  index: number;
  start: number;
  end: number;
  duration: number;
  clipSec: number;
  text: string;
};
export type TalkingHeadRange = {
  audioRel: string;
  inSec: number;
  durationSec: number;
  /** Words typed by hand for this range, used when the audio has no transcript. textInSec/textDurationSec say which stretch of the audio they cover. */
  text?: string;
  textInSec?: number;
  textDurationSec?: number;
};
export type TalkStart = {
  kind: "uploaded" | "head-shot" | "reference";
  label: string;
  rel: string;
  thumb: string;
  fullBody?: boolean;
};
export type TalkingHeadPlan = TalkingHeadRange & {
  requestedSec?: number;
  limitSec?: number | null;
  characterId: string;
  hasWords: boolean;
  transcript: string;
  windows: TalkWindow[];
  starts: TalkStart[];
  defaultStart: string;
  defaultPrompt: string;
};

async function talkingHeadPost<T>(path: string, body: unknown): Promise<T> {
  const res = await workerFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

function talkingHeadBase(name: string, characterId: string): string {
  return `/api/projects/${encodeURIComponent(name)}/characters/${encodeURIComponent(characterId)}/talking-head`;
}

export function planTalkingHead(name: string, characterId: string, range: TalkingHeadRange & { engine?: "grok" | "ltx" }): Promise<TalkingHeadPlan> {
  return talkingHeadPost<TalkingHeadPlan>(`${talkingHeadBase(name, characterId)}/plan`, range);
}

export function startTalkingHead(
  name: string,
  characterId: string,
  body: TalkingHeadRange & { prompt?: string; refRel: string; engine?: "grok" | "ltx"; subject?: string }
): Promise<{ ok: boolean; group: string; shotIds: string[]; windows: TalkWindow[] }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/start`, body);
}

export function uploadTalkingHeadStart(
  name: string,
  characterId: string,
  body: { name: string; data: string }
): Promise<TalkStart & { ok: boolean }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/start-image`, body);
}

export function stopTalkingHead(name: string, characterId: string, group: string): Promise<{ ok: boolean; removed: number }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/${encodeURIComponent(group)}/stop`, {});
}

export async function deleteTalkingHead(name: string, characterId: string, group: string): Promise<{ ok: boolean; removed: number }> {
  const res = await workerFetch(`${talkingHeadBase(name, characterId)}/${encodeURIComponent(group)}`, { method: "DELETE" });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; removed?: number; error?: string };
  if (!res.ok) throw new Error(payload.error || `Delete failed (${res.status})`);
  return { ok: true, removed: payload.removed || 0 };
}

export function resumeTalkingHead(
  name: string,
  characterId: string,
  group: string
): Promise<{ ok: boolean; group: string; resumed: boolean; fromWindow?: number }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/${encodeURIComponent(group)}/resume`, {});
}

export function redoTalkingHeadClip(
  name: string,
  characterId: string,
  group: string,
  index: number,
  cascade = false,
  engine?: "grok" | "ltx"
): Promise<{ ok: boolean; group: string; redone: number; cascade: boolean }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/${encodeURIComponent(group)}/redo`, {
    index,
    cascade,
    ...(engine ? { engine } : {}),
  });
}

export function undoTalkingHeadRedo(
  name: string,
  characterId: string,
  group: string,
  index: number
): Promise<{ ok: boolean; group: string; restored: number }> {
  return talkingHeadPost(`${talkingHeadBase(name, characterId)}/${encodeURIComponent(group)}/undo-redo`, { index });
}

export async function importProjectAudio(
  name: string,
  file: File,
  options: { character: string; name?: string; dryRun?: boolean; noTranscribe?: boolean; splitLong?: boolean }
): Promise<ImportAudioResponse> {
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("character", options.character);
  if (options.name) body.append("name", options.name);
  if (options.dryRun) body.append("dryRun", "true");
  if (options.noTranscribe) body.append("noTranscribe", "true");
  if (options.splitLong === false) body.append("splitLong", "false");
  if (options.splitLong === true) body.append("splitLong", "true");
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
