"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const LABEL_WIDTH = 80;
const LANE_ROW_PX = 28;
const LANE_EMPTY_PX = 12;

function laneHeight(blocks: LaneBlock[]): number {
  if (blocks.length === 0) return LANE_EMPTY_PX;
  const rows = Math.max(1, ...blocks.map((block) => (block.row ?? 0) + 1));
  return rows * LANE_ROW_PX;
}

export default function TimelineLanes({
  project,
  lanes,
  frame,
  selectedLine,
  onSeek,
  totalFrames,
  playing = false,
}: {
  project: string | null;
  lanes: LanesResponse | null;
  frame: number;
  selectedLine: number | null;
  onSeek: (frame: number, scriptLine: number | null) => void;
  totalFrames?: number;
  playing?: boolean;
}) {
  const total = Math.max(totalFrames || lanes?.totalFrames || 1, 1);
  const fps = Math.max(lanes?.fps || 24, 1);
  const maxFrame = Math.max(total - 1, 0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [viewWidth, setViewWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const followLockRef = useRef(false);
  zoomRef.current = zoom;

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
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  const applyScroll = useCallback((next: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const clamped = Math.max(0, Math.min(max, next));
    el.scrollLeft = clamped;
    setScrollLeft(clamped);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el || followLockRef.current) return;
    const next = followPlayheadScroll(frame, ppf, el.scrollLeft, el.clientWidth);
    if (next != null) applyScroll(next);
  }, [playing, frame, ppf, applyScroll]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = el.scrollLeft + (clientX - rect.left);
      onSeek(Math.max(0, Math.min(maxFrame, Math.round(x / Math.max(ppf, 1e-6)))), null);
    },
    [onSeek, maxFrame, ppf]
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

  const panRef = useRef<{ pointerId: number; startX: number; startScroll: number } | null>(null);

  function onPanPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    followLockRef.current = true;
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: scrollRef.current?.scrollLeft || 0 };
  }

  function onPanPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    applyScroll(pan.startScroll - (event.clientX - pan.startX));
  }

  function onPanPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    followLockRef.current = false;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      if (!el) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const next = zoomAroundCursor(zoomRef.current, factor, cursorX, el.scrollLeft, total, el.clientWidth);
        setZoom(next.zoom);
        requestAnimationFrame(() => applyScroll(next.scrollLeft));
        return;
      }
      if (Math.abs(event.deltaX) > 0.5 || Math.abs(event.deltaY) > 0.5) {
        event.preventDefault();
        applyScroll(el.scrollLeft + (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY));
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyScroll, total]);

  function nudgeZoom(factor: number) {
    const el = scrollRef.current;
    const width = el?.clientWidth || viewWidth || 1;
    const cursorX = width / 2;
    const next = zoomAroundCursor(zoom, factor, cursorX, el?.scrollLeft || 0, total, width);
    setZoom(next.zoom);
    requestAnimationFrame(() => applyScroll(next.scrollLeft));
  }

  function onFit() {
    setZoom(MIN_ZOOM);
    requestAnimationFrame(() => applyScroll(0));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-studio-panel" data-testid="timeline-lanes">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-studio-muted">
        <span className="uppercase tracking-[0.14em]">Timeline</span>
        <div className="flex items-center gap-1" data-testid="timeline-zoom-controls">
          <button
            type="button"
            data-testid="timeline-zoom-out"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => nudgeZoom(1 / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className="flex h-6 w-6 items-center justify-center rounded border border-neutral-600 bg-black/40 text-white hover:bg-neutral-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
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
              const el = scrollRef.current;
              const width = el?.clientWidth || viewWidth || 1;
              const nextZoom = sliderToZoom(Number(event.target.value));
              const factor = zoom > 0 ? nextZoom / zoom : 1;
              const next = zoomAroundCursor(zoom, factor, width / 2, el?.scrollLeft || 0, total, width);
              setZoom(next.zoom);
              requestAnimationFrame(() => applyScroll(next.scrollLeft));
            }}
          />
          <button
            type="button"
            data-testid="timeline-zoom-in"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => nudgeZoom(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className="flex h-6 w-6 items-center justify-center rounded border border-neutral-600 bg-black/40 text-white hover:bg-neutral-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
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
        <span className="ml-auto hidden uppercase tracking-[0.14em] sm:inline">Read-only · script is the source of truth</span>
      </div>
      <div className="flex min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="shrink-0" style={{ width: LABEL_WIDTH }}>
          <div className="h-5" />
          {LANE_META.map((lane) => {
            const blocks = (lanes?.blocks || []).filter((b) => b.lane === lane.id);
            const height = laneHeight(blocks);
            return (
              <div
                key={lane.id}
                className="truncate pt-0.5 text-[11px] font-medium uppercase tracking-wide text-studio-muted"
                style={{ height }}
                data-testid={`timeline-label-${lane.id}`}
                data-empty={blocks.length === 0 ? "true" : "false"}
              >
                {lane.label}
              </div>
            );
          })}
        </div>
        <div className="relative min-w-0 flex-1" ref={viewRef}>
          <div
            ref={scrollRef}
            data-testid="timeline-scroll"
            className="overflow-x-auto"
            onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
          >
            <div
              className="relative"
              style={{ width: trackW, minHeight: "100%" }}
              data-testid="timeline-track"
              onPointerDown={onPanPointerDown}
              onPointerMove={onPanPointerMove}
              onPointerUp={onPanPointerUp}
              onPointerCancel={onPanPointerUp}
            >
              <div
                data-testid="timeline-ruler"
                className="relative h-5 cursor-ew-resize border-b border-neutral-800"
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
              </div>
              <div data-testid="timeline-scrubber" className="relative">
                {LANE_META.map((lane) => {
                  const blocks = (lanes?.blocks || []).filter((b) => b.lane === lane.id);
                  const height = laneHeight(blocks);
                  return (
                    <div
                      key={lane.id}
                      className="relative"
                      style={{ height }}
                      data-testid={`timeline-lane-${lane.id}`}
                      data-rows={blocks.length === 0 ? 0 : Math.max(1, ...blocks.map((b) => (b.row ?? 0) + 1))}
                    >
                      <div className="absolute inset-x-0 inset-y-0.5 rounded-sm bg-black/40" />
                      {blocks.map((block) => (
                        <LaneChip
                          key={block.id}
                          block={block}
                          ppf={ppf}
                          selected={selectedLine != null && block.scriptLine === selectedLine}
                          bar={lane.bar}
                          text={lane.text}
                          onSeek={onSeek}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              <div
                className="pointer-events-none absolute bottom-0 top-0 z-10"
                style={{ left: playheadX }}
                data-testid="timeline-playhead"
              >
                <div className="studio-playhead-handle pointer-events-none" />
                <div className="studio-playhead-line" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LaneChip({
  block,
  ppf,
  selected,
  bar,
  text,
  onSeek,
}: {
  block: LaneBlock;
  ppf: number;
  selected: boolean;
  bar: string;
  text: string;
  onSeek: (frame: number, scriptLine: number | null) => void;
}) {
  const left = block.startFrame * ppf;
  const width = Math.max((Math.max(block.endFrame - block.startFrame, 1)) * ppf, 2);
  const top = (block.row ?? 0) * LANE_ROW_PX + 2;
  return (
    <button
      type="button"
      title={`${block.label} · frames ${block.startFrame}–${block.endFrame}${
        block.scriptLine ? ` · line ${block.scriptLine}` : ""
      }`}
      onClick={() => onSeek(block.startFrame, block.scriptLine)}
      className={`absolute z-[1] h-6 overflow-hidden rounded-sm px-1.5 text-left text-[10px] leading-6 ${bar} ${text} ${
        selected ? "ring-2 ring-white" : ""
      }`}
      style={{ left, width, top }}
      data-row={block.row ?? 0}
    >
      <span className="block truncate">{block.label}</span>
    </button>
  );
}
