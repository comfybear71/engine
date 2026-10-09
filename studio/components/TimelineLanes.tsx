"use client";

import { useCallback, useRef } from "react";
import { frameFromTrackX } from "@/lib/playhead";
import type { LaneBlock, LaneId, LanesResponse } from "@/lib/worker";

const LANE_META: { id: LaneId; label: string; bar: string; text: string }[] = [
  { id: "action", label: "Action", bar: "bg-orange-500/80", text: "text-orange-50" },
  { id: "dialogue", label: "Dialogue", bar: "bg-sky-500/80", text: "text-sky-50" },
  { id: "audio", label: "Audio", bar: "bg-emerald-600/80", text: "text-emerald-50" },
  { id: "sfx", label: "SFX", bar: "bg-amber-500/80", text: "text-amber-50" },
  { id: "camera", label: "Camera", bar: "bg-violet-500/80", text: "text-violet-50" },
];

const LABEL_WIDTH = 72;

function pct(frame: number, total: number): number {
  if (total <= 0) return 0;
  return (frame / total) * 100;
}

export default function TimelineLanes({
  lanes,
  frame,
  selectedLine,
  onSeek,
}: {
  lanes: LanesResponse | null;
  frame: number;
  selectedLine: number | null;
  onSeek: (frame: number, scriptLine: number | null) => void;
}) {
  const total = Math.max(lanes?.totalFrames || 1, 1);
  const maxFrame = Math.max(total - 1, 0);
  const playheadPct = pct(Math.min(frame, maxFrame), total);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      onSeek(frameFromTrackX(clientX, rect.left, rect.width, total), null);
    },
    [onSeek, total]
  );

  function onBarPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromEvent(event.clientX);
  }

  function onBarPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekFromEvent(event.clientX);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-studio-panel" data-testid="timeline-lanes">
      <div className="flex shrink-0 items-center justify-between px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-studio-muted">
        <span>Timeline</span>
        <span className="normal-case tracking-normal">Read-only · script is the source of truth</span>
      </div>
      <div className="flex min-h-0 flex-1 px-2 pb-2">
        <div className="shrink-0" style={{ width: LABEL_WIDTH }}>
          <div className="h-4" />
          {LANE_META.map((lane) => (
            <div
              key={lane.id}
              className="h-7 truncate pt-1 text-[11px] font-medium uppercase tracking-wide text-studio-muted"
            >
              {lane.label}
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            ref={trackRef}
            data-testid="timeline-scrubber"
            className="relative h-4 cursor-ew-resize"
            onPointerDown={onBarPointerDown}
            onPointerMove={onBarPointerMove}
          >
            <div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-neutral-700" />
          </div>
          {LANE_META.map((lane) => {
            const blocks = (lanes?.blocks || []).filter((b) => b.lane === lane.id);
            return (
              <div key={lane.id} className="relative h-7">
                <div className="absolute inset-x-0 inset-y-0.5 rounded-sm bg-black/40" />
                {blocks.map((block) => (
                  <LaneChip
                    key={block.id}
                    block={block}
                    total={total}
                    selected={selectedLine != null && block.scriptLine === selectedLine}
                    bar={lane.bar}
                    text={lane.text}
                    onSeek={onSeek}
                  />
                ))}
              </div>
            );
          })}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10"
            style={{ left: `${playheadPct}%` }}
            data-testid="timeline-playhead"
          >
            <div className="studio-playhead-handle pointer-events-none" />
            <div className="studio-playhead-line" />
          </div>
        </div>
      </div>
    </div>
  );
}

function LaneChip({
  block,
  total,
  selected,
  bar,
  text,
  onSeek,
}: {
  block: LaneBlock;
  total: number;
  selected: boolean;
  bar: string;
  text: string;
  onSeek: (frame: number, scriptLine: number | null) => void;
}) {
  const left = pct(block.startFrame, total);
  const width = Math.max(pct(Math.max(block.endFrame - block.startFrame, 1), total), 0.6);
  return (
    <button
      type="button"
      title={`${block.label} · frames ${block.startFrame}–${block.endFrame}${
        block.scriptLine ? ` · line ${block.scriptLine}` : ""
      }`}
      onClick={() => onSeek(block.startFrame, block.scriptLine)}
      className={`absolute top-0.5 z-[1] h-6 overflow-hidden rounded-sm px-1.5 text-left text-[10px] leading-6 ${bar} ${text} ${
        selected ? "ring-2 ring-white" : ""
      }`}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      <span className="block truncate">{block.label}</span>
    </button>
  );
}
