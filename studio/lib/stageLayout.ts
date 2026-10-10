export const STAGE_LAYOUT_KEY = "engine.studio.stageLayout.v1";

/** Previous defaults from before the stacked Body/Face/Props lanes. */
const LEGACY_TIMELINE_HEIGHTS: readonly number[] = [176, 220];

export type StageLayout = {
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
};

/** Kept in sync with defaultTimelinePanelHeight() in timelineLanes.ts (tested). */
export const DEFAULT_STAGE_LAYOUT: StageLayout = {
  leftWidth: 280,
  rightWidth: 320,
  timelineHeight: 276,
};

export const STAGE_LAYOUT_LIMITS = {
  leftWidth: { min: 200, max: 520 },
  rightWidth: { min: 240, max: 480 },
  timelineHeight: { min: 180, max: 560 },
} as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampStageLayout(partial: Partial<StageLayout> | null | undefined): StageLayout {
  const src = partial && typeof partial === "object" ? partial : {};
  return {
    leftWidth: clamp(
      typeof src.leftWidth === "number" ? src.leftWidth : DEFAULT_STAGE_LAYOUT.leftWidth,
      STAGE_LAYOUT_LIMITS.leftWidth.min,
      STAGE_LAYOUT_LIMITS.leftWidth.max
    ),
    rightWidth: clamp(
      typeof src.rightWidth === "number" ? src.rightWidth : DEFAULT_STAGE_LAYOUT.rightWidth,
      STAGE_LAYOUT_LIMITS.rightWidth.min,
      STAGE_LAYOUT_LIMITS.rightWidth.max
    ),
    timelineHeight: clamp(
      typeof src.timelineHeight === "number" ? src.timelineHeight : DEFAULT_STAGE_LAYOUT.timelineHeight,
      STAGE_LAYOUT_LIMITS.timelineHeight.min,
      STAGE_LAYOUT_LIMITS.timelineHeight.max
    ),
  };
}

export function parseStoredLayout(raw: string | null | undefined): StageLayout {
  if (!raw) return { ...DEFAULT_STAGE_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as Partial<StageLayout>;
    if (typeof parsed.timelineHeight === "number" && LEGACY_TIMELINE_HEIGHTS.includes(parsed.timelineHeight)) {
      parsed.timelineHeight = DEFAULT_STAGE_LAYOUT.timelineHeight;
    }
    return clampStageLayout(parsed);
  } catch {
    return { ...DEFAULT_STAGE_LAYOUT };
  }
}

export function loadStageLayout(): StageLayout {
  if (typeof window === "undefined") return { ...DEFAULT_STAGE_LAYOUT };
  try {
    return parseStoredLayout(window.localStorage.getItem(STAGE_LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_STAGE_LAYOUT };
  }
}

export function saveStageLayout(layout: StageLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STAGE_LAYOUT_KEY, JSON.stringify(clampStageLayout(layout)));
  } catch {
    /* ignore quota / private mode */
  }
}

export const IMAGINE_DOCK_KEY = "engine.studio.imagineDock.v1";
export const DEFAULT_IMAGINE_HEIGHT = 280;
export const IMAGINE_HEIGHT_LIMITS = { min: 160, max: 560 } as const;

export function clampImagineHeight(value: number): number {
  return clamp(
    typeof value === "number" ? value : DEFAULT_IMAGINE_HEIGHT,
    IMAGINE_HEIGHT_LIMITS.min,
    IMAGINE_HEIGHT_LIMITS.max
  );
}

export function loadImagineHeight(): number {
  if (typeof window === "undefined") return DEFAULT_IMAGINE_HEIGHT;
  try {
    const raw = window.localStorage.getItem(IMAGINE_DOCK_KEY);
    if (!raw) return DEFAULT_IMAGINE_HEIGHT;
    const parsed = JSON.parse(raw) as { height?: number };
    return clampImagineHeight(typeof parsed.height === "number" ? parsed.height : DEFAULT_IMAGINE_HEIGHT);
  } catch {
    return DEFAULT_IMAGINE_HEIGHT;
  }
}

export function saveImagineHeight(height: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IMAGINE_DOCK_KEY, JSON.stringify({ height: clampImagineHeight(height) }));
  } catch {
    /* ignore quota / private mode */
  }
}

export const STAGE_LEFT_POOL_KEY = "engine.studio.stageLeftPool.v1";
export const LEFT_POOL_IDS = ["assets", "media", "effects"] as const;
export type StoredLeftPool = (typeof LEFT_POOL_IDS)[number];

export function parseStoredLeftPool(raw: string | null | undefined): StoredLeftPool | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: string | null };
    const id = parsed && typeof parsed === "object" ? parsed.id : raw;
    return LEFT_POOL_IDS.includes(id as StoredLeftPool) ? (id as StoredLeftPool) : null;
  } catch {
    return LEFT_POOL_IDS.includes(raw as StoredLeftPool) ? (raw as StoredLeftPool) : null;
  }
}

export function loadLeftPool(): StoredLeftPool | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredLeftPool(window.localStorage.getItem(STAGE_LEFT_POOL_KEY));
  } catch {
    return null;
  }
}

export function saveLeftPool(id: StoredLeftPool | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STAGE_LEFT_POOL_KEY, JSON.stringify({ id }));
  } catch {
    /* ignore quota / private mode */
  }
}

export const STAGE_ASSETS_TREE_KEY = "engine.studio.stageAssetsTree.v1";

export function parseStoredTreeOpen(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { open?: Record<string, boolean> };
    if (!parsed || typeof parsed.open !== "object" || !parsed.open) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed.open)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadAssetsTreeOpen(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    return parseStoredTreeOpen(window.localStorage.getItem(STAGE_ASSETS_TREE_KEY));
  } catch {
    return {};
  }
}

export function saveAssetsTreeOpen(open: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STAGE_ASSETS_TREE_KEY, JSON.stringify({ open }));
  } catch {
    /* ignore quota / private mode */
  }
}
