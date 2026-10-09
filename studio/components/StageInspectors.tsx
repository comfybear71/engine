"use client";

import { useEffect, useRef } from "react";
import { DrawerHeader } from "@/components/StageRails";
import type { LaneBlock, Mark, StageLayer } from "@/lib/worker";

export function MarksInspector({
  locationLabel,
  marks,
  selected,
  onSelect,
  onClose,
}: {
  locationLabel: string;
  marks: { location: string; name: string; mark: Mark }[];
  selected: { location: string; name: string } | null;
  onSelect: (item: { location: string; name: string; mark: Mark } | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="marks-drawer">
      <DrawerHeader title="Marks" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[11px] text-studio-muted">{locationLabel}</p>
        <ul className="space-y-1">
          {marks.map((item) => {
            const active = selected?.location === item.location && selected?.name === item.name;
            return (
              <li key={`${item.location}:${item.name}`}>
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : item)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                    active ? "bg-studio-accent/20 text-white" : "text-neutral-300 hover:bg-studio-raised"
                  }`}
                >
                  <span>{item.name}</span>
                  <span className="text-[11px] text-studio-muted">
                    {Math.round(item.mark.x)}, {Math.round(item.mark.y)}
                  </span>
                </button>
              </li>
            );
          })}
          {marks.length === 0 ? <li className="text-sm text-studio-muted">No marks.</li> : null}
        </ul>
      </div>
    </div>
  );
}

export function LayersInspector({
  layers,
  onClose,
}: {
  layers: StageLayer[];
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="layers-drawer">
      <DrawerHeader title="Layers" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[11px] text-studio-muted">Read-only z order (front at top). Dragging comes later.</p>
        <ul className="space-y-1">
          {layers.map((layer) => (
            <li key={layer.id} className="flex items-center gap-2 rounded-md bg-studio-raised px-2 py-1.5 text-sm">
              <span className="w-8 text-right font-mono text-[11px] text-studio-muted">{layer.z}</span>
              <span className="flex-1 truncate text-neutral-200">{layer.id}</span>
              <span className="rounded bg-black/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-studio-muted">
                {layer.kind}
              </span>
            </li>
          ))}
          {layers.length === 0 ? <li className="text-sm text-studio-muted">No layers in this scene.</li> : null}
        </ul>
      </div>
    </div>
  );
}

export function ScriptInspector({
  lines,
  playheadLine,
  blocks,
  onSeek,
  onClose,
}: {
  lines: string[];
  playheadLine: number | null;
  blocks: LaneBlock[];
  onSeek: (frame: number, scriptLine: number | null) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    if (playheadLine == null || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-script-line="${playheadLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [playheadLine]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="script-drawer">
      <DrawerHeader title="Script" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-2 px-1 text-[11px] text-studio-muted">
          Read-only. Playhead line is highlighted. Edit on the Script tab.
        </p>
        <ol ref={listRef} className="space-y-0.5 font-mono text-[11px] leading-5">
          {lines.map((line, index) => {
            const n = index + 1;
            const active = playheadLine === n;
            return (
              <li key={n}>
                <button
                  type="button"
                  data-script-line={n}
                  onClick={() => {
                    const hit = blocks.find((b) => b.scriptLine === n);
                    if (hit) onSeek(hit.startFrame, n);
                  }}
                  className={`flex w-full gap-2 rounded px-1 text-left ${
                    active ? "bg-studio-accent/25 text-white" : "text-neutral-400 hover:bg-studio-raised"
                  }`}
                >
                  <span className="w-6 shrink-0 text-right text-studio-muted">{n}</span>
                  <span className="truncate">{line || " "}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
