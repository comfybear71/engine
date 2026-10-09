"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ASSET_NEEDS,
  expandNeed,
  fillNeedPrompt,
  getAssetNeed,
  type AssetNeed,
} from "@/lib/assetNeeds";
import {
  cancelCharacterIngest,
  confirmCharacterIngest,
  previewCharacterIngest,
  saveCharacterReference,
  saveCharacterStyle,
  type Character,
  type IngestPreview,
} from "@/lib/worker";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

export default function AssetImaginePanel({
  project,
  character,
  onChanged,
}: {
  project: string;
  character: Character;
  onChanged: () => void;
}) {
  const [needId, setNeedId] = useState<string>(ASSET_NEEDS[0]?.id || "mouth_sheet");
  const need = useMemo(() => getAssetNeed(needId) || ASSET_NEEDS[0], [needId]);
  const [frames, setFrames] = useState<number>(need?.frameParam?.default ?? 8);
  const [style, setStyle] = useState(character.style || "");
  const [styleSaved, setStyleSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [attachReference, setAttachReference] = useState(false);

  useEffect(() => {
    setStyle(character.style || "");
    setStyleSaved(false);
    setPreview(null);
    setError(null);
  }, [character.id, character.style]);

  useEffect(() => {
    if (need?.frameParam) setFrames(need.frameParam.default);
  }, [need]);

  const expanded = useMemo(() => (need ? expandNeed(need, frames) : null), [need, frames]);
  const isReferenceNeed = need?.id === "full_body_reference" || need?.dest?.kind === "reference" || need?.ingest === false;
  const prompt = useMemo(() => {
    if (!need) return "";
    const base = fillNeedPrompt(need, { name: character.display_name, style, frames });
    if (!attachReference) return base;
    return `${base} Match the attached full-body reference image for likeness, costume, proportions, pose, and crop.`;
  }, [need, character.display_name, style, frames, attachReference]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy. Select the prompt and copy it yourself.");
    }
  }

  async function onSaveStyle() {
    setBusy("Saving style…");
    setError(null);
    try {
      await saveCharacterStyle(project, character.id, style);
      setStyleSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save style");
    } finally {
      setBusy(null);
    }
  }

  const saveReferenceFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("Drop a PNG or JPEG. It is stored as-is, not cut out.");
        return;
      }
      setBusy("Saving reference…");
      setError(null);
      try {
        const imageBase64 = await fileToBase64(file);
        await saveCharacterReference(project, character.id, { imageBase64, filename: file.name });
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save reference");
      } finally {
        setBusy(null);
      }
    },
    [project, character.id, onChanged]
  );

  const ingestFile = useCallback(
    async (file: File) => {
      if (!need) return;
      if (!file.type.startsWith("image/")) {
        setError("Drop a PNG or JPEG from Grok Imagine.");
        return;
      }
      if (isReferenceNeed) {
        await saveReferenceFile(file);
        return;
      }
      setBusy("Cutting out…");
      setError(null);
      try {
        const imageBase64 = await fileToBase64(file);
        const result = await previewCharacterIngest(project, character.id, {
          needId: need.id,
          imageBase64,
          filename: file.name,
          frames: need.frameParam ? frames : undefined,
        });
        const initial: Record<number, string> = {};
        for (const cell of result.cells) initial[cell.index] = cell.suggestedName;
        setNames(initial);
        setPreview(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ingest failed");
      } finally {
        setBusy(null);
      }
    },
    [need, isReferenceNeed, saveReferenceFile, project, character.id, frames]
  );

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("textarea, input, select")) return;
      if (target && target.closest("[data-reference-drop]")) return;
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      event.preventDefault();
      void ingestFile(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ingestFile]);

  async function closePreview(cancel: boolean) {
    if (cancel && preview) {
      try {
        await cancelCharacterIngest(project, character.id, preview.sessionId);
      } catch {
        /* leftover preview dir is harmless */
      }
    }
    setPreview(null);
  }

  async function onConfirm() {
    if (!preview) return;
    setBusy("Saving drawings…");
    setError(null);
    try {
      await confirmCharacterIngest(project, character.id, {
        sessionId: preview.sessionId,
        assignments: preview.cells
          .filter((cell) => !cell.empty)
          .map((cell) => ({ index: cell.index, name: names[cell.index] || cell.suggestedName })),
      });
      setPreview(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirm failed");
    } finally {
      setBusy(null);
    }
  }

  if (!need) return null;

  return (
    <section className="rounded-md border border-studio-border bg-studio-panel p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Grok Imagine</h3>
          <p className="mt-1 text-sm text-neutral-300">
            Copy a prompt, generate in the browser, then drop the PNG onto {character.display_name}.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-studio-muted">
          Need
          <select
            className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
            value={need.id}
            onChange={(event) => setNeedId(event.target.value)}
            data-testid="asset-need"
          >
            {ASSET_NEEDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mb-3 text-[12px] text-studio-muted">{need.description}</p>

      {need.frameParam ? (
        <label className="mb-3 flex items-center gap-2 text-[11px] text-studio-muted">
          Frames per view
          <input
            type="number"
            min={need.frameParam.min}
            max={need.frameParam.max}
            value={frames}
            onChange={(event) => setFrames(Number(event.target.value))}
            className="w-16 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
          />
        </label>
      ) : null}

      <label className="mb-3 block text-[11px] text-studio-muted">
        Style notes
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            value={style}
            onChange={(event) => {
              setStyle(event.target.value);
              setStyleSaved(false);
            }}
            placeholder="painted semi-real, flat cartoon, …"
            className="min-w-0 flex-1 rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-xs text-neutral-200"
          />
          <button
            type="button"
            onClick={() => void onSaveStyle()}
            disabled={busy != null}
            className="rounded-md border border-studio-border px-2.5 py-1 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
          >
            {styleSaved ? "Saved" : "Save"}
          </button>
        </div>
      </label>

      <textarea
        readOnly
        value={prompt}
        rows={6}
        className="w-full resize-y rounded-md border border-studio-border bg-studio-raised px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-200"
        data-testid="asset-prompt"
      />
      <label className="mb-3 flex items-start gap-2 text-[12px] text-neutral-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={attachReference}
          onChange={(event) => setAttachReference(event.target.checked)}
          data-testid="attach-reference"
        />
        <span>
          Attach reference to prompt
          {attachReference ? (
            <span className="mt-1 block text-[11px] text-amber-200/90">
              {character.referenceRel
                ? "Attach this character's full-body reference in Grok Imagine (image input) before you generate."
                : "Save a full-body reference on the character panel, then attach that file in Grok Imagine before you generate."}
            </span>
          ) : null}
        </span>
      </label>

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void copyPrompt()}
          className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover"
          data-testid="copy-prompt"
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>
        <span className="text-[11px] text-studio-muted">
          {isReferenceNeed
            ? "stored original · no cut-out"
            : `${expanded?.grid ? `${expanded.grid.cols}×${expanded.grid.rows} grid` : "connected components"}${
                need.key === false ? " · no chroma key" : " · key #00FF00"
              }`}
        </span>
      </div>

      <DropZone
        dragging={dragging}
        setDragging={setDragging}
        disabled={busy != null}
        label={
          busy ||
          (isReferenceNeed
            ? `Drop or paste a full-body reference for ${character.display_name} (stored as-is)`
            : `Drop or paste a Grok Imagine image for ${need.label}`)
        }
        onFile={(file) => void ingestFile(file)}
      />

      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

      {preview ? (
        <PreviewModal
          need={need}
          preview={preview}
          names={names}
          setNames={setNames}
          busy={busy}
          onCancel={() => void closePreview(true)}
          onConfirm={() => void onConfirm()}
        />
      ) : null}
    </section>
  );
}

function DropZone({
  dragging,
  setDragging,
  disabled,
  label,
  onFile,
}: {
  dragging: boolean;
  setDragging: (value: boolean) => void;
  disabled: boolean;
  label: string;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={`mt-4 flex min-h-[88px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-4 text-center text-xs ${
        dragging ? "border-studio-accent bg-studio-accent/10 text-white" : "border-studio-border text-studio-muted"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      {label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </label>
  );
}

function PreviewModal({
  need,
  preview,
  names,
  setNames,
  busy,
  onCancel,
  onConfirm,
}: {
  need: AssetNeed;
  preview: IngestPreview;
  names: Record<number, string>;
  setNames: (next: Record<number, string>) => void;
  busy: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cols = preview.grid?.cols || 3;
  const choices = need.assignChoices;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-md border border-studio-border bg-studio-panel p-4 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Preview cut-out</h2>
            <p className="text-[11px] text-studio-muted">
              Rename or reassign a cell before confirming. Empty cells are skipped.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {preview.cells.map((cell) => (
            <div key={cell.index} className="space-y-1.5">
              <div className="studio-checker relative aspect-square overflow-hidden rounded-md border border-studio-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cell.pngBase64} alt={cell.suggestedName} className="h-full w-full object-contain" />
                {cell.empty ? (
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-neutral-300">
                    empty
                  </span>
                ) : null}
              </div>
              {choices && choices.length > 0 ? (
                <select
                  className="w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-[11px] text-neutral-200"
                  value={names[cell.index] || cell.suggestedName}
                  onChange={(event) => setNames({ ...names, [cell.index]: event.target.value })}
                  disabled={cell.empty}
                >
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                  {(names[cell.index] && !choices.includes(names[cell.index])) ||
                  !choices.includes(cell.suggestedName) ? (
                    <option value={names[cell.index] || cell.suggestedName}>
                      {names[cell.index] || cell.suggestedName}
                    </option>
                  ) : null}
                </select>
              ) : (
                <input
                  className="w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-[11px] text-neutral-200"
                  value={names[cell.index] || cell.suggestedName}
                  onChange={(event) => setNames({ ...names, [cell.index]: event.target.value })}
                  disabled={cell.empty}
                />
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            disabled={busy != null}
            onClick={onConfirm}
            data-testid="ingest-confirm"
          >
            {busy || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
