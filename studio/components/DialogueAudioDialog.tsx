"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addSegment,
  formatClock,
  fitRange,
  parseClock,
  segmentRange,
  updateSegmentRange,
  type DialogueSegment,
} from "@/lib/dialogueSegments";
import { audioPeaks } from "@/lib/headRigAudio";
import { AUDIO_ACCEPT, acceptAudioFile, explainImportAudioError, suggestedLabelFromFilename } from "@/lib/importAudio";
import {
  importProjectAudio,
  loadProjectAudio,
  mediaUrl,
  planTalkingHead,
  type ProjectAudioFile,
  type TalkingHeadRange,
} from "@/lib/worker";

export type MadeClip = { audioRel?: string; audioInSec?: number };

type Drag =
  | { kind: "create"; anchor: number; now: number; moved: boolean }
  | { kind: "start" | "end"; id: string; now: number };

type Saved = { audioRel: string; durationSec: number; segments: DialogueSegment[] };

const storeKey = (project: string, characterId: string) => `studio.dialogueAudio.${project}.${characterId}`;
const PEAK_BUCKETS = 1400;
const EDGE_PX = 7;
let nextId = 1;
const newId = () => `line_${Date.now().toString(36)}_${nextId++}`;

function loadSaved(project: string, characterId: string): Saved | null {
  try {
    const raw = window.localStorage.getItem(storeKey(project, characterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Saved;
    if (!parsed || typeof parsed.audioRel !== "string" || !Array.isArray(parsed.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export default function DialogueAudioDialog({
  project,
  characterId,
  made,
  onClose,
  onMake,
}: {
  project: string;
  characterId: string;
  /** Talking-head clips already made for this character, to show which lines are done. */
  made: MadeClip[];
  onClose: () => void;
  onMake: (range: TalkingHeadRange) => void;
}) {
  const [audioList, setAudioList] = useState<ProjectAudioFile[]>([]);
  const [audioRel, setAudioRel] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  const [segments, setSegments] = useState<DialogueSegment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursorSec, setCursorSec] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [transcribe, setTranscribe] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const prefilledRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<Drag | null>(null);

  const refreshAudio = useCallback(async () => {
    try {
      const files = await loadProjectAudio(project);
      setAudioList(files.filter((f) => f.kind === "imported" && f.characterId === characterId));
      return files;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list the project's audio");
      return [];
    }
  }, [project, characterId]);

  useEffect(() => {
    const saved = loadSaved(project, characterId);
    if (saved) {
      setAudioRel(saved.audioRel);
      setDurationSec(saved.durationSec);
      setSegments(saved.segments);
      saved.segments.forEach((s) => prefilledRef.current.add(s.id));
    }
    void refreshAudio();
  }, [project, characterId, refreshAudio]);

  useEffect(() => {
    if (!audioRel) return;
    try {
      window.localStorage.setItem(storeKey(project, characterId), JSON.stringify({ audioRel, durationSec, segments }));
    } catch {
      /* optional */
    }
  }, [project, characterId, audioRel, durationSec, segments]);

  useEffect(() => {
    if (!audioRel) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    (async () => {
      try {
        const res = await fetch(mediaUrl(project, audioRel));
        if (!res.ok) throw new Error(`Could not read ${audioRel}`);
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) throw new Error("This browser cannot draw the waveform");
        const ctx = new Ctx();
        try {
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          if (cancelled) return;
          setPeaks(audioPeaks(buf.getChannelData(0), PEAK_BUCKETS));
          setDurationSec((current) => (current > 0 ? current : buf.duration));
        } finally {
          void ctx.close();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not draw the waveform");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, audioRel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    if (!peaks) return;
    ctx.fillStyle = "#6b7280";
    const barW = width / peaks.length;
    peaks.forEach((p, i) => {
      const h = Math.max(1, p * (height - 6));
      ctx.fillRect(i * barW, (height - h) / 2, Math.max(1, barW - 0.5), h);
    });
  }, [peaks, audioRel]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    stopAtRef.current = null;
    setPlayingId(null);
  }, []);

  function playRange(id: string, startSec: number, endSec: number) {
    if (playingId === id) {
      stopPlayback();
      return;
    }
    if (!audioRef.current) {
      const el = new Audio();
      el.addEventListener("timeupdate", () => {
        setCursorSec(el.currentTime);
        if (stopAtRef.current != null && el.currentTime >= stopAtRef.current) {
          el.pause();
          stopAtRef.current = null;
          setPlayingId(null);
        }
      });
      el.addEventListener("ended", () => setPlayingId(null));
      audioRef.current = el;
    }
    const el = audioRef.current;
    const src = mediaUrl(project, audioRel);
    if (el.getAttribute("data-src") !== src) {
      el.src = src;
      el.setAttribute("data-src", src);
    }
    stopAtRef.current = endSec;
    el.currentTime = startSec;
    setPlayingId(id);
    void el.play().catch(() => setPlayingId(null));
  }

  function chooseAudio(file: ProjectAudioFile | null) {
    stopPlayback();
    setError(null);
    setSegments([]);
    setSelectedId(null);
    prefilledRef.current = new Set();
    if (!file) {
      setAudioRel("");
      setDurationSec(0);
      return;
    }
    setAudioRel(file.rel);
    setDurationSec(file.durationSeconds && file.durationSeconds > 0 ? file.durationSeconds : 0);
  }

  async function onPickFile(file: File | undefined) {
    if (!file || importing) return;
    const ok = acceptAudioFile(file);
    if (!ok.ok) {
      setError(ok.error);
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const result = await importProjectAudio(project, file, {
        character: characterId,
        name: suggestedLabelFromFilename(file.name),
        noTranscribe: !transcribe,
        splitLong: false,
      });
      await refreshAudio();
      stopPlayback();
      setSegments([]);
      setSelectedId(null);
      prefilledRef.current = new Set();
      setAudioRel(result.wavPath || "");
      setDurationSec(result.durationSeconds > 0 ? result.durationSeconds : 0);
    } catch (err) {
      setError(explainImportAudioError(err instanceof Error ? err.message : "Import failed"));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const secAt = useCallback(
    (clientX: number) => {
      const box = waveRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || durationSec <= 0) return 0;
      return Math.max(0, Math.min(durationSec, ((clientX - box.left) / box.width) * durationSec));
    },
    [durationSec]
  );

  function onWavePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!audioRel || durationSec <= 0 || event.button !== 0) return;
    const box = waveRef.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const sec = secAt(event.clientX);
    const px = (s: number) => (s / durationSec) * box.width;
    const x = event.clientX - box.left;
    const edge = segments.find((s) => Math.abs(px(s.startSec) - x) <= EDGE_PX || Math.abs(px(s.endSec) - x) <= EDGE_PX);
    let next: Drag;
    if (edge) {
      const atStart = Math.abs(px(edge.startSec) - x) <= Math.abs(px(edge.endSec) - x);
      setSelectedId(edge.id);
      next = { kind: atStart ? "start" : "end", id: edge.id, now: sec };
    } else {
      const inside = segments.find((s) => sec > s.startSec && sec < s.endSec);
      if (inside) {
        setSelectedId(inside.id);
        setCursorSec(sec);
        return;
      }
      next = { kind: "create", anchor: sec, now: sec, moved: false };
    }
    dragRef.current = next;
    setDrag(next);
  }

  function onWavePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (!current) return;
    const sec = secAt(event.clientX);
    const next: Drag =
      current.kind === "create"
        ? { ...current, now: sec, moved: current.moved || Math.abs(sec - current.anchor) > durationSec * 0.004 }
        : { ...current, now: sec };
    dragRef.current = next;
    setDrag(next);
  }

  function onWavePointerUp() {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) return;
    if (current.kind === "create") {
      if (!current.moved) {
        setCursorSec(current.now);
        setSelectedId(null);
        return;
      }
      const id = newId();
      const next = addSegment(segments, current.anchor, current.now, durationSec, id, current.anchor);
      if (next) {
        setSegments(next);
        setSelectedId(id);
        void prefillWords(id, next);
      }
      return;
    }
    const seg = segments.find((s) => s.id === current.id);
    if (!seg) return;
    const start = current.kind === "start" ? current.now : seg.startSec;
    const end = current.kind === "end" ? current.now : seg.endSec;
    setSegments(updateSegmentRange(segments, current.id, start, end, durationSec));
  }

  async function prefillWords(id: string, list: DialogueSegment[]) {
    if (prefilledRef.current.has(id)) return;
    prefilledRef.current.add(id);
    const seg = list.find((s) => s.id === id);
    if (!seg) return;
    try {
      const plan = await planTalkingHead(project, characterId, { ...segmentRange(audioRel, seg), engine: "grok" });
      if (plan.hasWords && plan.transcript) {
        setSegments((prev) => prev.map((s) => (s.id === id && !s.text ? { ...s, text: plan.transcript } : s)));
      }
    } catch {
      /* no transcript for this audio: the words are typed by hand */
    }
  }

  const drawn = useMemo(() => {
    if (!drag) return null;
    if (drag.kind === "create") {
      const fit = fitRange(segments, drag.anchor, drag.now, durationSec, undefined, drag.anchor);
      return fit ? { id: null as string | null, ...fit } : null;
    }
    const seg = segments.find((s) => s.id === drag.id);
    if (!seg) return null;
    const fit = fitRange(
      segments,
      drag.kind === "start" ? drag.now : seg.startSec,
      drag.kind === "end" ? drag.now : seg.endSec,
      durationSec,
      seg.id,
      (seg.startSec + seg.endSec) / 2
    );
    return fit ? { id: seg.id as string | null, ...fit } : null;
  }, [drag, segments, durationSec]);

  function setText(id: string, text: string) {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
  }

  function setTime(id: string, which: "start" | "end", raw: string) {
    const value = parseClock(raw);
    const seg = segments.find((s) => s.id === id);
    if (value == null || !seg) return;
    setSegments(
      updateSegmentRange(segments, id, which === "start" ? value : seg.startSec, which === "end" ? value : seg.endSec, durationSec)
    );
  }

  function removeSegment(id: string) {
    if (playingId === id) stopPlayback();
    setSegments((prev) => prev.filter((s) => s.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function madeCount(seg: DialogueSegment): number {
    return made.filter(
      (m) => m.audioRel === audioRel && Number.isFinite(Number(m.audioInSec)) && Number(m.audioInSec) >= seg.startSec - 0.05 && Number(m.audioInSec) < seg.endSec - 0.05
    ).length;
  }

  const pct = (sec: number) => (durationSec > 0 ? `${(sec / durationSec) * 100}%` : "0%");
  const widthPct = (a: number, b: number) => (durationSec > 0 ? `${((b - a) / durationSec) * 100}%` : "0%");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" data-testid="dialogue-audio-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialogue-audio-title"
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 id="dialogue-audio-title" className="text-sm font-semibold text-white">
              Dialogue audio for {characterId}
            </h2>
            <p className="text-[11px] text-studio-muted">
              Import the real recording, drag across the waveform to pick each line, then make a talking head for it. The clips keep their place in the recording so separate lines line up.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose} data-testid="dialogue-audio-close">
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs text-neutral-200">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
              disabled={importing}
              data-testid="dialogue-audio-import"
              onClick={() => fileRef.current?.click()}
            >
              {importing ? "Importing…" : "Import recording (mp3 / wav)"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={AUDIO_ACCEPT}
              className="hidden"
              data-testid="dialogue-audio-file"
              onChange={(event) => void onPickFile(event.target.files?.[0])}
            />
            <select
              className="min-w-0 max-w-[16rem] rounded border border-studio-border bg-studio-raised px-1.5 py-1.5 text-[12px] text-neutral-200"
              value={audioRel}
              data-testid="dialogue-audio-select"
              onChange={(event) => chooseAudio(audioList.find((f) => f.rel === event.target.value) || null)}
            >
              <option value="">{audioList.length ? "or use a recording already imported…" : "No recordings imported for this character yet"}</option>
              {audioList.map((f) => (
                <option key={f.rel} value={f.rel}>
                  {f.label}
                  {f.durationSeconds ? ` (${formatClock(f.durationSeconds)})` : ""}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-[11px] text-studio-muted" title="Off: you type the words of each line yourself. On: ElevenLabs speech-to-text reads them (uses credits, billed by audio length).">
              <input
                type="checkbox"
                checked={transcribe}
                data-testid="dialogue-audio-transcribe"
                onChange={(event) => setTranscribe(event.target.checked)}
              />
              Also read the words automatically (ElevenLabs, uses credits)
            </label>
          </div>
          <p className="text-[11px] text-studio-muted">
            Your recording is used as it is. Nothing is generated by ElevenLabs; the checkbox above only controls whether it reads the words aloud for you.
          </p>

          {audioRel ? (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-studio-muted">
                <span>
                  {audioRel} · {durationSec > 0 ? formatClock(durationSec) : "…"}
                </span>
                <span>Drag on the waveform to pick a line. Drag a line's edge to adjust it.</span>
              </div>
              <div
                ref={waveRef}
                className="relative h-24 cursor-crosshair touch-none overflow-hidden rounded border border-studio-border bg-black"
                data-testid="dialogue-audio-wave"
                onPointerDown={onWavePointerDown}
                onPointerMove={onWavePointerMove}
                onPointerUp={onWavePointerUp}
                onPointerCancel={onWavePointerUp}
              >
                <canvas ref={canvasRef} width={PEAK_BUCKETS} height={96} className="pointer-events-none absolute inset-0 h-full w-full" />
                {!peaks ? <span className="absolute inset-0 flex items-center justify-center text-[11px] text-studio-muted">Drawing the waveform…</span> : null}
                {segments.map((seg, i) => {
                  const live = drawn && drawn.id === seg.id ? drawn : seg;
                  return (
                    <div
                      key={seg.id}
                      data-testid={`dialogue-audio-seg-${i + 1}`}
                      className={`pointer-events-none absolute inset-y-0 border-x-2 ${
                        seg.id === selectedId ? "border-amber-300 bg-amber-300/25" : "border-emerald-400 bg-emerald-400/20"
                      }`}
                      style={{ left: pct(live.startSec), width: widthPct(live.startSec, live.endSec) }}
                    >
                      <span className="absolute left-1 top-0.5 rounded bg-black/70 px-1 text-[10px] text-white">{i + 1}</span>
                    </div>
                  );
                })}
                {drawn && drawn.id == null ? (
                  <div
                    className="pointer-events-none absolute inset-y-0 border-x-2 border-sky-300 bg-sky-300/25"
                    style={{ left: pct(drawn.startSec), width: widthPct(drawn.startSec, drawn.endSec) }}
                  />
                ) : null}
                {cursorSec != null ? (
                  <div className="pointer-events-none absolute inset-y-0 w-px bg-yellow-300" style={{ left: pct(cursorSec) }} />
                ) : null}
              </div>
              {drawn ? (
                <p className="mt-1 text-[11px] text-sky-300">
                  {formatClock(drawn.startSec)} – {formatClock(drawn.endSec)} ({(drawn.endSec - drawn.startSec).toFixed(1)}s)
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rounded border border-dashed border-studio-border px-3 py-6 text-center text-[11px] text-studio-muted">
              Import the recording that has {characterId}&apos;s lines, or pick one that is already in the project.
            </p>
          )}

          {audioRel && segments.length === 0 && peaks ? (
            <p className="text-[11px] text-amber-300">No lines picked yet. Drag across the part of the waveform where {characterId} speaks.</p>
          ) : null}

          <ol className="space-y-2" data-testid="dialogue-audio-lines">
            {segments.map((seg, i) => {
              const count = madeCount(seg);
              const length = seg.endSec - seg.startSec;
              return (
                <li
                  key={seg.id}
                  data-testid={`dialogue-audio-line-${i + 1}`}
                  className={`rounded border px-2.5 py-2 ${seg.id === selectedId ? "border-amber-300/70 bg-studio-raised" : "border-studio-border bg-studio-raised"}`}
                  onClick={() => setSelectedId(seg.id)}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-studio-muted">
                    <span className="font-semibold uppercase tracking-wide">Line {i + 1}</span>
                    <label className="flex items-center gap-1">
                      from
                      <input
                        key={`s-${seg.startSec}`}
                        className="w-16 rounded border border-studio-border bg-black/30 px-1 py-0.5 text-neutral-200"
                        defaultValue={formatClock(seg.startSec)}
                        data-testid={`dialogue-audio-from-${i + 1}`}
                        onBlur={(event) => setTime(seg.id, "start", event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      to
                      <input
                        key={`e-${seg.endSec}`}
                        className="w-16 rounded border border-studio-border bg-black/30 px-1 py-0.5 text-neutral-200"
                        defaultValue={formatClock(seg.endSec)}
                        data-testid={`dialogue-audio-to-${i + 1}`}
                        onBlur={(event) => setTime(seg.id, "end", event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
                      />
                    </label>
                    <span>{length.toFixed(1)}s</span>
                    {count > 0 ? (
                      <span className="text-emerald-300" data-testid={`dialogue-audio-made-${i + 1}`}>
                        {count} clip{count === 1 ? "" : "s"} made
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        className="rounded border border-studio-border px-2 py-0.5 text-neutral-200 hover:bg-black/30"
                        data-testid={`dialogue-audio-play-${i + 1}`}
                        onClick={(event) => { event.stopPropagation(); playRange(seg.id, seg.startSec, seg.endSec); }}
                      >
                        {playingId === seg.id ? "■ Stop" : "▶ Listen"}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-studio-border px-2 py-0.5 text-red-300 hover:bg-black/30"
                        title="Remove this line (clips already made are kept)"
                        data-testid={`dialogue-audio-remove-${i + 1}`}
                        onClick={(event) => { event.stopPropagation(); removeSegment(seg.id); }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  <textarea
                    className="mb-1.5 h-14 w-full resize-none rounded border border-studio-border bg-black/30 px-2 py-1.5 text-xs text-neutral-200"
                    placeholder={`The words ${characterId} says in this line (needed so the clip matches what is said)`}
                    value={seg.text}
                    data-testid={`dialogue-audio-text-${i + 1}`}
                    onChange={(event) => setText(seg.id, event.target.value)}
                  />
                  <div className="flex items-center justify-end gap-2">
                    {!seg.text.trim() ? <span className="text-[11px] text-amber-300">Type the words first.</span> : null}
                    <button
                      type="button"
                      className="rounded bg-studio-accent px-3 py-1 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!seg.text.trim()}
                      data-testid={`dialogue-audio-make-${i + 1}`}
                      onClick={(event) => { event.stopPropagation(); stopPlayback(); onMake(segmentRange(audioRel, seg)); }}
                    >
                      Make talking head…
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          {error ? <p className="text-red-400" data-testid="dialogue-audio-error">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-studio-border px-4 py-3">
          <p className="text-[11px] text-studio-muted">
            When the clips are ready, press <span className="text-neutral-200">At audio time</span> on their batch in the sidebar to put them on the head track where they sit in the recording.
          </p>
          <button
            type="button"
            className="rounded border border-studio-border px-3 py-1.5 text-xs text-neutral-300 hover:bg-studio-raised"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
