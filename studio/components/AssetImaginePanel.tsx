"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ASSET_NEEDS,
  expandNeed,
  fillNeedPrompt,
  getAssetNeed,
  type AssetNeed,
} from "@/lib/assetNeeds";
import { explainGenerateError, summarizeGenerateCost } from "@/lib/generateImage";
import { fillPackPrompt, ingestNeedId, packForCharacter } from "@/lib/promptPacks";
import {
  cancelCharacterIngest,
  confirmCharacterIngest,
  generateProjectImage,
  loadEngineSettings,
  previewCharacterIngest,
  saveCharacterReference,
  saveCharacterStyle,
  type Character,
  type GenerateImageResponse,
  type GeneratedImage,
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
  embedded = false,
  initialNeedId = null,
  onNeedId,
}: {
  project: string;
  character: Character;
  onChanged: () => void;
  embedded?: boolean;
  initialNeedId?: string | null;
  onNeedId?: (id: string | null) => void;
}) {
  const pack = useMemo(() => packForCharacter(character), [character]);
  const setOptions = pack ? pack.sets : ASSET_NEEDS;
  const [needId, setNeedId] = useState<string>(initialNeedId || setOptions[0]?.id || "mouth_sheet");
  const packSet = useMemo(() => pack?.sets.find((set) => set.id === needId) || pack?.sets[0] || null, [pack, needId]);
  const ingestId = packSet ? ingestNeedId(packSet) : needId;
  const need = useMemo(() => {
    const fromAssets = getAssetNeed(ingestId) || getAssetNeed(needId);
    if (fromAssets) return fromAssets;
    if (packSet) {
      return {
        id: packSet.id,
        label: packSet.label,
        description: packSet.description,
        split: packSet.split || "grid",
        grid: packSet.grid,
        cells: packSet.cells?.filter((cell) => cell.dest) as AssetNeed["cells"],
        assignChoices: packSet.assignChoices,
        prompt: packSet.prompt,
      } as AssetNeed;
    }
    return ASSET_NEEDS[0];
  }, [ingestId, needId, packSet]);
  const [frames, setFrames] = useState<number>(need?.frameParam?.default ?? 8);
  const [style, setStyle] = useState(character.style || "");
  const [styleSaved, setStyleSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [attachReference, setAttachReference] = useState(true);
  const [variants, setVariants] = useState(2);
  const [costNote, setCostNote] = useState<string | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    setStyle(character.style || "");
    setStyleSaved(false);
    setPreview(null);
    setError(null);
    setResults([]);
    setPicked(null);
    const nextPack = packForCharacter(character);
    const first = nextPack?.sets[0]?.id || ASSET_NEEDS[0]?.id || "mouth_sheet";
    const match = initialNeedId
      ? (nextPack?.sets || ASSET_NEEDS).find((set) => set.id === initialNeedId || ("needId" in set && set.needId === initialNeedId))
      : null;
    setNeedId(match?.id || first);
  }, [character.id, character.style, initialNeedId]);

  useEffect(() => {
    if (need?.frameParam) setFrames(need.frameParam.default);
  }, [need]);

  const expanded = useMemo(() => (need ? expandNeed(need, frames) : null), [need, frames]);
  const isReferenceNeed =
    ingestId === "full_body_reference" || need?.id === "full_body_reference" || need?.dest?.kind === "reference" || need?.ingest === false;
  const prompt = useMemo(() => {
    if (pack && packSet) {
      return fillPackPrompt(packSet, { name: character.display_name, styleBlock: pack.styleBlock });
    }
    if (!need) return "";
    const base = fillNeedPrompt(need, { name: character.display_name, style, frames });
    if (!attachReference) return base;
    return `${base} Match the attached full-body reference image for likeness, costume, proportions, pose, and crop.`;
  }, [pack, packSet, need, character.display_name, style, frames, attachReference]);

  useEffect(() => {
    let cancelled = false;
    loadEngineSettings()
      .then((settings) => {
        if (!cancelled) setKeyConfigured(settings.xaiKeyConfigured);
      })
      .catch(() => {
        if (!cancelled) setKeyConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  useEffect(() => {
    let cancelled = false;
    generateProjectImage({
      project,
      characterId: character.id,
      needId: ingestId,
      n: variants,
      prompt,
      frames: need?.frameParam ? frames : undefined,
      dryRun: true,
    })
      .then((result) => {
        if (cancelled) return;
        const summary = summarizeGenerateCost(result);
        setCostNote(summary.creditNote);
        setKeyConfigured(result.keyConfigured);
      })
      .catch(() => {
        if (!cancelled) setCostNote("This uses xAI credits.");
      });
    return () => {
      cancelled = true;
    };
  }, [project, character.id, ingestId, variants, prompt, need?.frameParam, frames]);

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

  const ingestBase64 = useCallback(
    async (imageBase64: string, filename: string) => {
      if (isReferenceNeed) {
        setBusy("Saving reference…");
        setError(null);
        try {
          await saveCharacterReference(project, character.id, { imageBase64, filename });
          onChanged();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save reference");
        } finally {
          setBusy(null);
        }
        return;
      }
      setBusy("Cutting out…");
      setError(null);
      try {
        const result = await previewCharacterIngest(project, character.id, {
          needId: ingestId,
          imageBase64,
          filename,
          frames: need?.frameParam ? frames : undefined,
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
    [isReferenceNeed, project, character.id, onChanged, ingestId, need, frames]
  );

  const ingestFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("Drop a PNG or JPEG from Grok Imagine.");
        return;
      }
      if (isReferenceNeed) {
        await saveReferenceFile(file);
        return;
      }
      try {
        const imageBase64 = await fileToBase64(file);
        await ingestBase64(imageBase64, file.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ingest failed");
      }
    },
    [isReferenceNeed, saveReferenceFile, ingestBase64]
  );

  async function onGenerate() {
    setBusy("Generating…");
    setError(null);
    setResults([]);
    setPicked(null);
    try {
      const result: GenerateImageResponse = await generateProjectImage({
        project,
        characterId: character.id,
        needId: ingestId,
        n: variants,
        prompt,
        frames: need?.frameParam ? frames : undefined,
      });
      setResults(result.images || []);
      setCostNote(summarizeGenerateCost(result).creditNote);
      setKeyConfigured(result.keyConfigured);
    } catch (err) {
      setError(explainGenerateError(err instanceof Error ? err.message : "Generate failed"));
    } finally {
      setBusy(null);
    }
  }

  async function onPickGenerated(image: GeneratedImage) {
    setPicked(image.index);
    await ingestBase64(image.imageBase64, `${ingestId}_${image.index + 1}.png`);
  }

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
    <section className={embedded ? "" : "rounded-md border border-studio-border bg-studio-panel p-4"}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          {embedded ? null : (
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Grok Imagine</h3>
          )}
          <p className={`${embedded ? "" : "mt-1 "}text-sm text-neutral-300`}>
            {pack
              ? `Prompt pack for ${character.display_name}. Generate in-app, or still drop a PNG.`
              : `Copy a prompt or Generate in-app, then cut out onto ${character.display_name}.`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-studio-muted">
          {pack ? "Set" : "Need"}
          <select
            className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
            value={needId}
            onChange={(event) => {
              setNeedId(event.target.value);
              onNeedId?.(event.target.value);
              setResults([]);
              setPicked(null);
            }}
            data-testid="asset-need"
          >
            {pack
              ? pack.sets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              : ASSET_NEEDS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
          </select>
        </label>
      </div>

      <p className="mb-3 text-[12px] text-studio-muted">{packSet?.description || need.description}</p>

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

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void copyPrompt()}
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200 hover:text-white"
            data-testid="copy-prompt"
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-studio-muted">
            Variants
            <select
              className="rounded-md border border-studio-border bg-studio-raised px-1.5 py-1 text-xs text-neutral-200"
              value={variants}
              onChange={(event) => setVariants(Number(event.target.value))}
              data-testid="generate-n"
            >
              {[1, 2, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={busy != null}
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            data-testid="generate-image"
          >
            {busy === "Generating…" ? "Generating…" : "Generate"}
          </button>
        </div>
        <span className="text-[11px] text-studio-muted">
          {isReferenceNeed
            ? "stored original · no cut-out"
            : `${expanded?.grid ? `${expanded.grid.cols}×${expanded.grid.rows} grid` : packSet?.grid ? `${packSet.grid.cols}×${packSet.grid.rows} grid` : "connected components"}${
                need?.key === false ? " · no chroma key" : " · key #00FF00"
              }`}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-studio-muted" data-testid="generate-cost">
        {costNote || "This uses xAI credits."}
        {keyConfigured === false ? " xAI key is not set — open Settings." : ""}
        {character.referenceRel || character.bodyRel
          ? " Reference and body images are attached when present."
          : ""}
      </p>

      {results.length > 0 ? (
        <div className="mt-3 space-y-2" data-testid="generate-results">
          <p className="text-[11px] text-studio-muted">Pick one to cut out and preview. Confirm still saves into the slot folder.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {results.map((image) => (
              <button
                key={image.index}
                type="button"
                onClick={() => void onPickGenerated(image)}
                disabled={busy != null}
                className={`studio-checker overflow-hidden rounded-md border ${
                  picked === image.index ? "border-studio-accent ring-2 ring-studio-accent/40" : "border-studio-border"
                }`}
                data-testid={`generate-pick-${image.index}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.imageBase64} alt={`Variant ${image.index + 1}`} className="aspect-square w-full object-contain" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

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
