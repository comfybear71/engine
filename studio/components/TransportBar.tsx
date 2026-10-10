"use client";

import { formatTimecode } from "@/lib/playhead";

const btnBase =
  "flex h-6 w-6 items-center justify-center rounded-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent";
const btn =
  `${btnBase} text-neutral-300 hover:text-white`;

export default function TransportBar({
  frame,
  maxFrame,
  fps,
  script,
  playing,
  usingVideo,
  previewStatus,
  bufferHint,
  onRewind,
  onTogglePlay,
  onStop,
  onImportAudio,
}: {
  frame: number;
  maxFrame: number;
  fps: number;
  script: string;
  playing: boolean;
  usingVideo: boolean;
  previewStatus?: "idle" | "rendering" | "buffering" | null;
  bufferHint?: string | null;
  onRewind: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onImportAudio?: () => void;
}) {
  const rendering = previewStatus === "rendering" || previewStatus === "buffering";
  return (
    <div
      className="z-10 shrink-0 border-t border-studio-border bg-studio-panel px-3"
      data-testid="transport-bar"
    >
      <div className="flex h-7 items-center gap-3">
        <div className="w-[9.5rem] shrink-0 font-mono text-[11px] tabular-nums text-neutral-200">
          {formatTimecode(frame, fps)} / {formatTimecode(maxFrame, fps)}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div className="flex items-center gap-0.5" role="group" aria-label="Playback">
            <button
              type="button"
              data-testid="stage-rewind"
              title="Rewind to start"
              aria-label="Rewind to start"
              onClick={onRewind}
              className={btn}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                <path d="M11.5 12l8.5 6V6l-8.5 6zM4 6h2v12H4V6z" />
              </svg>
            </button>
            <button
              type="button"
              data-testid="stage-play"
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
              onClick={onTogglePlay}
              className={`${btnBase} ${
                playing
                  ? "text-studio-accent hover:text-studio-accent-hover"
                  : "text-studio-accent/80 hover:text-studio-accent"
              }`}
            >
              {playing ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                  <path d="M7 6h3.5v12H7V6zm6.5 0H17v12h-3.5V6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="ml-px h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l12-7L8 5z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              data-testid="stage-stop"
              title="Stop and return to start"
              aria-label="Stop and return to start"
              onClick={onStop}
              className={btn}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 truncate text-right text-[11px] text-neutral-300">
          {onImportAudio ? (
            <button
              type="button"
              data-testid="import-audio-open"
              onClick={onImportAudio}
              className="h-6 shrink-0 rounded-sm border border-studio-border bg-transparent px-1.5 text-[10px] text-neutral-300 hover:border-neutral-500 hover:text-white"
            >
              Import audio
            </button>
          ) : null}
          {rendering ? (
            <span className="text-studio-accent" data-testid="preview-render-status">
              {previewStatus === "buffering"
                ? `Buffering preview…${bufferHint ? ` ${bufferHint}` : ""}`
                : "Rendering preview…"}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            frame {frame} · {fps} fps · {script}
            {usingVideo ? <span className="ml-2 text-[10px] uppercase tracking-wide text-studio-accent">render</span> : null}
          </span>
        </div>
      </div>
    </div>
  );
}
