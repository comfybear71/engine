"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TimelineContextMenu, { type TimelineContextAction } from "@/components/TimelineContextMenu";
import { formatTimecode } from "@/lib/playhead";
import {
  ASSET_DRAG_MIME,
  applyAssetDropToScript,
  parseAssetDrag,
} from "@/lib/stageAssets";
import {
  clipboardFromBlocks,
  clipboardItemFitsLane,
  deleteBlocksInScript,
  duplicateBlocksInScript,
  pasteClipboardInScript,
  relatedEditIds,
  type TimelineClipboard,
} from "@/lib/timelineClipboard";
import {
  HEAD_VIEWS,
  applyTrimWrite,
  blockIsMovable,
  blockIsTrimmable,
  clampTrimEdge,
  collectSnapFrames,
  formatAtTime,
  idsForMarriedGroup,
  isMouthBlock,
  lineHasPinHold,
  moveBlocksInScript,
  planSplit,
  planTrim,
  setViewOnLine,
  snapStart,
  splitBlocksInScript,
  takeWindowForIds,
  trimKindForBlock,
  uniqueSplitWrites,
} from "@/lib/timelineEdit";
import { MOUTH_SHAPES, blocksIntersectingView, cueSourceTimes, visibleCueIndexes } from "@/lib/mouthCues";
import {
  DEFAULT_LANE_SCALE,
  H_SCROLLBAR_PX,
  LABEL_WIDTH,
  LANE_SCALE_STEP,
  MAX_LANE_SCALE,
  MIN_LANE_SCALE,
  RULER_PX,
  chipHeightPx,
  clampLaneScale,
  laneHeightPx,
  laneRowCount,
  laneScaleToSlider,
  loadLaneScale,
  occupiedLaneRowPx,
  saveLaneScale,
  sliderToLaneScale,
} from "@/lib/timelineLanes";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  followPlayheadScroll,
  loadProjectZoom,
  pixelsPerFrame,
  rulerTicks,
  saveProjectZoom,
  sliderToZoom,
  trackWidthPx,
  zoomAroundCursor,
  zoomToSlider,
} from "@/lib/timelineZoom";
import type { LaneBlock, LaneId, LanesResponse } from "@/lib/worker";

const LANE_META: { id: LaneId; label: string; bar: string; text: string }[] = [
  { id: "body", label: "Body/Move", bar: "bg-orange-500/80", text: "text-orange-50" },
  { id: "face", label: "Face", bar: "bg-rose-500/80", text: "text-rose-50" },
  { id: "props", label: "Props", bar: "bg-teal-500/80", text: "text-teal-50" },
  { id: "dialogue", label: "Dialogue", bar: "bg-sky-500/80", text: "text-sky-50" },
  { id: "audio", label: "Audio", bar: "bg-emerald-600/80", text: "text-emerald-50" },
  { id: "sfx", label: "SFX", bar: "bg-amber-500/80", text: "text-amber-50" },
  { id: "camera", label: "Camera", bar: "bg-violet-500/80", text: "text-violet-50" },
];

const DRAG_THRESHOLD_PX = 3;
const SNAP_PX = 8;
const CUE_COLORS: Record<string, string> = {
  X: "#525252",
  A: "#38bdf8",
  B: "#22d3ee",
  C: "#34d399",
  D: "#a3e635",
  E: "#fbbf24",
  F: "#fb923c",
  G: "#f472b6",
  H: "#c084fc",
};

function relatedMoveIds(blocks: LaneBlock[], seed: Set<string>): Set<string> {
  const ids = idsForMarriedGroup(blocks, seed);
  const seedBlocks = blocks.filter((block) => seed.has(block.id));
  const seedIsSpeech = seedBlocks.some((block) => block.lane === "dialogue" || block.lane === "audio");
  const lines = new Set(
    seedBlocks.map((block) => block.scriptLine).filter((line): line is number => line != null)
  );
  for (const block of blocks) {
    if (block.scriptLine == null || !lines.has(block.scriptLine)) continue;
    const isSpeech = block.lane === "dialogue" || block.lane === "audio";
    if (seedIsSpeech ? isSpeech : !isSpeech) ids.add(block.id);
  }
  return ids;
}

function idsForScriptLines(blocks: LaneBlock[], lines: Iterable<number>): Set<string> {
  const wanted = new Set(lines);
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.scriptLine != null && wanted.has(block.scriptLine)) ids.add(block.id);
  }
  return ids;
}

export default function TimelineLanes({
  project,
  lanes,
  frame,
  selectedLine,
  onSeek,
  totalFrames,
  playing = false,
  scriptText = "",
  onEditScript,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSyncLines,
  onPlaySelection,
  onToggleLoopSelection,
  onSelectionRange,
  syncing = false,
  lipSyncMode = "auto",
  onToggleLipSyncMode,
  loopSelection = false,
  onPatchCue,
}: {
  project: string | null;
  lanes: LanesResponse | null;
  frame: number;
  selectedLine: number | null;
  onSeek: (frame: number, scriptLine: number | null) => void;
  totalFrames?: number;
  playing?: boolean;
  scriptText?: string;
  onEditScript?: (next: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSyncLines?: (opts: { all?: boolean; scriptLine?: number; force?: boolean }) => void;
  onPlaySelection?: () => void;
  onToggleLoopSelection?: () => void;
  onSelectionRange?: (range: { start: number; end: number; scriptLine: number | null } | null) => void;
  syncing?: boolean;
  lipSyncMode?: "auto" | "manual";
  onToggleLipSyncMode?: () => void;
  loopSelection?: boolean;
  onPatchCue?: (patch: {
    rel: string;
    start: number;
    end: number;
    value?: string;
    pinned?: boolean;
  }) => void;
}) {
  const total = Math.max(totalFrames || lanes?.totalFrames || 1, 1);
  const fps = Math.max(lanes?.fps || 24, 1);
  const maxFrame = Math.max(total - 1, 0);
  const allBlocks = lanes?.blocks || [];
  const scenes = lanes?.scenes || [];
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [laneScale, setLaneScale] = useState(DEFAULT_LANE_SCALE);
  const [viewWidth, setViewWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draftDelta, setDraftDelta] = useState(0);
  const [draftTrim, setDraftTrim] = useState<{
    ids: Set<string>;
    edge: "in" | "out";
    start: number;
    end: number;
    allowed: boolean;
  } | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [expandedMouthIds, setExpandedMouthIds] = useState<Set<string>>(new Set());
  const [cueEditor, setCueEditor] = useState<{
    blockId: string;
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const [rubber, setRubber] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [clipboard, setClipboard] = useState<TimelineClipboard>({ items: [] });
  const [dropLane, setDropLane] = useState<LaneId | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lane: LaneId | null;
  } | null>(null);
  const hScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerScrollRef = useRef<HTMLDivElement | null>(null);
  const laneHRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const followLockRef = useRef(false);
  const selectedLinesRef = useRef<Set<number>>(new Set());
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    originStart: number;
    ids: Set<string>;
    moved: boolean;
    alt: boolean;
    delta: number;
  } | null>(null);
  const trimRef = useRef<{
    pointerId: number;
    edge: "in" | "out";
    ids: Set<string>;
    origin: number;
    allowed: boolean;
  } | null>(null);
  const rubberRef = useRef<{
    pointerId: number;
    x0: number;
    y0: number;
    additive: boolean;
    base: Set<string>;
  } | null>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startScroll: number } | null>(null);
  zoomRef.current = zoom;

  const rowPx = occupiedLaneRowPx(laneScale);
  const chipPx = chipHeightPx(laneScale);

  const laneBlocks = useMemo(() => {
    const faceExpanded = allBlocks.some((block) => isMouthBlock(block) && expandedMouthIds.has(block.id));
    return LANE_META.map((lane) => {
      const list = allBlocks.filter((b) => b.lane === lane.id);
      const extra = lane.id === "face" && faceExpanded ? 18 : 0;
      return { ...lane, blocks: list, height: laneHeightPx(list, laneScale) + extra, rows: laneRowCount(list) };
    });
  }, [allBlocks, laneScale, expandedMouthIds]);

  useEffect(() => {
    if (!project) {
      setZoom(MIN_ZOOM);
      return;
    }
    setZoom(loadProjectZoom(project));
  }, [project]);

  useEffect(() => {
    if (!project) return;
    saveProjectZoom(project, zoom);
  }, [project, zoom]);

  useEffect(() => {
    setLaneScale(loadLaneScale());
  }, []);

  useEffect(() => {
    saveLaneScale(laneScale);
  }, [laneScale]);

  useEffect(() => {
    if (!contextMenu) return;
    function onClose() {
      setContextMenu(null);
    }
    window.addEventListener("pointerdown", onClose);
    return () => window.removeEventListener("pointerdown", onClose);
  }, [contextMenu]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selectedLinesRef.current.size === 0) return;
    setSelectedIds(idsForScriptLines(allBlocks, selectedLinesRef.current));
  }, [allBlocks]);

  const ppf = pixelsPerFrame(zoom, total, viewWidth || 1);
  const trackW = trackWidthPx(total, ppf, viewWidth || 1);
  const playheadX = Math.min(frame, maxFrame) * ppf;
  const ticks = useMemo(
    () =>
      rulerTicks({
        totalFrames: total,
        fps,
        ppf,
        scrollLeft,
        viewWidth: viewWidth || trackW,
      }),
    [total, fps, ppf, scrollLeft, viewWidth, trackW]
  );

  const applyHScroll = useCallback((next: number) => {
    const el = hScrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const clamped = Math.max(0, Math.min(max, next));
    el.scrollLeft = clamped;
    if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = clamped;
    if (laneHRef.current) laneHRef.current.scrollLeft = clamped;
    setScrollLeft(clamped);
  }, []);

  const onHScroll = useCallback(() => {
    const el = hScrollRef.current;
    if (!el) return;
    const left = el.scrollLeft;
    if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = left;
    if (laneHRef.current) laneHRef.current.scrollLeft = left;
    setScrollLeft(left);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const el = hScrollRef.current;
    if (!el || followLockRef.current) return;
    const next = followPlayheadScroll(frame, ppf, el.scrollLeft, el.clientWidth);
    if (next != null) applyHScroll(next);
  }, [playing, frame, ppf, applyHScroll]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = viewRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = scrollLeft + (clientX - rect.left);
      onSeek(Math.max(0, Math.min(maxFrame, Math.round(x / Math.max(ppf, 1e-6)))), null);
    },
    [onSeek, maxFrame, ppf, scrollLeft]
  );

  function onRulerPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    followLockRef.current = true;
    seekFromClientX(event.clientX);
  }

  function onRulerPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekFromClientX(event.clientX);
  }

  function onRulerPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    followLockRef.current = false;
  }

  function emitSelectionRange(next: Set<string>) {
    const members = allBlocks.filter((block) => next.has(block.id));
    if (members.length === 0) {
      onSelectionRange?.(null);
      return;
    }
    onSelectionRange?.({
      start: Math.min(...members.map((block) => block.startFrame)),
      end: Math.max(...members.map((block) => block.endFrame)),
      scriptLine: members.find((block) => block.scriptLine != null)?.scriptLine ?? null,
    });
  }

  function clearSelection() {
    selectedLinesRef.current = new Set();
    setSelectedIds(new Set());
    onSelectionRange?.(null);
  }

  function commitSelection(next: Set<string>) {
    const lines = new Set<number>();
    for (const block of allBlocks) {
      if (next.has(block.id) && block.scriptLine != null) lines.add(block.scriptLine);
    }
    selectedLinesRef.current = lines;
    setSelectedIds(next);
    emitSelectionRange(next);
  }

  function selectFromClick(block: LaneBlock, additive: boolean) {
    const next = additive ? new Set(selectedIds) : new Set<string>();
    if (additive && next.has(block.id)) next.delete(block.id);
    else next.add(block.id);
    commitSelection(next);
  }

  function applyMove(delta: number, ids: Set<string>) {
    if (!onEditScript || !scriptText || delta === 0) return;
    const moves = [];
    const seen = new Set<number>();
    for (const block of allBlocks) {
      if (!ids.has(block.id) || !blockIsMovable(block) || block.scriptLine == null) continue;
      if (seen.has(block.scriptLine)) continue;
      seen.add(block.scriptLine);
      const scene = scenes.find((item) => item.id === block.sceneId);
      const source = block.sourceStartFrame ?? block.startFrame;
      const line = scriptText.split("\n")[block.scriptLine - 1] || "";
      const hold =
        trimKindForBlock(block) === "pin" && !lineHasPinHold(line)
          ? formatAtTime(Math.max(1, block.endFrame - block.startFrame), fps)
          : undefined;
      moves.push({
        scriptLine: block.scriptLine,
        startFrame: Math.max(0, source + delta),
        sceneStartFrame: scene?.startFrame ?? 0,
        hold,
      });
    }
    const next = moveBlocksInScript(scriptText, moves, fps);
    if (next !== scriptText) onEditScript(next);
  }

  function applyView(view: string) {
    if (!onEditScript || !scriptText) return;
    const block = allBlocks.find((item) => item.lane === "dialogue" && selectedIds.has(item.id));
    if (!block || block.scriptLine == null) return;
    const lines = scriptText.split("\n");
    const index = block.scriptLine - 1;
    if (!lines[index]) return;
    lines[index] = setViewOnLine(lines[index], view);
    const next = lines.join("\n");
    if (next !== scriptText) onEditScript(next);
  }

  function snapEdge(raw: number, ignoreIds: Iterable<string>, alt: boolean): { frame: number; snappedTo: number | null } {
    if (alt) return { frame: Math.max(0, Math.round(raw)), snappedTo: null };
    return snapStart(
      raw,
      collectSnapFrames({
        playhead: frame,
        blocks: allBlocks,
        ignoreIds,
        fps,
        totalFrames: total,
      }),
      Math.max(1, Math.round(SNAP_PX / Math.max(ppf, 1e-6)))
    );
  }

  function applyTrim(edge: "in" | "out", newEdgeFrame: number, ids: Set<string>) {
    if (!onEditScript || !scriptText) return;
    const write = planTrim({
      blocks: allBlocks,
      ids,
      edge,
      newEdgeFrame,
      scenes,
      fps,
      script: scriptText,
    });
    if (!write) return;
    const next = applyTrimWrite(scriptText, write);
    if (next !== scriptText) onEditScript(next);
  }

  function applySplit() {
    if (!onEditScript || !scriptText) return;
    const seeds = selectedIds.size > 0 ? selectedIds : new Set(allBlocks.filter((block) => block.scriptLine === selectedLine).map((block) => block.id));
    if (seeds.size === 0) return;
    const groups = new Map<number, Set<string>>();
    for (const id of relatedMoveIds(allBlocks, seeds)) {
      const block = allBlocks.find((item) => item.id === id);
      if (!block || block.scriptLine == null) continue;
      const set = groups.get(block.scriptLine) || new Set<string>();
      set.add(block.id);
      groups.set(block.scriptLine, set);
    }
    const writes = uniqueSplitWrites(
      [...groups.values()].map((ids) =>
        planSplit({
          blocks: allBlocks,
          ids,
          playhead: frame,
          scenes,
          fps,
          script: scriptText,
        })
      )
    );
    if (writes.length === 0) return;
    const next = splitBlocksInScript(scriptText, writes);
    if (next !== scriptText) onEditScript(next);
  }

  function canSplitSelection(): boolean {
    if (!scriptText) return false;
    const seeds = selectedIds.size > 0 ? selectedIds : new Set(allBlocks.filter((block) => block.scriptLine === selectedLine).map((block) => block.id));
    if (seeds.size === 0) return false;
    const take = takeWindowForIds(allBlocks, relatedMoveIds(allBlocks, seeds));
    if (!take) return false;
    return frame > take.start && frame < take.end;
  }

  function selectionSeeds(): Set<string> {
    if (selectedIds.size > 0) return selectedIds;
    return new Set(allBlocks.filter((block) => block.scriptLine === selectedLine).map((block) => block.id));
  }

  function applyCopy() {
    const seeds = selectionSeeds();
    if (seeds.size === 0) return;
    setClipboard(clipboardFromBlocks(scriptText, allBlocks, seeds));
  }

  function applyDelete(ripple: boolean) {
    if (!onEditScript || !scriptText) return;
    const seeds = selectionSeeds();
    if (seeds.size === 0) return;
    const next = deleteBlocksInScript({
      script: scriptText,
      blocks: allBlocks,
      ids: seeds,
      scenes,
      fps,
      ripple,
    });
    if (next !== scriptText) onEditScript(next);
  }

  function applyCut() {
    applyCopy();
    applyDelete(false);
  }

  function applyPaste(lane: LaneId | null = null) {
    if (!onEditScript || !scriptText || clipboard.items.length === 0) return;
    const next = pasteClipboardInScript({
      script: scriptText,
      clipboard,
      playhead: frame,
      fps,
      scenes,
      playheadLine: selectedLine,
      lane,
    });
    if (next !== scriptText) onEditScript(next);
  }

  function applyDuplicate() {
    if (!onEditScript || !scriptText) return;
    const seeds = selectionSeeds();
    if (seeds.size === 0) return;
    const next = duplicateBlocksInScript({
      script: scriptText,
      blocks: allBlocks,
      ids: seeds,
      fps,
      scenes,
    });
    if (next !== scriptText) onEditScript(next);
  }

  function applyContextAction(action: TimelineContextAction) {
    const lane = contextMenu?.lane ?? null;
    if (action === "copy") applyCopy();
    else if (action === "cut") applyCut();
    else if (action === "paste") applyPaste(lane);
    else if (action === "duplicate") applyDuplicate();
    else if (action === "delete") applyDelete(false);
    else if (action === "ripple") applyDelete(true);
    else if (action === "sync" || action === "redo-sync") {
      const block = allBlocks.find((item) => selectedIds.has(item.id) && item.lane === "dialogue");
      if (block?.scriptLine != null) onSyncLines?.({ scriptLine: block.scriptLine, force: action === "redo-sync" });
    }
  }

  function openContextMenu(event: React.MouseEvent, block: LaneBlock | null, lane: LaneId | null) {
    event.preventDefault();
    event.stopPropagation();
    if (block) {
      const next = selectedIds.has(block.id) ? new Set(selectedIds) : new Set<string>([block.id]);
      commitSelection(relatedEditIds(allBlocks, next));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, lane });
  }

  function onAssetDragOver(event: React.DragEvent<HTMLDivElement>, lane: LaneId) {
    if (![...event.dataTransfer.types].some((type) => type === ASSET_DRAG_MIME || type === "text/plain")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropLane(lane);
  }

  function onAssetDrop(event: React.DragEvent<HTMLDivElement>, lane: LaneId) {
    event.preventDefault();
    event.stopPropagation();
    setDropLane(null);
    if (!onEditScript || !scriptText) return;
    const asset = parseAssetDrag(event.dataTransfer.getData(ASSET_DRAG_MIME) || event.dataTransfer.getData("text/plain"));
    if (!asset) return;
    const rect = viewRef.current?.getBoundingClientRect();
    const x = rect ? scrollLeft + (event.clientX - rect.left) : 0;
    const dropFrame = Math.max(0, Math.min(maxFrame, Math.round(x / Math.max(ppf, 1e-6))));
    const next = applyAssetDropToScript({
      script: scriptText,
      asset,
      lane,
      frame: dropFrame,
      fps,
      scenes,
      playheadLine: selectedLine,
    });
    if (next !== scriptText) onEditScript(next);
  }

  function onTrimPointerDown(event: React.PointerEvent<HTMLElement>, block: LaneBlock, edge: "in" | "out") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = selectedIds.has(block.id) ? new Set(selectedIds) : new Set<string>([block.id]);
    commitSelection(next);
    const related = relatedMoveIds(allBlocks, next);
    const take = takeWindowForIds(allBlocks, related);
    if (!take || !blockIsTrimmable(block)) return;
    followLockRef.current = true;
    const drag = {
      pointerId: event.pointerId,
      edge,
      ids: related,
      origin: edge === "in" ? take.start : take.end,
      edgeFrame: edge === "in" ? take.start : take.end,
      allowed: true,
    };
    trimRef.current = drag;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      ev.preventDefault();
      const raw = drag.origin + (ev.clientX - event.clientX) / Math.max(ppf, 1e-6);
      const snapped = snapEdge(raw, drag.ids, ev.altKey);
      const clamped = clampTrimEdge({ edge: drag.edge, rawFrame: snapped.frame, take });
      drag.allowed = clamped.allowed;
      drag.edgeFrame = clamped.frame;
      const start = drag.edge === "in" ? clamped.frame : take.start;
      const end = drag.edge === "out" ? clamped.frame : take.end;
      setDraftTrim({ ids: drag.ids, edge: drag.edge, start, end, allowed: clamped.allowed });
      setSnapGuide(snapped.snappedTo);
      const inFrame = take.trimIn + (start - take.start);
      const outFrame = take.trimIn + (end - take.start);
      setTooltip({
        x: ev.clientX,
        y: ev.clientY,
        text: `in ${formatTimecode(inFrame, fps)}  out ${formatTimecode(outFrame, fps)}  ${formatTimecode(Math.max(1, end - start), fps)}`,
      });
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (trimRef.current?.pointerId === drag.pointerId) trimRef.current = null;
      followLockRef.current = false;
      setDraftTrim(null);
      setSnapGuide(null);
      setTooltip(null);
      if (drag.edgeFrame !== drag.origin) applyTrim(drag.edge, drag.edgeFrame, drag.ids);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onChipPointerDown(event: React.PointerEvent<HTMLDivElement>, block: LaneBlock) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (isMouthBlock(block)) {
      const group = relatedMoveIds(allBlocks, new Set([block.id]));
      commitSelection(group);
      onSeek(block.startFrame, block.scriptLine);
      return;
    }
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const already = selectedIds.has(block.id);
    const next = additive || already ? new Set(selectedIds) : new Set<string>();
    if (!already) next.add(block.id);
    commitSelection(next);
    const related = relatedMoveIds(allBlocks, next);
    const movable = [...related].some((id) => {
      const hit = allBlocks.find((item) => item.id === id);
      return hit ? blockIsMovable(hit) : false;
    });
    followLockRef.current = true;
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      originStart: block.startFrame,
      ids: movable ? related : new Set<string>(),
      moved: false,
      alt: event.altKey,
      delta: 0,
    };
    dragRef.current = drag;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      const dx = ev.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (drag.ids.size === 0) return;
      ev.preventDefault();
      drag.moved = true;
      drag.alt = ev.altKey;
      const rawDelta = dx / Math.max(ppf, 1e-6);
      const members = allBlocks.filter((item) => drag.ids.has(item.id));
      const minStart = Math.min(...members.map((item) => item.startFrame));
      let nextStart = minStart + rawDelta;
      let snappedTo: number | null = null;
      if (!drag.alt) {
        const snapped = snapStart(
          nextStart,
          collectSnapFrames({
            playhead: frame,
            blocks: allBlocks,
            ignoreIds: drag.ids,
            fps,
            totalFrames: total,
          }),
          Math.max(1, Math.round(SNAP_PX / Math.max(ppf, 1e-6)))
        );
        nextStart = snapped.frame;
        snappedTo = snapped.snappedTo;
      } else {
        nextStart = Math.max(0, Math.round(nextStart));
      }
      drag.delta = nextStart - minStart;
      setDraftDelta(drag.delta);
      setSnapGuide(snappedTo);
      setTooltip({
        x: ev.clientX,
        y: ev.clientY,
        text: formatTimecode(Math.max(0, drag.originStart + drag.delta), fps),
      });
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragRef.current?.pointerId === drag.pointerId) dragRef.current = null;
      followLockRef.current = false;
      setDraftDelta(0);
      setSnapGuide(null);
      setTooltip(null);
      if (drag.moved) {
        applyMove(drag.delta, drag.ids);
        return;
      }
      selectFromClick(block, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      onSeek(block.startFrame, block.scriptLine);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("[data-lane-chip]")) return;
    if (event.button === 1) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      followLockRef.current = true;
      panRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: hScrollRef.current?.scrollLeft || 0 };
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    followLockRef.current = true;
    rubberRef.current = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      base: new Set(selectedIds),
    };
    setRubber({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY });
  }

  function onTrackPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      applyHScroll(pan.startScroll - (event.clientX - pan.startX));
      return;
    }
    const box = rubberRef.current;
    if (!box || box.pointerId !== event.pointerId) return;
    setRubber({ x0: box.x0, y0: box.y0, x1: event.clientX, y1: event.clientY });
  }

  function onTrackPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    const box = rubberRef.current;
    rubberRef.current = null;
    followLockRef.current = false;
    setRubber(null);
    if (!box || box.pointerId !== event.pointerId) return;
    const left = Math.min(box.x0, event.clientX);
    const right = Math.max(box.x0, event.clientX);
    const top = Math.min(box.y0, event.clientY);
    const bottom = Math.max(box.y0, event.clientY);
    const next = box.additive ? new Set(box.base) : new Set<string>();
    if (right - left >= 3 || bottom - top >= 3) {
      const chips = trackRef.current?.querySelectorAll<HTMLElement>("[data-lane-chip]") || [];
      for (const chip of chips) {
        const rect = chip.getBoundingClientRect();
        const hit = rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
        if (hit && chip.dataset.blockId) next.add(chip.dataset.blockId);
      }
      commitSelection(next);
    } else if (!box.additive) {
      clearSelection();
    }
  }

  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      const h = hScrollRef.current;
      const view = viewRef.current;
      if (!h) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = (view || h).getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const width = view?.clientWidth || h.clientWidth;
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const next = zoomAroundCursor(zoomRef.current, factor, cursorX, h.scrollLeft, total, width);
        setZoom(next.zoom);
        requestAnimationFrame(() => applyHScroll(next.scrollLeft));
        return;
      }
      if (Math.abs(event.deltaX) > 0.5 || Math.abs(event.deltaY) > 0.5) {
        event.preventDefault();
        applyHScroll(h.scrollLeft + (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY));
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyHScroll, total]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("textarea, input, [contenteditable='true']")) return;
      if (event.key === "Escape") {
        clearSelection();
        setRubber(null);
        setContextMenu(null);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "s" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        applySplit();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        applyDelete(event.shiftKey);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (key === "c") {
        event.preventDefault();
        applyCopy();
        return;
      }
      if (key === "x") {
        event.preventDefault();
        applyCut();
        return;
      }
      if (key === "v") {
        event.preventDefault();
        applyPaste(null);
        return;
      }
      if (key === "d") {
        event.preventDefault();
        applyDuplicate();
        return;
      }
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        onRedo?.();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        onUndo?.();
        return;
      }
      if (key === "y") {
        event.preventDefault();
        onRedo?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onRedo, applySplit, scriptText, selectedIds, selectedLine, frame, allBlocks, scenes, fps, clipboard, onEditScript, onSyncLines]);

  function nudgeZoom(factor: number) {
    const h = hScrollRef.current;
    const width = viewRef.current?.clientWidth || h?.clientWidth || viewWidth || 1;
    const cursorX = width / 2;
    const next = zoomAroundCursor(zoom, factor, cursorX, h?.scrollLeft || 0, total, width);
    setZoom(next.zoom);
    requestAnimationFrame(() => applyHScroll(next.scrollLeft));
  }

  function onFit() {
    setZoom(MIN_ZOOM);
    requestAnimationFrame(() => applyHScroll(0));
  }

  function nudgeLaneScale(delta: number) {
    setLaneScale((current) => clampLaneScale(current + delta));
  }

  const headerBtn =
    "flex h-6 w-6 items-center justify-center rounded border border-neutral-600 bg-black/40 text-white hover:bg-neutral-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent";

  return (
    <div className="flex h-full min-h-0 flex-col bg-studio-panel" data-testid="timeline-lanes">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11px] text-studio-muted">
        <span className="uppercase tracking-[0.14em]">Timeline</span>
        <div className="flex items-center gap-1" data-testid="timeline-edit-controls">
          <button
            type="button"
            data-testid="timeline-undo"
            title="Undo timeline edit (Ctrl+Z)"
            aria-label="Undo timeline edit"
            onClick={() => onUndo?.()}
            disabled={!canUndo}
            className="studio-header-iconbtn"
          >
            ↶
          </button>
          <button
            type="button"
            data-testid="timeline-redo"
            title="Redo timeline edit (Ctrl+Y)"
            aria-label="Redo timeline edit"
            onClick={() => onRedo?.()}
            disabled={!canRedo}
            className="studio-header-iconbtn"
          >
            ↷
          </button>
          <button
            type="button"
            data-testid="timeline-split"
            title="Split selected block(s) at the playhead (S)"
            aria-label="Split at playhead"
            onClick={() => applySplit()}
            disabled={!onEditScript || !canSplitSelection()}
            className="studio-header-textbtn"
          >
            Split
          </button>
          {allBlocks.some((block) => block.lane === "dialogue" && selectedIds.has(block.id)) ? (
            <label className="ml-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500" data-testid="timeline-view-control">
              View
              <select
                data-testid="timeline-view-select"
                className="studio-view-select"
                value={
                  allBlocks.find((block) => block.lane === "dialogue" && selectedIds.has(block.id))?.view || "front"
                }
                onChange={(event) => applyView(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {HEAD_VIEWS.map((view) => (
                  <option key={view} value={view}>
                    {view}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="studio-header-textbtn"
            data-testid="timeline-sync-all"
            title="Run Rhubarb on every unsynced or stale line"
            disabled={syncing || !onSyncLines}
            onClick={() => onSyncLines?.({ all: true })}
          >
            Sync all
          </button>
          <button
            type="button"
            className="studio-header-iconbtn"
            data-testid="timeline-play-selection"
            title="Play selected block(s)"
            aria-label="Play selection"
            disabled={!onPlaySelection}
            onClick={() => onPlaySelection?.()}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M3 2h1.5v12H3V2zm3 1.2v9.6L14 8 6 3.2z" />
            </svg>
          </button>
          <button
            type="button"
            className="studio-header-iconbtn"
            data-testid="timeline-loop-selection"
            title="Loop selected block(s)"
            aria-label="Loop selection"
            aria-pressed={loopSelection}
            data-active={loopSelection ? "true" : "false"}
            disabled={!onToggleLoopSelection}
            onClick={() => onToggleLoopSelection?.()}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M12 3H7.5L9 1.5 8 0.5 5 3.5 8 6.5 9 5.5 7.5 4H12a2 2 0 0 1 2 2v3h-1.5V6a.5.5 0 0 0-.5-.5h-4.5M4 13h4.5L7 14.5 8 15.5 11 12.5 8 9.5 7 10.5 8.5 12H4a2 2 0 0 1-2-2V7h1.5v3a.5.5 0 0 0 .5.5h4.5" />
            </svg>
          </button>
          <button
            type="button"
            className="studio-header-textbtn"
            data-testid="timeline-lipsync-mode"
            title="When auto, voices and import-audio still run Rhubarb"
            data-active={lipSyncMode === "manual" ? "true" : "false"}
            disabled={!onToggleLipSyncMode}
            onClick={() => onToggleLipSyncMode?.()}
          >
            {lipSyncMode === "manual" ? "Manual" : "Auto"}
          </button>
        </div>
        <div className="flex items-center gap-1" data-testid="timeline-zoom-controls">
          <button
            type="button"
            data-testid="timeline-zoom-out"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => nudgeZoom(1 / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className={headerBtn}
          >
            −
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={zoomToSlider(zoom)}
            aria-label="Timeline zoom"
            data-testid="timeline-zoom-slider"
            className="studio-zoom-slider w-28"
            onChange={(event) => {
              const h = hScrollRef.current;
              const width = viewRef.current?.clientWidth || h?.clientWidth || viewWidth || 1;
              const nextZoom = sliderToZoom(Number(event.target.value));
              const factor = zoom > 0 ? nextZoom / zoom : 1;
              const next = zoomAroundCursor(zoom, factor, width / 2, h?.scrollLeft || 0, total, width);
              setZoom(next.zoom);
              requestAnimationFrame(() => applyHScroll(next.scrollLeft));
            }}
          />
          <button
            type="button"
            data-testid="timeline-zoom-in"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => nudgeZoom(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className={headerBtn}
          >
            +
          </button>
          <button
            type="button"
            data-testid="timeline-zoom-fit"
            title="Fit the whole shot"
            aria-label="Fit the whole shot"
            onClick={onFit}
            className="h-6 rounded border border-neutral-600 bg-black/40 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
          >
            Fit
          </button>
        </div>
        <div className="flex items-center gap-1" data-testid="timeline-lane-height-controls" title="Lane height">
          <span className="hidden uppercase tracking-[0.14em] md:inline">Lanes</span>
          <button
            type="button"
            data-testid="timeline-lane-height-down"
            title="Shorter lanes"
            aria-label="Shorter lanes"
            onClick={() => nudgeLaneScale(-LANE_SCALE_STEP)}
            disabled={laneScale <= MIN_LANE_SCALE}
            className={headerBtn}
          >
            −
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={laneScaleToSlider(laneScale)}
            aria-label="Lane height"
            data-testid="timeline-lane-height-slider"
            className="studio-zoom-slider w-16"
            onChange={(event) => setLaneScale(sliderToLaneScale(Number(event.target.value)))}
          />
          <button
            type="button"
            data-testid="timeline-lane-height-up"
            title="Taller lanes"
            aria-label="Taller lanes"
            onClick={() => nudgeLaneScale(LANE_SCALE_STEP)}
            disabled={laneScale >= MAX_LANE_SCALE}
            className={headerBtn}
          >
            +
          </button>
        </div>
        <span className="ml-auto hidden uppercase tracking-[0.14em] lg:inline">Script is the source of truth</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col" ref={wheelRef}>
        <div className="flex shrink-0">
          <div className="shrink-0" style={{ width: LABEL_WIDTH, height: RULER_PX }} />
          <div
            ref={rulerScrollRef}
            className="min-w-0 flex-1 overflow-hidden"
            style={{ height: RULER_PX }}
          >
            <div
              data-testid="timeline-ruler"
              className="relative cursor-ew-resize border-b border-neutral-800 bg-studio-panel"
              style={{ width: trackW, height: RULER_PX }}
              onPointerDown={onRulerPointerDown}
              onPointerMove={onRulerPointerMove}
              onPointerUp={onRulerPointerUp}
              onPointerCancel={onRulerPointerUp}
            >
              {ticks.map((tick) => (
                <div
                  key={`${tick.major ? "M" : "m"}-${tick.frame}`}
                  className="absolute top-0 h-full"
                  style={{ left: tick.frame * ppf }}
                >
                  <div className={`w-px ${tick.major ? "h-3 bg-neutral-300" : "h-1.5 bg-neutral-600"}`} />
                  {tick.label ? (
                    <span className="absolute left-1 top-0 font-mono text-[9px] tabular-nums text-neutral-300">
                      {tick.label}
                    </span>
                  ) : null}
                </div>
              ))}
              <div className="pointer-events-none absolute top-0 z-10" style={{ left: playheadX }}>
                <div className="studio-playhead-handle pointer-events-none" />
              </div>
              {snapGuide != null ? (
                <div className="studio-snap-guide" style={{ left: snapGuide * ppf }} data-testid="timeline-snap-guide" />
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="timeline-lanes-body">
          <div className="flex w-full">
            <div className="shrink-0" style={{ width: LABEL_WIDTH }} data-testid="timeline-label-column">
              {laneBlocks.map((lane) => (
                <div
                  key={lane.id}
                  className="flex items-center overflow-hidden whitespace-nowrap px-1.5 text-[10px] font-medium uppercase leading-none tracking-wide text-studio-muted"
                  style={{ height: lane.height }}
                  data-testid={`timeline-label-${lane.id}`}
                  data-empty={lane.blocks.length === 0 ? "true" : "false"}
                  title={lane.label}
                >
                  {lane.label}
                </div>
              ))}
            </div>
            <div className="relative min-w-0 flex-1" ref={viewRef}>
              <div ref={laneHRef} className="overflow-x-hidden" data-testid="timeline-scroll">
                <div
                  ref={trackRef}
                  className="relative"
                  style={{ width: trackW }}
                  data-testid="timeline-track"
                  onPointerDown={onTrackPointerDown}
                  onPointerMove={onTrackPointerMove}
                  onPointerUp={onTrackPointerUp}
                  onPointerCancel={onTrackPointerUp}
                >
                  <div data-testid="timeline-scrubber" className="relative">
                    {laneBlocks.map((lane) => (
                      <div
                        key={lane.id}
                        className="studio-lane-drop relative"
                        style={{ height: lane.height }}
                        data-testid={`timeline-lane-${lane.id}`}
                        data-lane={lane.id}
                        data-rows={lane.rows}
                        data-drop-active={dropLane === lane.id ? "true" : "false"}
                        onDragOver={(event) => onAssetDragOver(event, lane.id)}
                        onDragLeave={() => setDropLane((current) => (current === lane.id ? null : current))}
                        onDrop={(event) => onAssetDrop(event, lane.id)}
                        onContextMenu={(event) => {
                          if ((event.target as HTMLElement).closest("[data-lane-chip]")) return;
                          openContextMenu(event, null, lane.id);
                        }}
                      >
                        <div className="absolute inset-x-0 inset-y-0.5 rounded-sm bg-black/40" />
                        {blocksIntersectingView(
                          lane.blocks,
                          scrollLeft / Math.max(ppf, 1e-6) - fps,
                          (scrollLeft + (viewWidth || 1)) / Math.max(ppf, 1e-6) + fps
                        ).map((block) => {
                          const selected =
                            selectedIds.has(block.id) ||
                            (selectedIds.size === 0 && selectedLine != null && block.scriptLine === selectedLine);
                          const shifting =
                            draftDelta !== 0 &&
                            (selectedIds.has(block.id) ||
                              (block.marriedId != null &&
                                allBlocks.some(
                                  (item) => selectedIds.has(item.id) && item.marriedId === block.marriedId
                                )) ||
                              (block.scriptLine != null && selectedLinesRef.current.has(block.scriptLine)));
                          const take = draftTrim && draftTrim.ids.has(block.id) ? draftTrim : null;
                          const group = relatedMoveIds(allBlocks, new Set([block.id]));
                          const members = allBlocks.filter((item) => group.has(item.id));
                          const groupStart = members.length ? Math.min(...members.map((item) => item.startFrame)) : block.startFrame;
                          const groupEnd = members.length ? Math.max(...members.map((item) => item.endFrame)) : block.endFrame;
                          return (
                            <LaneChip
                              key={block.id}
                              block={block}
                              ppf={ppf}
                              fps={fps}
                              rowPx={rowPx}
                              chipPx={chipPx}
                              selected={selected}
                              bar={lane.bar}
                              text={lane.text}
                              draftDelta={take ? 0 : shifting ? draftDelta : 0}
                              draftStart={take && block.startFrame === groupStart ? take.start : null}
                              draftEnd={take && block.endFrame === groupEnd ? take.end : null}
                              trimAllowed={take ? take.allowed : true}
                              showInHandle={blockIsTrimmable(block) && block.startFrame === groupStart}
                              showOutHandle={blockIsTrimmable(block) && block.endFrame === groupEnd}
                              syncing={syncing}
                              onPointerDown={onChipPointerDown}
                              onContextMenu={(event) => openContextMenu(event, block, lane.id)}
                              onTrimPointerDown={onTrimPointerDown}
                              mouthExpanded={isMouthBlock(block) && expandedMouthIds.has(block.id)}
                              viewStartFrame={scrollLeft / Math.max(ppf, 1e-6) - fps}
                              viewEndFrame={(scrollLeft + (viewWidth || 1)) / Math.max(ppf, 1e-6) + fps}
                              onToggleMouth={(event) => {
                                event.stopPropagation();
                                setExpandedMouthIds((current) => {
                                  const next = new Set(current);
                                  if (next.has(block.id)) next.delete(block.id);
                                  else next.add(block.id);
                                  return next;
                                });
                                setCueEditor(null);
                              }}
                              onCueClick={
                                onPatchCue && block.cuesRel
                                  ? (cue, index, clientX, clientY) => {
                                      setCueEditor({ blockId: block.id, index, x: clientX, y: clientY });
                                    }
                                  : undefined
                              }
                              onSyncLine={
                                onSyncLines
                                  ? () =>
                                      onSyncLines({
                                        scriptLine: block.scriptLine ?? undefined,
                                        force: block.sync === "synced",
                                      })
                                  : undefined
                              }
                            />
                          );
                        })}
                      </div>
                    ))}
                    <div
                      className="pointer-events-none absolute bottom-0 top-0 z-10"
                      style={{ left: playheadX }}
                      data-testid="timeline-playhead"
                    >
                      <div className="studio-playhead-line studio-playhead-line--lanes" />
                    </div>
                    {snapGuide != null ? (
                      <div className="studio-snap-guide" style={{ left: snapGuide * ppf }} />
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 border-t border-neutral-800 bg-studio-panel" data-testid="timeline-h-scroll-row">
        <div className="shrink-0" style={{ width: LABEL_WIDTH, height: H_SCROLLBAR_PX }} />
        <div
          ref={hScrollRef}
          data-testid="timeline-h-scroll"
          className="studio-timeline-hscroll min-w-0 flex-1"
          onScroll={onHScroll}
        >
          <div style={{ width: trackW, height: 1 }} aria-hidden="true" />
        </div>
      </div>
      {tooltip ? (
        <div
          className="pointer-events-none fixed z-50 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-amber-100"
          style={{ left: tooltip.x + 12, top: tooltip.y + 16 }}
          data-testid="timeline-edit-tooltip"
        >
          {tooltip.text}
        </div>
      ) : null}
      {rubber ? (
        <div
          className="studio-rubber-band"
          data-testid="timeline-rubber-band"
          style={{
            position: "fixed",
            left: Math.min(rubber.x0, rubber.x1),
            top: Math.min(rubber.y0, rubber.y1),
            width: Math.abs(rubber.x1 - rubber.x0),
            height: Math.abs(rubber.y1 - rubber.y0),
          }}
        />
      ) : null}
      {cueEditor ? (
        <CueEditor
          block={allBlocks.find((item) => item.id === cueEditor.blockId) || null}
          index={cueEditor.index}
          x={cueEditor.x}
          y={cueEditor.y}
          fps={fps}
          onClose={() => setCueEditor(null)}
          onPatch={onPatchCue}
        />
      ) : null}
      {contextMenu ? (
        <TimelineContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canEdit={Boolean(onEditScript)}
          canPaste={
            clipboard.items.length > 0 &&
            clipboard.items.some((item) => clipboardItemFitsLane(item, contextMenu.lane))
          }
          hasSelection={selectedIds.size > 0}
          showSync={allBlocks.some((block) => block.lane === "dialogue" && selectedIds.has(block.id))}
          syncLabel={
            allBlocks.find((block) => block.lane === "dialogue" && selectedIds.has(block.id))?.sync === "synced"
              ? "Redo sync"
              : "Sync"
          }
          onAction={applyContextAction}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function LaneChip({
  block,
  ppf,
  fps,
  rowPx,
  chipPx,
  selected,
  bar,
  text,
  draftDelta,
  draftStart,
  draftEnd,
  trimAllowed,
  showInHandle,
  showOutHandle,
  syncing,
  mouthExpanded = false,
  viewStartFrame = 0,
  viewEndFrame = 0,
  onPointerDown,
  onContextMenu,
  onTrimPointerDown,
  onToggleMouth,
  onCueClick,
  onSyncLine,
}: {
  block: LaneBlock;
  ppf: number;
  fps: number;
  rowPx: number;
  chipPx: number;
  selected: boolean;
  bar: string;
  text: string;
  draftDelta: number;
  draftStart: number | null;
  draftEnd: number | null;
  trimAllowed: boolean;
  showInHandle: boolean;
  showOutHandle: boolean;
  syncing: boolean;
  mouthExpanded?: boolean;
  viewStartFrame?: number;
  viewEndFrame?: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, block: LaneBlock) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTrimPointerDown: (event: React.PointerEvent<HTMLElement>, block: LaneBlock, edge: "in" | "out") => void;
  onToggleMouth?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCueClick?: (cue: { shape: string; start: number; end: number; pinned?: boolean }, index: number, x: number, y: number) => void;
  onSyncLine?: () => void;
}) {
  const mouth = isMouthBlock(block);
  const movable = blockIsMovable(block) && !mouth;
  const start = draftStart != null ? draftStart : block.startFrame + draftDelta;
  const end = draftEnd != null ? draftEnd : block.endFrame + draftDelta;
  const left = start * ppf;
  const width = Math.max(Math.max(end - start, 1) * ppf, 2);
  const top = (block.row ?? 0) * rowPx + 2;
  const durationSec = Math.max((block.endFrame - block.startFrame) / Math.max(fps, 1), 0.001);
  const cues = mouth ? block.cues || [] : [];
  const visibleCues = mouthExpanded
    ? visibleCueIndexes(cues, start, fps, viewStartFrame, viewEndFrame)
    : [];
  const syncTitle =
    block.sync === "synced"
      ? "Synced — redo lip-sync"
      : block.sync === "stale"
        ? "Stale — audio or text changed"
        : "Not synced";
  return (
    <div
      role="button"
      tabIndex={0}
      data-lane-chip="true"
      data-block-id={block.id}
      data-role={block.role || ""}
      data-selected={selected ? "true" : "false"}
      data-sync={block.sync || ""}
      data-movable={movable ? "true" : "false"}
      data-row={block.row ?? 0}
      title={`${block.label} · frames ${block.startFrame}–${block.endFrame}${
        block.scriptLine ? ` · line ${block.scriptLine}` : ""
      }${block.view ? ` · view=${block.view}` : ""}${block.sync ? ` · ${block.sync}` : ""}${
        block.timing?.attr ? ` · ${block.timing.attr}=` : ""
      }`}
      onPointerDown={(event) => onPointerDown(event, block)}
      onContextMenu={onContextMenu}
      className={`absolute z-[1] select-none rounded-sm px-1 text-left text-[10px] ${bar} ${text} ${
        selected ? "ring-1 ring-white/80" : ""
      } ${mouthExpanded ? "overflow-visible" : "overflow-hidden"} ${
        movable ? "cursor-grab active:cursor-grabbing" : mouth ? "cursor-default" : "cursor-not-allowed"
      }`}
      style={{
        left,
        width,
        top,
        height: mouthExpanded ? chipPx + 16 : chipPx,
        lineHeight: `${Math.max(12, chipPx - 6)}px`,
        touchAction: "none",
      }}
    >
      {showInHandle ? (
        <span
          className="studio-trim-handle"
          data-edge="in"
          data-testid="timeline-trim-in"
          data-allowed={trimAllowed ? "true" : "false"}
          title="Trim in"
          onPointerDown={(event) => onTrimPointerDown(event, block, "in")}
        />
      ) : null}
      {showOutHandle ? (
        <span
          className="studio-trim-handle"
          data-edge="out"
          data-testid="timeline-trim-out"
          data-allowed={trimAllowed ? "true" : "false"}
          title="Trim out"
          onPointerDown={(event) => onTrimPointerDown(event, block, "out")}
        />
      ) : null}
      <span className="relative flex items-start gap-1" style={{ height: chipPx }}>
        {block.lane === "dialogue" ? (
          <span className="studio-sync-dot mt-1.5" data-testid="timeline-sync-dot" data-sync={block.sync || "not_synced"} />
        ) : null}
        {mouth ? (
          <button
            type="button"
            className="studio-mouth-chevron"
            data-testid="timeline-mouth-expand"
            data-open={mouthExpanded ? "true" : "false"}
            title={mouthExpanded ? "Collapse mouth cues" : "Expand mouth cues"}
            aria-label={mouthExpanded ? "Collapse mouth cues" : "Expand mouth cues"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onToggleMouth}
          >
            {mouthExpanded ? "▾" : "▸"}
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{block.label}</span>
        {block.lane === "dialogue" && onSyncLine ? (
          <button
            type="button"
            className="studio-chip-sync"
            data-testid="timeline-sync-line"
            title={syncTitle}
            aria-label={syncTitle}
            disabled={syncing || block.scriptLine == null}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSyncLine();
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M8 2a6 6 0 1 0 5.65 4H12A4.5 4.5 0 1 1 8 3.5V6l3-2.5L8 1v1z" />
            </svg>
          </button>
        ) : null}
        {mouth && cues.length > 0 ? <CueStrip cues={cues} durationSec={durationSec} width={width} /> : null}
      </span>
      {mouth && mouthExpanded ? (
        <div className="studio-mouth-cue-row" data-testid="timeline-mouth-cue-row">
          {visibleCues.map((index) => {
            const cue = cues[index];
            return (
              <button
                key={`${cue.shape}-${cue.start}-${index}`}
                type="button"
                className="studio-mouth-cue-hit"
                data-testid="timeline-mouth-cue"
                data-shape={cue.shape}
                data-pinned={cue.pinned ? "true" : "false"}
                title={`${cue.shape}${cue.pinned ? " pinned" : ""}`}
                style={{
                  left: `${(cue.start / durationSec) * 100}%`,
                  width: `${Math.max(((cue.end - cue.start) / durationSec) * 100, 1.2)}%`,
                  background: CUE_COLORS[cue.shape] || "#a3a3a3",
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onCueClick?.(cue, index, event.clientX, event.clientY);
                }}
              >
                {cue.pinned ? `${cue.shape}·` : cue.shape}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function CueStrip({
  cues,
  durationSec,
  width: cssWidth,
}: {
  cues: { shape: string; start: number; end: number }[];
  durationSec: number;
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = canvas.clientWidth || cssWidth || 1;
    const height = canvas.clientHeight || 4;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const cue of cues) {
      const x = (cue.start / durationSec) * width;
      const w = Math.max(((cue.end - cue.start) / durationSec) * width, 1);
      ctx.fillStyle = CUE_COLORS[cue.shape] || "#a3a3a3";
      ctx.fillRect(x, 0, w, height);
    }
  }, [cues, durationSec, cssWidth]);
  return <canvas ref={ref} className="studio-mouth-cues" data-testid="timeline-mouth-cues" aria-hidden="true" />;
}

function CueEditor({
  block,
  index,
  x,
  y,
  fps,
  onClose,
  onPatch,
}: {
  block: LaneBlock | null;
  index: number;
  x: number;
  y: number;
  fps: number;
  onClose: () => void;
  onPatch?: (patch: { rel: string; start: number; end: number; value?: string; pinned?: boolean }) => void;
}) {
  const cue = block?.cues?.[index];
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!block || !cue || !block.cuesRel || !onPatch) return null;
  const source = cueSourceTimes(cue, block.trim?.inFrames, fps);
  return (
    <div
      className="studio-cue-editor"
      data-testid="timeline-cue-editor"
      style={{ left: Math.min(x + 8, 1100), top: Math.min(y + 12, 820) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-0.5">
        {MOUTH_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            data-testid="timeline-cue-shape"
            data-shape={shape}
            data-active={cue.shape === shape ? "true" : "false"}
            className="studio-cue-shape"
            onClick={() => {
              onPatch({ rel: block.cuesRel as string, start: source.start, end: source.end, value: shape });
              onClose();
            }}
          >
            {shape}
          </button>
        ))}
        <button
          type="button"
          className="studio-cue-pin"
          data-testid="timeline-cue-pin"
          data-pinned={cue.pinned ? "true" : "false"}
          title={cue.pinned ? "Unpin this mouth shape" : "Pin this mouth shape"}
          onClick={() => {
            onPatch({
              rel: block.cuesRel as string,
              start: source.start,
              end: source.end,
              pinned: !cue.pinned,
            });
            onClose();
          }}
        >
          {cue.pinned ? "unpin" : "pin"}
        </button>
      </div>
    </div>
  );
}
