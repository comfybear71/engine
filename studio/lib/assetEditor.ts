/**
 * Assets viewer/editor helpers: mouth labels, navigation, Imagine preselect,
 * and worker calls for inspect / replace / add / rename / delete.
 */

import { workerFetch } from "./worker.ts";

export const RHUBARB_SHAPES = ["X", "A", "B", "C", "D", "E", "F", "G", "H"] as const;
export const MOUTH_SOUNDS: Record<(typeof RHUBARB_SHAPES)[number], string> = {
  X: "rest",
  A: "closed M/B/P",
  B: "slightly open EE",
  C: "open EH",
  D: "wide AH",
  E: "round OH",
  F: "pursed OO",
  G: "teeth-on-lip F/V",
  H: "tongue L",
};

export type AssetFocus =
  | { mode: "slot"; characterId: string; slot: string; view?: string }
  | { mode: "drawing"; characterId: string; slot: string; drawing: string; view?: string };

export type DrawingUsage = {
  kind: string;
  script?: string | null;
  line?: number | null;
  cycle?: string;
  slot?: string;
  text: string;
};

export type EditorDrawing = {
  name: string;
  rel: string;
  mtime?: number | null;
  width: number | null;
  height: number | null;
  bytes?: number;
  hash?: string;
  source: "project" | "show" | "global";
  loud?: boolean;
  shape?: string | null;
  view?: string;
  duplicateOf?: string | null;
  duplicates?: string[];
};

export type SlotEditor = {
  ok: boolean;
  characterId: string;
  displayName: string;
  slot: string;
  owner: string | null;
  drawingsDir: string;
  view: string;
  views: { id: string; drawingsDir: string; count: number }[];
  offset: { x: number; y: number };
  scale: number;
  rotation: number;
  defaultDrawing: string | null;
  cycles: Record<string, { drawings: string[]; fps: number }>;
  mouth: boolean;
  shapes: { shape: string; sound: string; present: boolean; loud: boolean }[];
  missingShapes: string[];
  drawings: EditorDrawing[];
};

export type DrawingEditor = SlotEditor & {
  drawing: EditorDrawing;
  usages: DrawingUsage[];
  prev: string | null;
  next: string | null;
};

export type EditPreview = {
  ok: boolean;
  sessionId: string;
  kind: "replace" | "add";
  drawing?: string;
  slot: string;
  view: string;
  suggestedName?: string;
  before?: { rel: string; width: number | null; height: number | null; pngBase64: string | null };
  after: { width: number; height: number; pngBase64: string };
};

export type LipsyncSample = {
  id: string;
  label: string;
  kind: "builtin" | "audio";
  audioRel: string | null;
  cues: { shape: string; start: number; end: number }[];
};

export type LipsyncPreview = {
  ok: boolean;
  slot: string;
  view: string;
  drawings: EditorDrawing[];
  fallback: EditorDrawing | null;
  samples: LipsyncSample[];
};

export type DeleteConflict = {
  used: true;
  error: string;
  usages: DrawingUsage[];
};

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

function slotPath(project: string, characterId: string, slot: string, extra = "", view?: string): string {
  const base = `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/slots/${encodeURIComponent(slot)}${extra}`;
  if (!view || view === "front") return base;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}view=${encodeURIComponent(view)}`;
}

export async function loadSlotEditor(
  project: string,
  characterId: string,
  slot: string,
  view?: string
): Promise<SlotEditor> {
  const res = await workerFetch(slotPath(project, characterId, slot, "", view));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<SlotEditor>;
}

export async function loadDrawingEditor(
  project: string,
  characterId: string,
  slot: string,
  drawing: string,
  view?: string
): Promise<DrawingEditor> {
  const res = await workerFetch(
    slotPath(project, characterId, slot, `/drawings/${encodeURIComponent(drawing)}`, view)
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<DrawingEditor>;
}

export async function previewReplaceDrawing(
  project: string,
  characterId: string,
  slot: string,
  drawing: string,
  body: { imageBase64: string; filename?: string; view?: string }
): Promise<EditPreview> {
  const res = await workerFetch(
    slotPath(project, characterId, slot, `/drawings/${encodeURIComponent(drawing)}/replace`, body.view),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<EditPreview>;
}

export async function confirmReplaceDrawing(
  project: string,
  characterId: string,
  slot: string,
  drawing: string,
  sessionId: string
): Promise<void> {
  const res = await workerFetch(
    slotPath(project, characterId, slot, `/drawings/${encodeURIComponent(drawing)}/replace/confirm`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
}

export async function previewAddDrawing(
  project: string,
  characterId: string,
  slot: string,
  body: { imageBase64: string; filename?: string; name?: string; view?: string }
): Promise<EditPreview> {
  const res = await workerFetch(slotPath(project, characterId, slot, "/drawings", body.view), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<EditPreview>;
}

export async function confirmAddDrawing(
  project: string,
  characterId: string,
  slot: string,
  body: { sessionId: string; name: string }
): Promise<{ drawing: string }> {
  const res = await workerFetch(slotPath(project, characterId, slot, "/drawings/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ drawing: string }>;
}

export async function cancelDrawingEdit(
  project: string,
  characterId: string,
  slot: string,
  sessionId: string,
  drawing?: string
): Promise<void> {
  const extra = drawing
    ? `/drawings/${encodeURIComponent(drawing)}/replace/cancel`
    : "/drawings/cancel";
  const res = await workerFetch(slotPath(project, characterId, slot, extra), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function renameEditorDrawing(
  project: string,
  characterId: string,
  slot: string,
  drawing: string,
  body: { name: string; view?: string }
): Promise<{ drawing: string }> {
  const res = await workerFetch(
    slotPath(project, characterId, slot, `/drawings/${encodeURIComponent(drawing)}/rename`, body.view),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<{ drawing: string }>;
}

export async function deleteEditorDrawing(
  project: string,
  characterId: string,
  slot: string,
  drawing: string,
  body: { confirm: true; force?: boolean; view?: string }
): Promise<{ ok: boolean } | DeleteConflict> {
  const res = await workerFetch(
    slotPath(project, characterId, slot, `/drawings/${encodeURIComponent(drawing)}/delete`, body.view),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const json = (await res.json().catch(() => ({}))) as DeleteConflict & { error?: string };
  if (res.status === 409 && json.used) return json;
  if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
  return { ok: true };
}

export async function loadLipsyncPreview(
  project: string,
  characterId: string,
  slot: string,
  view?: string
): Promise<LipsyncPreview> {
  const res = await workerFetch(slotPath(project, characterId, slot, "/lipsync-preview", view));
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<LipsyncPreview>;
}

export function mouthSound(name: string): string | null {
  const shape = String(name || "").replace(/_loud$/i, "").toUpperCase();
  return (MOUTH_SOUNDS as Record<string, string>)[shape] || null;
}

export function neighborDrawing(names: string[], current: string, dir: -1 | 1): string | null {
  if (names.length === 0) return null;
  const index = names.indexOf(current);
  if (index < 0) return names[0] || null;
  return names[(index + dir + names.length) % names.length];
}

export function needIdForSlot(
  slot: string,
  packSets?: readonly { id: string; needId?: string; cells?: readonly { dest?: unknown }[] }[]
): string {
  const n = String(slot || "").toLowerCase();
  if (packSets && packSets.length) {
    const hit = packSets.find((set) =>
      (set.cells || []).some((cell) => {
        const dest = cell.dest as { slot?: string; drawings_dir?: string } | null | undefined;
        return dest?.slot === n || dest?.drawings_dir === n;
      })
    );
    if (hit) return hit.needId || hit.id;
  }
  if (n === "mouth" || n.startsWith("mouth_")) return "mouth_sheet";
  if (n === "eyes" || n.startsWith("eye")) return "expression_heads";
  if (n === "face" || n === "head" || n.startsWith("face_")) return "expression_heads";
  if (n.includes("hand") || n.includes("arm") || n === "mic_arm") return "arm_hand";
  if (n === "body") return "walk_cycle";
  return "mouth_sheet";
}

export function fileToImageBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

export function imageFileFromClipboard(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

export function cueAtTime(cues: { shape: string; start: number; end: number }[], time: number): string {
  const hit = cues.find((cue) => time >= cue.start && time < cue.end);
  return hit?.shape || cues[cues.length - 1]?.shape || "X";
}

export function formatUsage(usage: DrawingUsage): string {
  if (usage.script && usage.line != null) return `${usage.script}:${usage.line} ${usage.text}`;
  if (usage.kind === "cycle") return usage.text;
  if (usage.kind === "default") return usage.text;
  return usage.text;
}
