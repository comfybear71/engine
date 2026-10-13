declare module "../../shared/placement.js" {
  export function evaluateFrame(
    graph: unknown,
    frame: number
  ): {
    frame: number;
    canvas: { width: number; height: number };
    fps: number;
    commands: Array<Record<string, unknown>>;
  };
  export function collectRels(graph: unknown): string[];
  export function backgroundDestRect(
    cmd: Record<string, unknown>,
    canvasW: number,
    canvasH: number
  ): { x: number; y: number; w: number; h: number };
  export function evaluateBackgroundRect(
    graph: unknown,
    frame: number
  ): { x: number; y: number; w: number; h: number } | null;
  export function anchorOffset(anchor: string, width: number, height: number): [number, number];
  export function rotateOffsetClockwise(x: number, y: number, degrees: number): [number, number];
}
