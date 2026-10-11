"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelDrawingEdit,
  confirmAddDrawing,
  confirmReplaceDrawing,
  cueAtTime,
  deleteEditorDrawing,
  fileToImageBase64,
  flipEditorDrawing,
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
  promoteSlotView,
  realignSlotView,
  remapLipSyncShape,
  excludedLipSyncShapes,
  renameEditorDrawing,
  restoreEditorDrawing,
  saveDrawingFlags,
  type AssetFocus,
  type DrawingEditor,
  type DrawingUsage,
  type EditPreview,
  type EditorDrawing,
  type LipsyncPreview,
  type SlotEditor,
} from "@/lib/assetEditor";
import {
  alignProbeUrl,
  applyCollar,
  autoFitHeadNudge,
  canvasLandmarks,
  clampHeadNudge,
  defaultHeadNudge,
  headScaleToSlider,
  landmarksFromRgba,
  previewAlignLayout,
  residualHeadNudge,
  sliderToHeadScale,
  type HeadLandmarks,
  type HeadNudge,
} from "@/lib/headAlign";
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
  const [nudge, setNudge] = useState(defaultHeadNudge());
  const [overlayDefault, setOverlayDefault] = useState(true);
  const [flipUndo, setFlipUndo] = useState<{ drawing: string; replaced: string } | null>(null);
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

  async function onPromoteView() {
    setBusy("Setting default…");
    setError(null);
    try {
      await promoteSlotView(project, focus.characterId, focus.slot, view);
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not promote set");
    } finally {
      setBusy(null);
    }
  }

  async function onRealign(drawing?: string, opts?: { collarY?: number; cropToHead?: boolean; autoScale?: number }) {
    setBusy("Re-aligning…");
    setError(null);
    try {
      await realignSlotView(project, focus.characterId, focus.slot, {
        view,
        drawing,
        nudge: residualHeadNudge(clampHeadNudge(nudge), opts?.autoScale ?? 1),
        cropToHead: opts?.cropToHead !== false,
        collarY: opts?.collarY,
      });
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not re-align");
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
    const excluded = excludedLipSyncShapes(slot?.drawings || []);
    const tick = (now: number) => {
      const t = (now - started) / 1000;
      if (t >= last) {
        setPlayShape(null);
        playRef.current = null;
        return;
      }
      setPlayShape(remapLipSyncShape(cueAtTime(sample.cues, t), excluded));
      playRef.current = window.requestAnimationFrame(tick);
    };
    playRef.current = window.requestAnimationFrame(tick);
  }

  useEffect(() => {
    setFlipUndo(null);
  }, [drawingName]);

  async function onFlip() {
    if (focus.mode !== "drawing") return;
    setBusy("Flipping…");
    setError(null);
    try {
      const result = await flipEditorDrawing(project, focus.characterId, focus.slot, focus.drawing, { view });
      setFlipUndo(result.replaced ? { drawing: focus.drawing, replaced: result.replaced } : null);
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not flip");
    } finally {
      setBusy(null);
    }
  }

  async function onUndoFlip() {
    if (focus.mode !== "drawing" || !flipUndo || flipUndo.drawing !== focus.drawing) return;
    setBusy("Undoing flip…");
    setError(null);
    try {
      await restoreEditorDrawing(project, focus.characterId, focus.slot, focus.drawing, {
        replaced: flipUndo.replaced,
        view,
      });
      setFlipUndo(null);
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo flip");
    } finally {
      setBusy(null);
    }
  }

  async function onHand(hand: "L" | "R" | null) {
    if (focus.mode !== "drawing") return;
    setBusy("Saving…");
    setError(null);
    try {
      await saveDrawingFlags(project, focus.characterId, focus.slot, focus.drawing, { hand, view });
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set L/R");
    } finally {
      setBusy(null);
    }
  }

  async function onExcludeFromLipSync(exclude: boolean) {
    if (focus.mode !== "drawing") return;
    setBusy(exclude ? "Excluding…" : "Including…");
    setError(null);
    try {
      await saveDrawingFlags(project, focus.characterId, focus.slot, focus.drawing, {
        excludeFromLipSync: exclude,
        view,
      });
      onChanged();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update lip sync");
    } finally {
      setBusy(null);
    }
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
          project={project}
          canRealign={Boolean(slot?.canRealign)}
          overlayDefault={overlayDefault}
          onOverlayDefault={setOverlayDefault}
          nudge={nudge}
          onNudge={(next) => setNudge(clampHeadNudge(next))}
          onRealign={(opts) => void onRealign(current.name, opts)}
          onRealignAll={(opts) => void onRealign(undefined, opts)}
          onExcludeFromLipSync={slot?.mouth ? (value) => void onExcludeFromLipSync(value) : undefined}
          onFlip={() => void onFlip()}
          onUndoFlip={flipUndo && flipUndo.drawing === drawingName ? () => void onUndoFlip() : undefined}
          onHand={(hand) => void onHand(hand)}
          defaultRel={
            slot?.canRealign && slot.defaultDrawingsDir
              ? `characters/${focus.characterId}/${slot.defaultDrawingsDir}/${current.name}.png`
              : null
          }
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
          onPromote={() => void onPromoteView()}
          onRealign={() => void onRealign()}
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
  project,
  canRealign,
  overlayDefault,
  onOverlayDefault,
  nudge,
  onNudge,
  onRealign,
  onRealignAll,
  onExcludeFromLipSync,
  onFlip,
  onUndoFlip,
  onHand,
  defaultRel,
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
  project: string;
  canRealign: boolean;
  overlayDefault: boolean;
  onOverlayDefault: (value: boolean) => void;
  nudge: { x: number; y: number; scale: number };
  onNudge: (nudge: { x: number; y: number; scale: number }) => void;
  onRealign: (opts?: { collarY?: number; cropToHead?: boolean; autoScale?: number }) => void;
  onRealignAll: (opts?: { collarY?: number; cropToHead?: boolean; autoScale?: number }) => void;
  onExcludeFromLipSync?: (exclude: boolean) => void;
  onFlip: () => void;
  onUndoFlip?: () => void;
  onHand: (hand: "L" | "R" | null) => void;
  defaultRel: string | null;
}) {
  const defaultSrc = defaultRel ? assetUrl(project, defaultRel) : null;
  const [cropToHead, setCropToHead] = useState(true);
  const [collarY, setCollarY] = useState(0.72);
  const [srcMarks, setSrcMarks] = useState<HeadLandmarks | null>(null);
  const [refMarks, setRefMarks] = useState<HeadLandmarks | null>(null);
  const croppedSrc = useMemo(
    () => (srcMarks ? (cropToHead ? applyCollar(srcMarks, collarY) : srcMarks) : null),
    [srcMarks, cropToHead, collarY]
  );
  const autoScale = croppedSrc && refMarks ? autoFitHeadNudge(croppedSrc, refMarks).scale : 1;
  const realignOpts = { cropToHead, collarY: cropToHead ? collarY : undefined, autoScale };

  function applyAutoFit() {
    if (!croppedSrc || !refMarks) return;
    onNudge(autoFitHeadNudge(croppedSrc, refMarks));
  }

  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!src || !croppedSrc || !refMarks) return;
    if (fittedFor.current === src) return;
    fittedFor.current = src;
    onNudge(autoFitHeadNudge(croppedSrc, refMarks));
  }, [src, croppedSrc, refMarks, onNudge]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {canRealign && overlayDefault && defaultSrc ? (
          <AlignPreview
            src={src}
            defaultSrc={defaultSrc}
            label={current.name}
            bg={bg}
            playShape={playShape}
            cropToHead={cropToHead}
            collarY={collarY}
            onCollarY={setCollarY}
            nudge={nudge}
            srcMarks={srcMarks}
            refMarks={refMarks}
            onSrcMarks={setSrcMarks}
            onRefMarks={setRefMarks}
            knownSrcW={current.width || 0}
            knownSrcH={current.height || 0}
          />
        ) : (
          <ZoomPane
            src={src}
            label={current.name}
            bg={bg}
            playShape={playShape}
            cropToHead={canRealign && cropToHead}
            collarY={collarY}
            onCollarY={setCollarY}
          />
        )}
      </div>
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
        {onExcludeFromLipSync ? (
          <label className="flex items-center gap-1 text-[10px] text-neutral-400">
            <input
              type="checkbox"
              checked={Boolean(current.excludeFromLipSync)}
              onChange={(event) => onExcludeFromLipSync(event.target.checked)}
              data-testid="asset-exclude-lipsync"
            />
            Exclude from lip sync
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">L/R</span>
          {(["L", "R"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className="studio-header-textbtn"
              data-active={current.hand === side}
              data-testid={`asset-hand-${side}`}
              onClick={() => onHand(current.hand === side ? null : side)}
            >
              {side}
            </button>
          ))}
        </div>
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
        {canRealign ? (
          <div className="space-y-1 border-t border-studio-border pt-2" data-testid="asset-nudge">
            <label className="flex items-center gap-1 text-[10px] text-neutral-400">
              <input
                type="checkbox"
                checked={overlayDefault}
                onChange={(event) => onOverlayDefault(event.target.checked)}
              />
              Overlay default
            </label>
            <label className="flex items-center gap-1 text-[10px] text-neutral-400">
              <input
                type="checkbox"
                checked={cropToHead}
                onChange={(event) => setCropToHead(event.target.checked)}
                data-testid="asset-crop-to-head"
              />
              Crop to head
            </label>
            {cropToHead ? (
              <label className="block text-[10px] text-neutral-500">
                Collar line
                <input
                  type="range"
                  min={20}
                  max={95}
                  value={Math.round(collarY * 100)}
                  className="w-full"
                  data-testid="asset-collar-slider"
                  onChange={(event) => setCollarY(Number(event.target.value) / 100)}
                />
              </label>
            ) : null}
            <label className="block text-[10px] text-neutral-500">
              Nudge X
              <input
                type="range"
                min={-200}
                max={200}
                value={nudge.x}
                className="w-full"
                onChange={(event) => onNudge({ ...nudge, x: Number(event.target.value) })}
              />
            </label>
            <label className="block text-[10px] text-neutral-500">
              Nudge Y
              <input
                type="range"
                min={-200}
                max={200}
                value={nudge.y}
                className="w-full"
                onChange={(event) => onNudge({ ...nudge, y: Number(event.target.value) })}
              />
            </label>
            <label className="block text-[10px] text-neutral-500">
              Scale {nudge.scale.toFixed(2)}×
              <input
                type="range"
                min={0}
                max={1000}
                value={Math.round(headScaleToSlider(nudge.scale) * 1000)}
                className="w-full"
                data-testid="asset-nudge-scale"
                onChange={(event) => onNudge({ ...nudge, scale: sliderToHeadScale(Number(event.target.value) / 1000) })}
              />
            </label>
            <button
              type="button"
              className="studio-header-textbtn"
              data-testid="asset-autofit"
              onClick={applyAutoFit}
              disabled={!croppedSrc || !refMarks}
            >
              Auto-fit to default
            </button>
            <button
              type="button"
              className="studio-header-textbtn"
              data-testid="asset-realign-one"
              onClick={() => onRealign(realignOpts)}
            >
              Re-align this drawing
            </button>
            <button
              type="button"
              className="studio-header-textbtn"
              data-testid="asset-realign-all"
              onClick={() => onRealignAll(realignOpts)}
            >
              Apply to all in this slot
            </button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <button type="button" className="studio-header-textbtn" onClick={onFlip} data-testid="asset-flip">
            Flip horizontally
          </button>
          {onUndoFlip ? (
            <button type="button" className="studio-header-textbtn" onClick={onUndoFlip} data-testid="asset-flip-undo">
              Undo flip
            </button>
          ) : null}
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

function readLandmarks(img: HTMLImageElement): HeadLandmarks {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w < 1 || h < 1) return canvasLandmarks(1, 1);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvasLandmarks(w, h);
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, w, h);
    return landmarksFromRgba(pixels.data, w, h);
  } catch {
    return canvasLandmarks(w, h);
  }
}

function AlignPreview({
  src,
  defaultSrc,
  label,
  bg,
  playShape,
  cropToHead,
  collarY,
  onCollarY,
  nudge,
  srcMarks,
  refMarks,
  onSrcMarks,
  onRefMarks,
  knownSrcW = 0,
  knownSrcH = 0,
}: {
  src: string | null;
  defaultSrc: string;
  label: string;
  bg: BgKind;
  playShape: string | null;
  cropToHead: boolean;
  collarY: number;
  onCollarY?: (y: number) => void;
  nudge: HeadNudge;
  srcMarks: HeadLandmarks | null;
  refMarks: HeadLandmarks | null;
  onSrcMarks: (marks: HeadLandmarks) => void;
  onRefMarks: (marks: HeadLandmarks) => void;
  knownSrcW?: number;
  knownSrcH?: number;
}) {
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [srcSize, setSrcSize] = useState({ w: knownSrcW, h: knownSrcH });
  const [refSize, setRefSize] = useState({ w: 0, h: 0 });
  const displaySrc = alignProbeUrl(src);
  const displayDefault = alignProbeUrl(defaultSrc) || defaultSrc;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const r = stage.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const seededSrc = useRef<string | null>(null);
  useEffect(() => {
    if (knownSrcW < 1 || knownSrcH < 1) return;
    const key = `${knownSrcW}x${knownSrcH}:${src || ""}`;
    if (seededSrc.current === key) return;
    seededSrc.current = key;
    setSrcSize({ w: knownSrcW, h: knownSrcH });
    onSrcMarks(canvasLandmarks(knownSrcW, knownSrcH));
  }, [knownSrcW, knownSrcH, src, onSrcMarks]);

  useEffect(() => {
    let cancelled = false;
    function load(url: string | null, dest: "src" | "ref") {
      if (!url) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled || img.naturalWidth < 1) return;
        const marks = readLandmarks(img);
        if (dest === "src") {
          setSrcSize({ w: img.naturalWidth, h: img.naturalHeight });
          onSrcMarks(marks);
        } else {
          setRefSize({ w: img.naturalWidth, h: img.naturalHeight });
          onRefMarks(marks);
        }
      };
      img.src = url;
    }
    load(displaySrc, "src");
    load(displayDefault, "ref");
    return () => {
      cancelled = true;
    };
  }, [displaySrc, displayDefault, onSrcMarks, onRefMarks]);

  const cropped = srcMarks && cropToHead ? applyCollar(srcMarks, collarY) : srcMarks;
  const layout =
    srcSize.w > 0 && refSize.w > 0 && cropped && refMarks && box.w > 0 && box.h > 0
      ? previewAlignLayout({
          boxW: box.w,
          boxH: box.h,
          srcW: srcSize.w,
          srcH: srcSize.h,
          refW: refSize.w,
          refH: refSize.h,
          src: cropped,
          ref: refMarks,
          nudge,
        })
      : null;

  return (
    <div
      ref={stageRef}
      className={`absolute inset-0 overflow-hidden ${bg === "checker" ? "studio-checker" : ""}`}
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
        className="absolute inset-0"
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: "0 0" }}
      >
        {layout ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displayDefault}
              alt=""
              crossOrigin="anonymous"
              data-testid="asset-align-overlay"
              className="pointer-events-none absolute object-fill opacity-40 mix-blend-screen"
              style={{
                left: layout.ref.left,
                top: layout.ref.top,
                width: layout.ref.width,
                height: layout.ref.height,
              }}
              onLoad={(event) => {
                const img = event.currentTarget;
                setRefSize({ w: img.naturalWidth, h: img.naturalHeight });
                onRefMarks(readLandmarks(img));
              }}
            />
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displaySrc || src}
                alt={label}
                crossOrigin="anonymous"
                className="pointer-events-none absolute object-fill"
                style={{
                  left: layout.src.left,
                  top: layout.src.top,
                  width: layout.src.width,
                  height: layout.src.height,
                  clipPath: cropToHead ? `inset(0 0 ${Math.max(0, (1 - collarY) * 100)}% 0)` : undefined,
                }}
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setSrcSize({ w: img.naturalWidth, h: img.naturalHeight });
                  onSrcMarks(readLandmarks(img));
                }}
              />
            ) : null}
          </>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displayDefault}
              alt=""
              crossOrigin="anonymous"
              className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-40 mix-blend-screen"
              onLoad={(event) => {
                const img = event.currentTarget;
                setRefSize({ w: img.naturalWidth, h: img.naturalHeight });
                onRefMarks(readLandmarks(img));
              }}
            />
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displaySrc || src}
                alt={label}
                crossOrigin="anonymous"
                className="pointer-events-none absolute inset-0 m-auto max-h-[70%] max-w-[70%] object-contain"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setSrcSize({ w: img.naturalWidth, h: img.naturalHeight });
                  onSrcMarks(readLandmarks(img));
                }}
              />
            ) : null}
          </>
        )}
      </div>
      {layout && cropToHead ? (
        <button
          type="button"
          data-testid="asset-collar-handle"
          aria-label="Collar line"
          className="absolute z-10 h-3 cursor-ns-resize border-0 bg-transparent p-0"
          style={{
            top: layout.src.top * zoom.scale + zoom.y + collarY * layout.src.height * zoom.scale - 6,
            left: layout.src.left * zoom.scale + zoom.x,
            width: layout.src.width * zoom.scale,
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const startY = event.clientY;
            const start = collarY;
            const height = Math.max(1, layout.src.height * zoom.scale);
            function move(ev: PointerEvent) {
              onCollarY?.(Math.min(0.95, Math.max(0.2, start + (ev.clientY - startY) / height)));
            }
            function up() {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            }
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          <span className="absolute left-0 right-0 top-1/2 border-t-2 border-studio-accent" />
          <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white bg-studio-accent" />
        </button>
      ) : null}
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

function ZoomPane({
  src,
  label,
  bg,
  playShape,
  cropToHead = false,
  collarY = 0.72,
  onCollarY,
}: {
  src: string | null;
  label: string;
  bg: BgKind;
  playShape: string | null;
  cropToHead?: boolean;
  collarY?: number;
  onCollarY?: (y: number) => void;
}) {
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [imgBox, setImgBox] = useState({ top: 0, left: 0, w: 0, h: 0 });

  function measureImage() {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return;
    const parent = stage.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    setImgBox({ top: r.top - parent.top, left: r.left - parent.left, w: r.width, h: r.height });
  }

  useEffect(() => {
    measureImage();
  }, [src, zoom.scale, zoom.x, zoom.y, cropToHead]);

  return (
    <div
      ref={stageRef}
      className={`absolute inset-0 overflow-hidden ${bg === "checker" ? "studio-checker" : ""}`}
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
        measureImage();
      }}
      onPointerUp={() => {
        drag.current = null;
        measureImage();
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      >
        {src ? (
          // Worker-served PNG
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={src}
            alt={label}
            className="max-h-[70%] max-w-[70%] object-contain"
            draggable={false}
            onLoad={measureImage}
          />
        ) : (
          <span className="text-[11px] text-studio-muted">No drawing</span>
        )}
      </div>
      {cropToHead && imgBox.h > 0 ? (
        <button
          type="button"
          data-testid="asset-collar-handle"
          aria-label="Collar line"
          className="absolute z-10 h-3 w-full cursor-ns-resize border-0 bg-transparent p-0"
          style={{ top: imgBox.top + collarY * imgBox.h - 6, left: imgBox.left, width: imgBox.w }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const startY = event.clientY;
            const start = collarY;
            const height = imgBox.h || 1;
            function move(ev: PointerEvent) {
              const next = Math.min(0.95, Math.max(0.2, start + (ev.clientY - startY) / height));
              onCollarY?.(next);
            }
            function up() {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            }
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          <span className="absolute left-0 right-0 top-1/2 border-t-2 border-studio-accent" />
          <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white bg-studio-accent" />
        </button>
      ) : null}
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
  onPromote,
  onRealign,
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
  onPromote: () => void;
  onRealign: () => void;
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
        {slot.mouth && !slot.isDefaultView ? (
          <button type="button" className="studio-header-textbtn" data-testid="asset-promote-view" onClick={onPromote}>
            Use this set as default
          </button>
        ) : null}
        {slot.canRealign ? (
          <button type="button" className="studio-header-textbtn" data-testid="asset-realign" onClick={onRealign}>
            Re-align to default
          </button>
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
              {cell.drawing?.excludeFromLipSync ? (
                <span className="text-[9px] text-amber-200" data-testid="asset-manual-only">
                  manual only
                </span>
              ) : null}
              {cell.drawing?.hand ? (
                <span className="text-[9px] text-neutral-400" data-testid="asset-hand-tag">
                  {cell.drawing.hand}
                </span>
              ) : null}
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
                {drawing.excludeFromLipSync ? (
                  <span className="text-[9px] text-amber-200">manual only</span>
                ) : null}
                {drawing.hand ? (
                  <span className="text-[9px] text-neutral-400">{drawing.hand}</span>
                ) : null}
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
