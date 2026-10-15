"use client";

import { useEffect, useState } from "react";
import { formatSeconds } from "@/lib/talkingHead";
import { planTalkingHead, startTalkingHead, type TalkingHeadPlan, type TalkingHeadRange } from "@/lib/worker";

const promptKey = (project: string, characterId: string) => `studio.talkingHeadPrompt.${project}.${characterId}`;

export default function TalkingHeadDialog({
  project,
  characterId,
  range,
  onClose,
  onStarted,
}: {
  project: string;
  characterId: string;
  range: TalkingHeadRange;
  onClose: () => void;
  onStarted: (characterId: string) => void;
}) {
  const [plan, setPlan] = useState<TalkingHeadPlan | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setError(null);
    planTalkingHead(project, characterId, range)
      .then((next) => {
        if (cancelled) return;
        setPlan(next);
        let saved = "";
        try {
          saved = window.localStorage.getItem(promptKey(project, characterId)) || "";
        } catch {
          saved = "";
        }
        setPrompt((current) => current || saved || next.defaultPrompt);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId, range.audioRel, range.inSec, range.durationSec]);

  const windows = plan?.windows ?? [];
  const clipSeconds = windows.reduce((sum, w) => sum + w.clipSec, 0);
  const blocker = !plan
    ? null
    : !plan.hasWords
      ? "No transcript for this audio. Re-import it with transcription on so the words are known."
      : !plan.hasReference
        ? "This character has no reference head image to start from."
        : null;

  async function onGenerate() {
    if (!plan || blocker || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        window.localStorage.setItem(promptKey(project, characterId), prompt.trim());
      } catch {
        /* optional */
      }
      await startTalkingHead(project, characterId, { ...range, prompt: prompt.trim() });
      onStarted(characterId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the talking head");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" data-testid="talking-head-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="talking-head-title"
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 id="talking-head-title" className="text-sm font-semibold text-white">
              Make talking head
            </h2>
            <p className="text-[11px] text-studio-muted">
              Grok head clips for this audio, chained last frame to first frame. They arrive in {characterId}&apos;s Head Rig.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs text-neutral-200">
          {!plan && !error ? <p className="text-studio-muted">Reading the transcript…</p> : null}
          {plan ? (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-studio-muted">
                <span>
                  Audio <span className="text-neutral-200">{formatSeconds(plan.durationSec)}</span>
                </span>
                <span>
                  Clips <span className="text-neutral-200" data-testid="talking-head-clip-count">{windows.length}</span>
                  {windows.length > 1 ? " (chained one after another)" : ""}
                </span>
                <span>
                  Grok video <span className="text-neutral-200">{clipSeconds}s</span>
                </span>
              </div>

              <ol className="space-y-1.5" data-testid="talking-head-windows">
                {windows.map((win) => (
                  <li key={win.index} className="rounded border border-studio-border bg-studio-raised px-2.5 py-1.5">
                    <div className="mb-0.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-studio-muted">
                      <span>
                        Clip {win.index + 1} · {formatSeconds(win.start)}–{formatSeconds(win.end)}
                      </span>
                      <span>
                        {win.index === 0 ? "from the reference head" : "from clip " + win.index + "'s last frame"} · {win.clipSec}s
                      </span>
                    </div>
                    <p className="leading-snug text-neutral-200">{win.text || <em className="text-studio-muted">(no words)</em>}</p>
                  </li>
                ))}
              </ol>

              <label className="block">
                <span className="mb-1 block text-[11px] text-studio-muted">Head prompt (added to every clip)</span>
                <textarea
                  className="h-16 w-full resize-none rounded border border-studio-border bg-studio-raised px-2 py-1.5 text-xs text-neutral-200"
                  value={prompt}
                  data-testid="talking-head-prompt"
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <p className="text-[11px] text-studio-muted">
                Grok does not hear the audio. It acts out each clip&apos;s words, and every clip is trimmed to its audio, so lip timing is approximate.
              </p>
            </>
          ) : null}
          {blocker ? <p className="text-amber-300" data-testid="talking-head-blocker">{blocker}</p> : null}
          {error ? <p className="text-red-400" data-testid="talking-head-error">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-studio-border px-4 py-3">
          <button
            type="button"
            className="rounded border border-studio-border px-3 py-1.5 text-xs text-neutral-300 hover:bg-studio-raised"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="talking-head-generate"
            className="rounded bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!plan || Boolean(blocker) || busy || !prompt.trim()}
            onClick={() => void onGenerate()}
          >
            {busy ? "Starting…" : `Generate ${windows.length || ""} clip${windows.length === 1 ? "" : "s"}`.replace("  ", " ")}
          </button>
        </div>
      </div>
    </div>
  );
}
