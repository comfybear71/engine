export type InsertActionId =
  | "walk"
  | "swing"
  | "cameraPush"
  | "frontBack"
  | "pose"
  | "move"
  | "do"
  | "propShow"
  | "propHide"
  | "insertStill";

export type InsertActionDef = {
  id: InsertActionId;
  label: string;
  template: (name: string) => string;
};

/** Known keys on `[Move: Name ...]` (including `action=` walk cycles). */
export const MOVE_KEYS = ["to", "over", "ease", "wait", "at_time", "start", "scale", "action"] as const;

/** Real tag syntax from docs/script-format.md. `{Name}` is a cast display name. */
export const INSERT_ACTIONS: InsertActionDef[] = [
  {
    id: "walk",
    label: "Walk",
    template: (name) => `[Move: ${name} to=right action=walk_side]`,
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
    id: "do",
    label: "Do action",
    template: (name) => `[Do: ${name} nod]`,
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
  {
    id: "insertStill",
    label: "Insert still",
    template: () => `[Insert: image=inserts/shot.png at_time=942 for=11]`,
  },
];

export type CheatSheetEntry = {
  id: string;
  /** The tag, as typed in a script. Character examples use `name`. */
  example: (name: string) => string;
  note: string;
};

export type CheatSheetGroup = {
  id: string;
  title: string;
  entries: CheatSheetEntry[];
};

/**
 * Script tags use only the first word as a character name, so a cast name with a
 * space ("Colnel Klink") is written as its id ("colnel_klink") in examples.
 */
export function scriptSafeName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "Name";
  if (!/\s/.test(trimmed)) return trimmed;
  return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Name";
}

/** One real example per tag and per useful option. Syntax from docs/script-format.md. */
export const CHEAT_SHEET: CheatSheetGroup[] = [
  {
    id: "setup",
    title: "Set up a scene",
    entries: [
      { id: "scene", example: () => "[Scene: Scene 1]", note: "Starts a scene. Everything below belongs to it." },
      { id: "location", example: () => "[Location: museum]", note: "Background and marks. Put it before Cast, Clip or Action lines." },
      { id: "cast", example: (n) => `[Cast: ${n}]`, note: "Who is in the scene, comma separated. Spaces in names are fine here." },
      { id: "comment", example: () => "# a note to myself", note: "Lines starting with # are ignored." },
    ],
  },
  {
    id: "clips",
    title: "Baked Action Shots ([Clip:])",
    entries: [
      { id: "clip", example: (n) => `[Clip: ${n} turn at_time=3s scale=0.75]`, note: "Plays a baked shot. Name, shot name, start time. Use the id for names with spaces." },
      { id: "clip-place", example: (n) => `[Clip: ${n} turn at_time=0s x=700 scale=0.7]`, note: "x= moves left/right (960 is the middle). y= moves up/down. scale= resizes." },
      { id: "clip-mark", example: (n) => `[Clip: ${n} turn at_time=0s mark=left]`, note: "Stand on a named spot instead of x=." },
      { id: "clip-trim", example: (n) => `[Clip: ${n} turn at_time=0s trim_in=0.5s trim_out=2s]`, note: "Play only a slice of the shot." },
      { id: "clip-speed", example: (n) => `[Clip: ${n} turn at_time=3s speed=2]`, note: "2 = twice as fast, 0.5 = half speed (0.1 to 8)." },
      { id: "clip-walk", example: (n) => `[Clip: ${n} side_profile_walking at_time=0s x=-200 scale=0.75 to=centre over=3s]`, note: "Starts off screen and slides to a mark (or to=x,y) over the time. Clip must be at least that long." },
      { id: "clip-flip", example: (n) => `[Clip: ${n} turn at_time=0s flip]`, note: "Mirror the clip left/right." },
    ],
  },
  {
    id: "camera",
    title: "Camera (keep these in time order)",
    entries: [
      { id: "cam-zoom", example: () => "[Camera: zoom=1.5 over=2s at_time=1s wait=false]", note: "Zoom in on the centre. over= is required. wait=false keeps the script clock where it is." },
      { id: "cam-face", example: () => "[Camera: to=640,270 zoom=3 over=0.5s at_time=1s wait=false]", note: "Zoom onto a spot (left/right, up/down on the 1920x1080 canvas)." },
      { id: "cam-pan", example: () => "[Camera: pan=1200,540 over=2s at_time=4s wait=false]", note: "Slide the view to a spot, same zoom." },
      { id: "cam-tilt", example: () => "[Camera: tilt=-100 over=1s at_time=4s wait=false]", note: "Move the view up (negative) or down (positive)." },
      { id: "cam-reset", example: () => "[Camera: reset over=0.5s at_time=6s wait=false]", note: "Back to the full picture. Put it after the zoom it undoes." },
    ],
  },
  {
    id: "audio",
    title: "Voices and sound",
    entries: [
      { id: "dialogue", example: (n) => `${n}: Hello there.`, note: "A spoken line. Lip-sync and timing come from it." },
      { id: "dialogue-timed", example: (n) => `${n} at_time=2s: Hello there.`, note: "Put the line at an exact time." },
      { id: "audio", example: (n) => `[Audio: ${n} file=my_take at_time=0s]`, note: "A recording from Import audio. file= is the label you gave it." },
      { id: "audio-trim", example: (n) => `[Audio: ${n} file=my_take at_time=0s trim_in=1s trim_out=4s]`, note: "Use only part of the recording." },
      { id: "pause", example: () => "[Pause: 0.5s]", note: "A gap of silence." },
    ],
  },
  {
    id: "rig",
    title: "Rig characters (moving parts)",
    entries: [
      { id: "action-at", example: (n) => `[Action: ${n} at=left]`, note: "Jump to a mark. Add flip to face the other way, scale=, or z= for draw order." },
      { id: "action-flip", example: (n) => `[Action: ${n} flip]`, note: "Turn to face the other way." },
      { id: "action-face", example: (n) => `[Action: ${n} eyes=furious]`, note: "Change a part (eyes, right_hand, body...) to a named drawing." },
      { id: "move", example: (n) => `[Move: ${n} to=right over=2s]`, note: "Slide to a mark or to=x,y. Add action=walk_side for a walk cycle." },
      { id: "walk", example: (n) => `[Move: ${n} to=right action=walk_side]`, note: "Walk to a mark with legs moving." },
      { id: "pose", example: (n) => `[Pose: ${n} right_arm=40 over=1s]`, note: "Turn a body part by degrees." },
      { id: "swing", example: (n) => `[Swing: ${n} right_arm=30 period=0.5s for=2s]`, note: "Wave a part back and forth." },
      { id: "do", example: (n) => `[Do: ${n} nod]`, note: "Play a saved action. [Do: Name rest] releases a held pose." },
      { id: "view", example: (n) => `[View: ${n} right_34]`, note: "Which way the head faces for following lines." },
      { id: "layer", example: (n) => `[Layer: ${n} z=30]`, note: "Draw in front of (bigger) or behind (smaller) others." },
    ],
  },
  {
    id: "props",
    title: "Props and stills",
    entries: [
      { id: "prop-show", example: () => "[Prop: mic_stand show]", note: "Show a prop the location declares." },
      { id: "prop-hide", example: () => "[Prop: mic_stand hide at_time=0s hold=28.8s]", note: "Hide it. at_time= and hold= control when and for how long." },
      { id: "prop-move", example: () => "[Prop: mic_stand at=centre]", note: "Move it to a mark, or at=640,480." },
      { id: "insert", example: () => "[Insert: image=inserts/shot.png at_time=942 for=11]", note: "Hold a still picture over a range of frames." },
    ],
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
