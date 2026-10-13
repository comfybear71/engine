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
  export function anchorOffset(anchor: string, width: number, height: number): [number, number];
  export function rotateOffsetClockwise(x: number, y: number, degrees: number): [number, number];
}
