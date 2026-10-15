"use client";

import { useEffect, useRef, useState } from "react";
import { formatSeconds } from "@/lib/talkingHead";
import {
  WORKER_URL,
  loadEngineSettings,
  planTalkingHead,
  startTalkingHead,
  uploadTalkingHeadStart,
  type TalkStart,
  type TalkingHeadPlan,
  type TalkingHeadRange,
} from "@/lib/worker";

const promptKey = (project: string, characterId: string) => `studio.talkingHeadPrompt.${project}.${characterId}`;
const engineKey = (project: string, characterId: string) => `studio.talkingHeadEngine.${project}.${characterId}`;
type TalkEngine = "grok" | "ltx";
const startKey = (project: string, characterId: string) => `studio.talkingHeadStart.${project}.${characterId}`;

function thumbUrl(project: string, characterId: string, start: TalkStart): string | null {
  if (!start.thumb) return null;
  return `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(start.thumb)}`;
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

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
  const [starts, setStarts] = useState<TalkStart[]>([]);
  const [startRel, setStartRel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [engine, setEngine] = useState<TalkEngine>("grok");
  const [comfyConfigured, setComfyConfigured] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        setStarts(next.starts);
        let remembered = "";
        try {
          remembered = window.localStorage.getItem(startKey(project, characterId)) || "";
        } catch {
          remembered = "";
        }
        const keep = next.starts.some((item) => item.rel === remembered) ? remembered : next.defaultStart;
        setStartRel((current) => (next.starts.some((item) => item.rel === current) ? current : keep));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId, range.audioRel, range.inSec, range.durationSec]);

  useEffect(() => {
    let cancelled = false;
    let saved = "";
    try {
      saved = window.localStorage.getItem(engineKey(project, characterId)) || "";
    } catch {
      saved = "";
    }
    loadEngineSettings()
      .then((settings) => {
        if (cancelled) return;
        const configured = Boolean(settings.comfyKeyConfigured);
        setComfyConfigured(configured);
        setEngine(saved === "grok" ? "grok" : saved === "ltx" || configured ? "ltx" : "grok");
      })
      .catch(() => {
        if (!cancelled) setEngine(saved === "ltx" ? "ltx" : "grok");
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId]);

  const ltx = engine === "ltx";
  const engineName = ltx ? "LTX" : "Grok";
  const windows = plan?.windows ?? [];
  const clipSeconds = windows.reduce((sum, w) => sum + w.clipSec, 0);
  const chosen = starts.find((item) => item.rel === startRel) || null;
  const blocker = !plan
    ? null
    : ltx && comfyConfigured === false
      ? "COMFY_CLOUD_API_KEY is not set. Add it to the engine .env file and restart the engine, or switch to Grok."
      : !plan.hasWords
      ? "No transcript for this audio. Re-import it with transcription on so the words are known."
      : !chosen
        ? "Choose the head image to start from, or upload one. It should be a head with no neck or collar."
        : chosen.fullBody
          ? `The full-body reference would make ${engineName} draw a body. Pick or upload a head image.`
          : null;

  async function onUpload(file: File | undefined) {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await uploadTalkingHeadStart(project, characterId, { name: file.name, data: await readFileBase64(file) });
      const item: TalkStart = { kind: "uploaded", label: saved.label, rel: saved.rel, thumb: saved.thumb };
      setStarts((current) => [item, ...current.filter((existing) => existing.rel !== item.rel)]);
      setStartRel(saved.rel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that image");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onGenerate() {
    if (!plan || blocker || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        window.localStorage.setItem(promptKey(project, characterId), prompt.trim());
        window.localStorage.setItem(startKey(project, characterId), startRel);
        window.localStorage.setItem(engineKey(project, characterId), engine);
      } catch {
        /* optional */
      }
      await startTalkingHead(project, characterId, { ...range, prompt: prompt.trim(), refRel: startRel, engine });
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
              {engineName} head clips for this audio, chained last frame to first frame. They arrive in {characterId}&apos;s Head Rig.
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
                  {ltx ? "LTX video" : "Grok video"}{" "}
                  <span className="text-neutral-200">
                    {ltx ? Math.round(windows.reduce((sum, w) => sum + w.duration, 0) * 10) / 10 : clipSeconds}s
                  </span>
                </span>
              </div>

              <div className="flex items-center gap-2 text-[11px]" data-testid="talking-head-engine">
                <span className="text-studio-muted">Generate with</span>
                {(["ltx", "grok"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-testid={`talking-head-engine-${option}`}
                    aria-pressed={engine === option}
                    onClick={() => setEngine(option)}
                    className={`rounded border px-2 py-0.5 ${
                      engine === option ? "border-studio-accent bg-studio-accent/10 text-white" : "border-studio-border text-studio-muted hover:bg-studio-raised"
                    }`}
                  >
                    {option === "ltx" ? "Comfy Cloud LTX (hears the audio)" : "Grok"}
                  </button>
                ))}
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-studio-muted">
                  <span>Start image (clip 1 starts from this head)</span>
                  <button
                    type="button"
                    className="rounded border border-studio-border px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-studio-raised disabled:opacity-40"
                    disabled={uploading}
                    data-testid="talking-head-upload"
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? "Uploading…" : "Upload image"}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    data-testid="talking-head-file"
                    onChange={(event) => void onUpload(event.target.files?.[0])}
                  />
                </div>
                <div className="flex flex-wrap gap-2" data-testid="talking-head-starts">
                  {starts.map((item) => {
                    const src = thumbUrl(project, characterId, item);
                    const selected = item.rel === startRel;
                    return (
                      <button
                        key={item.rel}
                        type="button"
                        title={item.label}
                        data-testid="talking-head-start"
                        onClick={() => setStartRel(item.rel)}
                        className={`flex w-20 flex-col items-center gap-1 rounded border p-1 text-[10px] ${
                          selected ? "border-studio-accent bg-studio-accent/10 text-white" : "border-studio-border text-studio-muted hover:bg-studio-raised"
                        }`}
                      >
                        {src ? (
                          <img src={src} alt="" className="h-16 w-full rounded bg-black object-contain" />
                        ) : (
                          <span className="flex h-16 w-full items-center justify-center rounded bg-black text-[10px]">full body</span>
                        )}
                        <span className="w-full truncate text-center">
                          {item.kind === "reference" ? "Reference" : item.label}
                        </span>
                      </button>
                    );
                  })}
                  {starts.length === 0 ? (
                    <p className="text-[11px] text-amber-300">No head images yet. Upload the head image you want {engineName} to start from.</p>
                  ) : null}
                </div>
                {chosen?.fullBody ? (
                  <p className="mt-1 text-[11px] text-amber-300" data-testid="talking-head-body-warning">
                    This is the full-body reference. {engineName} will start from a body, not a head. Pick or upload a head image instead.
                  </p>
                ) : null}
              </div>

              <ol className="space-y-1.5" data-testid="talking-head-windows">
                {windows.map((win) => (
                  <li key={win.index} className="rounded border border-studio-border bg-studio-raised px-2.5 py-1.5">
                    <div className="mb-0.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-studio-muted">
                      <span>
                        Clip {win.index + 1} · {formatSeconds(win.start)}–{formatSeconds(win.end)}
                      </span>
                      <span>
                        {win.index === 0 ? "from the start image" : "from clip " + win.index + "'s last frame"} · {win.clipSec}s
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
                {ltx
                  ? "LTX hears each clip's audio and lip-syncs to it, using Comfy Cloud credits. The head is filmed on black and the black is keyed out (dark hair and beard are kept). Non-16:9 start images are padded with black, never cropped."
                  : "Grok does not hear the audio. It acts out each clip's words, and every clip is trimmed to its audio, so lip timing is approximate."}
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
