export type InsertActionId =
  | "walk"
  | "swing"
  | "cameraPush"
  | "frontBack"
  | "pose"
  | "move"
  | "propShow"
  | "propHide";

export type InsertActionDef = {
  id: InsertActionId;
  label: string;
  template: (name: string) => string;
};

/** Real tag syntax from docs/script-format.md. `{Name}` is a cast display name. */
export const INSERT_ACTIONS: InsertActionDef[] = [
  {
    id: "walk",
    label: "Walk",
    template: (name) => `[Action: ${name} body=walk_side]\n[Move: ${name} to=mark over=2s]`,
  },
  {
    id: "swing",
    label: "Swing arms",
    template: (name) => `[Swing: ${name} right_arm=30 period=0.5s for=2s]`,
  },
  {
    id: "cameraPush",
    label: "Camera push-in",
    template: () => `[Camera: zoom=1.3 over=8s]`,
  },
  {
    id: "frontBack",
    label: "Front/Back",
    template: (name) => `[Layer: ${name} z=30]`,
  },
  {
    id: "pose",
    label: "Pose",
    template: (name) => `[Pose: ${name} right_arm=40 over=1s]`,
  },
  {
    id: "move",
    label: "Move",
    template: (name) => `[Move: ${name} to=mark over=2s]`,
  },
  {
    id: "propShow",
    label: "Prop show",
    template: () => `[Prop: name show]`,
  },
  {
    id: "propHide",
    label: "Prop hide",
    template: () => `[Prop: name hide]`,
  },
];

/**
 * Insert Action drop: put `snippet` at the textarea selection, adding a
 * leading newline when the cursor is mid-line, and a trailing newline.
 */
export function insertSnippetAtCursor(
  text: string,
  snippet: string,
  selectionStart: number,
  selectionEnd: number = selectionStart
): { next: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(text.length, Number(selectionEnd) || 0));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length && !before.endsWith("\n") ? "\n" : "";
  const next = `${before}${prefix}${snippet}\n${after}`;
  const cursor = start + prefix.length + snippet.length + 1;
  return { next, cursor };
}
