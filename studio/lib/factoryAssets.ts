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

export type ActionShot = {
  id: string;
  name: string;
  label: string;
  characterId: string | null;
  characterName: string;
  thumbRel?: string | null;
  rel?: string;
  source?: string;
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
      id: action.label || `${characterId || "shared"}/${action.id}`,
      name: action.name || action.id,
      label: action.name || action.id,
      characterId,
      characterName,
      thumbRel: action.thumbRel || null,
      rel: action.rel,
      source: action.source,
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

export type AssetsSection = "characters" | "props" | "backgrounds" | "actions" | "sounds";

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
