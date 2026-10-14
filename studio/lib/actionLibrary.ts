/**
 * Action pack dictionary + Action Shots grouping. Resolve-simple: clips in
 * the character library, shots grouped by category.
 */

export const DEFAULT_ACTION_CATEGORIES = [
  { id: "walks", label: "Walks" },
  { id: "turns_looks", label: "Turns/Looks" },
  { id: "head_moves", label: "Head moves" },
  { id: "mic", label: "Mic" },
  { id: "arms_gestures", label: "Arms/Gestures" },
  { id: "expressions", label: "Expressions" },
  { id: "idle_stand", label: "Idle/Stand" },
  { id: "inserts", label: "Inserts" },
  { id: "other", label: "Other" },
] as const;

export type ActionCategory = { id: string; label: string };

export const FRAME_ISSUE_LABELS: Record<string, string> = {
  upside_down: "upside down",
  mirrored: "mirrored",
  arm_side: "wrong arm/side",
  flagged: "flagged",
  empty: "empty",
};

export function issueLabel(issue: string | null | undefined): string {
  const id = String(issue || "").trim();
  return FRAME_ISSUE_LABELS[id] || id.replace(/_/g, " ");
}

export function mergeCategories(extra?: ActionCategory[] | null): ActionCategory[] {
  const seen = new Set<string>();
  const out: ActionCategory[] = [];
  for (const item of [...DEFAULT_ACTION_CATEGORIES, ...(extra || [])]) {
    const id = String(item.id || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: item.label || id });
  }
  return out;
}

export function inferActionCategory(id: string | null | undefined, explicit?: string | null): string {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const text = String(id || "").toLowerCase();
  if (/walk|stride|gait/.test(text)) return "walks";
  if (/mic/.test(text)) return "mic";
  if (/head/.test(text)) return "head_moves";
  if (/turn|look/.test(text)) return "turns_looks";
  if (/idle|stand/.test(text)) return "idle_stand";
  if (/arm|gesture/.test(text)) return "arms_gestures";
  if (/insert/.test(text)) return "inserts";
  return "other";
}

export type CategorizedAction<T extends { category?: string | null; name?: string; id?: string }> = {
  id: string;
  label: string;
  actions: T[];
};

export function groupActionsByCategory<T extends { category?: string | null; name?: string; id?: string }>(
  actions: T[] | null | undefined,
  categories?: ActionCategory[] | null
): CategorizedAction<T>[] {
  const cats = mergeCategories(categories);
  const buckets = new Map<string, T[]>();
  for (const cat of cats) buckets.set(cat.id, []);
  for (const action of actions || []) {
    const id = inferActionCategory(action.name || action.id, action.category);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(action);
  }
  const extra = [...buckets.keys()].filter((id) => !cats.some((cat) => cat.id === id));
  const order = [...cats, ...extra.map((id) => ({ id, label: id.replace(/_/g, " ") }))];
  return order
    .map((cat) => ({
      id: cat.id,
      label: cat.label,
      actions: buckets.get(cat.id) || [],
    }))
    .filter((group) => group.actions.length > 0 || cats.some((cat) => cat.id === group.id));
}

export function actionShotBadge(action: { still?: boolean; frames?: number; drawings?: number } | null | undefined): string {
  if (!action) return "";
  if (action.still || (action.frames != null && action.frames <= 1)) return "still";
  const frames = Number(action.frames) || Number(action.drawings) || 0;
  if (frames <= 0) return "";
  return `${frames} shot${frames === 1 ? "" : "s"}`;
}
