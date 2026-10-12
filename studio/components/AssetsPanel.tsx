"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import AlignHeadModal from "@/components/AlignHeadModal";
import AssetEditorOverlay from "@/components/AssetEditorOverlay";
import CharacterReferenceCard from "@/components/CharacterReferenceCard";
import ImportAudioDialog from "@/components/ImportAudioDialog";
import { slotViewGroups, type AssetFocus } from "@/lib/assetEditor";
import {
  FACTORY_VIEW_TABS,
  formatCountLine,
  formatPivot,
  isFactoryBadge,
  pivotPercent,
  sourceLabel,
} from "@/lib/factoryAssets";
import { alignableSlots } from "@/lib/headAlign";
import {
  addLibraryCharacter,
  assetUrl,
  loadCharacters,
  loadFactoryCharacter,
  loadLibrary,
  loadProjectActions,
  loadProjectAudio,
  loadStaging,
  loadStudioSettings,
  makeProjectIndependent,
  saveFactoryStatus,
  saveStudioSettings,
  type Character,
  type CharacterSlot,
  type FactoryBadge,
  type FactoryCharacter,
  type FactoryPiece,
  type FactoryRow,
  type ProjectAction,
  type ProjectAudioFile,
  type Staging,
} from "@/lib/worker";

type LibraryKind = "characters" | "props" | "backgrounds" | "actions" | "sounds";
type LibrarySel =
  | { kind: "characters"; id: string }
  | { kind: "props"; id: string }
  | { kind: "backgrounds"; id: string }
  | { kind: "actions"; id: string }
  | { kind: "sounds"; id: string };

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

function TinyThumb({ src, label }: { src: string | null; label: string }) {
  return (
    <span className="studio-asset-thumb" aria-hidden="true">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" />
      ) : (
        <span className="studio-asset-thumb-empty">{label.slice(0, 1)}</span>
      )}
    </span>
  );
}

function FactoryCell({
  project,
  piece,
  selected,
  onSelect,
  onOpen,
}: {
  project: string;
  piece: FactoryPiece;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const badge = isFactoryBadge(piece.badge) ? piece.badge : piece.missing ? "missing" : null;
  return (
    <button
      type="button"
      className="studio-factory-cell"
      data-testid={`assets-piece-${piece.key}`}
      data-selected={selected ? "true" : "false"}
      data-missing={piece.missing ? "true" : "false"}
      title={piece.key}
      onClick={onSelect}
      onDoubleClick={() => onOpen?.()}
    >
      <span className={`studio-factory-cell-thumb ${piece.rel ? "studio-checker" : ""}`}>
        {piece.rel ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetUrl(project, piece.rel, { v: piece.mtime }) || undefined} alt={piece.name} />
        ) : null}
        {badge ? (
          <span className="studio-factory-badge" data-badge={badge} data-testid={`assets-badge-${badge}`}>
            {badge === "ticked" ? "✓" : badge === "locked" ? "L" : badge === "draft" ? "d" : "–"}
          </span>
        ) : null}
      </span>
      <span className="studio-factory-cell-label">{piece.name}</span>
    </button>
  );
}

function FactoryRowBlock({
  project,
  row,
  selectedKey,
  onSelect,
  onOpenSlot,
  onOpenDrawing,
}: {
  project: string;
  row: FactoryRow;
  selectedKey: string | null;
  onSelect: (piece: FactoryPiece) => void;
  onOpenSlot?: () => void;
  onOpenDrawing: (piece: FactoryPiece) => void;
}) {
  const counts = row.drawings.reduce(
    (acc, piece) => {
      if (piece.badge && acc[piece.badge] != null) acc[piece.badge] += 1;
      return acc;
    },
    { ticked: 0, locked: 0, draft: 0, missing: 0 } as Record<FactoryBadge, number>
  );
  return (
    <section className="studio-factory-row" data-testid={`assets-slot-${row.slot}`}>
      <div className="studio-factory-row-head">
        <h4 className="studio-factory-row-title">
          {row.kind === "slot" ? (
            <button type="button" onClick={onOpenSlot}>
              {row.label}
              {row.owner ? <span className="ml-1 font-normal text-studio-muted">on {row.owner}</span> : null}
            </button>
          ) : (
            <span>{row.label}</span>
          )}
        </h4>
        <span className="studio-factory-row-meta">
          {row.drawings.length} drawing{row.drawings.length === 1 ? "" : "s"}
          {formatCountLine(counts) ? ` · ${formatCountLine(counts)}` : ""}
        </span>
      </div>
      <div className="studio-factory-thumbs" data-testid={`assets-slot-row-${row.slot}`}>
        {row.drawings.map((piece) => (
          <FactoryCell
            key={piece.key}
            project={project}
            piece={piece}
            selected={piece.key === selectedKey}
            onSelect={() => onSelect(piece)}
            onOpen={piece.rel && row.kind === "slot" ? () => onOpenDrawing(piece) : undefined}
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
  const [actions, setActions] = useState<ProjectAction[]>([]);
  const [audio, setAudio] = useState<ProjectAudioFile[]>([]);
  const [selectedIdState, setSelectedIdState] = useState<string | null>(null);
  const selectedId = onSelectId ? selectedIdProp ?? null : selectedIdState;
  const setSelectedId = onSelectId ?? setSelectedIdState;
  const [librarySel, setLibrarySel] = useState<LibrarySel | null>(null);
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
  const [view, setView] = useState("front");
  const [factory, setFactory] = useState<FactoryCharacter | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [redoNote, setRedoNote] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [importAudioOpen, setImportAudioOpen] = useState(false);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      loadCharacters(project),
      loadStaging(project),
      loadStudioSettings(project),
      loadProjectActions(project),
      loadProjectAudio(project),
    ])
      .then(([chars, nextStaging, settings, nextActions, nextAudio]) => {
        if (cancelled) return;
        setCharacters(chars);
        setStaging(nextStaging);
        setActions(nextActions);
        setAudio(nextAudio);
        setIndependent(settings.independent !== false);
        const current = selectedId;
        const nextId = current && chars.some((c) => c.id === current) ? current : chars[0]?.id ?? null;
        setSelectedId(nextId);
        setLibrarySel((prev) => {
          if (prev && prev.kind !== "characters") return prev;
          return nextId ? { kind: "characters", id: nextId } : prev;
        });
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

  const selected = useMemo(
    () => characters.find((c) => c.id === selectedId) || null,
    [characters, selectedId]
  );

  useEffect(() => {
    if (!project || !workerUp || !selectedId || pool) return;
    let cancelled = false;
    loadFactoryCharacter(project, selectedId, view, selectedKey || undefined)
      .then((next) => {
        if (cancelled) return;
        setFactory(next);
        if (next.inspector?.redo) setRedoNote(next.inspector.redo);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, selectedId, view, reloadKey, refreshToken, pool]);

  useEffect(() => {
    setAlignOpen(false);
    setSelectedKey(null);
    setRedoNote("");
  }, [selectedId]);

  useEffect(() => {
    setSelectedKey(null);
    setRedoNote("");
  }, [view]);

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

  async function persistStatus(body: { key: string; state?: FactoryBadge; redo?: string }) {
    if (!project || !selectedId || statusBusy) return;
    setStatusBusy(true);
    setError(null);
    try {
      const next = await saveFactoryStatus(project, selectedId, { ...body, view });
      setFactory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write status.json");
    } finally {
      setStatusBusy(false);
    }
  }

  function selectCharacter(id: string) {
    setSelectedId(id);
    setLibrarySel({ kind: "characters", id });
  }

  function onNew(kind: LibraryKind) {
    if (kind === "sounds") {
      setImportAudioOpen(true);
      return;
    }
    if (kind === "characters" && !selectedId) {
      setLibraryOpen(true);
      return;
    }
    onOpenImagine?.(selectedId ? { characterId: selectedId } : undefined);
  }

  if (!project) {
    return <EmptyState message="Pick a project to browse the library." />;
  }

  const showCharacters = !pool || poolSection === "assets";
  const showBackgrounds = !pool || poolSection === "media";
  const showProps = !pool || poolSection === "effects";
  const gridClass = pool
    ? "grid grid-cols-2 gap-2"
    : "grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

  const inspector = factory?.inspector || null;
  const pivotAt = inspector ? pivotPercent(inspector.pivot, inspector.canvas) : null;
  const selectedProp = librarySel?.kind === "props" ? (staging?.props || []).find((p) => `${p.location}:${p.id}` === librarySel.id) : null;
  const selectedBg = librarySel?.kind === "backgrounds" ? (staging?.backgrounds || []).find((b) => b.id === librarySel.id) : null;
  const selectedAction = librarySel?.kind === "actions" ? actions.find((a) => a.label === librarySel.id) : null;
  const selectedSound = librarySel?.kind === "sounds" ? audio.find((a) => a.rel === librarySel.id) : null;
  const showCharacterMain = !librarySel || librarySel.kind === "characters";

  const toolbar = showCharacters ? (
    <div className={pool ? "flex shrink-0 flex-wrap items-center justify-end gap-2" : "studio-factory-actions"}>
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
        className={pool ? "rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white disabled:opacity-40" : "studio-header-textbtn"}
      >
        {makeIndepBusy ? "Copying…" : "Make independent"}
      </button>
      {onOpenImagine ? (
        <button
          type="button"
          data-testid="imagine-open"
          onClick={() => onOpenImagine()}
          className={pool ? "rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white" : "studio-header-textbtn"}
        >
          Grok Imagine
        </button>
      ) : null}
      <button
        type="button"
        data-testid="library-open"
        onClick={() => setLibraryOpen(true)}
        className={pool ? "rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white" : "studio-header-textbtn"}
      >
        Library
      </button>
      {!pool && selected && alignableSlots(selected.slots).length > 0 ? (
        <button type="button" data-testid="align-head" onClick={() => setAlignOpen(true)} className="studio-header-textbtn">
          Align head
        </button>
      ) : null}
    </div>
  ) : null;

  const overlays = (
    <>
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

      {importAudioOpen ? (
        <ImportAudioDialog
          project={project}
          defaultCharacter={selected?.display_name}
          onClose={() => {
            setImportAudioOpen(false);
            setReloadKey((n) => n + 1);
          }}
          onInsertTag={async () => {
            setImportAudioOpen(false);
            setReloadKey((n) => n + 1);
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
    </>
  );

  if (pool) {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}
          {loading ? <p className="mb-4 text-sm text-studio-muted">Loading library…</p> : null}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-studio-muted">
              {poolSection === "assets" ? "Library characters" : poolSection === "media" ? "Backgrounds" : "Props"}
            </p>
            {toolbar}
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
                      onClick={() => selectCharacter(character.id)}
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
        {overlays}
      </div>
    );
  }

  return (
    <div className="studio-factory-page" data-testid="assets-factory">
      <aside className="studio-factory-library" data-testid="assets-library">
        <LibraryGroup
          kind="characters"
          label="Characters"
          onNew={() => onNew("characters")}
        >
          {characters.map((character) => (
            <button
              key={character.id}
              type="button"
              className="studio-asset-leaf"
              data-testid={`assets-tree-character-${character.id}`}
              data-selected={librarySel?.kind === "characters" && librarySel.id === character.id ? "true" : "false"}
              onClick={() => selectCharacter(character.id)}
            >
              <TinyThumb
                src={assetUrl(project, character.thumbRel, { thumb: true, v: character.mtime })}
                label={character.display_name}
              />
              <span className="min-w-0 flex-1 truncate">{character.display_name}</span>
            </button>
          ))}
        </LibraryGroup>
        <LibraryGroup kind="props" label="Props" onNew={() => onNew("props")}>
          {(staging?.props || []).map((prop) => {
            const id = `${prop.location}:${prop.id}`;
            return (
              <button
                key={id}
                type="button"
                className="studio-asset-leaf"
                data-testid={`assets-tree-prop-${prop.id}`}
                data-selected={librarySel?.kind === "props" && librarySel.id === id ? "true" : "false"}
                onClick={() => setLibrarySel({ kind: "props", id })}
              >
                <TinyThumb src={assetUrl(project, prop.thumbRel, { thumb: true, v: prop.mtime })} label={prop.id} />
                <span className="min-w-0 flex-1 truncate">{prop.id}</span>
              </button>
            );
          })}
        </LibraryGroup>
        <LibraryGroup kind="backgrounds" label="Backgrounds" onNew={() => onNew("backgrounds")}>
          {(staging?.backgrounds || []).map((bg) => (
            <button
              key={bg.id}
              type="button"
              className="studio-asset-leaf"
              data-testid={`assets-tree-background-${bg.id}`}
              data-selected={librarySel?.kind === "backgrounds" && librarySel.id === bg.id ? "true" : "false"}
              onClick={() => setLibrarySel({ kind: "backgrounds", id: bg.id })}
            >
              <TinyThumb src={assetUrl(project, bg.thumbRel, { thumb: true, v: bg.mtime })} label={bg.id} />
              <span className="min-w-0 flex-1 truncate">{bg.id}</span>
            </button>
          ))}
        </LibraryGroup>
        <LibraryGroup kind="actions" label="Actions" onNew={() => onNew("actions")}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="studio-asset-leaf"
              data-testid={`assets-tree-action-${action.id}`}
              data-selected={librarySel?.kind === "actions" && librarySel.id === action.label ? "true" : "false"}
              onClick={() => setLibrarySel({ kind: "actions", id: action.label })}
            >
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
            </button>
          ))}
        </LibraryGroup>
        <LibraryGroup kind="sounds" label="Sounds" onNew={() => onNew("sounds")}>
          {audio.map((file) => (
            <button
              key={file.rel}
              type="button"
              className="studio-asset-leaf"
              data-testid={`assets-tree-sound-${file.label}`}
              data-selected={librarySel?.kind === "sounds" && librarySel.id === file.rel ? "true" : "false"}
              onClick={() => setLibrarySel({ kind: "sounds", id: file.rel })}
            >
              <span className="min-w-0 flex-1 truncate">{file.label}</span>
            </button>
          ))}
        </LibraryGroup>
      </aside>

      <div className="studio-factory-main">
        {error ? <p className="px-2 py-1 text-[11px] text-red-400">{error}</p> : null}
        {loading ? <p className="px-2 py-1 text-[11px] text-studio-muted">Loading library…</p> : null}
        {makeIndepNote ? <p className="px-2 py-1 text-[11px] text-emerald-300">{makeIndepNote}</p> : null}

        <div className="studio-factory-toolbar">
          {showCharacterMain && selected ? (
            <div className="studio-factory-meta" data-testid="assets-character-meta">
              <strong>{selected.display_name}</strong>
              <span>{sourceLabel(selected.source)}</span>
              <span>canvas {factory?.canvas.w || selected.canvas?.w || 1024}</span>
              <span>scale {factory?.default_scale ?? selected.default_scale ?? 1}</span>
              <span>{FACTORY_VIEW_TABS.length} views</span>
              {factory ? <span>{formatCountLine(factory.counts) || "no review yet"}</span> : null}
            </div>
          ) : (
            <div className="studio-factory-meta">
              <strong>
                {selectedProp?.id || selectedBg?.id || selectedAction?.label || selectedSound?.label || "Library"}
              </strong>
            </div>
          )}
          {toolbar}
        </div>

        {showCharacterMain ? (
          <>
            <div className="studio-factory-tabs" data-testid="assets-view-tabs">
              {FACTORY_VIEW_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="studio-factory-tab"
                  data-testid={`assets-view-${tab.id}`}
                  data-active={view === tab.id ? "true" : "false"}
                  onClick={() => setView(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="studio-factory-rows">
              {!selected ? (
                <p className="text-[11px] text-studio-muted">None in this project yet. Open Library or + New to add a character.</p>
              ) : factory ? (
                factory.rows.map((row) => (
                  <FactoryRowBlock
                    key={row.id}
                    project={project}
                    row={row}
                    selectedKey={selectedKey}
                    onSelect={(piece) => {
                      setSelectedKey(piece.key);
                      setRedoNote(factory.redos[piece.key] || "");
                      setFactory((current) =>
                        current
                          ? {
                              ...current,
                              inspector: {
                                key: piece.key,
                                slot: row.slot,
                                label: row.label,
                                drawing: piece.name,
                                view: current.view,
                                rel: piece.rel,
                                badge: piece.badge,
                                missing: piece.missing,
                                canvas: current.canvas,
                                pivot: current.canvas.pivot,
                                offset: { x: 0, y: 0 },
                                anchor: "pivot + offset",
                                redo: current.redos[piece.key] || "",
                              },
                            }
                          : current
                      );
                    }}
                    onOpenSlot={() => setAssetFocus({ mode: "slot", characterId: selected.id, slot: row.slot, view })}
                    onOpenDrawing={(piece) =>
                      setAssetFocus({
                        mode: "drawing",
                        characterId: selected.id,
                        slot: row.slot,
                        drawing: piece.name,
                        view,
                      })
                    }
                  />
                ))
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
          </>
        ) : (
          <div className="studio-factory-rows">
            {selectedProp ? (
              <Thumb
                src={assetUrl(project, selectedProp.thumbRel, { thumb: true, v: selectedProp.mtime })}
                label={`${selectedProp.id} · ${selectedProp.location}`}
                fit="contain"
              />
            ) : null}
            {selectedBg ? (
              <Thumb
                src={assetUrl(project, selectedBg.thumbRel, { thumb: true, v: selectedBg.mtime })}
                label={selectedBg.id}
                fit="contain"
              />
            ) : null}
            {selectedAction ? <p className="text-[11px] text-neutral-300">{selectedAction.rel}</p> : null}
            {selectedSound ? (
              <p className="text-[11px] text-neutral-300">
                {selectedSound.rel}
                {selectedSound.durationSeconds != null ? ` · ${selectedSound.durationSeconds.toFixed(1)}s` : ""}
              </p>
            ) : null}
          </div>
        )}
      </div>

      <aside className="studio-factory-inspector" data-testid="assets-inspector">
        {showCharacterMain && inspector ? (
          <div>
            <h2 className="studio-factory-inspector-title">
              {inspector.slot} / {inspector.drawing}
            </h2>
            <div className="studio-factory-preview studio-checker">
              {inspector.rel ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assetUrl(project, inspector.rel) || undefined} alt={inspector.drawing} />
              ) : (
                <div className="flex h-full items-center justify-center text-[10px] text-studio-muted">missing</div>
              )}
              <div className="studio-factory-bounds" />
              {pivotAt ? (
                <div className="studio-factory-pivot" style={{ left: `${pivotAt.left}%`, top: `${pivotAt.top}%` }} />
              ) : null}
            </div>
            <dl className="studio-factory-fields">
              <dt>Slot</dt>
              <dd>{inspector.slot}</dd>
              <dt>View</dt>
              <dd>{inspector.view}</dd>
              <dt>Canvas</dt>
              <dd>
                {inspector.canvas.w} × {inspector.canvas.h}
              </dd>
              <dt>Pivot</dt>
              <dd>{formatPivot(inspector.pivot)}</dd>
              <dt>Anchor</dt>
              <dd>{inspector.anchor}</dd>
              <dt>Source</dt>
              <dd title={inspector.rel || undefined}>{inspector.rel || "—"}</dd>
            </dl>
            <div className="studio-factory-btns">
              <button
                type="button"
                className="studio-factory-btn studio-factory-btn--go"
                data-testid="assets-approve"
                disabled={!inspector.rel || statusBusy}
                onClick={() => void persistStatus({ key: inspector.key, state: "ticked" })}
              >
                Approve
              </button>
              <button
                type="button"
                className="studio-factory-btn"
                data-testid="assets-redo"
                disabled={statusBusy}
                onClick={() => void persistStatus({ key: inspector.key, redo: redoNote || "redo" })}
              >
                Redo
              </button>
            </div>
            <textarea
              className="studio-factory-redo"
              data-testid="assets-redo-note"
              placeholder="Redo note"
              value={redoNote}
              onChange={(event) => setRedoNote(event.target.value)}
            />
          </div>
        ) : showCharacterMain && selected ? (
          <div className="space-y-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-studio-muted">Character</p>
              <h2 className="text-sm font-semibold text-white">{selected.display_name}</h2>
              <p className="text-[11px] text-studio-muted">
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
            <p className="text-[11px] text-studio-muted">Click a drawing for pivot, canvas, and Approve / Redo.</p>
          </div>
        ) : (
          <p className="text-[11px] text-studio-muted">Select a library item.</p>
        )}
      </aside>

      {overlays}
    </div>
  );
}

function LibraryGroup({
  kind,
  label,
  onNew,
  children,
}: {
  kind: LibraryKind;
  label: string;
  onNew: () => void;
  children: ReactNode;
}) {
  return (
    <section className="studio-factory-group">
      <div className="studio-factory-group-head">
        <h3 className="studio-factory-group-title">{label}</h3>
        <button type="button" className="studio-factory-new" data-testid={`assets-new-${kind}`} onClick={onNew}>
          + New
        </button>
      </div>
      {children}
    </section>
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
