"use client";

import { useEffect, useMemo, useState } from "react";
import { addSceneToScript, nextSceneName, type NewSceneResult } from "@/lib/newScene";
import { loadCharacters, loadStaging, type Character, type Staging } from "@/lib/worker";

export default function NewSceneDialog({
  project,
  scriptText,
  currentSceneId,
  currentLocation,
  onCreate,
  onClose,
}: {
  project: string;
  scriptText: string;
  currentSceneId: string | null;
  currentLocation: string | null;
  onCreate: (result: NewSceneResult) => void;
  onClose: () => void;
}) {
  const [backgrounds, setBackgrounds] = useState<Staging["backgrounds"]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(() => nextSceneName(scriptText));
  const [location, setLocation] = useState(currentLocation || "");
  const [cast, setCast] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadStaging(project), loadCharacters(project)])
      .then(([staging, chars]) => {
        if (cancelled) return;
        setBackgrounds(staging.backgrounds);
        setCharacters(chars);
        setLocation((current) => current || staging.backgrounds[0]?.id || "");
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load backgrounds and characters");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const castNames = useMemo(() => {
    const names = characters.map((character) => character.display_name);
    for (const name of cast) if (!names.includes(name)) names.push(name);
    return names;
  }, [characters, cast]);

  function toggle(castName: string) {
    setCast((current) => (current.includes(castName) ? current.filter((item) => item !== castName) : [...current, castName]));
  }

  function create() {
    const result = addSceneToScript(scriptText, { afterSceneId: currentSceneId, name, location, cast });
    if (!result) {
      setError("Pick a background first.");
      return;
    }
    onCreate(result);
  }

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      data-testid="new-scene-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="w-full max-w-md rounded-md border border-studio-border bg-studio-panel p-4 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-white">New scene</h2>
        <p className="mb-3 text-[11px] text-studio-muted">
          Added after the scene you are on. It gets its own background and cast; nothing in the other scenes changes.
        </p>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] text-studio-muted">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-neutral-100"
            data-testid="new-scene-name"
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] text-studio-muted">Background</span>
          <select
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            className="w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1.5 text-sm text-neutral-100"
            data-testid="new-scene-location"
          >
            {loaded && backgrounds.length === 0 ? <option value="">No backgrounds yet</option> : null}
            {backgrounds.map((background) => (
              <option key={background.id} value={background.id}>
                {background.id}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="mb-3">
          <legend className="mb-1 text-[11px] text-studio-muted">Who is in it</legend>
          <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
            {castNames.length === 0 ? <span className="text-xs text-studio-muted">No characters yet</span> : null}
            {castNames.map((castName) => (
              <label key={castName} className="flex items-center gap-1.5 text-xs text-neutral-200">
                <input
                  type="checkbox"
                  checked={cast.includes(castName)}
                  onChange={() => toggle(castName)}
                  data-testid={`new-scene-cast-${castName}`}
                />
                {castName}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-studio-muted">
            Characters shown as Action Shots (like a walking clip) do not need to be ticked; drop the clip onto the stage
            instead.
          </p>
        </fieldset>
        {error ? <p className="mb-3 text-xs text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200 hover:text-white"
            data-testid="new-scene-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={!location}
            className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            data-testid="new-scene-create"
          >
            Add scene
          </button>
        </div>
      </div>
    </div>
  );
}
