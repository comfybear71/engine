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
