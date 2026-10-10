"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AUDIO_ACCEPT,
  IMPORT_AUDIO_STAGES,
  acceptAudioFile,
  buildAudioTag,
  explainImportAudioError,
  suggestedLabelFromFilename,
  summarizeDryRun,
  type DryRunSummary,
  type ImportAudioResult,
} from "@/lib/importAudio";
import { importProjectAudio, loadCharacters, type Character } from "@/lib/worker";

type Step = "pick" | "checking" | "review" | "importing" | "done";

export default function ImportAudioDialog({
  project,
  defaultCharacter,
  onClose,
  onInsertTag,
}: {
  project: string;
  defaultCharacter?: string;
  onClose: () => void;
  onInsertTag: (tag: string) => void | Promise<void>;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [characterId, setCharacterId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [noTranscribe, setNoTranscribe] = useState(false);
  const [step, setStep] = useState<Step>("pick");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dryRun, setDryRun] = useState<ImportAudioResult | null>(null);
  const [imported, setImported] = useState<ImportAudioResult | null>(null);
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadCharacters(project)
      .then((list) => {
        if (cancelled) return;
        setCharacters(list);
        const match =
          list.find((c) => c.id === defaultCharacter || c.display_name === defaultCharacter) || list[0];
        setCharacterId((current) => (list.some((c) => c.id === current) ? current : match?.id || ""));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(explainImportAudioError(err.message));
      });
    return () => {
      cancelled = true;
    };
  }, [project, defaultCharacter]);

  const selected = useMemo(
    () => characters.find((c) => c.id === characterId) || null,
    [characters, characterId]
  );

  const summary: DryRunSummary | null = dryRun ? summarizeDryRun(dryRun, { noTranscribe }) : null;

  function takeFile(next: File | null | undefined) {
    const check = acceptAudioFile(next);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setFile(next!);
    setLabel((current) => current || suggestedLabelFromFilename(next!.name));
    setError(null);
    setDryRun(null);
    setImported(null);
    setStep("pick");
  }

  async function onReview() {
    if (!file || !characterId || step === "checking") return;
    setStep("checking");
    setError(null);
    try {
      const result = await importProjectAudio(project, file, {
        character: characterId,
        name: label.trim() || undefined,
        dryRun: true,
        noTranscribe,
      });
      setDryRun(result);
      setStep("review");
    } catch (err) {
      setError(explainImportAudioError(err instanceof Error ? err.message : "Could not check the recording"));
      setStep("pick");
    }
  }

  async function onImport() {
    if (!file || !characterId || step === "importing") return;
    setStep("importing");
    setError(null);
    try {
      const result = await importProjectAudio(project, file, {
        character: characterId,
        name: label.trim() || undefined,
        noTranscribe,
      });
      setImported(result);
      setStep("done");
    } catch (err) {
      setError(explainImportAudioError(err instanceof Error ? err.message : "Import failed"));
      setStep("review");
    }
  }

  async function onInsert() {
    if (!imported || inserting) return;
    const name = selected?.display_name || imported.character;
    const tag = imported.tag && imported.tag.includes(name) ? imported.tag : buildAudioTag(name, imported.label);
    setInserting(true);
    setError(null);
    try {
      await onInsertTag(tag);
      onClose();
    } catch (err) {
      setError(explainImportAudioError(err instanceof Error ? err.message : "Could not insert into the script"));
    } finally {
      setInserting(false);
    }
  }

  const busy = step === "checking" || step === "importing" || inserting;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" data-testid="import-audio-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-audio-title"
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 id="import-audio-title" className="text-sm font-semibold text-white">
              Import audio
            </h2>
            <p className="text-[11px] text-studio-muted">
              Drop an mp3 or wav. The engine converts it, makes mouth shapes, and can transcribe speech.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step === "pick" || step === "checking" ? (
            <div className="space-y-3">
              <label
                className={`flex min-h-[110px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-4 text-center text-xs outline-none ${
                  dragging ? "border-studio-accent bg-studio-accent/10 text-white" : "border-studio-border text-studio-muted"
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  takeFile(event.dataTransfer.files[0]);
                }}
              >
                {file ? (
                  <span className="text-neutral-200">
                    {file.name}
                    <span className="mt-1 block text-[11px] text-studio-muted">Drop another file to replace it</span>
                  </span>
                ) : (
                  "Drop an mp3 or wav here, or click to pick a file"
                )}
                <input
                  type="file"
                  accept={AUDIO_ACCEPT}
                  className="hidden"
                  data-testid="import-audio-file"
                  disabled={busy}
                  onChange={(event) => {
                    takeFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>

              <label className="flex items-center gap-2 text-[11px] text-studio-muted">
                <span className="w-16 shrink-0">Character</span>
                <select
                  className="studio-field"
                  value={characterId}
                  disabled={characters.length === 0 || busy}
                  onChange={(event) => setCharacterId(event.target.value)}
                  data-testid="import-audio-character"
                >
                  {characters.length === 0 ? <option value="">No characters</option> : null}
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.display_name}
                    </option>
                  ))}
                </select>
              </label>
              {characters.length === 0 ? (
                <p className="text-[11px] text-studio-muted">Add a character on the Assets tab first.</p>
              ) : null}

              <label className="flex items-center gap-2 text-[11px] text-studio-muted">
                <span className="w-16 shrink-0">Label</span>
                <input
                  className="studio-field"
                  value={label}
                  placeholder="optional, e.g. monologue"
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                  data-testid="import-audio-label"
                />
              </label>
            </div>
          ) : null}

          {step === "review" && summary ? (
            <div className="space-y-3" data-testid="import-audio-review">
              <p className="text-sm text-neutral-200">
                Length: <span className="font-medium text-white">{summary.durationLabel}</span>
              </p>
              <p className="text-xs text-neutral-300">{summary.creditNote}</p>
              {summary.usesCredits ? (
                <p className="text-xs text-amber-200">Speech-to-text uses ElevenLabs credits.</p>
              ) : null}
              {summary.estimatedCost ? (
                <p className="text-xs text-neutral-200">
                  Estimated cost: <span className="text-white">{summary.estimatedCost}</span>
                </p>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  checked={noTranscribe}
                  onChange={(event) => setNoTranscribe(event.target.checked)}
                  data-testid="import-audio-skip"
                />
                Skip transcription
              </label>
            </div>
          ) : null}

          {step === "importing" ? (
            <div className="space-y-3" data-testid="import-audio-progress">
              <p className="text-sm text-neutral-200">Importing — this can take a minute for a long recording.</p>
              <ol className="space-y-1.5 text-xs text-neutral-300">
                {IMPORT_AUDIO_STAGES.map((stage) => {
                  const skipped = stage.id === "transcribe" && noTranscribe;
                  return (
                    <li key={stage.id} className={skipped ? "text-studio-muted" : "text-neutral-200"}>
                      <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-studio-accent align-middle" />
                      {stage.label}
                      {skipped ? " — skipped" : "…"}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {step === "done" && imported ? (
            <div className="space-y-3" data-testid="import-audio-done">
              <p className="text-sm text-neutral-200">Imported. Insert the tag so the Audio and Dialogue lanes show it.</p>
              <p className="font-mono text-xs text-neutral-300">
                {buildAudioTag(selected?.display_name || imported.character, imported.label)}
              </p>
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-sm text-red-400" data-testid="import-audio-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-studio-border px-4 py-3">
          {step === "pick" || step === "checking" ? (
            <>
              <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="import-audio-review-btn"
                disabled={!file || !characterId || busy}
                onClick={() => void onReview()}
                className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
              >
                {step === "checking" ? "Checking…" : "Review"}
              </button>
            </>
          ) : null}
          {step === "review" ? (
            <>
              <button
                type="button"
                className="text-xs text-studio-muted hover:text-white"
                onClick={() => {
                  setStep("pick");
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="import-audio-confirm"
                disabled={busy}
                onClick={() => void onImport()}
                className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
              >
                Import
              </button>
            </>
          ) : null}
          {step === "importing" ? (
            <span className="text-xs text-studio-muted">Working…</span>
          ) : null}
          {step === "done" ? (
            <>
              <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onClose}>
                Done
              </button>
              <button
                type="button"
                data-testid="import-audio-insert"
                disabled={inserting}
                onClick={() => void onInsert()}
                className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
              >
                {inserting ? "Inserting…" : "Insert into script"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
