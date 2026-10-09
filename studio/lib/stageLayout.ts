export const STAGE_LAYOUT_KEY = "engine.studio.stageLayout.v1";

export type StageLayout = {
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
};

export const DEFAULT_STAGE_LAYOUT: StageLayout = {
  leftWidth: 280,
  rightWidth: 320,
  timelineHeight: 176,
};

export const STAGE_LAYOUT_LIMITS = {
  leftWidth: { min: 200, max: 520 },
  rightWidth: { min: 240, max: 480 },
  timelineHeight: { min: 120, max: 420 },
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
    return clampStageLayout(JSON.parse(raw) as Partial<StageLayout>);
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
