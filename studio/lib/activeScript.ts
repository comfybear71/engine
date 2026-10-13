/**
 * Last-selected script per project. Browser refresh must restore the file
 * the owner was on, not fall back to script.txt / newest.
 */

export const ACTIVE_SCRIPT_KEY = "engine.studio.activeScript.v1";

const SAFE_SCRIPT = /^script(?:_[A-Za-z0-9][A-Za-z0-9._-]*)?\.txt$/;

export function isRememberableScript(name: string | null | undefined): name is string {
  if (!name || typeof name !== "string") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return SAFE_SCRIPT.test(name);
}

export function parseActiveScriptMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [project, script] of Object.entries(data as Record<string, unknown>)) {
      if (project && isRememberableScript(typeof script === "string" ? script : "")) {
        out[project] = script as string;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberedScript(
  map: Record<string, string>,
  project: string | null | undefined
): string {
  if (!project) return "";
  const name = map[project];
  return isRememberableScript(name) ? name : "";
}

export function rememberScript(
  map: Record<string, string>,
  project: string,
  script: string
): Record<string, string> {
  if (!project || !isRememberableScript(script)) return map;
  if (map[project] === script) return map;
  return { ...map, [project]: script };
}

export function readRememberedScript(project: string | null | undefined): string {
  if (typeof window === "undefined" || !project) return "";
  try {
    return rememberedScript(parseActiveScriptMap(window.localStorage.getItem(ACTIVE_SCRIPT_KEY)), project);
  } catch {
    return "";
  }
}

export function writeRememberedScript(project: string, script: string): void {
  if (typeof window === "undefined" || !project || !isRememberableScript(script)) return;
  try {
    const next = rememberScript(
      parseActiveScriptMap(window.localStorage.getItem(ACTIVE_SCRIPT_KEY)),
      project,
      script
    );
    window.localStorage.setItem(ACTIVE_SCRIPT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
}
