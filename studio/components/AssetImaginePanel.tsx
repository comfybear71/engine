"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_NEEDS,
  expandNeed,
  fillNeedPrompt,
  getAssetNeed,
  type AssetNeed,
} from "@/lib/assetNeeds";
import { explainGenerateError, summarizeGenerateCost } from "@/lib/generateImage";
import {
  CUSTOM_MOUTH_NAMES,
  CUSTOM_NEED_ID,
  composeCustomPrompt,
  customCellName,
  customSlotChoices,
  fillPackPrompt,
  ingestNeedId,
  packForCharacter,
  resolveImagineNeedId,
} from "@/lib/promptPacks";
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
  const setOptions = pack ? pack.sets : ASSET_NEEDS.filter((need) => need.id !== CUSTOM_NEED_ID);
  const [needId, setNeedId] = useState<string>(initialNeedId || setOptions[0]?.id || "mouth_sheet");
  const isCustom = needId === CUSTOM_NEED_ID;
  const packSet = useMemo(
    () => (isCustom ? null : pack?.sets.find((set) => set.id === needId) || (initialNeedId ? null : pack?.sets[0]) || null),
    [pack, needId, isCustom, initialNeedId]
  );
  const slotChoices = useMemo(() => customSlotChoices(character), [character]);
  const [customCols, setCustomCols] = useState(5);
  const [customRows, setCustomRows] = useState(3);
  const [customSlotKey, setCustomSlotKey] = useState("mouth:mouth");
  const customDest = useMemo(() => {
    const found = slotChoices.find((item) => `${item.slot}:${item.drawings_dir}` === customSlotKey) || slotChoices[0];
    return { kind: "slot" as const, slot: found.slot, drawings_dir: found.drawings_dir };
  }, [slotChoices, customSlotKey]);
  const customGrid = useMemo(() => ({ cols: customCols, rows: customRows }), [customCols, customRows]);
  const ingestId = isCustom ? CUSTOM_NEED_ID : packSet ? ingestNeedId(packSet) : needId;
  const need = useMemo(() => {
    if (isCustom) {
      const count = Math.max(1, customGrid.cols * customGrid.rows);
      const cells = Array.from({ length: count }, (_, index) => ({
        name: customCellName(index, customDest.slot),
        dest: customDest,
      }));
      return {
        id: CUSTOM_NEED_ID,
        label: "Custom",
        description:
          "Paste your own sheet prompt. The character style block is prepended. Choose a grid and target slot for the cut-out.",
        split: "grid" as const,
        grid: customGrid,
        cells,
        assignChoices: customDest.slot === "mouth" ? [...CUSTOM_MOUTH_NAMES] : cells.map((cell) => cell.name),
        dest: customDest,
        prompt: "",
      } as AssetNeed;
    }
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
  }, [isCustom, ingestId, needId, packSet, customGrid, customDest]);
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
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [promptDraft, setPromptDraft] = useState("");
  const promptSeedKey = useRef("");

  useEffect(() => {
    setStyle(character.style || "");
    setStyleSaved(false);
    setPreview(null);
    setError(null);
    setResults([]);
    setPicked(null);
    setConfirmed([]);
    const nextPack = packForCharacter(character);
    const sets = nextPack?.sets || ASSET_NEEDS.filter((item) => item.id !== CUSTOM_NEED_ID);
    setNeedId(resolveImagineNeedId(sets, initialNeedId));
  }, [character.id, character.style, initialNeedId]);

  useEffect(() => {
    if (need?.frameParam) setFrames(need.frameParam.default);
  }, [need]);

  const expanded = useMemo(() => (need ? expandNeed(need, frames) : null), [need, frames]);
  const isReferenceNeed =
    ingestId === "full_body_reference" || need?.id === "full_body_reference" || need?.dest?.kind === "reference" || need?.ingest === false;
  const promptSeed = useMemo(() => {
    if (isCustom) return "";
    if (pack && packSet) {
      return fillPackPrompt(packSet, { name: character.display_name, styleBlock: pack.styleBlock });
    }
    if (!need) return "";
    const base = fillNeedPrompt(need, { name: character.display_name, style, frames });
    if (!attachReference) return base;
    return `${base} Match the attached full-body reference image for likeness, costume, proportions, pose, and crop.`;
  }, [isCustom, pack, packSet, need, character.display_name, style, frames, attachReference]);

  const stylePrefix = (pack?.styleBlock || character.style || "").trim();
  const generatePrompt = isCustom ? composeCustomPrompt(stylePrefix, promptDraft) : promptDraft;

  useEffect(() => {
    const key = `${character.id}:${needId}`;
    if (promptSeedKey.current === key) return;
    promptSeedKey.current = key;
    setPromptDraft(isCustom ? "" : promptSeed);
  }, [character.id, needId, isCustom, promptSeed]);

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
      prompt: generatePrompt,
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
  }, [project, character.id, ingestId, variants, generatePrompt, need?.frameParam, frames]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(generatePrompt);
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

  function applyPreview(result: IngestPreview, keepNames = false) {
    const next: Record<number, string> = keepNames ? { ...names } : {};
    for (const cell of result.cells) {
      if (!keepNames || !next[cell.index]) next[cell.index] = cell.suggestedName;
    }
    setNames(next);
    setPreview(result);
  }

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
          ...(isCustom ? { grid: customGrid, dest: customDest } : {}),
        });
        applyPreview(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ingest failed");
      } finally {
        setBusy(null);
      }
    },
    [isReferenceNeed, project, character.id, onChanged, ingestId, need, frames, isCustom, customGrid, customDest]
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
    setConfirmed([]);
    try {
      const result: GenerateImageResponse = await generateProjectImage({
        project,
        characterId: character.id,
        needId: ingestId,
        n: variants,
        prompt: generatePrompt,
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

  async function recutPreview(grid: { cols: number; rows: number }) {
    if (!preview) return;
    setBusy("Re-cutting…");
    setError(null);
    try {
      const result = await previewCharacterIngest(project, character.id, {
        needId: ingestId,
        sessionId: preview.sessionId,
        grid,
        frames: need?.frameParam ? frames : undefined,
        ...(isCustom ? { dest: customDest } : {}),
      });
      applyPreview(result, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-cut failed");
    } finally {
      setBusy(null);
    }
  }

  async function onConfirm(opts?: { flipAll?: boolean }) {
    if (!preview) return;
    setBusy("Saving drawings…");
    setError(null);
    try {
      await confirmCharacterIngest(project, character.id, {
        sessionId: preview.sessionId,
        assignments: preview.cells
          .filter((cell) => !cell.empty)
          .map((cell) => ({ index: cell.index, name: names[cell.index] || cell.suggestedName })),
        flipAll: Boolean(opts?.flipAll),
      });
      if (picked != null) {
        setConfirmed((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
      }
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
              setConfirmed([]);
            }}
            data-testid="asset-need"
          >
            {setOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
            <option value={CUSTOM_NEED_ID}>Custom</option>
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

      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-studio-muted">Prompt</span>
        <button
          type="button"
          className="text-[11px] text-studio-muted underline-offset-2 hover:text-white hover:underline"
          onClick={() => setPromptDraft(isCustom ? "" : promptSeed)}
          data-testid="reset-prompt"
        >
          {isCustom ? "Clear" : "Reset to pack prompt"}
        </button>
      </div>
      {isCustom && stylePrefix ? (
        <p className="mb-1 text-[10px] leading-snug text-neutral-500" data-testid="custom-style-prepend">
          Style block prepended on Generate.
        </p>
      ) : null}
      <textarea
        value={promptDraft}
        onChange={(event) => setPromptDraft(event.target.value)}
        rows={6}
        placeholder={isCustom ? "Paste your sheet prompt…" : undefined}
        className="w-full resize-y rounded-md border border-studio-border bg-studio-raised px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-200"
        data-testid="asset-prompt"
      />
      {isCustom ? (
        <div className="mt-2 mb-3 flex flex-wrap items-center gap-2 text-[11px] text-studio-muted">
          <span>Cut-out grid</span>
          <input
            type="number"
            min={1}
            max={16}
            className="w-12 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-[11px] text-neutral-200"
            value={customCols}
            onChange={(event) => setCustomCols(Math.max(1, Math.min(16, Number(event.target.value) || 1)))}
            data-testid="custom-grid-cols"
          />
          <span>cols ×</span>
          <input
            type="number"
            min={1}
            max={16}
            className="w-12 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-[11px] text-neutral-200"
            value={customRows}
            onChange={(event) => setCustomRows(Math.max(1, Math.min(16, Number(event.target.value) || 1)))}
            data-testid="custom-grid-rows"
          />
          <span>rows</span>
          <span className="text-studio-border">·</span>
          <span>Slot</span>
          <select
            className="rounded-md border border-studio-border bg-studio-raised px-1.5 py-0.5 text-[11px] text-neutral-200"
            value={customSlotKey}
            onChange={(event) => setCustomSlotKey(event.target.value)}
            data-testid="custom-slot"
          >
            {slotChoices.map((item) => (
              <option key={`${item.slot}:${item.drawings_dir}`} value={`${item.slot}:${item.drawings_dir}`}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
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
          <p className="text-[11px] text-studio-muted">
            Pick a sheet to cut out. Confirm adds its drawings (existing names get _b, _c). You can confirm more than one.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {results.map((image) => (
              <button
                key={image.index}
                type="button"
                onClick={() => void onPickGenerated(image)}
                disabled={busy != null}
                className={`studio-checker relative overflow-hidden rounded-md border ${
                  picked === image.index ? "border-studio-accent ring-2 ring-studio-accent/40" : "border-studio-border"
                }`}
                data-testid={`generate-pick-${image.index}`}
                data-confirmed={confirmed.includes(image.index) ? "true" : "false"}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.imageBase64} alt={`Variant ${image.index + 1}`} className="aspect-square w-full object-contain" />
                {confirmed.includes(image.index) ? (
                  <span
                    className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-studio-accent"
                    data-testid={`generate-confirmed-${image.index}`}
                  >
                    Confirmed
                  </span>
                ) : null}
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
          onConfirm={(opts) => void onConfirm(opts)}
          onRecut={(grid) => void recutPreview(grid)}
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
  onRecut,
}: {
  need: AssetNeed;
  preview: IngestPreview;
  names: Record<number, string>;
  setNames: (next: Record<number, string>) => void;
  busy: string | null;
  onCancel: () => void;
  onConfirm: (opts?: { flipAll?: boolean }) => void;
  onRecut: (grid: { cols: number; rows: number }) => void;
}) {
  const cols = preview.grid?.cols || 3;
  const choices = need.assignChoices;
  const [flipAll, setFlipAll] = useState(false);
  const [recutCols, setRecutCols] = useState(preview.grid?.cols || 5);
  const [recutRows, setRecutRows] = useState(preview.grid?.rows || 3);
  useEffect(() => {
    setRecutCols(preview.grid?.cols || 5);
    setRecutRows(preview.grid?.rows || 3);
  }, [preview.sessionId, preview.grid?.cols, preview.grid?.rows]);
  const emptyCount = preview.cells.filter(
    (cell) => (cell.empty || cell.warning === "empty") && !/^empty\d*$/i.test(cell.suggestedName)
  ).length;
  const sizeCount = preview.cells.filter((cell) => cell.warning === "small" || cell.warning === "large").length;
  const warningLines =
    preview.warnings && preview.warnings.length > 0
      ? preview.warnings
      : [
          emptyCount ? `${emptyCount} empty cell${emptyCount === 1 ? "" : "s"}` : "",
          sizeCount ? `${sizeCount} cell${sizeCount === 1 ? "" : "s"} much larger or smaller than the others` : "",
        ].filter(Boolean);
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
        {warningLines.length > 0 ? (
          <div
            className="mb-3 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-100"
            data-testid="ingest-cutout-warnings"
          >
            <p className="font-semibold">Cut-out looks uneven — reassign cells or re-cut as a grid.</p>
            <ul className="mt-1 list-disc pl-4">
              {warningLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {preview.cells.map((cell) => (
            <div key={cell.index} className="space-y-1.5">
              <div className="studio-checker relative aspect-square overflow-hidden rounded-md border border-studio-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cell.pngBase64 || undefined}
                  alt={cell.suggestedName}
                  className="h-full w-full object-contain"
                  style={flipAll ? { transform: "scaleX(-1)" } : undefined}
                />
                {cell.empty || cell.warning === "empty" ? (
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-neutral-300">
                    empty
                  </span>
                ) : null}
                {cell.warning === "small" || cell.warning === "large" ? (
                  <span className="absolute top-1 left-1 rounded bg-amber-800/90 px-1 py-0.5 text-[10px] text-amber-50">
                    {cell.warning === "small" ? "tiny crop" : "huge crop"}
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
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <div className="mr-auto flex flex-wrap items-center gap-1.5 text-[11px] text-studio-muted">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={flipAll}
                onChange={(event) => setFlipAll(event.target.checked)}
                data-testid="ingest-flip-all"
              />
              Flip all in this sheet
            </label>
            <span className="text-studio-border">·</span>
            <span>Re-cut as grid</span>
            <input
              type="number"
              min={1}
              max={16}
              className="w-12 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-[11px] text-neutral-200"
              value={recutCols}
              onChange={(event) => setRecutCols(Math.max(1, Math.min(16, Number(event.target.value) || 1)))}
              data-testid="ingest-recut-cols"
            />
            <span>cols ×</span>
            <input
              type="number"
              min={1}
              max={16}
              className="w-12 rounded border border-studio-border bg-studio-raised px-1 py-0.5 text-[11px] text-neutral-200"
              value={recutRows}
              onChange={(event) => setRecutRows(Math.max(1, Math.min(16, Number(event.target.value) || 1)))}
              data-testid="ingest-recut-rows"
            />
            <span>rows</span>
            <button
              type="button"
              className="rounded-md border border-studio-border px-2 py-0.5 text-[11px] text-neutral-200 hover:text-white disabled:opacity-40"
              disabled={busy != null}
              onClick={() => onRecut({ cols: recutCols, rows: recutRows })}
              data-testid="ingest-recut"
            >
              Re-cut
            </button>
          </div>
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
            onClick={() => onConfirm({ flipAll })}
            data-testid="ingest-confirm"
          >
            {busy || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
