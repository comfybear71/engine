/**
 * Script edit behind the Stage "New scene" button: writes
 * [Scene:] / [Location:] / [Cast:] after an existing scene.
 */

import { slugifySceneName } from "./cameraTag.ts";

const SCENE_LINE = /^\s*\[Scene:\s*(.+?)\s*\]/i;
const CAST_LINE = /^\s*\[Cast:\s*(.*?)\s*\]/i;
const DIVIDER_LINE = /^\s*=+\s*$/;

function sceneRange(lines: string[], sceneId: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SCENE_LINE);
    if (!match) continue;
    if (start >= 0) return { start, end: i };
    if (slugifySceneName(match[1]) === sceneId) start = i;
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

export function sceneIds(script: string): string[] {
  const ids: string[] = [];
  for (const line of script.split("\n")) {
    const match = line.match(SCENE_LINE);
    if (match) ids.push(slugifySceneName(match[1]));
  }
  return ids;
}

export function sceneCastNames(script: string, sceneId: string | null): string[] {
  if (!sceneId) return [];
  const lines = script.split("\n");
  const range = sceneRange(lines, sceneId);
  if (!range) return [];
  for (let i = range.start + 1; i < range.end; i++) {
    const match = lines[i].match(CAST_LINE);
    if (match) {
      return match[1]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function nextSceneName(script: string): string {
  const taken = new Set(sceneIds(script));
  let n = taken.size + 1;
  while (taken.has(slugifySceneName(`Scene ${n}`))) n += 1;
  return `Scene ${n}`;
}

export type NewSceneResult = { script: string; sceneId: string; name: string };

/**
 * Adds a scene after `afterSceneId` (or at the end of the file when that scene
 * is unknown). A name that would collide with an existing scene gets " 2", " 3"…
 * so the returned `sceneId` matches what the parser will call it.
 */
export function addSceneToScript(
  script: string,
  opts: { afterSceneId: string | null; name: string; location: string; cast: string[] }
): NewSceneResult | null {
  const location = opts.location.trim();
  if (!location) return null;
  const taken = new Set(sceneIds(script));
  const baseName = opts.name.replace(/[\[\]\r\n]+/g, " ").trim() || nextSceneName(script);
  let name = baseName;
  let n = 2;
  while (taken.has(slugifySceneName(name))) {
    name = `${baseName} ${n}`;
    n += 1;
  }
  const lines = script.split("\n");
  const range = opts.afterSceneId ? sceneRange(lines, opts.afterSceneId) : null;
  let at = range ? range.end : lines.length;
  while (at > (range ? range.start + 1 : 0) && (lines[at - 1].trim() === "" || DIVIDER_LINE.test(lines[at - 1]))) {
    at -= 1;
  }
  const cast = opts.cast.map((item) => item.trim()).filter(Boolean);
  const block = ["", `[Scene: ${name}]`, `[Location: ${location}]`, ...(cast.length ? [`[Cast: ${cast.join(", ")}]`] : [])];
  if (at >= lines.length) {
    lines.push(...block, "");
  } else {
    lines.splice(at, 0, ...block);
  }
  return { script: lines.join("\n"), sceneId: slugifySceneName(name), name };
}
