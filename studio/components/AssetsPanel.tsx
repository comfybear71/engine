"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ActionShotsPage from "@/components/ActionShotsPage";
import { ActionShotDetail } from "@/components/ActionShotsSection";
import AlignHeadModal from "@/components/AlignHeadModal";
import HeadRigModal from "@/components/HeadRigModal";
import AssetEditorOverlay from "@/components/AssetEditorOverlay";
import ImportAudioDialog from "@/components/ImportAudioDialog";
import {
  cleanIslandsDrawing,
  cleanIslandsSlot,
  deleteEditorDrawing,
  fileToImageBase64,
  needIdForSlot,
  renameEditorDrawing,
  slotViewGroups,
  type AssetFocus,
} from "@/lib/assetEditor";
import {
  FACTORY_THUMB_COMPACT_PX,
  FACTORY_THUMB_PX,
  FACTORY_THUMB_WIDE_PX,
  FACTORY_VIEW_TABS,
  formatCountLine,
  formatPivot,
  groupActionsByCharacter,
  isFactoryBadge,
  pickVisibleProp,
  pivotPercent,
  sectionLabel,
  soundDisplayName,
  sourceLabel,
  visibleDrawings,
  splitSlotActionFrames,
  type AssetsSection,
} from "@/lib/factoryAssets";
import { mergeCategories } from "@/lib/actionLibrary";
import { alignableSlots } from "@/lib/headAlign";
import {
  addLibraryCharacter,
  assetUrl,
  trashProjectAsset,
  importStillAsset,
  loadCharacters,
  lintScript,
  loadFactoryCharacter,
  loadLibrary,
  loadProjectActions,
  loadProjectAudio,
  loadStaging,
  loadStudioSettings,
  makeProjectIndependent,
  mediaUrl,
  openProjectFolder,
  patchActionCategory,
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

type AssetsNav =
  | { page: "home" }
  | { page: "section"; section: AssetsSection }
  | { page: "character"; id: string }
  | { page: "prop"; id: string }
  | { page: "background"; id: string }
  | { page: "action"; id: string }
  | { page: "sound"; id: string };

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
  wide = false,
}: {
  src: string | null;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  badge?: string;
  fit?: "cover" | "contain";
  compact?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{ width: compact ? FACTORY_THUMB_COMPACT_PX : wide ? FACTORY_THUMB_WIDE_PX : FACTORY_THUMB_PX }}
      className={`group flex flex-col text-left ${compact ? "shrink-0 gap-0.5" : "gap-1"} ${
        onClick ? "cursor-pointer" : "cursor-default"
      }`}
    >
      <div
        className={`relative overflow-hidden border ${
          wide ? "aspect-video studio-bg-thumb" : "aspect-square"
        } ${compact ? "rounded-sm" : "rounded-md"} ${
          wide ? "bg-studio-raised" : fit === "contain" ? "studio-checker" : "bg-studio-raised"
        } ${selected ? "border-studio-accent ring-1 ring-studio-accent/50" : "border-studio-border"}`}
      >
        {src ? (
          // Worker-served PNGs; next/image remote config is out of scope for localhost.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={label}
            className={`h-full w-full ${fit === "contain" ? "object-contain object-bottom" : "object-cover object-center"}`}
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

function AddTile({
  testId,
  label,
  onClick,
  wide = false,
}: {
  testId: string;
  label?: string;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button type="button" className="studio-factory-add" data-testid={testId} data-wide={wide ? "true" : "false"} onClick={onClick} title={label || "Add"}>
      <span>+</span>
    </button>
  );
}

function TrashButton({ testId, onClick }: { testId: string; onClick: () => void }) {
  return (
    <button type="button" className="studio-factory-trash" data-testid={testId} title="Delete" onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}>
      ⌫
    </button>
  );
}

function WaveformIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="9" width="2.2" height="6" rx="1" />
      <rect x="7" y="6" width="2.2" height="12" rx="1" />
      <rect x="11" y="4" width="2.2" height="16" rx="1" />
      <rect x="15" y="7" width="2.2" height="10" rx="1" />
      <rect x="19" y="9" width="2.2" height="6" rx="1" />
    </svg>
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
                <AddTile
                  testId={`assets-new-slot-${group.id}`}
                  onClick={() => onOpen?.({ mode: "slot", characterId, slot: slot.name, view: group.id === "mouth" ? undefined : group.id })}
                />
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
          <AddTile
            testId={`assets-new-slot-${slot.name}`}
            onClick={() => onOpen?.({ mode: "slot", characterId, slot: slot.name })}
          />
        </DrawingRow>
      ) : (
        <DrawingRow testId={`assets-slot-row-${slot.name}`}>
          <AddTile
            testId={`assets-new-slot-${slot.name}`}
            onClick={() => onOpen?.({ mode: "slot", characterId, slot: slot.name })}
          />
        </DrawingRow>
      )}
    </section>
  );
}

function FactoryCell({
  project,
  piece,
  selected,
  onSelect,
  onOpen,
  onDelete,
  onRename,
  onClean,
}: {
  project: string;
  piece: FactoryPiece;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
  onDelete?: () => void;
  onRename?: (name: string) => void;
  onClean?: () => void;
}) {
  const badge = isFactoryBadge(piece.badge) ? piece.badge : piece.missing ? "missing" : null;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(piece.name);
  useEffect(() => {
    setDraft(piece.name);
  }, [piece.name]);
  return (
    <div
      className="studio-factory-cell"
      data-testid={`assets-piece-${piece.key}`}
      data-selected={selected ? "true" : "false"}
      data-missing={piece.missing ? "true" : "false"}
      title={piece.key}
    >
      <button
        type="button"
        className={`studio-factory-cell-thumb ${piece.rel ? "studio-checker" : ""}`}
        onClick={onSelect}
        onDoubleClick={() => onOpen?.()}
      >
        {piece.rel ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={
              assetUrl(project, piece.rel, {
                factory: true,
                over: piece.compositeRel,
                v: piece.mtime,
              }) || undefined
            }
            alt={piece.name}
          />
        ) : null}
        {piece.side ? (
          <span className="studio-factory-side" data-testid={`assets-side-${piece.side}`} title={piece.side === "L" ? "Left" : "Right"}>
            {piece.side}
          </span>
        ) : null}
        {badge ? (
          <span
            className="studio-factory-badge"
            data-badge={badge}
            data-testid={`assets-badge-${badge}`}
            title={badge}
          />
        ) : null}
      </button>
      {piece.rel && !piece.missing ? (
        <span className="studio-factory-cell-tools">
          {onClean ? (
            <button
              type="button"
              className="studio-factory-cell-tool"
              data-kind="clean"
              data-testid={`assets-clean-${piece.key}`}
              title="Clean stray bits"
              onClick={(event) => {
                event.stopPropagation();
                onClean();
              }}
            >
              ✂
            </button>
          ) : null}
          {onRename ? (
            <button
              type="button"
              className="studio-factory-cell-tool"
              data-kind="rename"
              data-testid={`assets-rename-${piece.key}`}
              title="Rename"
              onClick={(event) => {
                event.stopPropagation();
                setRenaming(true);
              }}
            >
              ✎
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              className="studio-factory-cell-tool"
              data-kind="delete"
              data-testid={`assets-delete-${piece.key}`}
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M4.5 1h3l.3 1H10v1H2V2h2.2L4.5 1zm.2 3h1v5h-1V4zm2 0h1v5h-1V4zM3 3h6l-.4 7.2A1 1 0 0 1 7.6 11H4.4a1 1 0 0 1-1-.8L3 3z"
                />
              </svg>
            </button>
          ) : null}
        </span>
      ) : null}
      {renaming && onRename ? (
        <input
          className="studio-factory-cell-rename"
          data-testid={`assets-rename-input-${piece.key}`}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = draft.trim();
            setRenaming(false);
            if (next && next !== piece.name) onRename(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(piece.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="studio-factory-cell-label"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (onRename) setRenaming(true);
            else onOpen?.();
          }}
        >
          {piece.name}
        </button>
      )}
    </div>
  );
}

function FactoryRowBlock({
  project,
  row,
  selectedKey,
  showMissing,
  actions,
  characterId,
  onSelect,
  onOpenSlot,
  onOpenDrawing,
  onOpenAction,
  onAdd,
  onDeleteDrawing,
  onRenameDrawing,
  onCleanDrawing,
  onCleanRow,
}: {
  project: string;
  row: FactoryRow;
  selectedKey: string | null;
  showMissing: boolean;
  actions?: ProjectAction[];
  characterId?: string | null;
  onSelect: (piece: FactoryPiece) => void;
  onOpenSlot?: () => void;
  onOpenDrawing: (piece: FactoryPiece) => void;
  onOpenAction?: (actionId: string) => void;
  onAdd?: () => void;
  onDeleteDrawing?: (piece: FactoryPiece) => void;
  onRenameDrawing?: (piece: FactoryPiece, name: string) => void;
  onCleanDrawing?: (piece: FactoryPiece) => void;
  onCleanRow?: () => void;
}) {
  const { drawings, actionGroups } = splitSlotActionFrames(row.drawings, actions, characterId);
  const counts = drawings.reduce(
    (acc, piece) => {
      if (piece.badge && acc[piece.badge] != null) acc[piece.badge] += 1;
      return acc;
    },
    { ticked: 0, locked: 0, draft: 0, missing: 0 } as Record<FactoryBadge, number>
  );
  function renderCell(piece: FactoryPiece) {
    return (
      <FactoryCell
        key={piece.key}
        project={project}
        piece={piece}
        selected={piece.key === selectedKey}
        onSelect={() => onSelect(piece)}
        onOpen={piece.rel && row.kind === "slot" ? () => onOpenDrawing(piece) : undefined}
        onDelete={piece.rel && row.kind === "slot" ? () => onDeleteDrawing?.(piece) : undefined}
        onRename={piece.rel && row.kind === "slot" ? (name) => onRenameDrawing?.(piece, name) : undefined}
        onClean={piece.rel && row.kind === "slot" ? () => onCleanDrawing?.(piece) : undefined}
      />
    );
  }
  return (
    <section className="studio-factory-row" data-testid={`assets-row-${row.label}`}>
      <div className="studio-factory-row-head">
        <h4 className="studio-factory-row-title">
          <button type="button" onClick={onOpenSlot}>
            {row.label}
            {row.owner ? <span className="ml-1 font-normal text-studio-muted">on {row.owner}</span> : null}
          </button>
        </h4>
        <span className="studio-factory-row-meta">
          {drawings.length} drawing{drawings.length === 1 ? "" : "s"}
          {formatCountLine(counts) ? ` · ${formatCountLine(counts)}` : ""}
          {onCleanRow ? (
            <>
              {" · "}
              <button
                type="button"
                className="studio-header-textbtn"
                data-testid={`assets-clean-row-${row.slot}`}
                onClick={onCleanRow}
              >
                Clean stray bits
              </button>
            </>
          ) : null}
        </span>
      </div>
      <div className="studio-factory-thumbs" data-testid={`assets-slot-row-${row.slot}`}>
        {visibleDrawings(drawings, showMissing).map((piece) => renderCell(piece))}
        {onAdd ? <AddTile testId={`assets-new-slot-${row.slot}`} onClick={onAdd} /> : null}
      </div>
      {actionGroups.map((group) => (
        <details key={group.id} className="studio-factory-action-frames" data-testid={`assets-action-frames-${group.id}`}>
          <summary>
            <span>{group.label}</span>
            {group.actionId && onOpenAction ? (
              <button
                type="button"
                className="studio-factory-action-shot-link"
                data-testid={`assets-action-frames-link-${group.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenAction(group.actionId!);
                }}
              >
                Action Shot
              </button>
            ) : null}
          </summary>
          <div className="studio-factory-thumbs" data-testid={`assets-action-frames-row-${group.id}`}>
            {visibleDrawings(group.drawings, showMissing).map((piece) => renderCell(piece))}
          </div>
        </details>
      ))}
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
  onOpenImagine?: (opts?: {
    characterId?: string;
    needId?: string;
    mode?: "character" | "new-character" | "prop" | "background" | "slot";
    slot?: string;
    view?: string;
    label?: string;
  }) => void;
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
  const [lintNote, setLintNote] = useState<string | null>(null);
  const [lintBusy, setLintBusy] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [nav, setNav] = useState<AssetsNav>({ page: "home" });
  const [showMissing, setShowMissing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [playingRel, setPlayingRel] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      loadLibrary(project).catch(() => ({ characters: [], added: [] })),
    ])
      .then(([chars, nextStaging, settings, nextActions, nextAudio, library]) => {
        if (cancelled) return;
        setCharacters(chars);
        setStaging(nextStaging);
        setActions(nextActions);
        setAudio(nextAudio);
        setLibraryChars(library.characters || []);
        setLibraryAdded(library.added || []);
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

  const selected = useMemo(() => {
    const local = characters.find((c) => c.id === selectedId) || null;
    if (local && (local.source !== "global" || !independent)) return local;
    if (independent) return local && local.source !== "global" ? local : null;
    return libraryChars.find((c) => c.id === selectedId) || local;
  }, [characters, libraryChars, selectedId, independent]);

  useEffect(() => {
    if (!project || !workerUp || !selectedId || pool) return;
    let cancelled = false;
    loadFactoryCharacter(project, selectedId, view === "library" ? "front" : view, selectedKey || undefined)
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
  }, [project, workerUp, selectedId, view, selectedKey, reloadKey, refreshToken, pool]);

  useEffect(() => {
    setAlignOpen(false);
    setSelectedKey(null);
    setRedoNote("");
    setDetailOpen(false);
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
    setNav({ page: "character", id });
  }

  function goHome() {
    setNav({ page: "home" });
    setLibrarySel(null);
  }

  function goSection(section: AssetsSection) {
    setNav({ page: "section", section });
    setLibrarySel(null);
  }

  async function onTrash(body: Parameters<typeof trashProjectAsset>[1], label: string) {
    if (!project) return;
    const usedHint = body.kind === "sound" ? " If a script uses it, delete is blocked." : "";
    if (!window.confirm(`Move ${label} to .trash? The file is kept, not erased.${usedHint}`)) return;
    try {
      const result = await trashProjectAsset(project, body);
      if (!result.ok) {
        const scripts = [...new Set((result.usages || []).map((item) => item.script))].join(", ");
        const message = result.error || (scripts ? `Used in ${scripts}` : "This item is used in a script.");
        if (!window.confirm(`${message}\nMove it to .trash anyway?`)) return;
        const forced = await trashProjectAsset(project, { ...body, force: true });
        if (!forced.ok) {
          setError(forced.error || message);
          return;
        }
      }
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
      if (nav.page !== "home" && nav.page !== "section") goSection(body.kind === "sound" ? "sounds" : body.kind === "action" ? "actions" : `${body.kind}s` as AssetsSection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    }
  }

  async function onDeleteDrawing(slot: string, piece: FactoryPiece) {
    if (!project || !selectedId) return;
    if (!window.confirm(`Move ${piece.name} to .trash? The file is kept, not erased.`)) return;
    try {
      const result = await deleteEditorDrawing(project, selectedId, slot, piece.name, { confirm: true, view });
      if ("used" in result && result.used) {
        const hint = (result.usages || []).map((item) => item.text).slice(0, 6).join("; ");
        if (!window.confirm(`${result.error || hint}\nMove it to .trash anyway?`)) return;
        const forced = await deleteEditorDrawing(project, selectedId, slot, piece.name, {
          confirm: true,
          force: true,
          view,
        });
        if ("used" in forced && forced.used) {
          setError(forced.error);
          return;
        }
      }
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    }
  }

  async function onRenameDrawing(slot: string, piece: FactoryPiece, name: string) {
    if (!project || !selectedId) return;
    try {
      await renameEditorDrawing(project, selectedId, slot, piece.name, { name, view });
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename");
    }
  }

  async function onCleanDrawing(slot: string, piece: FactoryPiece) {
    if (!project || !selectedId) return;
    try {
      await cleanIslandsDrawing(project, selectedId, slot, piece.name, { view });
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clean stray bits");
    }
  }

  async function onCleanRow(slot: string) {
    if (!project || !selectedId) return;
    if (!window.confirm(`Clean stray bits on every drawing in ${slot}? Originals are kept in _replaced.`)) return;
    try {
      await cleanIslandsSlot(project, selectedId, slot, { view });
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clean stray bits");
    }
  }

  async function onImportStill(kind: "prop" | "background", file: File) {
    if (!project) return;
    try {
      const imageBase64 = await fileToImageBase64(file);
      const location = kind === "prop" ? staging?.props[0]?.location || staging?.backgrounds[0]?.id : undefined;
      const result = await importStillAsset(project, { kind, name: file.name, location, imageBase64 });
      setReloadKey((n) => n + 1);
      onLibraryChange?.();
      if (kind === "prop") {
        const id = `${result.location}:${result.id}`;
        setLibrarySel({ kind: "props", id });
        setNav({ page: "prop", id });
      } else {
        setLibrarySel({ kind: "backgrounds", id: result.id });
        setNav({ page: "background", id: result.id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import PNG");
    }
  }

  function togglePlay(rel: string) {
    if (!project) return;
    if (playingRel === rel) {
      audioRef.current?.pause();
      setPlayingRel(null);
      return;
    }
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.pause();
    audioRef.current.src = mediaUrl(project, rel);
    void audioRef.current.play();
    audioRef.current.onended = () => setPlayingRel(null);
    setPlayingRel(rel);
  }

  function onNew(kind: LibraryKind) {
    if (kind === "sounds") {
      setImportAudioOpen(true);
      return;
    }
    if (kind === "characters") {
      onOpenImagine?.({ mode: "new-character" });
      return;
    }
    if (kind === "actions") {
      onOpenImagine?.(selectedId ? { mode: "character", characterId: selectedId } : { mode: "character" });
      return;
    }
    if (kind === "props") {
      onOpenImagine?.({ mode: "prop" });
      return;
    }
    if (kind === "backgrounds") {
      onOpenImagine?.({ mode: "background" });
      return;
    }
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
  const selectedAction =
    nav.page === "action"
      ? actions.find((a) => a.label === nav.id || a.id === nav.id)
      : librarySel?.kind === "actions"
        ? actions.find((a) => a.label === librarySel.id || a.id === librarySel.id)
        : null;
  const visibleCharacters = independent
    ? characters.filter((character) => character.source !== "global")
    : characters;
  const factoryTabs = [
    ...(factory?.views?.length ? factory.views : FACTORY_VIEW_TABS),
  ];
  const factoryCounts = factory?.counts || { ticked: 0, locked: 0, draft: 0, missing: 0 };
  const actionGroups = useMemo(
    () => groupActionsByCharacter(actions, visibleCharacters),
    [actions, visibleCharacters]
  );
  const soundCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of audio) map.set(file.label, (map.get(file.label) || 0) + 1);
    return map;
  }, [audio]);

  async function onValidate() {
    if (!project || lintBusy) return;
    setLintBusy(true);
    setLintNote(null);
    try {
      const result = await lintScript(project, undefined, script);
      const errors = result.lint?.errors?.length || 0;
      const warnings = result.lint?.warnings?.length || 0;
      setLintNote(errors ? `${errors} error${errors === 1 ? "" : "s"}` : warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "ok");
    } catch (err) {
      setLintNote(err instanceof Error ? err.message : "Validate failed");
    } finally {
      setLintBusy(false);
    }
  }

  async function onOpenFolder() {
    if (!project || !selectedId || openBusy) return;
    setOpenBusy(true);
    try {
      await openProjectFolder(project, `characters/${selectedId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open folder");
    } finally {
      setOpenBusy(false);
    }
  }

  const toolbar = showCharacters ? (
    <div className={pool ? "flex shrink-0 flex-wrap items-center justify-end gap-2" : "studio-factory-actions"}>
      {!pool ? (
        <>
          {nav.page !== "character" && !(nav.page === "section" && nav.section === "actions") ? (
            <>
              <button
                type="button"
                className="studio-header-textbtn"
                data-testid="assets-validate"
                disabled={lintBusy}
                onClick={() => void onValidate()}
              >
                {lintBusy ? "Validate…" : lintNote ? `Validate · ${lintNote}` : "Validate"}
              </button>
              <button
                type="button"
                className="studio-header-textbtn"
                data-testid="assets-open-folder"
                disabled={!selectedId || openBusy}
                onClick={() => void onOpenFolder()}
              >
                {openBusy ? "Opening…" : "Open folder"}
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300" data-testid="independent-toggle">
            <input
              type="checkbox"
              checked={independent}
              disabled={independentBusy}
              onChange={(event) => void onToggleIndependent(event.target.checked)}
            />
            Independent
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
          <button
            type="button"
            data-testid="library-open"
            onClick={() => setLibraryOpen(true)}
            className="rounded-md border border-studio-border bg-studio-raised px-3 py-1.5 text-xs font-medium text-neutral-200 hover:text-white"
          >
            Library
          </button>
        </>
      )}
      {/* Factory button removed — replaced by Grok shot creator on character page */}
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

      {/* AlignHeadModal removed — head alignment now done inline on character page */}

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
                  <Thumb
                    key={bg.id}
                    src={assetUrl(project, bg.thumbRel, { thumb: true, cover: true, v: bg.mtime })}
                    label={bg.id}
                    fit="cover"
                    wide
                  />
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

  const homeProp = pickVisibleProp(staging?.props || []);
  const homeCards = [
    {
      id: "characters" as const,
      label: "Characters",
      count: visibleCharacters.length,
      wide: false,
      src: visibleCharacters[0]
        ? assetUrl(project, visibleCharacters[0].thumbRel, {
            factory: true,
            key: true,
            v: visibleCharacters[0].mtime,
          })
        : null,
    },
    {
      id: "props" as const,
      label: "Props",
      count: (staging?.props || []).length,
      wide: false,
      src: homeProp
        ? assetUrl(project, homeProp.thumbRel, { factory: true, v: homeProp.mtime })
        : null,
    },
    {
      id: "backgrounds" as const,
      label: "Backgrounds",
      count: (staging?.backgrounds || []).length,
      wide: true,
      src: staging?.backgrounds[0]
        ? assetUrl(project, staging.backgrounds[0].thumbRel, {
            thumb: true,
            cover: true,
            v: staging.backgrounds[0].mtime,
          })
        : null,
    },
    {
      id: "actions" as const,
      label: "Action Shots",
      count: actions.length,
      wide: false,
      src: actions.find((item) => item.thumbRel)
        ? assetUrl(project, actions.find((item) => item.thumbRel)?.thumbRel || null, { factory: true })
        : visibleCharacters[0]
          ? assetUrl(project, visibleCharacters[0].thumbRel, {
              factory: true,
              key: true,
              v: visibleCharacters[0].mtime,
            })
          : null,
    },
    {
      id: "sounds" as const,
      label: "Sounds",
      count: audio.length,
      wide: false,
      src: null,
      icon: "wave" as const,
    },
  ];

  const showInspector = false; // old slot inspector disabled — Build Character is now inline

  return (
    <div className="studio-factory-page" data-testid="assets-factory">
      <div className="studio-factory-main">
        {error ? <p className="px-2 py-1 text-[11px] text-red-400">{error}</p> : null}
        {loading ? <p className="px-2 py-1 text-[11px] text-studio-muted">Loading library…</p> : null}
        {makeIndepNote ? <p className="px-2 py-1 text-[11px] text-emerald-300">{makeIndepNote}</p> : null}

        <div className="studio-factory-toolbar">
          <nav className="studio-factory-crumb" data-testid="assets-breadcrumb">
            <button type="button" onClick={goHome}>
              Assets
            </button>
            {nav.page !== "home" ? (
              <>
                <span>/</span>
                <button
                  type="button"
                  onClick={() =>
                    goSection(
                      nav.page === "section"
                        ? nav.section
                        : nav.page === "character"
                          ? "characters"
                          : nav.page === "prop"
                            ? "props"
                            : nav.page === "background"
                              ? "backgrounds"
                              : nav.page === "action"
                                ? "actions"
                                : "sounds"
                    )
                  }
                >
                  {nav.page === "section" ? sectionLabel(nav.section) : sectionLabel(
                    nav.page === "character"
                      ? "characters"
                      : nav.page === "prop"
                        ? "props"
                        : nav.page === "background"
                          ? "backgrounds"
                          : nav.page === "action"
                            ? "actions"
                            : "sounds"
                  )}
                </button>
              </>
            ) : null}
            {nav.page === "character" || nav.page === "prop" || nav.page === "background" || nav.page === "action" || nav.page === "sound" ? (
              <>
                <span>/</span>
                <strong>
                  {nav.page === "character"
                    ? selected?.display_name || nav.id
                    : nav.page === "prop"
                      ? selectedProp?.id || nav.id
                      : nav.page === "background"
                        ? selectedBg?.id || nav.id
                        : nav.page === "action"
                          ? selectedAction?.name || selectedAction?.id || nav.id
                          : soundDisplayName(
                              audio.find((file) => file.rel === nav.id) || { label: nav.id, rel: nav.id },
                              false
                            )}
                </strong>
              </>
            ) : null}
          </nav>
          {toolbar}
        </div>

        {nav.page === "home" ? (
          <div className="studio-factory-home" data-testid="assets-home">
            {homeCards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="studio-factory-home-card"
                data-testid={`assets-home-${card.id}`}
                onClick={() => goSection(card.id)}
              >
                <span
                  className={`studio-factory-home-thumb ${
                    card.wide ? "studio-bg-thumb" : card.src || card.icon === "wave" ? "studio-checker" : ""
                  }`}
                  data-wide={card.wide ? "true" : "false"}
                >
                  {card.src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.src} alt="" />
                  ) : card.icon === "wave" ? (
                    <WaveformIcon />
                  ) : (
                    <span>{card.count}</span>
                  )}
                </span>
                <span className="studio-factory-home-copy">
                  <strong>{card.label}</strong>
                  <em>{card.count}</em>
                </span>
              </button>
            ))}
          </div>
        ) : nav.page === "section" && nav.section === "characters" ? (
          <div className="studio-factory-grid" data-testid="assets-section-characters">
            {visibleCharacters.map((character) => (
              <div key={character.id} className="studio-factory-tile-wrap">
                <Thumb
                  src={assetUrl(project, character.thumbRel, { factory: true, key: true, v: character.mtime })}
                  label={character.display_name}
                  fit="contain"
                  onClick={() => selectCharacter(character.id)}
                />
              </div>
            ))}
            <AddTile testId="assets-new-characters" onClick={() => onNew("characters")} />
          </div>
        ) : nav.page === "section" && nav.section === "props" ? (
          <div className="studio-factory-grid" data-testid="assets-section-props">
            {(staging?.props || []).map((prop) => {
              const id = `${prop.location}:${prop.id}`;
              return (
                <div key={id} className="studio-factory-tile-wrap">
                  <Thumb
                    src={assetUrl(project, prop.thumbRel, { factory: true, v: prop.mtime })}
                    label={prop.id}
                    fit="contain"
                    onClick={() => {
                      setLibrarySel({ kind: "props", id });
                      setNav({ page: "prop", id });
                    }}
                  />
                  <TrashButton
                    testId={`assets-trash-prop-${prop.id}`}
                    onClick={() =>
                      void onTrash(
                        { kind: "prop", id: prop.id, location: prop.location, rel: prop.thumbRel || undefined, confirm: true },
                        prop.id
                      )
                    }
                  />
                </div>
              );
            })}
            <AddTile testId="assets-new-props" onClick={() => onNew("props")} />
          </div>
        ) : nav.page === "section" && nav.section === "backgrounds" ? (
          <div className="studio-factory-grid" data-testid="assets-section-backgrounds">
            {(staging?.backgrounds || []).map((bg) => (
              <div key={bg.id} className="studio-factory-tile-wrap" data-wide="true">
                <Thumb
                  src={assetUrl(project, bg.thumbRel, { thumb: true, cover: true, v: bg.mtime })}
                  label={bg.id}
                  fit="cover"
                  wide
                  onClick={() => {
                    setLibrarySel({ kind: "backgrounds", id: bg.id });
                    setNav({ page: "background", id: bg.id });
                  }}
                />
                <TrashButton
                  testId={`assets-trash-background-${bg.id}`}
                  onClick={() => void onTrash({ kind: "background", id: bg.id, confirm: true }, bg.id)}
                />
              </div>
            ))}
            <AddTile testId="assets-new-backgrounds" wide onClick={() => onNew("backgrounds")} />
          </div>
        ) : nav.page === "section" && nav.section === "actions" ? (
          <ActionShotsPage
            project={project}
            characterId={selected?.id || ""}
            onReload={() => setReloadKey((n) => n + 1)}
          />
        ) : nav.page === "section" && nav.section === "sounds" ? (
          <div className="studio-factory-sounds" data-testid="assets-section-sounds">
            {audio.map((file) => (
              <SoundTile
                key={file.rel}
                name={soundDisplayName(file, (soundCounts.get(file.label) || 0) > 1)}
                peaks={file.peaks || []}
                playing={playingRel === file.rel}
                onPlay={() => togglePlay(file.rel)}
                onOpen={() => {
                  setLibrarySel({ kind: "sounds", id: file.label });
                  setNav({ page: "sound", id: file.rel });
                }}
                onDelete={() => void onTrash({ kind: "sound", label: file.label, id: file.label, confirm: true }, file.label)}
              />
            ))}
            <AddTile testId="assets-new-sounds" onClick={() => onNew("sounds")} />
          </div>
        ) : nav.page === "character" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {!selected ? (
              <p className="p-4 text-[11px] text-studio-muted">No character in this project yet.</p>
            ) : (
              <HeadRigModal project={project} characterId={selected.id} inline />
            )}
          </div>
        ) : nav.page === "action" && selectedAction ? (
          <ActionShotDetail
            project={project}
            action={selectedAction}
            categories={mergeCategories()}
            onCategory={(id) => {
              if (!selectedAction.characterId) return;
              void patchActionCategory(
                project,
                selectedAction.characterId,
                selectedAction.name || selectedAction.id,
                id
              ).then(() => setReloadKey((n) => n + 1));
            }}
          />
        ) : (
          <div className="studio-factory-fit-pane" data-testid="assets-fit-preview">
            {nav.page === "prop" && selectedProp ? (
              <FitPreview
                src={assetUrl(project, selectedProp.thumbRel, { thumb: true, v: selectedProp.mtime })}
                label={selectedProp.id}
              />
            ) : null}
            {nav.page === "background" && selectedBg ? (
              <FitPreview
                src={assetUrl(project, selectedBg.thumbRel, { thumb: true, cover: true, v: selectedBg.mtime })}
                label={selectedBg.id}
                cover
              />
            ) : null}
            {nav.page === "sound" ? (
              <SoundTile
                name={soundDisplayName(
                  audio.find((file) => file.rel === nav.id) || { label: nav.id, rel: nav.id },
                  false
                )}
                peaks={audio.find((file) => file.rel === nav.id)?.peaks || []}
                playing={playingRel === nav.id}
                onPlay={() => togglePlay(nav.id)}
              />
            ) : null}
          </div>
        )}
      </div>

      {showInspector ? (
      <aside className="studio-factory-inspector" data-testid="assets-inspector">
        {nav.page === "character" && inspector ? (
          <div>
            <h2 className="studio-factory-inspector-title">
              {inspector.label} / {inspector.drawing}
            </h2>
            <div className="studio-factory-preview studio-checker">
              {inspector.rel ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={
                    assetUrl(project, inspector.rel, {
                      factory: true,
                      over: inspector.compositeRel,
                    }) || undefined
                  }
                  alt={inspector.drawing}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[10px] text-studio-muted">missing</div>
              )}
              <div className="studio-factory-bounds" />
              {pivotAt ? (
                <div className="studio-factory-pivot" style={{ left: `${pivotAt.left}%`, top: `${pivotAt.top}%` }} />
              ) : null}
            </div>
            <button
              type="button"
              className="studio-factory-details"
              data-testid="assets-drawing-details"
              data-open={detailOpen ? "true" : "false"}
              onClick={() => setDetailOpen((open) => !open)}
            >
              {detailOpen ? "Hide details" : "Details"}
            </button>
            {detailOpen ? (
            <dl className="studio-factory-fields" data-testid="assets-drawing-detail-panel">
              <dt>Slot</dt>
              <dd>{inspector.slot}</dd>
              <dt>View</dt>
              <dd>{inspector.view}</dd>
              <dt>Offset</dt>
              <dd>{inspector.offset ? `${inspector.offset.x}, ${inspector.offset.y}` : "—"}</dd>
              <dt>Scale</dt>
              <dd>{factory?.default_scale ?? selected?.default_scale ?? 1}</dd>
              <dt>Pivot</dt>
              <dd>
                {formatPivot(inspector.pivot)}
                {inspector.offset ? ` + ${inspector.offset.x},${inspector.offset.y}` : ""}
              </dd>
              <dt>Used by</dt>
              <dd data-testid="assets-inspector-usages">
                {(inspector.usages || []).length
                  ? (inspector.usages || [])
                      .slice(0, 4)
                      .map((item) => item.script || item.text)
                      .filter(Boolean)
                      .join(", ") || `${(inspector.usages || []).length} refs`
                  : "—"}
              </dd>
            </dl>
            ) : null}
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
            <label className="studio-factory-redo-label" htmlFor="assets-redo-note">
              Redo prompt
            </label>
            <textarea
              id="assets-redo-note"
              className="studio-factory-redo"
              data-testid="assets-redo-note"
              placeholder="wider eyes, brows raised, keep lids and skin tone…"
              value={redoNote}
              onChange={(event) => setRedoNote(event.target.value)}
            />
            {(inspector.history || []).length > 0 ? (
              <div className="studio-factory-history" data-testid="assets-inspector-history">
                <p className="studio-factory-redo-label">History</p>
                <div className="studio-factory-history-row">
                  {(inspector.history || []).map((item) => (
                    <span key={item.rel} className="studio-factory-history-thumb studio-checker">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={assetUrl(project, item.rel, { factory: true, v: item.mtime }) || undefined} alt="" />
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="studio-factory-redo-label" data-testid="assets-inspector-history">
                History · none
              </p>
            )}
          </div>
        ) : (
          <div className="studio-factory-summary" data-testid="assets-character-summary">
            <h2 className="studio-factory-inspector-title">{selected?.display_name}</h2>
            <p className="text-[10px] text-studio-muted">Click a drawing to approve it.</p>
          </div>
        )}
      </aside>
      ) : null}

      {overlays}
    </div>
  );
}

function FitPreview({ src, label, cover = false }: { src: string | null; label: string; cover?: boolean }) {
  return (
    <div className={`studio-factory-fit ${cover ? "studio-factory-fit--cover" : ""}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} />
      ) : (
        <p className="text-[11px] text-studio-muted">No picture</p>
      )}
      <span>{label}</span>
    </div>
  );
}

function Waveform({ peaks }: { peaks: number[] }) {
  const bars = peaks.length ? peaks : Array.from({ length: 24 }, () => 0.12);
  return (
    <span className="studio-factory-wave" aria-hidden="true">
      {bars.map((value, i) => (
        <i key={i} style={{ height: `${Math.max(8, Math.round(value * 100))}%` }} />
      ))}
    </span>
  );
}

function SoundTile({
  name,
  peaks,
  playing,
  onPlay,
  onOpen,
  onDelete,
}: {
  name: string;
  peaks: number[];
  playing: boolean;
  onPlay: () => void;
  onOpen?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="studio-factory-sound" data-testid={`assets-sound-${name}`} data-playing={playing ? "true" : "false"}>
      <button type="button" className="studio-factory-sound-main" onClick={onOpen}>
        <span className="studio-factory-sound-name">{name}</span>
        <Waveform peaks={peaks} />
      </button>
      <div className="studio-factory-sound-actions">
        <button type="button" className="studio-factory-sound-play" data-testid={`assets-sound-play-${name}`} onClick={onPlay}>
          {playing ? "Stop" : "Play"}
        </button>
        {onDelete ? (
          <button type="button" className="studio-factory-sound-trash" data-testid={`assets-sound-trash-${name}`} onClick={onDelete}>
            ⌫
          </button>
        ) : null}
      </div>
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
