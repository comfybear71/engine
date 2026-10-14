"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mergeCategories } from "@/lib/actionLibrary";
import { actionShotCaption, FACTORY_VIEW_TABS } from "@/lib/factoryAssets";
import {
  assetUrl,
  extractLibraryFace,
  importFactoryMp4,
  loadCharacterLibrary,
  saveLibraryFrameToSlot,
  tickLibraryClip,
  type CharacterLibrary,
  type LibraryClip,
  type LibraryFrame,
} from "@/lib/worker";

const SLOT_OPTIONS = [
  { id: "torso", label: "Torso / Body pose" },
  { id: "arm", label: "Arms" },
  { id: "eyes", label: "Eyes" },
  { id: "mouth", label: "Mouth" },
  { id: "head_base", label: "Head" },
];

export default function CharacterLibraryTab({
  project,
  characterId,
  onImported,
}: {
  project: string;
  characterId: string;
  onImported: () => void;
}) {
  const [library, setLibrary] = useState<CharacterLibrary | null>(null);
  const [kind, setKind] = useState("all");
  const [action, setAction] = useState("all");
  const [view, setView] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ clipId: string; index: number } | null>(null);
  const [slot, setSlot] = useState("torso");
  const [slotView, setSlotView] = useState("front");
  const [drawingName, setDrawingName] = useState("");
  const [side, setSide] = useState("L");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadCharacterLibrary(project, characterId)
      .then((next) => {
        if (!cancelled) setLibrary(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Library failed");
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId]);

  const clips = useMemo(() => {
    const list = library?.clips || [];
    return list.filter((clip) => {
      if (kind !== "all" && clip.kind !== kind) return false;
      if (action !== "all" && clip.action !== action && clip.category !== action) return false;
      if (view !== "all" && clip.view !== view && !(clip.frames || []).some((frame) => frame.view === view)) return false;
      return true;
    });
  }, [library, kind, action, view]);

  const actions = [...new Set((library?.clips || []).map((clip) => clip.action).filter(Boolean))];
  const views = [...new Set((library?.clips || []).flatMap((clip) => clip.frames.map((frame) => frame.view).filter(Boolean)))];

  async function refresh(message?: string) {
    const next = await loadCharacterLibrary(project, characterId);
    setLibrary(next);
    onImported();
    if (message) setNote(message);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importFactoryMp4(project, { characterId, file, prompt: file.name.replace(/\.[^.]+$/, "") });
      await refresh("Imported");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import MP4 failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onSave() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveLibraryFrameToSlot(
        project,
        characterId,
        selected.clipId,
        selected.index,
        slot,
        slotView,
        drawingName || undefined,
        slot === "arm" ? side : undefined
      );
      setNote(`Draft ${result.name} → ${result.slot}`);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save to slot failed");
    } finally {
      setBusy(false);
    }
  }

  async function onExtract(clip: LibraryClip, face: "mouth" | "eyes") {
    setBusy(true);
    setError(null);
    try {
      const result = await extractLibraryFace(project, characterId, clip.id, face);
      const names = result.drawings.map((item) => item.name).join(", ") || "none";
      await refresh(`Draft ${face}: ${names}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extract failed");
    } finally {
      setBusy(false);
    }
  }

  async function onTick(clip: LibraryClip) {
    setBusy(true);
    setError(null);
    try {
      const result = await tickLibraryClip(project, characterId, clip.id);
      await refresh(`Action Shot ${result.actionId} (${actionShotCaption(result) || `${result.frames} shots`})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tick failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-factory-library-tab" data-testid="assets-library-tab">
      <div className="studio-factory-library-filters">
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="assets-library-kind">
            <option value="all">All</option>
            <option value="body">Body</option>
            <option value="head">Head</option>
          </select>
        </label>
        <label>
          Action
          <select value={action} onChange={(event) => setAction(event.target.value)} data-testid="assets-library-action">
            <option value="all">All</option>
            {actions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          View
          <select value={view} onChange={(event) => setView(event.target.value)} data-testid="assets-library-view">
            <option value="all">All</option>
            {views.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/*"
          className="hidden"
          data-testid="assets-library-file"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      {error ? <p className="mb-2 text-[11px] text-red-400">{error}</p> : null}
      {note ? <p className="mb-2 text-[11px] text-studio-muted">{note}</p> : null}
      {selected ? (
        <div className="studio-factory-library-save" data-testid="assets-library-save-bar">
          <label>
            Slot
            <select value={slot} onChange={(event) => setSlot(event.target.value)} data-testid="assets-library-slot">
              {SLOT_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            View
            <select value={slotView} onChange={(event) => setSlotView(event.target.value)} data-testid="assets-library-slot-view">
              {FACTORY_VIEW_TABS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={drawingName}
              onChange={(event) => setDrawingName(event.target.value)}
              placeholder={slot === "mouth" ? "X" : slot === "eyes" ? "open" : "pose"}
              data-testid="assets-library-slot-name"
            />
          </label>
          {slot === "arm" ? (
            <label>
              Side
              <select value={side} onChange={(event) => setSide(event.target.value)} data-testid="assets-library-arm-side">
                <option value="L">L</option>
                <option value="R">R</option>
              </select>
            </label>
          ) : null}
          <button type="button" data-testid="assets-library-save-slot" disabled={busy} onClick={() => void onSave()}>
            Save to slot
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-studio-muted">Select a frame, then Save to slot as a draft.</p>
      )}
      <div className="studio-factory-library-clips">
        <button
          type="button"
          className="studio-factory-add"
          data-testid="assets-library-import"
          data-wide="false"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          title="Import MP4"
        >
          <span>{busy ? "…" : "+"}</span>
          <em>Import MP4</em>
        </button>
        {clips.length === 0 ? (
          <p className="text-[11px] text-studio-muted">Import an MP4 to fill this character’s action pack.</p>
        ) : null}
        {clips.map((clip) => (
          <ClipStrip
            key={clip.id}
            project={project}
            clip={clip}
            selected={selected}
            busy={busy}
            onSelect={(frame) => {
              setSelected({ clipId: clip.id, index: frame.index });
              if (frame.view) setSlotView(frame.view);
            }}
            onExtract={(face) => void onExtract(clip, face)}
            onTick={() => void onTick(clip)}
          />
        ))}
      </div>
    </div>
  );
}

function ClipStrip({
  project,
  clip,
  selected,
  busy,
  onSelect,
  onExtract,
  onTick,
}: {
  project: string;
  clip: LibraryClip;
  selected: { clipId: string; index: number } | null;
  busy: boolean;
  onSelect: (frame: LibraryFrame) => void;
  onExtract: (kind: "mouth" | "eyes") => void;
  onTick: () => void;
}) {
  const cats = mergeCategories();
  const label = cats.find((item) => item.id === clip.category)?.label || clip.category;
  const caption = clip.ticked
    ? actionShotCaption({ frames: clip.frameCount, still: clip.frameCount <= 1 })
    : "";
  return (
    <section className="studio-factory-library-clip" data-testid={`assets-library-clip-${clip.id}`}>
      <header>
        <strong>{clip.id}</strong>
        <span>
          {clip.kind} · {label} · {clip.frameCount} frames
        </span>
        {caption ? (
          <b className="studio-factory-shot-badge" data-testid={`assets-library-clip-badge-${clip.id}`}>
            {caption}
          </b>
        ) : null}
        {clip.warnings.length ? <em title={clip.warnings.join(" ")}>warning</em> : null}
      </header>
      <div className="studio-factory-library-clip-tools">
        <button type="button" data-testid={`assets-library-tick-${clip.id}`} disabled={busy || Boolean(clip.ticked)} onClick={onTick}>
          {clip.ticked ? "Ticked" : "Tick as Action Shot"}
        </button>
        {clip.kind === "head" ? (
          <>
            <button type="button" data-testid={`assets-library-extract-mouth-${clip.id}`} disabled={busy} onClick={() => onExtract("mouth")}>
              Extract mouths
            </button>
            <button type="button" data-testid={`assets-library-extract-eyes-${clip.id}`} disabled={busy} onClick={() => onExtract("eyes")}>
              Extract eyes
            </button>
          </>
        ) : null}
      </div>
      <div className="studio-factory-import-strip">
        {clip.frames.map((frame) => (
          <button
            key={frame.index}
            type="button"
            className="studio-factory-import-cell"
            data-active={selected && selected.clipId === clip.id && selected.index === frame.index ? "true" : "false"}
            data-testid={`assets-library-frame-${clip.id}-${frame.index}`}
            onClick={() => onSelect(frame)}
          >
            {frame.thumbRel || frame.rel ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={assetUrl(project, frame.thumbRel || frame.rel, { factory: true }) || undefined} alt="" />
            ) : null}
            <span>{String(frame.index).padStart(2, "0")}</span>
            {frame.issues && frame.issues.length ? <i>!</i> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
