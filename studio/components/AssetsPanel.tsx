"use client";

import { useEffect, useMemo, useState } from "react";
import AlignHeadModal from "@/components/AlignHeadModal";
import AssetEditorOverlay from "@/components/AssetEditorOverlay";
import CharacterReferenceCard from "@/components/CharacterReferenceCard";
import type { AssetFocus } from "@/lib/assetEditor";
import { alignableSlots } from "@/lib/headAlign";
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
  fit = "cover",
}: {
  src: string | null;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  badge?: string;
  fit?: "cover" | "contain";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full flex-col gap-1.5 text-left ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <div
        className={`relative aspect-square overflow-hidden rounded-md border ${
          fit === "contain" ? "studio-checker" : "bg-studio-raised"
        } ${selected ? "border-studio-accent ring-2 ring-studio-accent/40" : "border-studio-border"}`}
      >
        {src ? (
          // Worker-served PNGs; next/image remote config is out of scope for localhost.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={label}
            className={`h-full w-full ${fit === "contain" ? "object-contain object-bottom" : "object-cover"}`}
          />
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

function SlotBlock({
  slot,
  project,
  characterId,
  onOpen,
}: {
  slot: CharacterSlot;
  project: string;
  characterId: string;
  onOpen?: (focus: AssetFocus) => void;
}) {
  const cycleEntries = Object.entries(slot.cycles || {});
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-white">
          <button
            type="button"
            className="hover:text-studio-accent"
            data-testid={`assets-slot-${slot.name}`}
            onClick={() => onOpen?.({ mode: "slot", characterId, slot: slot.name })}
          >
            {slot.name}
          </button>
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
            src={assetUrl(project, drawing.rel, { v: drawing.mtime })}
            label={drawing.name}
            selected={drawing.name === slot.default_drawing}
            fit="contain"
            onClick={() =>
              onOpen?.({ mode: "drawing", characterId, slot: slot.name, drawing: drawing.name })
            }
          />
        ))}
      </div>
    </section>
  );
}

export default function AssetsPanel({
  project,
  workerUp,
  script,
  onLibraryChange,
  variant = "page",
  poolSection = "assets",
  selectedId: selectedIdProp,
  onSelectId,
  onOpenImagine,
  refreshToken = 0,
}: {
  project: string | null;
  workerUp: boolean;
  script?: string | null;
  onLibraryChange?: () => void;
  variant?: "page" | "pool";
  poolSection?: "assets" | "media" | "effects";
  selectedId?: string | null;
  onSelectId?: (id: string | null) => void;
  onOpenImagine?: (opts?: { characterId?: string; needId?: string }) => void;
  refreshToken?: number;
}) {
  const pool = variant === "pool";
  const [characters, setCharacters] = useState<Character[]>([]);
  const [staging, setStaging] = useState<Staging | null>(null);
  const [selectedIdState, setSelectedIdState] = useState<string | null>(null);
  const selectedId = onSelectId ? selectedIdProp ?? null : selectedIdState;
  const setSelectedId = onSelectId ?? setSelectedIdState;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryChars, setLibraryChars] = useState<Character[]>([]);
  const [libraryAdded, setLibraryAdded] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [alignOpen, setAlignOpen] = useState(false);
  const [assetFocus, setAssetFocus] = useState<AssetFocus | null>(null);

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
        const current = selectedId;
        setSelectedId(current && chars.some((c) => c.id === current) ? current : chars[0]?.id ?? null);
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
  }, [project, workerUp, reloadKey, refreshToken]);

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

  useEffect(() => {
    setAlignOpen(false);
  }, [selectedId]);

  if (!project) {
    return <EmptyState message="Pick a project to browse the library." />;
  }

  const showCharacters = !pool || poolSection === "assets";
  const showBackgrounds = !pool || poolSection === "media";
  const showProps = !pool || poolSection === "effects";
  const gridClass = pool
    ? "grid grid-cols-2 gap-2"
    : "grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className={`min-w-0 flex-1 overflow-y-auto ${pool ? "p-3" : "p-5"}`}>
        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}
        {loading ? <p className="mb-4 text-sm text-studio-muted">Loading library…</p> : null}

        <div className={`mb-4 flex items-center justify-between ${pool ? "gap-2" : "mb-6"}`}>
          <p className="text-sm text-studio-muted">
            {pool
              ? poolSection === "assets"
                ? "Library characters"
                : poolSection === "media"
                  ? "Backgrounds"
                  : "Props"
              : "Characters, backgrounds, and props this project uses."}
          </p>
          {showCharacters ? (
            <div className="flex shrink-0 items-center gap-2">
              {onOpenImagine ? (
                <button
                  type="button"
                  data-testid="imagine-open"
                  onClick={() => onOpenImagine()}
                  className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
                >
                  Grok Imagine
                </button>
              ) : null}
              <button
                type="button"
                data-testid="library-open"
                onClick={() => setLibraryOpen(true)}
                className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
              >
                Library
              </button>
            </div>
          ) : null}
        </div>

        {showCharacters ? (
        <Section title="Characters" count={characters.length}>
          {characters.length === 0 ? (
            <p className="text-sm text-studio-muted">None in this project yet. Open Library to add a global character.</p>
          ) : (
          <div className={gridClass}>
            {characters.map((character) => (
              <Thumb
                key={character.id}
                src={assetUrl(project, character.thumbRel, { thumb: true, v: character.mtime })}
                label={character.display_name}
                badge={character.source === "project" ? "local" : character.source === "show" ? "show" : undefined}
                selected={character.id === selectedId}
                fit="contain"
                onClick={() => setSelectedId(character.id)}
              />
            ))}
          </div>
          )}
        </Section>
        ) : null}

        {showBackgrounds ? (
        <Section title="Backgrounds" count={staging?.backgrounds.length ?? 0}>
          <div className={gridClass}>
            {(staging?.backgrounds || []).map((bg) => (
              <Thumb key={bg.id} src={assetUrl(project, bg.thumbRel, { thumb: true, v: bg.mtime })} label={bg.id} />
            ))}
          </div>
        </Section>
        ) : null}

        {showProps ? (
        <Section title="Props" count={staging?.props.length ?? 0}>
          {(staging?.props || []).length === 0 ? (
            <p className="text-sm text-studio-muted">No props in this project&apos;s staging.json.</p>
          ) : (
            <div className={gridClass}>
              {(staging?.props || []).map((prop) => (
                <Thumb
                  key={`${prop.location}:${prop.id}`}
                  src={assetUrl(project, prop.thumbRel, { thumb: true, v: prop.mtime })}
                  label={`${prop.id} · ${prop.location}`}
                />
              ))}
            </div>
          )}
        </Section>
        ) : null}
      </div>

      {pool ? null : (
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
            <CharacterReferenceCard
              project={project}
              character={selected}
              onChanged={() => {
                setReloadKey((n) => n + 1);
                onLibraryChange?.();
              }}
            />
            {alignableSlots(selected.slots).length > 0 ? (
              <button
                type="button"
                data-testid="align-head"
                onClick={() => setAlignOpen(true)}
                className="w-full rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
              >
                Align head
              </button>
            ) : null}
            {selected.slots.length === 0 ? (
              <p className="text-sm text-studio-muted">No slots on this character.</p>
            ) : (
              selected.slots.map((slot) => (
                <SlotBlock
                  key={`${slot.owner || "root"}:${slot.name}`}
                  slot={slot}
                  project={project}
                  characterId={selected.id}
                  onOpen={setAssetFocus}
                />
              ))
            )}
          </div>
        ) : (
          <p className="text-sm text-studio-muted">Click a character to see slots, drawings, and cycles.</p>
        )}
      </aside>
      )}

      {assetFocus && project ? (
        <div className="fixed inset-8 z-40 overflow-hidden rounded-md shadow-2xl">
          <AssetEditorOverlay
            project={project}
            focus={assetFocus}
            onFocus={setAssetFocus}
            onClose={() => setAssetFocus(null)}
            onChanged={() => {
              setReloadKey((n) => n + 1);
              onLibraryChange?.();
            }}
            onOpenImagine={(opts) => {
              setSelectedId(opts.characterId);
              onOpenImagine?.(opts);
            }}
          />
        </div>
      ) : null}

      {alignOpen && selected ? (
        <AlignHeadModal
          project={project}
          character={selected}
          script={script}
          onClose={() => setAlignOpen(false)}
          onChanged={() => {
            setReloadKey((n) => n + 1);
            onLibraryChange?.();
          }}
        />
      ) : null}

      {libraryOpen ? (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={() => setLibraryOpen(false)}>
          <aside
            className="flex h-full w-full max-w-md flex-col border-l border-studio-border bg-studio-panel shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            data-testid="library-drawer"
          >
            <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">Library</h2>
                <p className="text-[11px] text-studio-muted">
                  Global characters from _global_assets. Adding records a reference — art is not copied.
                </p>
              </div>
              <button
                type="button"
                data-testid="library-close"
                className="shrink-0 text-sm text-studio-muted hover:text-white"
                onClick={() => setLibraryOpen(false)}
              >
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
                      <Thumb
                        src={assetUrl(project, character.thumbRel, { thumb: true, v: character.mtime })}
                        label={character.display_name}
                        fit="contain"
                      />
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
