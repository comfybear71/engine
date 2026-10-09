"use client";

import { useRef } from "react";

export default function PanelSplitter({
  axis,
  label,
  testId,
  onDrag,
  onReset,
}: {
  axis: "x" | "y";
  label: string;
  testId: string;
  onDrag: (delta: number) => void;
  onReset: () => void;
}) {
  const last = useRef(0);

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      data-testid={testId}
      title="Drag to resize · double-click to reset"
      className={
        axis === "x"
          ? "group relative z-10 h-full w-1.5 shrink-0 cursor-col-resize bg-studio-border hover:bg-studio-accent"
          : "group relative z-10 h-1.5 w-full shrink-0 cursor-row-resize bg-studio-border hover:bg-studio-accent"
      }
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = axis === "x" ? event.clientX : event.clientY;
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const now = axis === "x" ? event.clientX : event.clientY;
        const delta = now - last.current;
        last.current = now;
        if (delta !== 0) onDrag(delta);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
    />
  );
}
