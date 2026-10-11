"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import AlignHeadModal from "@/components/AlignHeadModal";
import AssetEditorOverlay from "@/components/AssetEditorOverlay";
import CharacterReferenceCard from "@/components/CharacterReferenceCard";
import { slotViewGroups, type AssetFocus } from "@/lib/assetEditor";
import { alignableSlots } from "@/lib/headAlign";
import {
  addLibraryCharacter,
  assetUrl,
  loadCharacters,
  loadLibrary,
  loadStaging,
  loadStudioSettings,
  makeProjectIndependent,
  saveStudioSettings,
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
  compact = false,
}: {
  src: string | null;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  badge?: string;
  fit?: "cover" | "contain";
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`group flex flex-col text-left ${
        compact ? "w-11 shrink-0 gap-0.5" : "w-full gap-1.5"
      } ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <div
        className={`relative aspect-square overflow-hidden border ${
          compact ? "rounded-sm" : "rounded-md"
        } ${fit === "contain" ? "studio-checker" : "bg-studio-raised"} ${
          selected ? "border-studio-accent ring-1 ring-studio-accent/50" : "border-studio-border"
        }`}
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
      <span
        className={`truncate text-neutral-400 group-hover:text-white ${
          compact ? "text-[9px] leading-tight" : "text-xs text-neutral-300"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

function DrawingRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="studio-hscroll" data-testid={testId}>
      <div className="flex w-max items-start gap-1 py-0.5 pr-1">{children}</div>
    </div>
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
  const viewGroups = slot.name === "mouth" ? slotViewGroups(slot) : [];
  const totalCount =
    viewGroups.length > 0 ? viewGroups.reduce((sum, group) => sum + group.count, 0) : slot.drawings.length;
  return (
    <section className="space-y-0.5">
      <div className="flex items-baseline gap-1.5">
        <h4 className="min-w-0 text-[11px] font-medium leading-none text-white">
          <button
            type="button"
            className="hover:text-studio-accent"
            data-testid={`assets-slot-${slot.name}`}
            onClick={() => onOpen?.({ mode: "slot", characterId, slot: slot.name })}
          >
            {slot.name}
          </button>
          {slot.owner ? <span className="ml-1 font-normal text-studio-muted">on {slot.owner}</span> : null}
        </h4>
        <span className="text-[10px] tabular-nums text-neutral-500">{totalCount}</span>
        {slot.default_drawing && viewGroups.length === 0 ? (
          <span className="truncate text-[9px] text-studio-muted">default {slot.default_drawing}</span>
        ) : null}
      </div>
      {cycleEntries.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {cycleEntries.map(([name, cycle]) => (
            <span
              key={name}
              className="text-[9px] leading-none text-neutral-500"
              title={cycle.drawings.join(" → ")}
            >
              {name} · {cycle.drawings.length}
            </span>
          ))}
        </div>
      ) : null}
      {viewGroups.length > 0 ? (
        <div className="space-y-1">
          {viewGroups.map((group) => (
            <div key={group.drawingsDir} className="space-y-0.5" data-testid={`assets-slot-view-${group.id}`}>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-medium leading-none text-neutral-300">{group.label}</span>
                <span className="text-[10px] tabular-nums text-neutral-500">{group.count}</span>
                {group.isDefault ? (
                  <span
                    className="text-[8px] uppercase tracking-wide text-neutral-500"
                    data-testid="assets-view-default-tag"
                  >
                    default
                  </span>
                ) : null}
              </div>
              <DrawingRow testId={`assets-slot-row-${group.id}`}>
                {group.drawings.map((drawing) => (
                  <Thumb
                    key={`${group.id}:${drawing.name}`}
                    compact
                    src={assetUrl(project, drawing.rel, { v: drawing.mtime })}
                    label={drawing.name}
                    selected={group.isDefault && drawing.name === slot.default_drawing}
                    fit="contain"
                    onClick={() =>
                      onOpen?.({
                        mode: "drawing",
                        characterId,
                        slot: slot.name,
                        drawing: drawing.name,
                        view: group.id === "mouth" ? undefined : group.id,
                      })
                    }
                  />
                ))}
              </DrawingRow>
            </div>
          ))}
        </div>
      ) : slot.drawings.length > 0 ? (
        <DrawingRow testId={`assets-slot-row-${slot.name}`}>
          {slot.drawings.map((drawing) => (
            <Thumb
              key={drawing.name}
              compact
              src={assetUrl(project, drawing.rel, { v: drawing.mtime })}
              label={drawing.name}
              selected={drawing.name === slot.default_drawing}
              fit="contain"
              onClick={() =>
                onOpen?.({ mode: "drawing", characterId, slot: slot.name, drawing: drawing.name })
              }
            />
          ))}
        </DrawingRow>
      ) : null}
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
  const [independent, setIndependent] = useState(true);
  const [independentBusy, setIndependentBusy] = useState(false);
  const [makeIndepBusy, setMakeIndepBusy] = useState(false);
  const [makeIndepNote, setMakeIndepNote] = useState<string | null>(null);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadCharacters(project), loadStaging(project), loadStudioSettings(project)])
      .then(([chars, nextStaging, settings]) => {
        if (cancelled) return;
        setCharacters(chars);
        setStaging(nextStaging);
        setIndependent(settings.independent !== false);
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

  async function onToggleIndependent(next: boolean) {
    if (!project || independentBusy) return;
    setIndependentBusy(true);
    setError(null);
    try {
      const saved = await saveStudioSettings(project, { independent: next });
      setIndependent(saved.independent !== false);
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save Independent setting");
    } finally {
      setIndependentBusy(false);
    }
  }

  async function onMakeIndependent() {
    if (!project || makeIndepBusy) return;
    setMakeIndepBusy(true);
    setError(null);
    setMakeIndepNote(null);
    try {
      const result = await makeProjectIndependent(project);
      setIndependent(result.independent !== false);
      const n = result.copied?.files || 0;
      setMakeIndepNote(
        n > 0
          ? `Copied ${n} shared-library file${n === 1 ? "" : "s"} into this project.`
          : "This project is independent. Shared-library files it already had stay local."
      );
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make this project independent");
    } finally {
      setMakeIndepBusy(false);
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

        <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 ${pool ? "" : "mb-6"}`}>
          <p className="text-sm text-studio-muted">
            {pool
              ? poolSection === "assets"
                ? "Library characters"
                : poolSection === "media"
                  ? "Backgrounds"
                  : "Props"
              : "Characters, backgrounds, and props this project uses. Only this project's drawings are listed."}
          </p>
          {showCharacters ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-neutral-300" data-testid="independent-toggle">
                <input
                  type="checkbox"
                  checked={independent}
                  disabled={independentBusy}
                  onChange={(event) => void onToggleIndependent(event.target.checked)}
                />
                Independent: never read shared library
              </label>
              <button
                type="button"
                data-testid="make-independent"
                disabled={makeIndepBusy}
                onClick={() => void onMakeIndependent()}
                className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white disabled:opacity-40"
              >
                {makeIndepBusy ? "Copying…" : "Make independent"}
              </button>
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
        {makeIndepNote ? <p className="mb-3 text-[12px] text-emerald-300">{makeIndepNote}</p> : null}

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
      <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-studio-border bg-studio-panel p-3">
        {selected ? (
          <div className="space-y-3">
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
                  Shared library at _global_assets. Add copies the character into this project (the shared folder is not changed).
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
                        src={assetUrl(project, character.thumbRel, { thumb: true, v: character.mtime, library: true })}
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

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
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
