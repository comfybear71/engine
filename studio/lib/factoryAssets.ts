/**
 * Assets factory page helpers: view tabs, badge labels, and inspector math.
 * Row contents come from GET .../status (character.json + the standard rig).
 */

export const FACTORY_VIEW_TABS = [
  { id: "front", label: "Front" },
  { id: "left_34", label: "L 3/4" },
  { id: "right_34", label: "R 3/4" },
  { id: "left_side", label: "Side L" },
  { id: "right_side", label: "Side R" },
  { id: "back", label: "Back" },
] as const;

export type FactoryBadge = "ticked" | "locked" | "draft" | "missing";

export const BADGE_LABEL: Record<FactoryBadge, string> = {
  ticked: "ticked",
  locked: "locked",
  draft: "draft",
  missing: "missing",
};

export function isFactoryBadge(value: string | null | undefined): value is FactoryBadge {
  return value === "ticked" || value === "locked" || value === "draft" || value === "missing";
}

export function formatCountLine(counts: { ticked: number; locked: number; draft: number; missing: number }): string {
  const parts = [];
  if (counts.ticked) parts.push(`${counts.ticked} ticked`);
  if (counts.locked) parts.push(`${counts.locked} locked`);
  if (counts.draft) parts.push(`${counts.draft} draft`);
  if (counts.missing) parts.push(`${counts.missing} missing`);
  return parts.join(" · ");
}

export function sourceLabel(source: string | null | undefined): string {
  if (source === "project") return "project-local";
  if (source === "show") return "show";
  if (source === "global") return "library";
  return source || "";
}

export function pivotPercent(
  pivot: { x: number; y: number } | null | undefined,
  canvas: { w: number; h: number } | null | undefined
): { left: number; top: number } {
  const w = canvas && canvas.w > 0 ? canvas.w : 1024;
  const h = canvas && canvas.h > 0 ? canvas.h : 1024;
  const x = pivot && Number.isFinite(pivot.x) ? pivot.x : w / 2;
  const y = pivot && Number.isFinite(pivot.y) ? pivot.y : h / 2;
  return {
    left: Math.max(0, Math.min(100, (x / w) * 100)),
    top: Math.max(0, Math.min(100, (y / h) * 100)),
  };
}

export function formatPivot(pivot: { x: number; y: number } | null | undefined): string {
  if (!pivot) return "—";
  return `${Math.round(pivot.x)} / ${Math.round(pivot.y)}`;
}

export function formatBounds(
  bounds: { x: number; y: number; w: number; h: number } | null | undefined
): string {
  if (!bounds) return "—";
  return `${Math.round(bounds.x)},${Math.round(bounds.y)} → ${Math.round(bounds.x + bounds.w)},${Math.round(bounds.y + bounds.h)}`;
}

export type AudioFolder = { label: string; count: number; rel: string };

export function groupAudioFolders(files: { label: string; rel: string }[]): AudioFolder[] {
  const map = new Map<string, AudioFolder>();
  for (const file of files || []) {
    const current = map.get(file.label);
    if (current) current.count += 1;
    else map.set(file.label, { label: file.label, count: 1, rel: file.rel });
  }
  return [...map.values()];
}

export const PINNED_SCRIPTS = ["script.txt", "script_full_test.txt", "script_showcase_v2.txt"] as const;

export type ScriptGroups = { pinned: string[]; tests: string[] };

export type ScriptFileInfo = { name: string; mtime?: number; birthtime?: number };

export function scriptRecency(file: ScriptFileInfo): number {
  return Math.max(Number(file && file.mtime) || 0, Number(file && file.birthtime) || 0);
}

export function newestScriptName(files: ScriptFileInfo[], fallback = "script.txt"): string {
  if (!files.length) return fallback;
  return [...files].sort((a, b) => {
    const diff = scriptRecency(b) - scriptRecency(a);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  })[0].name;
}

export function isOldScript(active: string | null | undefined, newest: string | null | undefined): boolean {
  return Boolean(active && newest && active !== newest);
}

export function pickActiveScript(
  files: ScriptFileInfo[],
  current: string | null | undefined,
  remembered?: string | null
): string {
  const names = files.map((item) => item.name);
  if (current && names.includes(current)) return current;
  if (remembered && names.includes(remembered)) return remembered;
  return newestScriptName(files);
}

export function groupScripts(names: string[]): ScriptGroups {
  const pinned: string[] = [];
  const seen = new Set<string>();
  for (const name of PINNED_SCRIPTS) {
    if (names.includes(name)) {
      pinned.push(name);
      seen.add(name);
    }
  }
  const tests = names.filter((name) => !seen.has(name)).sort((a, b) => a.localeCompare(b));
  return { pinned, tests };
}

const SAFE_NEW_SCRIPT = /^script(?:_[A-Za-z0-9][A-Za-z0-9._-]*)?\.txt$/;

export function normalizeNewScriptName(raw: string | null | undefined): string | null {
  let stem = String(raw || "").trim();
  if (!stem) return null;
  stem = stem.replace(/\.txt$/i, "");
  if (!/^script(?:_|$)/i.test(stem)) stem = `script_${stem}`;
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const name = stem.toLowerCase().endsWith(".txt") ? stem : `${stem}.txt`;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  return SAFE_NEW_SCRIPT.test(name) ? name : null;
}

export function nextNewScriptName(existing: string[]): string {
  const used = new Set(existing);
  if (!used.has("script_new.txt")) return "script_new.txt";
  let n = 2;
  while (used.has(`script_new_${n}.txt`)) n += 1;
  return `script_new_${n}.txt`;
}

export type ActionShot = {
  id: string;
  name: string;
  label: string;
  characterId: string | null;
  characterName: string;
  thumbRel?: string | null;
  rel?: string;
  source?: string;
  frames?: number;
  drawings?: number;
  still?: boolean;
  category?: string;
  view?: string | null;
  warnings?: string[];
  flagged?: boolean;
};

export type ActionShotGroup = { characterId: string | null; characterName: string; actions: ActionShot[] };

export function groupActionsByCharacter(
  actions: Array<{
    id: string;
    name?: string;
    label: string;
    characterId: string | null;
    thumbRel?: string | null;
    rel?: string;
    source?: string;
    frames?: number;
    drawings?: number;
    still?: boolean;
    category?: string;
    view?: string | null;
    warnings?: string[];
    flagged?: boolean;
  }>,
  characters: Array<{ id: string; display_name: string }>
): ActionShotGroup[] {
  const names = new Map(characters.map((item) => [item.id, item.display_name]));
  const groups = new Map<string, ActionShotGroup>();
  for (const action of actions || []) {
    const characterId = action.characterId || null;
    const key = characterId || "shared";
    const characterName = characterId ? names.get(characterId) || characterId : "Shared";
    if (!groups.has(key)) groups.set(key, { characterId, characterName, actions: [] });
    groups.get(key)!.actions.push({
      ...action,
      id: action.label || `${characterId || "shared"}/${action.id}`,
      name: action.name || action.id,
      label: action.name || action.id,
      characterId,
      characterName,
      thumbRel: action.thumbRel || null,
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.characterId) return 1;
    if (!b.characterId) return -1;
    return a.characterName.localeCompare(b.characterName);
  });
}

export function visibleDrawings<T extends { missing?: boolean }>(drawings: T[], showMissing: boolean): T[] {
  if (showMissing) return drawings;
  return drawings.filter((item) => !item.missing);
}

/** `walk_side_01` → `walk_side`. Leaves `neutral`, `walk`, `armless_L` alone. */
export function numberedActionPrefix(name: string | null | undefined): string | null {
  const match = String(name || "").trim().match(/^(.*)_(0*[0-9]+)$/);
  if (!match || !match[1]) return null;
  return match[1];
}

export function actionFrameIndex(name: string | null | undefined): number {
  const match = String(name || "").trim().match(/_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function prettyActionFrameLabel(prefix: string, count: number): string {
  const words = String(prefix || "")
    .replace(/_/g, " ")
    .trim();
  const pretty = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Action";
  return `${pretty} frames (${count})`;
}

export type ActionFrameGroup<T extends { name: string }> = {
  id: string;
  prefix: string;
  label: string;
  drawings: T[];
  actionId: string | null;
  actionCharacterId: string | null;
  actionLabel: string | null;
};

function matchActionShot<A extends { id: string; name?: string; characterId: string | null; label: string }>(
  actions: A[] | null | undefined,
  characterId: string | null | undefined,
  prefix: string
): A | null {
  const pool = (actions || []).filter(
    (item) => !characterId || !item.characterId || item.characterId === characterId
  );
  const exact = pool.find((item) => (item.name || item.id) === prefix);
  if (exact) return exact;
  const fuzzy = pool
    .filter((item) => {
      const id = String(item.name || item.id);
      return id.startsWith(prefix) || prefix.startsWith(id);
    })
    .sort((a, b) => String(b.name || b.id).length - String(a.name || a.id).length);
  return fuzzy[0] || null;
}

/**
 * Display-only: pull numbered action frames (walk_side_01…) out of a slot
 * row. Files and references stay where they are.
 */
export function splitSlotActionFrames<T extends { name: string }>(
  drawings: T[] | null | undefined,
  actions?: { id: string; name?: string; characterId: string | null; label: string }[] | null,
  characterId?: string | null
): { drawings: T[]; actionGroups: ActionFrameGroup<T>[] } {
  const standalone: T[] = [];
  const buckets = new Map<string, T[]>();
  for (const piece of drawings || []) {
    const prefix = numberedActionPrefix(piece.name);
    if (!prefix) {
      standalone.push(piece);
      continue;
    }
    const list = buckets.get(prefix);
    if (list) list.push(piece);
    else buckets.set(prefix, [piece]);
  }
  const actionGroups: ActionFrameGroup<T>[] = [];
  for (const [prefix, pieces] of buckets) {
    const action = matchActionShot(actions, characterId, prefix);
    if (pieces.length < 2 && !action) {
      standalone.push(...pieces);
      continue;
    }
    const sorted = [...pieces].sort((a, b) => {
      const diff = actionFrameIndex(a.name) - actionFrameIndex(b.name);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    actionGroups.push({
      id: prefix,
      prefix,
      label: prettyActionFrameLabel(prefix, sorted.length),
      drawings: sorted,
      actionId: action ? action.name || action.id : null,
      actionCharacterId: action ? action.characterId : characterId || null,
      actionLabel: action ? action.label : null,
    });
  }
  actionGroups.sort((a, b) => a.label.localeCompare(b.label));
  return { drawings: standalone, actionGroups };
}

export type AssetsSection = "characters" | "props" | "backgrounds" | "actions" | "sounds";

export const FACTORY_THUMB_PX = 256;
export const FACTORY_THUMB_WIDE_PX = 256;
export const FACTORY_THUMB_COMPACT_PX = 88;

export const ASSET_SECTIONS: { id: AssetsSection; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "props", label: "Props" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "actions", label: "Action Shots" },
  { id: "sounds", label: "Sounds" },
];

export function sectionLabel(id: AssetsSection | null | undefined): string {
  return ASSET_SECTIONS.find((item) => item.id === id)?.label || "Assets";
}

export function soundDisplayName(file: { label: string; rel: string }, duplicates: boolean): string {
  const base = file.rel.replace(/^audio\/[^/]+\//, "").replace(/\.wav$/i, "");
  return duplicates ? `${file.label} ${base}` : file.label;
}

export const PREFERRED_PROP_IDS = ["mic_stand", "microphone", "mic", "speaker"];

export function pickVisibleProp<T extends { id: string }>(props: T[] | null | undefined): T | null {
  if (!props || !props.length) return null;
  for (const id of PREFERRED_PROP_IDS) {
    const hit = props.find((item) => item.id === id || item.id.includes(id));
    if (hit) return hit;
  }
  return props[0];
}

export function actionPreviewSeconds(frames: number, fps: number): number {
  const cycle = Math.max(1, Number(frames) || 1) / Math.max(1, Number(fps) || 12);
  const loops = Math.max(1, Math.round(2 / cycle));
  return Math.min(3, Math.max(1, Number((loops * cycle).toFixed(1))));
}

export function actionShotCaption(action: {
  still?: boolean;
  frames?: number;
  drawings?: number;
} | null | undefined): string {
  if (!action) return "";
  if (action.still || (action.frames != null && action.frames <= 1)) return "still";
  const frames = Number(action.frames) || Number(action.drawings) || 0;
  if (frames <= 0) return "";
  return `${frames} shot${frames === 1 ? "" : "s"}`;
}
