"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FACTORY_FRAMES,
  assembleHiddenPrompt,
  clampFactoryFrames,
  factoryHint,
  factoryPlaceholder,
  factoryUsesFrames,
  inferFactoryIntent,
  type FactoryFrames,
  type FactoryModeKind,
} from "@/lib/factoryPrompt";
import {
  buildFactoryImportMp4,
  factoryPreviewUrl,
  factoryStripUrl,
  importFactoryMp4,
  importStillAsset,
  redoFactoryJob,
  startFactoryJob,
  tickFactoryJob,
  type Character,
  type FactoryJob,
} from "@/lib/worker";
import { fileToPngBase64 } from "@/lib/assetEditor";

const UPLOAD_KIND = { "new-character": "character", prop: "prop", background: "background" } as const;
const UPLOAD_LABEL = { "new-character": "character", prop: "prop", background: "background" } as const;
const UPLOAD_PAGE = { "new-character": "Characters", prop: "Props", background: "Backgrounds" } as const;

export default function FactoryPanel({
  project,
  mode = "character",
  character = null,
  slot = null,
  view = null,
  label = null,
  onChanged,
}: {
  project: string;
  mode?: FactoryModeKind;
  character?: Character | null;
  slot?: string | null;
  view?: string | null;
  label?: string | null;
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [frames, setFrames] = useState<FactoryFrames>(8);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedPrompt, setAdvancedPrompt] = useState("");
  const [advancedTouched, setAdvancedTouched] = useState(false);
  const [useGrok, setUseGrok] = useState(false);
  const [useRigWalk, setUseRigWalk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<FactoryJob | null>(null);
  const [walkJobs, setWalkJobs] = useState<FactoryJob[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);

  const uploadMode = mode === "new-character" || mode === "prop" || mode === "background" ? mode : null;
  const showFrames = factoryUsesFrames(mode);
  const hint = factoryHint(mode, { character, slot, label });
  const placeholder = factoryPlaceholder(mode, { character, slot, label });
  const canImport = mode === "character" && Boolean(character);
  const importJob = Boolean(job?.usedImport);
  const thumbs = job?.importMp4?.thumbs || [];
  const steady = job?.importMp4?.steady;
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedDirty =
    importJob &&
    JSON.stringify([...(job?.importMp4?.selected || [])].sort((a, b) => a - b)) !==
      JSON.stringify([...selectedKeys].sort((a, b) => a - b));

  const assembled = useMemo(
    () =>
      assembleHiddenPrompt({
        mode,
        character: character || undefined,
        userPrompt: prompt,
        frames,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
        slot,
        view,
        label,
        name,
      }),
    [mode, character, prompt, frames, advancedPrompt, advancedTouched, slot, view, label, name]
  );

  useEffect(() => {
    if (job?.importMp4?.selected) setSelectedKeys(job.importMp4.selected.slice());
  }, [job?.jobId, (job?.importMp4?.selected || []).join(",")]);

  function jobOwner(current: FactoryJob | null): string {
    return current?.characterId || character?.id || "project";
  }

  function walkFlags(text: string) {
    const walkIntent = mode === "character" && inferFactoryIntent(text).kind === "walk";
    return {
      walkIntent,
      walkSet: walkIntent && useRigWalk && !useGrok,
      useRigWalk: walkIntent && useRigWalk && !useGrok,
      useGrok: walkIntent && useGrok,
    };
  }

  async function onUploadFile(file: File | undefined) {
    if (uploadRef.current) uploadRef.current.value = "";
    if (!file || !uploadMode) return;
    if (!file.type.startsWith("image/")) {
      setError("Pick a PNG or JPEG image.");
      return;
    }
    setBusy("Uploading…");
    setError(null);
    setUploadMessage(null);
    try {
      const imageBase64 = await fileToPngBase64(file);
      const result = await importStillAsset(project, {
        kind: UPLOAD_KIND[uploadMode],
        name: name.trim() || file.name,
        imageBase64,
        removeBackground: uploadMode !== "background" && removeBg,
      });
      setUploadMessage(`Added ${result.id} to ${UPLOAD_PAGE[uploadMode]}.`);
      if (uploadMode === "new-character") setName("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function onGenerate() {
    if (!prompt.trim()) {
      setError(hint);
      return;
    }
    if (mode === "character" && !character) {
      setError("Pick a character first.");
      return;
    }
    if (mode === "slot" && (!character || !slot)) {
      setError("Open a slot on a character first.");
      return;
    }
    const flags = walkFlags(prompt.trim());
    if (flags.walkIntent && !flags.useGrok && !flags.useRigWalk) {
      setError("Import an MP4 of the walk (Factory → Import MP4), or open Advanced to use Grok Imagine or the parked rig long-stride path.");
      return;
    }
    setBusy("Generating…");
    setError(null);
    try {
      const result = await startFactoryJob(project, {
        mode,
        characterId: character?.id,
        slot: slot || undefined,
        view: view || undefined,
        label: label || undefined,
        name: mode === "new-character" ? name.trim() : undefined,
        prompt: prompt.trim(),
        frames: showFrames ? frames : 1,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
        walkSet: flags.walkSet,
        useGrok: flags.useGrok,
        useRigWalk: flags.useRigWalk,
      });
      if (result.walkSet && result.jobs && result.jobs.length) {
        setWalkJobs(result.jobs);
        setJob(result.jobs[0]);
      } else {
        setWalkJobs([]);
        setJob(result);
      }
      if (result.warnings?.length) setError(result.warnings.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
    } finally {
      setBusy(null);
    }
  }

  async function onImportFile(file: File | undefined) {
    if (!file) return;
    if (!character) {
      setError("Pick a character first.");
      return;
    }
    setBusy("Importing…");
    setError(null);
    try {
      const result = await importFactoryMp4(project, {
        characterId: character.id,
        file,
        prompt: prompt.trim() || file.name.replace(/\.[^.]+$/, ""),
        frames,
        view: view || undefined,
      });
      setWalkJobs([]);
      setJob(result);
      setSelectedKeys((result.importMp4?.selected || []).slice());
      if (result.warnings?.length) setError(result.warnings.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import MP4 failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function rebuildImport(indices: number[], count: FactoryFrames) {
    if (!job) return;
    if (indices.length < 2) {
      setError("Tick at least two key frames in the strip.");
      return;
    }
    setBusy("Generating…");
    setError(null);
    try {
      const result = await buildFactoryImportMp4(project, jobOwner(job), job.jobId, {
        indices,
        frames: count,
      });
      setJob(result);
      setSelectedKeys((result.importMp4?.selected || indices).slice());
      if (result.warnings?.length) setError(result.warnings.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rebuild failed");
    } finally {
      setBusy(null);
    }
  }

  function toggleKey(index: number) {
    setSelectedKeys((prev) => {
      const next = prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index].sort((a, b) => a - b);
      return next;
    });
  }

  function onFramesChange(count: FactoryFrames) {
    setFrames(count);
    if (job?.usedImport) {
      const suggested = job.importMp4?.suggested?.[String(count)];
      if (suggested && suggested.length >= 2) {
        setSelectedKeys(suggested.slice());
        void rebuildImport(suggested, count);
      }
    }
  }

  async function onTick() {
    if (!job) return;
    setBusy("Saving…");
    setError(null);
    try {
      const targets = walkJobs.length ? walkJobs : [job];
      let last = job;
      for (const item of targets) {
        last = await tickFactoryJob(project, jobOwner(item), item.jobId);
      }
      setJob(last);
      setWalkJobs(walkJobs.map((item) => ({ ...item, ticked: true })));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tick failed");
    } finally {
      setBusy(null);
    }
  }

  async function onRedo() {
    if (job?.usedImport) {
      fileRef.current?.click();
      return;
    }
    if (!job || (walkJobs.length > 1 && !useGrok)) {
      void onGenerate();
      return;
    }
    setBusy("Generating…");
    setError(null);
    try {
      const result = await redoFactoryJob(project, jobOwner(job), job.jobId, {
        prompt: prompt.trim() || job.prompt,
        frames: showFrames ? frames : 1,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
        useGrok,
        useRigWalk,
      });
      setJob(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Redo failed");
    } finally {
      setBusy(null);
    }
  }

  const preview = job ? factoryPreviewUrl(project, jobOwner(job), job.jobId) : null;
  const previewIsImage = Boolean(job && (job.previewKind === "image" || /\.png$/i.test(job.previewRel || "")));
  const tickedMessage =
    mode === "prop"
      ? "Ticked. The prop is on the Props page."
      : mode === "background"
        ? "Ticked. The background is on the Backgrounds page."
        : mode === "new-character"
          ? `Ticked. ${job?.actionId || "Character"} is in Characters, ready for rig pieces.`
          : mode === "slot"
            ? `Ticked. Saved as a draft in ${label || slot}.`
            : `Ticked. ${job?.actionId} is in the character library and Action Shots.`;

  return (
    <section data-testid="factory-panel" data-mode={mode}>
      <p className="mb-3 text-sm text-neutral-300">{hint}</p>
      {mode === "new-character" ? (
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] text-studio-muted">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Grumpy old barman"
            className="w-full rounded-md border border-studio-border bg-studio-raised px-3 py-2 text-sm text-neutral-100"
            data-testid="factory-name"
          />
        </label>
      ) : null}
      {uploadMode ? (
        <div
          className="mb-3 rounded-md border border-studio-border bg-studio-raised/40 px-3 py-2"
          data-testid="factory-upload"
        >
          <p className="mb-2 text-[11px] text-studio-muted">
            Already have the image? Upload it instead of generating (JPEGs are converted to PNG).
            {uploadMode === "new-character"
              ? " It becomes the new character's reference picture. Type a name first, or the file name is used."
              : ""}
          </p>
          {uploadMode !== "background" ? (
            <label className="mb-2 flex items-start gap-2 text-xs text-neutral-200">
              <input
                type="checkbox"
                checked={removeBg}
                onChange={(event) => setRemoveBg(event.target.checked)}
                className="mt-0.5"
                data-testid="factory-upload-remove-bg"
              />
              <span>
                Make the background transparent and remove the Grok watermark. Works on a plain black, white or
                single-colour backdrop; skipped if the PNG is already transparent.
              </span>
            </label>
          ) : null}
          <input
            ref={uploadRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid="factory-upload-file"
            onChange={(event) => void onUploadFile(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => uploadRef.current?.click()}
            disabled={busy != null}
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs font-semibold text-neutral-100 hover:text-white disabled:opacity-40"
            data-testid="factory-upload-button"
          >
            {busy === "Uploading…" ? "Uploading…" : `Upload ${UPLOAD_LABEL[uploadMode]} image`}
          </button>
          {uploadMessage ? (
            <p className="mt-2 text-xs text-emerald-400" data-testid="factory-upload-message">
              {uploadMessage}
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="mb-3 block">
        <span className="sr-only">Prompt</span>
        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-studio-border bg-studio-raised px-3 py-2 text-sm text-neutral-100"
          data-testid="factory-prompt"
        />
      </label>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {showFrames ? (
          <>
            <span className="text-[11px] text-studio-muted">Frames</span>
            {FACTORY_FRAMES.map((count) => (
              <label key={count} className="flex items-center gap-1.5 text-xs text-neutral-200">
                <input
                  type="radio"
                  name="factory-frames"
                  checked={frames === count}
                  onChange={() => onFramesChange(clampFactoryFrames(count))}
                  data-testid={`factory-frames-${count}`}
                />
                {count}
              </label>
            ))}
          </>
        ) : null}
        <button
          type="button"
          onClick={() => void onGenerate()}
          disabled={busy != null}
          className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
          data-testid="factory-generate"
        >
          {busy === "Generating…" ? "Generating…" : "Generate"}
        </button>
        {canImport ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/*"
              className="hidden"
              data-testid="factory-import-file"
              onChange={(event) => void onImportFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy != null}
              className="rounded-md border border-studio-border px-3 py-1.5 text-xs font-semibold text-neutral-100 hover:text-white disabled:opacity-40"
              data-testid="factory-import-mp4"
            >
              {busy === "Importing…" ? "Importing…" : "Import MP4"}
            </button>
          </>
        ) : null}
      </div>

      <details
        className="mb-3 rounded-md border border-studio-border bg-studio-raised/40 px-3 py-2"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
        data-testid="factory-advanced"
      >
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-studio-muted">
          Advanced
        </summary>
        <p className="mt-2 text-[11px] text-studio-muted">
          Hidden pack for this project only. Walks use Import MP4 (no API). Grok Imagine and the parked rig long-stride
          path stay here, off by default.
        </p>
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={useGrok}
            onChange={(event) => setUseGrok(event.target.checked)}
            data-testid="factory-use-grok"
          />
          Use Grok Imagine for walks (costs credits)
        </label>
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={useRigWalk}
            onChange={(event) => setUseRigWalk(event.target.checked)}
            data-testid="factory-use-rig-walk"
          />
          Parked: build from ticked walk_side frames (rig long-stride)
        </label>
        <textarea
          value={advancedTouched ? advancedPrompt : assembled}
          onChange={(event) => {
            setAdvancedTouched(true);
            setAdvancedPrompt(event.target.value);
          }}
          rows={6}
          className="mt-2 w-full resize-y rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-200"
          data-testid="factory-advanced-prompt"
        />
      </details>

      {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

      <div className="min-h-[160px] rounded-md border border-studio-border bg-black/40 p-3" data-testid="factory-results">
        {job ? (
          <div className="space-y-3">
            {importJob && thumbs.length && !job.ticked ? (
              <div data-testid="factory-import-strip">
                <p className="mb-1 text-[11px] text-studio-muted">
                  Tick clean keys through one gait cycle. Dim frames are the intro stand/turn.
                </p>
                <div className="studio-factory-import-strip">
                  {thumbs.map((thumb) => {
                    const inSteady =
                      !steady || (thumb.index >= (steady.start || 0) && thumb.index < (steady.end || thumbs.length));
                    const checked = selectedSet.has(thumb.index);
                    const name = String(thumb.rel || "").split("/").pop() || `frame_${String(thumb.index).padStart(4, "0")}.png`;
                    return (
                      <label
                        key={thumb.index}
                        className="studio-factory-import-cell"
                        data-selected={checked ? "true" : "false"}
                        data-steady={inSteady ? "true" : "false"}
                        data-testid={`factory-import-key-${thumb.index}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy != null}
                          onChange={() => toggleKey(thumb.index)}
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={factoryStripUrl(project, jobOwner(job), job.jobId, name)} alt="" />
                        <span>{String(thumb.index).padStart(2, "0")}</span>
                      </label>
                    );
                  })}
                </div>
                {selectedDirty ? (
                  <button
                    type="button"
                    onClick={() => void rebuildImport(selectedKeys, frames)}
                    disabled={busy != null || selectedKeys.length < 2}
                    className="mt-2 rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
                    data-testid="factory-import-rebuild"
                  >
                    Rebuild preview
                  </button>
                ) : null}
              </div>
            ) : null}
            {walkJobs.length > 1 && !job.ticked ? (
              <div className="studio-factory-walk-row" data-testid="factory-walk-set">
                {walkJobs.map((item) => (
                  <figure key={item.jobId} className="studio-factory-walk-card">
                    <video
                      src={factoryPreviewUrl(project, jobOwner(item), item.jobId)}
                      muted
                      loop
                      playsInline
                      autoPlay
                      data-testid={`factory-preview-${item.frames}`}
                    />
                    <figcaption>{item.frames} frames</figcaption>
                  </figure>
                ))}
              </div>
            ) : preview && !job.ticked ? (
              previewIsImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={job.jobId}
                  src={preview}
                  alt=""
                  className="mx-auto max-h-56 w-full max-w-xs object-contain"
                  data-testid="factory-preview"
                />
              ) : (
                <video
                  key={`${job.jobId}-${job.previewRel || ""}`}
                  src={preview}
                  muted
                  loop
                  playsInline
                  autoPlay
                  className="mx-auto max-h-56 w-full max-w-xs object-contain"
                  data-testid="factory-preview"
                />
              )
            ) : null}
            {job.ticked ? (
              <p className="text-sm text-emerald-300" data-testid="factory-ticked">
                {tickedMessage}
              </p>
            ) : (
              <p className="text-[12px] text-studio-muted">
                Preview only. Tick saves it. Redo makes a new one.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onTick()}
                disabled={busy != null || job.ticked}
                className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
                data-testid="factory-tick"
              >
                Tick
              </button>
              <button
                type="button"
                onClick={() => void onRedo()}
                disabled={busy != null || job.ticked}
                className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
                data-testid="factory-redo"
              >
                Redo
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-studio-muted">
            {canImport ? "Import an MP4, or results show here after Generate." : "Results show here after Generate."}
          </p>
        )}
      </div>
    </section>
  );
}
