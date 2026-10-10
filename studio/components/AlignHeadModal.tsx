"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { alignableSlots, containedImageLayout, slotCenter } from "@/lib/headAlign";
import {
  assetUrl,
  fetchPreviewFrame,
  saveSlotAlignment,
  type Character,
  type CharacterSlot,
} from "@/lib/worker";

type Handle = "nw" | "ne" | "sw" | "se";

function defaultDrawing(slot: CharacterSlot): string {
  if (slot.default_drawing && slot.drawings.some((d) => d.name === slot.default_drawing)) {
    return slot.default_drawing;
  }
  const rest = slot.drawings.find((d) => d.name === "X");
  return (rest || slot.drawings[0])?.name || "";
}

export default function AlignHeadModal({
  project,
  character,
  script,
  onClose,
  onChanged,
}: {
  project: string;
  character: Character;
  script?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const slots = useMemo(() => alignableSlots(character.slots), [character.slots]);
  const [slotName, setSlotName] = useState(slots[0]?.name || "mouth");
  const slot = slots.find((item) => item.name === slotName) || slots[0] || null;
  const [drawingName, setDrawingName] = useState(slot ? defaultDrawing(slot) : "");
  const [offset, setOffset] = useState(slot?.offset || { x: 0, y: 0 });
  const [scale, setScale] = useState(slot?.scale ?? 1);
  const [rotation, setRotation] = useState(slot?.rotation ?? 0);
  const [bgKind, setBgKind] = useState<"reference" | "body">(
    character.referenceRel ? "reference" : "body"
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [bodySize, setBodySize] = useState<{ w: number; h: number } | null>(null);
  const [headSize, setHeadSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    kind: "move" | Handle;
    startX: number;
    startY: number;
    offset: { x: number; y: number };
    scale: number;
    dist: number;
  } | null>(null);

  const bodyRel = bgKind === "reference" ? character.referenceRel : character.bodyRel;
  const bodySrc = assetUrl(project, bodyRel, {
    v: bgKind === "reference" ? character.referenceMtime : character.mtime,
  });
  const drawing = slot?.drawings.find((d) => d.name === drawingName) || slot?.drawings[0];
  const headSrc = assetUrl(project, drawing?.rel, { v: drawing?.mtime });

  useEffect(() => {
    const list = alignableSlots(character.slots);
    const next = list.find((item) => item.name === slotName) || list[0] || null;
    if (!next) return;
    setOffset(next.offset || { x: 0, y: 0 });
    setScale(next.scale ?? 1);
    setRotation(next.rotation ?? 0);
    setDrawingName(defaultDrawing(next));
    // Reload after Save should not reset the live overlay / mouth preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, slotName]);

  useEffect(() => {
    if (!bodySrc) {
      setBodySize(null);
      return;
    }
    const img = new Image();
    img.onload = () => setBodySize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = bodySrc;
  }, [bodySrc]);

  useEffect(() => {
    if (!headSrc) {
      setHeadSize(null);
      return;
    }
    const img = new Image();
    img.onload = () => setHeadSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = headSrc;
  }, [headSrc]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bodySrc]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const layout = useMemo(
    () => containedImageLayout(bodySize?.w || 0, bodySize?.h || 0, box.w, box.h),
    [bodySize, box]
  );
  const center = useMemo(
    () => slotCenter(bodySize?.w || 0, bodySize?.h || 0, offset),
    [bodySize, offset]
  );

  function onPointerMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag || !bodySize || layout.scale <= 0) return;
    if (drag.kind === "move") {
      const dx = (event.clientX - drag.startX) / layout.scale;
      const dy = (event.clientY - drag.startY) / layout.scale;
      setOffset({ x: drag.offset.x + dx, y: drag.offset.y + dy });
      return;
    }
    const cx = layout.left + center.x * layout.scale;
    const cy = layout.top + center.y * layout.scale;
    const dist = Math.hypot(event.clientX - (stageRef.current?.getBoundingClientRect().left || 0) - cx, event.clientY - (stageRef.current?.getBoundingClientRect().top || 0) - cy);
    if (drag.dist < 4) return;
    const next = Math.min(4, Math.max(0.15, drag.scale * (dist / drag.dist)));
    setScale(next);
  }

  function endDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }

  function startMove(event: React.PointerEvent) {
    event.preventDefault();
    dragRef.current = {
      kind: "move",
      startX: event.clientX,
      startY: event.clientY,
      offset: { ...offset },
      scale,
      dist: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  }

  function startScale(handle: Handle, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = layout.left + center.x * layout.scale;
    const cy = layout.top + center.y * layout.scale;
    dragRef.current = {
      kind: handle,
      startX: event.clientX,
      startY: event.clientY,
      offset: { ...offset },
      scale,
      dist: Math.hypot(event.clientX - rect.left - cx, event.clientY - rect.top - cy),
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  }

  async function onSave() {
    if (!slot) return;
    setBusy("Saving…");
    setError(null);
    try {
      await saveSlotAlignment(project, character.id, slot.name, { offset, scale, rotation });
      onChanged();
      setBusy("Rendering preview…");
      const { blob } = await fetchPreviewFrame(project, 0, undefined, script);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const overlayLeft = layout.left + center.x * layout.scale;
  const overlayTop = layout.top + center.y * layout.scale;
  const overlayW = (headSize?.w || 0) * layout.scale;
  const overlayH = (headSize?.h || 0) * layout.scale;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Align head</h2>
            <p className="text-[11px] text-studio-muted">
              Drag the overlay to move. Corner handles or the slider scale around the head center. Rotation is
              clockwise degrees.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            {slots.length > 1 ? (
              <label className="text-[11px] text-studio-muted">
                Slot
                <select
                  className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  value={slot?.name || ""}
                  onChange={(event) => setSlotName(event.target.value)}
                >
                  {slots.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {slot ? (
              <label className="text-[11px] text-studio-muted">
                Mouth drawing
                <select
                  className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  value={drawingName}
                  onChange={(event) => setDrawingName(event.target.value)}
                  data-testid="align-mouth-drawing"
                >
                  {slot.drawings.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {character.referenceRel && character.bodyRel ? (
              <label className="text-[11px] text-studio-muted">
                Background
                <select
                  className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  value={bgKind}
                  onChange={(event) => setBgKind(event.target.value as "reference" | "body")}
                >
                  <option value="reference">Full-body reference</option>
                  <option value="body">Body drawing</option>
                </select>
              </label>
            ) : null}
          </div>

          <div
            ref={stageRef}
            className="studio-checker relative h-[min(62vh,640px)] w-full overflow-hidden rounded-md border border-studio-border"
          >
            {bodySrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bodySrc}
                alt=""
                className="pointer-events-none absolute"
                style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
              />
            ) : (
              <p className="absolute inset-0 flex items-center justify-center text-sm text-studio-muted">
                Add a body drawing or a full-body reference first.
              </p>
            )}
            {headSrc && headSize && bodySize ? (
              <div
                role="presentation"
                data-testid="align-head-overlay"
                className="absolute cursor-grab touch-none"
                style={{
                  left: overlayLeft,
                  top: overlayTop,
                  width: overlayW,
                  height: overlayH,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
                  transformOrigin: "center center",
                }}
                onPointerDown={startMove}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={headSrc}
                  alt=""
                  className="pointer-events-none h-full w-full object-fill"
                  style={{ opacity: 0.62 }}
                />
                <span className="pointer-events-none absolute inset-0 rounded-sm border border-studio-accent/80" />
                {(["nw", "ne", "sw", "se"] as Handle[]).map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    aria-label={`Scale ${handle}`}
                    className="absolute h-3 w-3 rounded-sm border border-white bg-studio-accent"
                    style={{
                      left: handle.includes("w") ? -6 : "auto",
                      right: handle.includes("e") ? -6 : "auto",
                      top: handle.includes("n") ? -6 : "auto",
                      bottom: handle.includes("s") ? -6 : "auto",
                    }}
                    onPointerDown={(event) => startScale(handle, event)}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-studio-muted">
              Offset x
              <input
                type="number"
                step="1"
                value={Number(offset.x.toFixed(2))}
                onChange={(event) => setOffset({ ...offset, x: Number(event.target.value) })}
                className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
              />
            </label>
            <label className="text-[11px] text-studio-muted">
              Offset y
              <input
                type="number"
                step="1"
                value={Number(offset.y.toFixed(2))}
                onChange={(event) => setOffset({ ...offset, y: Number(event.target.value) })}
                className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
              />
            </label>
            <label className="text-[11px] text-studio-muted">
              Scale {scale.toFixed(2)}
              <input
                type="range"
                min={0.25}
                max={2.5}
                step={0.01}
                value={scale}
                onChange={(event) => setScale(Number(event.target.value))}
                className="studio-scrubber mt-2 w-full"
              />
            </label>
            <label className="text-[11px] text-studio-muted">
              Rotation {rotation.toFixed(1)}°
              <input
                type="range"
                min={-180}
                max={180}
                step={0.5}
                value={rotation}
                onChange={(event) => setRotation(Number(event.target.value))}
                className="studio-scrubber mt-2 w-full"
              />
            </label>
          </div>

          {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

          {previewUrl ? (
            <div className="mt-4">
              <p className="mb-2 text-[11px] uppercase tracking-wider text-studio-muted">Preview frame after save</p>
              <div className="overflow-hidden rounded-md border border-studio-border bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Preview after alignment" className="w-full object-contain" />
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-studio-border px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            disabled={busy != null || !slot}
            onClick={() => void onSave()}
            data-testid="align-head-save"
          >
            {busy || "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
