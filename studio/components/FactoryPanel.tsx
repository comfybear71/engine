"use client";

import { useMemo, useState } from "react";
import {
  FACTORY_FRAMES,
  assembleHiddenPrompt,
  clampFactoryFrames,
  type FactoryFrames,
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
  character,
  onChanged,
}: {
  project: string;
  character: Character;
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [frames, setFrames] = useState<FactoryFrames>(8);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedPrompt, setAdvancedPrompt] = useState("");
  const [advancedTouched, setAdvancedTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<FactoryJob | null>(null);

  const assembled = useMemo(
    () =>
      assembleHiddenPrompt({
        character,
        userPrompt: prompt,
        frames,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
      }),
    [character, prompt, frames, advancedPrompt, advancedTouched]
  );

  async function onGenerate() {
    if (!prompt.trim()) {
      setError("Type what you want, e.g. Rodney walking long stride.");
      return;
    }
    setBusy("Generating…");
    setError(null);
    try {
      const result = await startFactoryJob(project, {
        characterId: character.id,
        prompt: prompt.trim(),
        frames,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
      });
      setJob(result);
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
      const result = await tickFactoryJob(project, character.id, job.jobId);
      setJob(result);
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
      const result = await redoFactoryJob(project, character.id, job.jobId, {
        prompt: prompt.trim() || job.prompt,
        frames,
        advancedPrompt: advancedTouched ? advancedPrompt : undefined,
      });
      setJob(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Redo failed");
    } finally {
      setBusy(null);
    }
  }

  const preview = job ? factoryPreviewUrl(project, character.id, job.jobId) : null;

  return (
    <section data-testid="factory-panel">
      <p className="mb-3 text-sm text-neutral-300">
        Type what {character.display_name} should do. Style, references, and green screen are already packed in.
      </p>
      <label className="mb-3 block">
        <span className="sr-only">Prompt</span>
        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`${character.display_name} walking long stride`}
          className="w-full rounded-md border border-studio-border bg-studio-raised px-3 py-2 text-sm text-neutral-100"
          data-testid="factory-prompt"
        />
      </label>
      <div className="mb-3 flex flex-wrap items-center gap-3">
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
          Hidden pack for this project only: locked style, reference pictures, flat #00FF00, one head, no squash.
          You never have to open this.
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
            {preview && !job.ticked ? (
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
            ) : null}
            {job.ticked ? (
              <p className="text-sm text-emerald-300" data-testid="factory-ticked">
                Ticked. {job.actionId} is in the character library and Action Shots.
              </p>
            ) : (
              <p className="text-[12px] text-studio-muted">
                Preview only. Tick saves the drawings. Redo makes a new sheet.
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
