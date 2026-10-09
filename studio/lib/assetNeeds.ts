import raw from "./assetNeeds.json";

export type AssetDest =
  | { kind: "file"; rel: string }
  | { kind: "slot"; slot: string; drawings_dir: string; child?: string }
  | { kind: "prop" }
  | { kind: "background" };

export type AssetNeedCell = {
  name: string;
  dest: AssetDest;
  cycle?: string;
};

export type AssetNeed = {
  id: string;
  label: string;
  description: string;
  split: "grid" | "components";
  grid?: { cols: number; rows: number };
  key?: boolean;
  cells?: AssetNeedCell[];
  assignChoices?: string[];
  frameParam?: {
    default: number;
    min: number;
    max: number;
    views: string[];
  };
  cycleFps?: number;
  dest?: AssetDest;
  prompt: string;
};

export type ExpandedNeed = {
  id: string;
  label: string;
  description: string;
  split: "grid" | "components";
  grid: { cols: number; rows: number } | null;
  key: boolean;
  cells: AssetNeedCell[];
  assignChoices: string[];
  cycles: Record<string, { drawings: string[]; fps: number }> | null;
  prompt: string;
};

export const ASSET_NEEDS: AssetNeed[] = raw.needs as AssetNeed[];

export function getAssetNeed(id: string): AssetNeed | undefined {
  return ASSET_NEEDS.find((need) => need.id === id);
}

export function clampFrames(need: AssetNeed, frames: number): number {
  const param = need.frameParam;
  if (!param) return frames;
  const n = Math.floor(Number(frames));
  if (!Number.isFinite(n)) return param.default;
  return Math.min(param.max, Math.max(param.min, n));
}

export function expandNeed(need: AssetNeed, frames?: number): ExpandedNeed {
  const key = need.key !== false;
  if (!need.frameParam) {
    const cells = need.cells || [];
    return {
      id: need.id,
      label: need.label,
      description: need.description,
      split: need.split || (need.grid ? "grid" : "components"),
      grid: need.grid || null,
      key,
      cells,
      assignChoices: need.assignChoices || cells.map((cell) => cell.name),
      cycles: null,
      prompt: need.prompt,
    };
  }

  const n = clampFrames(need, frames ?? need.frameParam.default);
  const views = need.frameParam.views;
  const cells: AssetNeedCell[] = [];
  const cycles: Record<string, { drawings: string[]; fps: number }> = {};
  const fps = need.cycleFps || 12;
  const dest = need.dest || { kind: "slot" as const, slot: "body", drawings_dir: "body" };

  for (const view of views) {
    const drawings: string[] = [];
    const cycleName = `walk_${view}`;
    for (let i = 1; i <= n; i += 1) {
      const name = `${cycleName}_${String(i).padStart(2, "0")}`;
      drawings.push(name);
      cells.push({ name, dest, cycle: cycleName });
    }
    cycles[cycleName] = { drawings, fps };
  }

  return {
    id: need.id,
    label: need.label,
    description: need.description,
    split: "grid",
    grid: { cols: n, rows: views.length },
    key,
    cells,
    assignChoices: cells.map((cell) => cell.name),
    cycles,
    prompt: need.prompt,
  };
}

export function styleClause(style: string | null | undefined): string {
  const trimmed = (style || "").trim();
  if (!trimmed) return "in a consistent character style";
  return `in a ${trimmed} style`;
}

export function fillNeedPrompt(
  need: AssetNeed,
  vars: { name: string; style?: string | null; frames?: number }
): string {
  const expanded = expandNeed(need, vars.frames);
  const frames = expanded.grid?.cols ?? vars.frames ?? "";
  const rows = expanded.grid?.rows ?? "";
  return need.prompt
    .replaceAll("{{name}}", vars.name)
    .replaceAll("{{style}}", styleClause(vars.style))
    .replaceAll("{{frames}}", String(frames))
    .replaceAll("{{rows}}", String(rows))
    .replaceAll("{{grid}}", expanded.grid ? `${expanded.grid.cols}x${expanded.grid.rows}` : "1x1");
}
