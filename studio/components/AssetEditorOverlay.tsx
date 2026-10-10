"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelDrawingEdit,
  confirmAddDrawing,
  confirmReplaceDrawing,
  cueAtTime,
  deleteEditorDrawing,
  fileToImageBase64,
  formatUsage,
  imageFileFromClipboard,
  loadDrawingEditor,
  loadLipsyncPreview,
  loadSlotEditor,
  mouthSound,
  needIdForSlot,
  neighborDrawing,
  previewAddDrawing,
  previewReplaceDrawing,
  renameEditorDrawing,
  type AssetFocus,
  type DrawingEditor,
  type DrawingUsage,
  type EditPreview,
  type EditorDrawing,
  type LipsyncPreview,
  type SlotEditor,
} from "@/lib/assetEditor";
import { packForCharacter } from "@/lib/promptPacks";
import { assetUrl, loadCharacters, type Character } from "@/lib/worker";

type BgKind = "checker" | "black" | "white" | "gray";

const BG: Record<BgKind, string> = {
  checker: "",
  black: "#000",
  white: "#fff",
  gray: "#6b6b6b",
};

function Icon({ d, label }: { d: string; label: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <title>{label}</title>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function fileFromDrop(event: React.DragEvent): File | null {
  const file = event.dataTransfer.files?.[0];
  return file && file.type.startsWith("image/") ? file : null;
}

export default function AssetEditorOverlay({
  project,
  focus,
  onFocus,
  onClose,
  onChanged,
  onOpenImagine,
}: {
  project: string;
  focus: AssetFocus;
  onFocus: (focus: AssetFocus) => void;
  onClose: () => void;
  onChanged: () => void;
  onOpenImagine?: (opts: { characterId: string; needId: string }) => void;
}) {
  const [slot, setSlot] = useState<SlotEditor | null>(null);
  const [detail, setDetail] = useState<DrawingEditor | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bg, setBg] = useState<BgKind>("checker");
  const [edit, setEdit] = useState<EditPreview | null>(null);
  const [addName, setAddName] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<{ force: boolean; usages: DrawingUsage[] } | null>(null);
  const [lipsync, setLipsync] = useState<LipsyncPreview | null>(null);
  const [sampleId, setSampleId] = useState<string>("builtin:hello");
  const [playShape, setPlayShape] = useState<string | null>(null);
  const playRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const addFileRef = useRef<HTMLInputElement | null>(null);

  const view = focus.view;
  const drawingName = focus.mode === "drawing" ? focus.drawing : null;

  const reload = useCallback(async () => {
    const nextSlot = await loadSlotEditor(project, focus.characterId, focus.slot, view);
    setSlot(nextSlot);
    if (focus.mode === "drawing") {
      setDetail(await loadDrawingEditor(project, focus.characterId, focus.slot, focus.drawing, view));
    } else {
      setDetail(null);
    }
  }, [project, focus, view]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    reload().catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    loadCharacters(project)
      .then((list) => {
        if (!cancelled) setCharacters(list);
      })
      .catch(() => {
        if (!cancelled) setCharacters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    if (!slot?.mouth) {
      setLipsync(null);
      return;
    }
    let cancelled = false;
    loadLipsyncPreview(project, focus.characterId, focus.slot, view)
      .then((next) => {
        if (cancelled) return;
        setLipsync(next);
        if (!next.samples.some((sample) => sample.id === sampleId)) {
          setSampleId(next.samples[0]?.id || "builtin:hello");
        }
      })
      .catch(() => {
        if (!cancelled) setLipsync(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project, focus.characterId, focus.slot, view, slot?.mouth, sampleId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (edit || renameTo != null || deleteState) return;
        onClose();
        return;
      }
      if (focus.mode !== "drawing" || !slot) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const names = slot.drawings.map((item) => item.name);
        const next = neighborDrawing(names, focus.drawing, event.key === "ArrowLeft" ? -1 : 1);
        if (next) onFocus({ ...focus, mode: "drawing", drawing: next });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, slot, onFocus, onClose, edit, renameTo, deleteState]);

  useEffect(() => {
    return () => {
      if (playRef.current != null) window.cancelAnimationFrame(playRef.current);
    };
  }, []);

  const character = characters.find((item) => item.id === focus.characterId) || null;
  const names = slot?.drawings.map((item) => item.name) || [];
  const current = detail?.drawing || slot?.drawings.find((item) => item.name === drawingName) || null;
  const previewSrc = playShape
    ? assetUrl(project, (slot?.drawings.find((item) => item.name === playShape) || slot?.drawings.find((item) => item.shape === playShape))?.rel)
    : assetUrl(project, current?.rel, { v: current?.mtime });

  async function ingestFile(file: File, kind: "replace" | "add") {
    if (!file.type.startsWith("image/")) {
      setError("Drop a PNG or JPEG.");
      return;
    }
    setBusy(kind === "replace" ? "Cutting out…" : "Adding…");
    setError(null);
    try {
      const imageBase64 = await fileToImageBase64(file);
      if (kind === "replace") {
        if (focus.mode !== "drawing") return;
        setEdit(
          await previewReplaceDrawing(project, focus.characterId, focus.slot, focus.drawing, {
            imageBase64,
            filename: file.name,
            view,
          })
        );
      } else {
        const preview = await previewAddDrawing(project, focus.characterId, focus.slot, {
          imageBase64,
          filename: file.name,
          name: addName || file.name.replace(/\.[^.]+$/, ""),
          view,
        });
        setAddName(preview.suggestedName || addName);
        setEdit(preview);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not process the image");
    } finally {
      setBusy(null);
    }
  }

  async function acceptEdit() {
    if (!edit) return;
    setBusy("Saving…");
    setError(null);
    try {
      if (edit.kind === "replace" && focus.mode === "drawing") {
        await confirmReplaceDrawing(project, focus.characterId, focus.slot, focus.drawing, edit.sessionId);
      } else {
        const name = addName.trim();
        if (!name) throw new Error("Name the new drawing first.");
        const saved = await confirmAddDrawing(project, focus.characterId, focus.slot, {
          sessionId: edit.sessionId,
          name,
        });
        onFocus({ mode: "drawing", characterId: focus.characterId, slot: focus.slot, drawing: saved.drawing, view });
      }
      setEdit(null);
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  async function cancelEdit() {
    if (!edit) return;
    try {
      await cancelDrawingEdit(
        project,
        focus.characterId,
        focus.slot,
        edit.sessionId,
        edit.kind === "replace" ? edit.drawing : undefined
      );
    } catch {
      /* session may already be gone */
    }
    setEdit(null);
  }

  async function onRename() {
    if (focus.mode !== "drawing" || !renameTo) return;
    const name = renameTo.trim();
    if (!name || name === focus.drawing) {
      setRenameTo(null);
      return;
    }
    setBusy("Renaming…");
    setError(null);
    try {
      const result = await renameEditorDrawing(project, focus.characterId, focus.slot, focus.drawing, { name, view });
      setRenameTo(null);
      onFocus({ ...focus, drawing: result.drawing });
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename");
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(force = false) {
    if (focus.mode !== "drawing") return;
    setBusy("Deleting…");
    setError(null);
    try {
      const result = await deleteEditorDrawing(project, focus.characterId, focus.slot, focus.drawing, {
        confirm: true,
        force,
        view,
      });
      if ("used" in result && result.used) {
        setDeleteState({ force: true, usages: result.usages });
        setError(result.error);
        return;
      }
      setDeleteState(null);
      onFocus({ mode: "slot", characterId: focus.characterId, slot: focus.slot, view });
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(null);
    }
  }

  function playSample() {
    const sample = lipsync?.samples.find((item) => item.id === sampleId);
    if (!sample) return;
    if (playRef.current != null) window.cancelAnimationFrame(playRef.current);
    const started = performance.now();
    const last = sample.cues[sample.cues.length - 1]?.end || 1;
    const tick = (now: number) => {
      const t = (now - started) / 1000;
      if (t >= last) {
        setPlayShape(null);
        playRef.current = null;
        return;
      }
      setPlayShape(cueAtTime(sample.cues, t));
      playRef.current = window.requestAnimationFrame(tick);
    };
    playRef.current = window.requestAnimationFrame(tick);
  }

  function openImagine() {
    const pack = packForCharacter(character);
    onOpenImagine?.({
      characterId: focus.characterId,
      needId: needIdForSlot(focus.slot, pack?.sets),
    });
  }

  const cycleUses = useMemo(() => {
    if (!current || !slot) return [];
    return Object.entries(slot.cycles)
      .filter(([, cycle]) => cycle.drawings.includes(current.name))
      .map(([name]) => name);
  }, [current, slot]);

  return (
    <div
      className="studio-asset-editor"
      data-testid="asset-editor"
      data-mode={focus.mode}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = fileFromDrop(event);
        if (file) void ingestFile(file, focus.mode === "drawing" ? "replace" : "add");
      }}
      onPaste={(event) => {
        const file = imageFileFromClipboard(event.nativeEvent);
        if (file) void ingestFile(file, focus.mode === "drawing" ? "replace" : "add");
      }}
    >
      <header className="studio-asset-editor-bar">
        <div className="flex min-w-0 items-center gap-1.5">
          {focus.mode === "drawing" ? (
            <button
              type="button"
              className="studio-header-iconbtn"
              data-testid="asset-editor-back"
              onClick={() => onFocus({ mode: "slot", characterId: focus.characterId, slot: focus.slot, view })}
              title="Slot grid"
            >
              <Icon d="M7.5 2.2 3.2 6l4.3 3.8V2.2z" label="Back" />
            </button>
          ) : null}
          <span className="truncate text-[11px] text-neutral-200">
            {slot?.displayName || focus.characterId}
            <span className="text-neutral-500"> · {focus.slot}</span>
            {focus.mode === "drawing" ? <span className="text-white"> · {focus.drawing}</span> : null}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {focus.mode === "drawing" ? (
            <>
              <button
                type="button"
                className="studio-header-iconbtn"
                data-testid="asset-editor-prev"
                title="Previous"
                onClick={() => {
                  const next = neighborDrawing(names, focus.drawing, -1);
                  if (next) onFocus({ ...focus, drawing: next });
                }}
              >
                <Icon d="M7.5 2.2 3.2 6l4.3 3.8V2.2z" label="Previous" />
              </button>
              <button
                type="button"
                className="studio-header-iconbtn"
                data-testid="asset-editor-next"
                title="Next"
                onClick={() => {
                  const next = neighborDrawing(names, focus.drawing, 1);
                  if (next) onFocus({ ...focus, drawing: next });
                }}
              >
                <Icon d="M4.5 2.2v7.6L8.8 6 4.5 2.2z" label="Next" />
              </button>
            </>
          ) : null}
          <button type="button" className="studio-header-textbtn" onClick={onClose} data-testid="asset-editor-close">
            Close
          </button>
        </div>
      </header>

      {error ? <p className="px-2 py-1 text-[11px] text-red-400">{error}</p> : null}
      {busy ? <p className="px-2 py-1 text-[11px] text-studio-muted">{busy}</p> : null}

      {edit ? (
        <ReplacePreview
          edit={edit}
          addName={addName}
          onAddName={setAddName}
          onAccept={() => void acceptEdit()}
          onCancel={() => void cancelEdit()}
        />
      ) : focus.mode === "drawing" && current ? (
        <DrawingView
          slot={slot}
          detail={detail}
          current={current}
          src={previewSrc}
          bg={bg}
          onBg={setBg}
          cycleUses={cycleUses}
          playShape={playShape}
          onReplace={() => fileRef.current?.click()}
          onRename={() => setRenameTo(current.name)}
          onDelete={() => setDeleteState({ force: false, usages: detail?.usages || [] })}
        />
      ) : slot ? (
        <SlotGrid
          project={project}
          slot={slot}
          playShape={playShape}
          lipsync={lipsync}
          sampleId={sampleId}
          onSampleId={setSampleId}
          onPlay={playSample}
          onOpenDrawing={(drawing, nextView) =>
            onFocus({
              mode: "drawing",
              characterId: focus.characterId,
              slot: focus.slot,
              drawing,
              view: nextView || view,
            })
          }
          onView={(next) => onFocus({ ...focus, mode: "slot", view: next })}
          onAdd={() => addFileRef.current?.click()}
          onDropAdd={(file) => void ingestFile(file, "add")}
          onDropReplace={(drawing, file) => {
            onFocus({ mode: "drawing", characterId: focus.characterId, slot: focus.slot, drawing, view });
            void ingestFile(file, "replace");
          }}
          onOpenImagine={openImagine}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[11px] text-studio-muted">Loading…</div>
      )}

      {renameTo != null ? (
        <ConfirmStrip
          testId="asset-rename"
          label="Rename"
          onCancel={() => setRenameTo(null)}
          onOk={() => void onRename()}
        >
          <input
            className="studio-field max-w-[160px]"
            value={renameTo}
            onChange={(event) => setRenameTo(event.target.value)}
            data-testid="asset-rename-input"
          />
        </ConfirmStrip>
      ) : null}

      {deleteState ? (
        <ConfirmStrip
          testId="asset-delete"
          label={deleteState.force ? "Delete anyway" : "Delete"}
          onCancel={() => setDeleteState(null)}
          onOk={() => void onDelete(deleteState.force)}
        >
          <span className="text-[11px] text-neutral-300">
            {deleteState.force
              ? "Used by a script — moves to _trash."
              : "Move to _trash? The file is kept, not erased."}
          </span>
          {deleteState.usages.length > 0 ? (
            <ul className="max-h-16 overflow-auto text-[10px] text-amber-200" data-testid="asset-delete-usages">
              {deleteState.usages.slice(0, 8).map((usage, i) => (
                <li key={`${usage.script}:${usage.line}:${i}`}>{formatUsage(usage)}</li>
              ))}
            </ul>
          ) : null}
        </ConfirmStrip>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void ingestFile(file, "replace");
        }}
      />
      <input
        ref={addFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="asset-add-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void ingestFile(file, "add");
        }}
      />
    </div>
  );
}

function DrawingView({
  slot,
  detail,
  current,
  src,
  bg,
  onBg,
  cycleUses,
  playShape,
  onReplace,
  onRename,
  onDelete,
}: {
  slot: SlotEditor | null;
  detail: DrawingEditor | null;
  current: EditorDrawing;
  src: string | null;
  bg: BgKind;
  onBg: (bg: BgKind) => void;
  cycleUses: string[];
  playShape: string | null;
  onReplace: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <ZoomPane src={src} label={current.name} bg={bg} playShape={playShape} />
      <aside className="studio-asset-editor-meta">
        <MetaRow label="Name" value={current.name} />
        <MetaRow
          label="Size"
          value={current.width && current.height ? `${current.width} × ${current.height}` : "—"}
        />
        <MetaRow label="Slot" value={slot?.slot || ""} />
        <MetaRow
          label="Offset"
          value={slot ? `${slot.offset.x}, ${slot.offset.y}` : "—"}
        />
        <MetaRow label="Scale" value={slot ? String(slot.scale) : "—"} />
        {current.shape ? <MetaRow label="Shape" value={`${current.shape} · ${mouthSound(current.name) || ""}`} /> : null}
        {current.duplicateOf ? (
          <p className="text-[10px] text-amber-300" data-testid="asset-duplicate">
            Duplicate of {current.duplicateOf}
          </p>
        ) : null}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">Used by</p>
          {cycleUses.length ? (
            <p className="text-[11px] text-neutral-300">cycles {cycleUses.join(", ")}</p>
          ) : null}
          {(detail?.usages || []).length ? (
            <ul className="mt-1 space-y-0.5 text-[10px] text-neutral-400" data-testid="asset-usages">
              {detail?.usages.slice(0, 8).map((usage, i) => (
                <li key={`${usage.script}:${usage.line}:${i}`}>{formatUsage(usage)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-neutral-600">No script lines yet.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1 pt-1">
          {(["checker", "black", "white", "gray"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="studio-header-textbtn"
              data-active={bg === kind}
              onClick={() => onBg(kind)}
            >
              {kind}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className="studio-header-textbtn" onClick={onReplace} data-testid="asset-replace">
            Replace
          </button>
          <button type="button" className="studio-header-textbtn" onClick={onRename} data-testid="asset-rename-open">
            Rename
          </button>
          <button type="button" className="studio-header-textbtn" onClick={onDelete} data-testid="asset-delete-open">
            Delete
          </button>
        </div>
        <p className="text-[10px] text-neutral-600">Drop or paste an image to replace. Old file goes to _replaced/.</p>
      </aside>
    </div>
  );
}

function ZoomPane({
  src,
  label,
  bg,
  playShape,
}: {
  src: string | null;
  label: string;
  bg: BgKind;
  playShape: string | null;
}) {
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  return (
    <div
      className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${bg === "checker" ? "studio-checker" : ""}`}
      style={bg === "checker" ? undefined : { background: BG[bg] }}
      data-testid="asset-viewer-stage"
      onWheel={(event) => {
        event.preventDefault();
        const next = event.deltaY < 0 ? zoom.scale * 1.12 : zoom.scale / 1.12;
        setZoom((current) => ({ ...current, scale: Math.min(8, Math.max(0.25, next)) }));
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY, ox: zoom.x, oy: zoom.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        setZoom({
          scale: zoom.scale,
          x: drag.current.ox + (event.clientX - drag.current.x),
          y: drag.current.oy + (event.clientY - drag.current.y),
        });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      >
        {src ? (
          // Worker-served PNG
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className="max-h-[70%] max-w-[70%] object-contain" draggable={false} />
        ) : (
          <span className="text-[11px] text-studio-muted">No drawing</span>
        )}
      </div>
      <div className="absolute bottom-1 left-1 flex items-center gap-1">
        <button type="button" className="studio-header-textbtn" onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}>
          Reset
        </button>
        <span className="text-[10px] text-neutral-500">{Math.round(zoom.scale * 100)}%</span>
        {playShape ? <span className="text-[10px] text-amber-200">{playShape}</span> : null}
      </div>
    </div>
  );
}

function SlotGrid({
  project,
  slot,
  playShape,
  lipsync,
  sampleId,
  onSampleId,
  onPlay,
  onOpenDrawing,
  onView,
  onAdd,
  onDropAdd,
  onDropReplace,
  onOpenImagine,
}: {
  project: string;
  slot: SlotEditor;
  playShape: string | null;
  lipsync: LipsyncPreview | null;
  sampleId: string;
  onSampleId: (id: string) => void;
  onPlay: () => void;
  onOpenDrawing: (drawing: string, view?: string) => void;
  onView: (view: string) => void;
  onAdd: () => void;
  onDropAdd: (file: File) => void;
  onDropReplace: (drawing: string, file: File) => void;
  onOpenImagine: () => void;
}) {
  const cells = slot.mouth
    ? slot.shapes.map((shape) => {
        const drawing = slot.drawings.find((item) => item.shape === shape.shape && !item.loud);
        const loud = slot.drawings.find((item) => item.shape === shape.shape && item.loud);
        return { key: shape.shape, label: shape.shape, sound: shape.sound, drawing, loud, missing: !shape.present };
      })
    : slot.drawings.map((drawing) => ({
        key: drawing.name,
        label: drawing.name,
        sound: mouthSound(drawing.name),
        drawing,
        loud: null as EditorDrawing | null,
        missing: false,
      }));
  const extras = slot.mouth ? slot.drawings.filter((item) => !item.shape) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-studio-border px-2 py-1">
        {slot.views.map((view) => (
          <button
            key={view.id}
            type="button"
            className="studio-header-textbtn"
            data-active={slot.view === view.id}
            data-testid={`asset-view-${view.id}`}
            onClick={() => onView(view.id)}
          >
            {view.id}
            <span className="ml-1 text-neutral-600">{view.count}</span>
          </button>
        ))}
        <span className="flex-1" />
        {slot.mouth && lipsync ? (
          <>
            <select
              className="studio-view-select"
              value={sampleId}
              onChange={(event) => onSampleId(event.target.value)}
              data-testid="asset-lipsync-sample"
            >
              {lipsync.samples.map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.label}
                </option>
              ))}
            </select>
            <button type="button" className="studio-header-textbtn" data-testid="asset-lipsync-play" onClick={onPlay}>
              Play sample
            </button>
          </>
        ) : null}
        <button type="button" className="studio-header-textbtn" data-testid="asset-imagine" onClick={onOpenImagine}>
          Open Grok Imagine for this slot
        </button>
      </div>
      {slot.missingShapes.length ? (
        <p className="px-2 py-1 text-[10px] text-amber-300" data-testid="asset-missing-shapes">
          Missing shapes {slot.missingShapes.join(", ")}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {cells.map((cell) => (
            <button
              key={cell.key}
              type="button"
              data-testid={`asset-cell-${cell.label}`}
              className="studio-asset-cell"
              data-missing={cell.missing ? "true" : "false"}
              data-playing={playShape === cell.label ? "true" : "false"}
              onClick={() => cell.drawing && onOpenDrawing(cell.drawing.name)}
              onDoubleClick={() => cell.drawing && onOpenDrawing(cell.drawing.name)}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const file = fileFromDrop(event);
                if (!file) return;
                if (cell.drawing) onDropReplace(cell.drawing.name, file);
                else onDropAdd(file);
              }}
            >
              <span className={`studio-asset-cell-thumb ${cell.drawing ? "studio-checker" : "bg-studio-raised"}`}>
                {cell.drawing ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(project, cell.drawing.rel, { v: cell.drawing.mtime }) || ""} alt={cell.label} />
                ) : (
                  <span className="text-[10px] text-neutral-600">missing</span>
                )}
              </span>
              <span className="truncate text-[11px] text-neutral-200">{cell.label}</span>
              {cell.sound ? <span className="truncate text-[9px] text-neutral-500">{cell.sound}</span> : null}
              {cell.drawing?.duplicateOf ? (
                <span className="text-[9px] text-amber-300">dup {cell.drawing.duplicateOf}</span>
              ) : null}
              {cell.loud ? <span className="text-[9px] text-neutral-400">loud</span> : null}
            </button>
          ))}
          <button
            type="button"
            className="studio-asset-cell"
            data-testid="asset-add"
            onClick={onAdd}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const file = fileFromDrop(event);
              if (file) onDropAdd(file);
            }}
          >
            <span className="studio-asset-cell-thumb flex items-center justify-center bg-studio-raised text-lg text-neutral-500">
              +
            </span>
            <span className="text-[11px] text-neutral-400">Add</span>
          </button>
        </div>
        {extras.length ? (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {extras.map((drawing) => (
              <button
                key={drawing.name}
                type="button"
                className="studio-asset-cell"
                onClick={() => onOpenDrawing(drawing.name)}
                onDoubleClick={() => onOpenDrawing(drawing.name)}
              >
                <span className="studio-asset-cell-thumb studio-checker">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assetUrl(project, drawing.rel, { v: drawing.mtime }) || ""} alt={drawing.name} />
                </span>
                <span className="truncate text-[11px] text-neutral-200">{drawing.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReplacePreview({
  edit,
  addName,
  onAddName,
  onAccept,
  onCancel,
}: {
  edit: EditPreview;
  addName: string;
  onAddName: (name: string) => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="asset-replace-preview">
      <div className="flex min-h-0 flex-1">
        {edit.before ? (
          <figure className="flex min-w-0 flex-1 flex-col">
            <figcaption className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">Before</figcaption>
            <div className="studio-checker min-h-0 flex-1">
              {edit.before.pngBase64 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={edit.before.pngBase64} alt="Before" className="h-full w-full object-contain" />
              ) : null}
            </div>
          </figure>
        ) : null}
        <figure className="flex min-w-0 flex-1 flex-col">
          <figcaption className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">After</figcaption>
          <div className="studio-checker min-h-0 flex-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={edit.after.pngBase64} alt="After" className="h-full w-full object-contain" />
          </div>
        </figure>
      </div>
      <div className="flex items-center gap-2 border-t border-studio-border px-2 py-1.5">
        {edit.kind === "add" ? (
          <input
            className="studio-field max-w-[180px]"
            value={addName}
            onChange={(event) => onAddName(event.target.value)}
            placeholder="drawing name"
            data-testid="asset-add-name"
          />
        ) : (
          <span className="text-[11px] text-neutral-400">Old file is kept in _replaced/.</span>
        )}
        <span className="flex-1" />
        <button type="button" className="studio-header-textbtn" onClick={onCancel} data-testid="asset-edit-cancel">
          Cancel
        </button>
        <button type="button" className="studio-header-textbtn" onClick={onAccept} data-testid="asset-edit-accept">
          Accept
        </button>
      </div>
    </div>
  );
}

function ConfirmStrip({
  testId,
  label,
  onCancel,
  onOk,
  children,
}: {
  testId: string;
  label: string;
  onCancel: () => void;
  onOk: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-studio-border px-2 py-1.5" data-testid={testId}>
      {children}
      <span className="flex-1" />
      <button type="button" className="studio-header-textbtn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="studio-header-textbtn" data-testid={`${testId}-ok`} onClick={onOk}>
        {label}
      </button>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="text-[11px] text-neutral-200">{value}</p>
    </div>
  );
}
