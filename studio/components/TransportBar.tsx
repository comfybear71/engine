"use client";

import { formatTimecode } from "@/lib/playhead";

export default function TransportBar({
  frame,
  maxFrame,
  fps,
  script,
  playing,
  usingVideo,
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
  onRewind: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  return (
    <div className="border-t border-studio-border bg-studio-panel px-3 py-2" data-testid="transport-bar">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="font-mono text-xs tabular-nums text-studio-muted">
          {formatTimecode(frame, fps)} / {formatTimecode(maxFrame, fps)}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="stage-rewind"
            title="Rewind"
            aria-label="Rewind"
            onClick={onRewind}
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-studio-raised hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M11.5 12l8.5 6V6l-8.5 6zM4 6h2v12H4V6z" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="stage-play"
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
            onClick={onTogglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-studio-accent text-black hover:bg-studio-accent-hover"
          >
            {playing ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M7 6h3.5v12H7V6zm6.5 0H17v12h-3.5V6z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor">
                <path d="M8 5v14l12-7L8 5z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            data-testid="stage-stop"
            title="Stop"
            aria-label="Stop"
            onClick={onStop}
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-studio-raised hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        </div>
        <div className="text-right text-xs text-studio-muted">
          frame {frame} · {fps} fps · {script}
          {usingVideo ? <span className="ml-2 text-[10px] uppercase tracking-wide">render</span> : null}
        </div>
      </div>
    </div>
  );
}
