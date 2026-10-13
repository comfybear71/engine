import {
  anchorOffset,
  collectRels as collectRelsJs,
  evaluateFrame as evaluateFrameJs,
  rotateOffsetClockwise,
} from "../../shared/placement.js";

export type PreviewCommand = {
  kind: "bg" | "sprite";
  rel?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  scale?: number;
  flipX?: boolean;
  rotation?: number;
  opacity?: number;
  anchor?: string;
  pivot?: [number, number] | number[] | null;
  fit?: string;
  cx?: number;
  cy?: number;
  zoom?: number;
  originX?: number;
  originY?: number;
  sx?: number;
  sy?: number;
};

export type EvaluatedFrame = {
  frame: number;
  canvas: { width: number; height: number };
  fps: number;
  commands: PreviewCommand[];
};

export function evaluateFrame(graph: unknown, frame: number): EvaluatedFrame {
  return evaluateFrameJs(graph, frame) as EvaluatedFrame;
}

export function collectRels(graph: unknown): string[] {
  return collectRelsJs(graph);
}

export function spriteDrawOffset(cmd: PreviewCommand): { dx: number; dy: number } {
  const width = Number(cmd.width) || 1;
  const height = Number(cmd.height) || 1;
  if (cmd.pivot && cmd.pivot.length >= 2) {
    return { dx: Number(cmd.pivot[0]) || 0, dy: Number(cmd.pivot[1]) || 0 };
  }
  const [ax, ay] = anchorOffset(cmd.anchor || "center", width, height);
  return { dx: ax, dy: ay };
}

export { anchorOffset, rotateOffsetClockwise };
