export type CameraEase = "linear" | "inout";

export type CameraMoveForm = {
  zoom: string;
  pan: string;
  tilt: string;
  to: string;
  reset: boolean;
  over: string;
  ease: CameraEase;
};

export type CameraTagResult = { ok: true; tag: string } | { ok: false; error: string };

export const DEFAULT_CAMERA_FORM: CameraMoveForm = {
  zoom: "",
  pan: "",
  tilt: "",
  to: "",
  reset: false,
  over: "2s",
  ease: "linear",
};

export function normalizeOver(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n}s`;
}

export function buildCameraTag(form: CameraMoveForm): CameraTagResult {
  const over = normalizeOver(form.over);
  if (!over) return { ok: false, error: "over is required (e.g. 2s)" };

  const zoom = form.zoom.trim();
  const pan = form.pan.trim();
  const tilt = form.tilt.trim();
  const to = form.to.trim();
  const bits: string[] = [];

  if (form.reset) {
    if (zoom || pan || tilt || to) {
      return { ok: false, error: "reset cannot combine with zoom, pan, tilt, or to" };
    }
    bits.push("reset");
  } else {
    if (!zoom && !pan && !tilt && !to) {
      return { ok: false, error: "needs zoom, pan, tilt, to, or reset" };
    }
    if (to && pan) return { ok: false, error: "cannot combine to and pan" };
    if (to && tilt) return { ok: false, error: "cannot combine to and tilt" };
    if (zoom) bits.push(`zoom=${zoom}`);
    if (pan) bits.push(`pan=${pan}`);
    if (tilt) bits.push(`tilt=${tilt}`);
    if (to) bits.push(`to=${to}`);
  }

  bits.push(`over=${over}`);
  if (form.ease === "inout") bits.push("ease=inout");
  return { ok: true, tag: `[Camera: ${bits.join(" ")}]` };
}

/** Insert `line` after 1-based `afterLine` (0 = start of file). */
export function insertLineAfter(text: string, afterLine: number, line: string): string {
  const lines = text.split("\n");
  const idx = Math.max(0, Math.min(lines.length, Math.round(afterLine)));
  lines.splice(idx, 0, line);
  return lines.join("\n");
}

export function slugifySceneName(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "scene"
  );
}

/**
 * Where to insert a new [Camera:] tag: after the playhead's script line when
 * it is in this shot, otherwise after the last line of the current scene.
 */
export function findInsertAfterLine(
  scriptText: string,
  playheadLine: number | null,
  sceneId: string | null
): number {
  const lines = scriptText.split("\n");
  if (playheadLine != null && playheadLine >= 1) {
    return Math.min(playheadLine, lines.length);
  }
  if (!sceneId) return lines.length;
  let inScene = false;
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*\[Scene:\s*(.+?)\s*\]/i);
    if (match) {
      const id = slugifySceneName(match[1]);
      if (inScene && id !== sceneId) return last;
      inScene = id === sceneId;
    }
    if (inScene) last = i + 1;
  }
  return last || lines.length;
}
