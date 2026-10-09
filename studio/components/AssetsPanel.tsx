"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addLibraryCharacter,
  assetUrl,
  loadCharacters,
  loadLibrary,
  loadStaging,
  type Character,
  type CharacterSlot,
  type Staging,
} from "@/lib/worker";

function Thumb({
  src,
  label,
  selected,
  onClick,
  badge,
}: {
  src: string | null;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full flex-col gap-1.5 text-left ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <div
        className={`relative aspect-square overflow-hidden rounded-md border bg-studio-raised ${
          selected ? "border-studio-accent ring-2 ring-studio-accent/40" : "border-studio-border"
        }`}
      >
        {src ? (
          // Worker-served PNGs; next/image remote config is out of scope for localhost.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-studio-muted">No art</div>
        )}
        {badge ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] uppercase tracking-wide text-neutral-300">
            {badge}
          </span>
        ) : null}
      </div>
      <span className="truncate text-xs text-neutral-300 group-hover:text-white">{label}</span>
    </button>
  );
}

function SlotBlock({ slot, project }: { slot: CharacterSlot; project: string }) {
  const cycleEntries = Object.entries(slot.cycles || {});
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-white">
          {slot.name}
          {slot.owner ? <span className="ml-2 text-xs font-normal text-studio-muted">on {slot.owner}</span> : null}
        </h4>
        {slot.default_drawing ? (
          <span className="text-[11px] text-studio-muted">default {slot.default_drawing}</span>
        ) : null}
      </div>
      {cycleEntries.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {cycleEntries.map(([name, cycle]) => (
            <span
              key={name}
              className="rounded-full border border-studio-border bg-studio-raised px-2 py-0.5 text-[11px] text-neutral-300"
              title={cycle.drawings.join(" → ")}
            >
              cycle {name} · {cycle.fps} fps · {cycle.drawings.length} drawings
            </span>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
        {slot.drawings.map((drawing) => (
          <Thumb
            key={drawing.name}
            src={assetUrl(project, drawing.rel)}
            label={drawing.name}
            selected={drawing.name === slot.default_drawing}
          />
        ))}
      </div>
    </section>
  );
}

export default function AssetsPanel({
  project,
  workerUp,
  onLibraryChange,
}: {
  project: string | null;
  workerUp: boolean;
  onLibraryChange?: () => void;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [staging, setStaging] = useState<Staging | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryChars, setLibraryChars] = useState<Character[]>([]);
  const [libraryAdded, setLibraryAdded] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadCharacters(project), loadStaging(project)])
      .then(([chars, nextStaging]) => {
        if (cancelled) return;
        setCharacters(chars);
        setStaging(nextStaging);
        setSelectedId((current) => current && chars.some((c) => c.id === current) ? current : chars[0]?.id ?? null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, reloadKey]);

  useEffect(() => {
    if (!project || !workerUp || !libraryOpen) return;
    let cancelled = false;
    loadLibrary(project)
      .then((lib) => {
        if (cancelled) return;
        setLibraryChars(lib.characters);
        setLibraryAdded(lib.added);
        setLibraryError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setLibraryError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, libraryOpen, reloadKey]);

  async function onAddFromLibrary(characterId: string) {
    if (!project || addingId) return;
    setAddingId(characterId);
    setLibraryError(null);
    try {
      await addLibraryCharacter(project, characterId);
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : "Could not add character");
    } finally {
      setAddingId(null);
    }
  }

  const selected = useMemo(
    () => characters.find((c) => c.id === selectedId) || null,
    [characters, selectedId]
  );

  if (!project) {
    return <EmptyState message="Pick a project to browse the library." />;
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}
        {loading ? <p className="mb-4 text-sm text-studio-muted">Loading library…</p> : null}

        <div className="mb-6 flex items-center justify-between">
          <p className="text-sm text-studio-muted">Characters, backgrounds, and props this project uses.</p>
          <button
            type="button"
            data-testid="library-open"
            onClick={() => setLibraryOpen(true)}
            className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
          >
            Library
          </button>
        </div>

        <Section title="Characters" count={characters.length}>
          {characters.length === 0 ? (
            <p className="text-sm text-studio-muted">None in this project yet. Open Library to add a global character.</p>
          ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {characters.map((character) => (
              <Thumb
                key={character.id}
                src={assetUrl(project, character.thumbRel)}
                label={character.display_name}
                badge={character.source === "project" ? "local" : undefined}
                selected={character.id === selectedId}
                onClick={() => setSelectedId(character.id)}
              />
            ))}
          </div>
          )}
        </Section>

        <Section title="Backgrounds" count={staging?.backgrounds.length ?? 0}>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {(staging?.backgrounds || []).map((bg) => (
              <Thumb key={bg.id} src={assetUrl(project, bg.thumbRel)} label={bg.id} />
            ))}
          </div>
        </Section>

        <Section title="Props" count={staging?.props.length ?? 0}>
          {(staging?.props || []).length === 0 ? (
            <p className="text-sm text-studio-muted">No props in this project&apos;s staging.json.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {(staging?.props || []).map((prop) => (
                <Thumb
                  key={`${prop.location}:${prop.id}`}
                  src={assetUrl(project, prop.thumbRel)}
                  label={`${prop.id} · ${prop.location}`}
                />
              ))}
            </div>
          )}
        </Section>
      </div>

      <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-studio-border bg-studio-panel p-4">
        {selected ? (
          <div className="space-y-5">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-studio-muted">Character</p>
              <h2 className="text-lg font-semibold text-white">{selected.display_name}</h2>
              <p className="text-xs text-studio-muted">
                {selected.id} · {selected.source} · z {selected.z}
              </p>
            </div>
            {selected.slots.length === 0 ? (
              <p className="text-sm text-studio-muted">No slots on this character.</p>
            ) : (
              selected.slots.map((slot) => (
                <SlotBlock key={`${slot.owner || "root"}:${slot.name}`} slot={slot} project={project} />
              ))
            )}
          </div>
        ) : (
          <p className="text-sm text-studio-muted">Click a character to see slots, drawings, and cycles.</p>
        )}
      </aside>

      {libraryOpen ? (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={() => setLibraryOpen(false)}>
          <aside
            className="flex h-full w-full max-w-md flex-col border-l border-studio-border bg-studio-panel shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            data-testid="library-drawer"
          >
            <div className="flex items-center justify-between border-b border-studio-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Library</h2>
                <p className="text-[11px] text-studio-muted">Global characters from _global_assets. Adding records a reference — art is not copied.</p>
              </div>
              <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={() => setLibraryOpen(false)}>
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {libraryError ? <p className="mb-3 text-sm text-red-400">{libraryError}</p> : null}
              <div className="grid grid-cols-3 gap-3">
                {libraryChars.map((character) => {
                  const added = libraryAdded.includes(character.id) || characters.some((c) => c.id === character.id);
                  return (
                    <div key={character.id} className="space-y-1.5">
                      <Thumb src={assetUrl(project, character.thumbRel)} label={character.display_name} />
                      <button
                        type="button"
                        disabled={added || addingId === character.id}
                        onClick={() => void onAddFromLibrary(character.id)}
                        className="w-full rounded-md border border-studio-border px-2 py-1 text-[11px] text-neutral-200 hover:text-white disabled:cursor-default disabled:opacity-40"
                        data-testid={`library-add-${character.id}`}
                      >
                        {added ? "In project" : addingId === character.id ? "Adding…" : "Add"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {libraryChars.length === 0 ? (
                <p className="text-sm text-studio-muted">No global characters in projects/_global_assets.</p>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">{title}</h3>
        <span className="rounded-full bg-studio-raised px-2 py-0.5 text-[11px] text-neutral-400">{count}</span>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-studio-muted">{message}</div>
  );
}
