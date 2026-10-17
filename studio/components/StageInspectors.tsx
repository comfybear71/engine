"use client";

import { useEffect, useRef } from "react";
import { DrawerHeader } from "@/components/StageRails";
import type { PropScope, ScenePropState } from "@/lib/stageProps";
import { assetUrl, type LaneBlock, type Mark, type StageLayer } from "@/lib/worker";

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
  onImportAudio,
  onClose,
}: {
  lines: string[];
  playheadLine: number | null;
  blocks: LaneBlock[];
  onSeek: (frame: number, scriptLine: number | null) => void;
  onImportAudio?: () => void;
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
        <div className="mb-2 flex items-start justify-between gap-2 px-1">
          <p className="text-[11px] text-studio-muted">
            Read-only. Playhead line is highlighted. Edit on the Script tab.
          </p>
          {onImportAudio ? (
            <button
              type="button"
              data-testid="import-audio-open"
              onClick={onImportAudio}
              className="shrink-0 rounded-md border border-studio-accent/50 bg-studio-raised px-2 py-1 text-[11px] text-neutral-200 hover:border-studio-accent hover:text-white"
            >
              Import audio
            </button>
          ) : null}
        </div>
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

export function PropsInspector({
  project,
  locationLabel,
  props,
  busy,
  message,
  onChange,
  onImport,
  onClose,
}: {
  project: string;
  locationLabel: string | null;
  props: ScenePropState[];
  busy: boolean;
  message: string | null;
  onChange: (propId: string, action: "hide" | "show", scope: PropScope) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const btn =
    "rounded border border-studio-border px-1.5 py-1 text-[11px] text-neutral-200 hover:border-studio-accent hover:text-white disabled:opacity-40";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="props-drawer">
      <DrawerHeader title="Props" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[11px] text-studio-muted">
          {locationLabel ? `Location ${locationLabel}. ` : "This scene has no location. "}
          Changes apply at the playhead, or to the whole scene. They are written to the script as [Prop:] lines.
        </p>
        <ul className="space-y-2">
          {props.map((prop) => (
            <li
              key={prop.id}
              data-testid={`props-row-${prop.id}`}
              data-visible={prop.visible ? "true" : "false"}
              className="rounded-md bg-studio-raised p-2"
            >
              <div className="flex items-center gap-2">
                {prop.thumbRel ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetUrl(project, prop.thumbRel, { thumb: true, v: prop.mtime }) ?? undefined}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded bg-black/40 object-contain"
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{prop.id}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    prop.visible ? "bg-emerald-900/50 text-emerald-300" : "bg-black/40 text-studio-muted"
                  }`}
                >
                  {prop.visible ? "On stage" : "Off"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {prop.visible ? (
                  <>
                    <button type="button" disabled={busy} data-testid={`props-remove-${prop.id}`} className={btn} onClick={() => onChange(prop.id, "hide", "here")}>
                      Remove from here
                    </button>
                    <button type="button" disabled={busy} data-testid={`props-remove-scene-${prop.id}`} className={btn} onClick={() => onChange(prop.id, "hide", "scene")}>
                      Remove from scene
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy} data-testid={`props-add-${prop.id}`} className={btn} onClick={() => onChange(prop.id, "show", "here")}>
                      Add here
                    </button>
                    <button type="button" disabled={busy} data-testid={`props-add-scene-${prop.id}`} className={btn} onClick={() => onChange(prop.id, "show", "scene")}>
                      Add to whole scene
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
          {props.length === 0 ? (
            <li className="text-sm text-studio-muted">
              {locationLabel ? "No props in this location yet." : "Pick a location for this scene first."}
            </li>
          ) : null}
        </ul>
        {locationLabel ? (
          <div className="mt-3 border-t border-studio-border pt-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png"
              className="hidden"
              data-testid="props-import-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onImport(file);
              }}
            />
            <button
              type="button"
              disabled={busy}
              data-testid="props-import"
              className="w-full rounded-md border border-studio-accent/50 bg-studio-raised px-2 py-1.5 text-[12px] text-neutral-200 hover:border-studio-accent hover:text-white disabled:opacity-40"
              onClick={() => fileRef.current?.click()}
            >
              Add a new prop (PNG)…
            </button>
            <p className="mt-1 text-[11px] text-studio-muted">
              A new prop lands in this location and is on stage for the whole scene. Use Remove to take it out again.
            </p>
          </div>
        ) : null}
        {message ? (
          <p className="mt-2 text-[11px] text-studio-muted" data-testid="props-message">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
