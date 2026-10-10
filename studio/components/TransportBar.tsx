"use client";

import { formatTimecode } from "@/lib/playhead";

export default function TransportBar({
  frame,
  maxFrame,
  fps,
  script,
  playing,
  usingVideo,
  previewStatus,
  onRewind,
  onTogglePlay,
  onStop,
}: {
  frame: number;
  maxFrame: number;
  fps: number;
  script: string;
  playing: boolean;
  usingVideo: boolean;
  previewStatus?: "idle" | "rendering" | null;
  onRewind: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  const rendering = previewStatus === "rendering";
  return (
    <div
      className="z-10 shrink-0 border-t border-studio-border bg-studio-panel px-3 py-2"
      data-testid="transport-bar"
    >
      <div className="flex items-center gap-3">
        <div className="w-[9.5rem] shrink-0 font-mono text-xs tabular-nums text-neutral-200">
          {formatTimecode(frame, fps)} / {formatTimecode(maxFrame, fps)}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div
            className="flex items-center gap-1 rounded-full border border-neutral-600 bg-black/60 px-1.5 py-0.5 shadow-md"
            role="group"
            aria-label="Playback"
          >
            <button
              type="button"
              data-testid="stage-rewind"
              title="Rewind to start"
              aria-label="Rewind to start"
              onClick={onRewind}
              className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
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
              className="flex h-11 w-11 items-center justify-center rounded-full bg-studio-accent text-black shadow hover:bg-studio-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {playing ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                  <path d="M7 6h3.5v12H7V6zm6.5 0H17v12h-3.5V6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor" aria-hidden="true">
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
              className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>
          </div>
        </div>
        <div className="min-w-0 flex-1 truncate text-right text-xs text-neutral-300">
          {rendering ? (
            <span className="mr-2 text-studio-accent" data-testid="preview-render-status">
              Rendering preview…
            </span>
          ) : null}
          frame {frame} · {fps} fps · {script}
          {usingVideo ? <span className="ml-2 text-[10px] uppercase tracking-wide text-studio-accent">render</span> : null}
        </div>
      </div>
    </div>
  );
}
