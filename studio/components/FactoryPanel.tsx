"use client";

import { useMemo, useState } from "react";
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
  factoryPreviewUrl,
  redoFactoryJob,
  startFactoryJob,
  tickFactoryJob,
  type Character,
  type FactoryJob,
} from "@/lib/worker";

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<FactoryJob | null>(null);
  const [walkJobs, setWalkJobs] = useState<FactoryJob[]>([]);

  const showFrames = factoryUsesFrames(mode);
  const hint = factoryHint(mode, { character, slot, label });
  const placeholder = factoryPlaceholder(mode, { character, slot, label });

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

  function jobOwner(current: FactoryJob | null): string {
    return current?.characterId || character?.id || "project";
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
        walkSet: mode === "character" && inferFactoryIntent(prompt.trim()).kind === "walk",
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
    if (!job) {
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
                  onChange={() => setFrames(clampFactoryFrames(count))}
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
          Hidden pack for this project only. You never have to open this.
        </p>
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
            {walkJobs.length > 1 && !job.ticked ? (
              <div className="studio-factory-walk-row" data-testid="factory-walk-set">
                {walkJobs.map((item) => (
                  <video
                    key={item.jobId}
                    src={factoryPreviewUrl(project, jobOwner(item), item.jobId)}
                    muted
                    loop
                    playsInline
                    autoPlay
                    data-testid={`factory-preview-${item.frames}`}
                  />
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
                  key={job.jobId}
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
          <p className="text-[12px] text-studio-muted">Results show here after Generate.</p>
        )}
      </div>
    </section>
  );
}
