"use client";

import { useEffect, useRef, useState } from "react";
import {
  groupActionsByCategory,
  issueLabel,
  mergeCategories,
  type ActionCategory,
} from "@/lib/actionLibrary";
import { actionShotCaption, type ActionShotGroup } from "@/lib/factoryAssets";
import {
  actionPreviewUrl,
  actionPosterUrl,
  addActionCategory,
  assetUrl,
  deleteActionFrame,
  flagActionFrame,
  loadActionFrames,
  loadCharacterLibrary,
  patchActionCategory,
  saveActionFrameToSlot,
  type ActionFrameDetail,
  type ProjectAction,
} from "@/lib/worker";

function ShotTile({
  project,
  action,
  onClick,
}: {
  project: string;
  action: {
    id: string;
    name?: string;
    label: string;
    characterId: string | null;
    thumbRel?: string | null;
    frames?: number;
    drawings?: number;
    still?: boolean;
    warnings?: string[];
    flagged?: boolean;
  };
  onClick: () => void;
}) {
  const preview = actionPreviewUrl(project, action.characterId, action.name || action.id);
  const poster = actionPosterUrl(project, action.characterId, action.name || action.id);
  const fallback = assetUrl(project, action.thumbRel || null, { factory: true });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const caption = actionShotCaption(action);
  const warned = Boolean(action.flagged || (action.warnings && action.warnings.length));
  return (
    <button
      type="button"
      className="studio-factory-cell"
      data-testid={`assets-action-${action.name}`}
      data-still={action.still ? "true" : "false"}
      onClick={onClick}
      onMouseEnter={() => {
        const video = videoRef.current;
        if (video) void video.play();
      }}
      onMouseLeave={() => {
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        video.currentTime = 0;
      }}
    >
      <span className="studio-factory-cell-thumb studio-checker">
        {preview && !failed ? (
          <video
            ref={videoRef}
            src={preview}
            muted
            loop
            playsInline
            preload="metadata"
            poster={fallback || poster || undefined}
            onError={() => setFailed(true)}
          />
        ) : fallback ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fallback} alt="" />
        ) : null}
        {caption ? (
          <span className="studio-factory-shot-badge" data-testid={`assets-action-meta-${action.name}`}>
            {caption}
          </span>
        ) : null}
        {warned ? (
          <span className="studio-factory-shot-warn" title={(action.warnings || []).join(" ")}>
            !
          </span>
        ) : null}
      </span>
      <span className="studio-factory-cell-label">{action.label}</span>
    </button>
  );
}

function CategorySelect({
  value,
  categories,
  onChange,
  testId,
}: {
  value: string;
  categories: ActionCategory[];
  onChange: (id: string) => void;
  testId?: string;
}) {
  return (
    <select
      className="studio-factory-cat-select"
      value={value}
      data-testid={testId}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value)}
    >
      {categories.map((cat) => (
        <option key={cat.id} value={cat.id}>
          {cat.label}
        </option>
      ))}
    </select>
  );
}

export function ActionShotDetail({
  project,
  action,
  categories,
  onCategory,
}: {
  project: string;
  action: ProjectAction;
  categories: ActionCategory[];
  onCategory: (id: string) => void;
}) {
  const [detail, setDetail] = useState<ActionFrameDetail | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [cats, setCats] = useState<ActionCategory[]>(() => mergeCategories(categories));
  const characterId = action.characterId;
  const actionId = action.name || action.id;
  const preview = actionPreviewUrl(project, characterId, actionId);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    loadActionFrames(project, characterId, actionId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    loadCharacterLibrary(project, characterId)
      .then((lib) => {
        if (!cancelled) setCats(mergeCategories(lib.categories));
      })
      .catch(() => {
        /* keep defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId, actionId]);

  useEffect(() => {
    if (!playing || !detail || detail.drawings.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((n) => (n + 1) % detail.drawings.length);
    }, 1000 / 8);
    return () => window.clearInterval(timer);
  }, [playing, detail]);

  const current = detail?.drawings[index] || null;

  async function refresh(next: ActionFrameDetail) {
    setDetail(next);
    setIndex((n) => Math.min(n, Math.max(0, next.drawings.length - 1)));
  }

  return (
    <div className="studio-factory-action-detail" data-testid="assets-action-detail">
      <div className="studio-factory-action-detail-head">
        <strong>{actionId}</strong>
        {characterId ? (
          <CategorySelect
            value={action.category || detail?.category || "other"}
            categories={cats}
            onChange={onCategory}
            testId="assets-action-category"
          />
        ) : null}
      </div>
      {preview ? (
        <video src={preview} muted loop playsInline controls className="studio-factory-action-detail-video" />
      ) : null}
      {detail && detail.drawings.length ? (
        <>
          <div className="studio-factory-action-scrub">
            <button type="button" onClick={() => setPlaying((v) => !v)} data-testid="assets-action-play">
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, detail.drawings.length - 1)}
              value={index}
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
              data-testid="assets-action-scrub"
            />
            <span>
              {index + 1} / {detail.drawings.length}
            </span>
          </div>
          <div className="studio-factory-action-frame-grid" data-testid="assets-action-frames">
            {detail.drawings.map((frame) => (
              <button
                key={`${frame.name}-${frame.index}`}
                type="button"
                className="studio-factory-action-frame"
                data-active={frame.index === index ? "true" : "false"}
                data-testid={`assets-action-frame-${frame.number}`}
                onClick={() => {
                  setPlaying(false);
                  setIndex(frame.index);
                }}
              >
                {frame.rel ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(project, frame.rel, { factory: true })} alt="" />
                ) : (
                  <span />
                )}
                <em>{String(frame.number).padStart(2, "0")}</em>
                {frame.issues.length ? <i title={frame.issues.map(issueLabel).join(", ")}>!</i> : null}
              </button>
            ))}
          </div>
          {current && characterId ? (
            <div className="studio-factory-action-frame-tools">
              <button
                type="button"
                data-testid="assets-action-save-slot"
                onClick={() =>
                  void saveActionFrameToSlot(project, characterId, actionId, current.index, current.slot, action.view || undefined)
                    .then((result) => setNote(`Draft ${result.name}`))
                    .catch((err) => setNote(err instanceof Error ? err.message : "Save failed"))
                }
              >
                Save to slot (draft)
              </button>
              <button
                type="button"
                data-testid="assets-action-flag"
                onClick={() =>
                  void flagActionFrame(project, characterId, actionId, current.index, "flagged").then(refresh)
                }
              >
                Flag issue
              </button>
              <button
                type="button"
                data-testid="assets-action-flag-flip"
                onClick={() =>
                  void flagActionFrame(project, characterId, actionId, current.index, "upside_down").then(refresh)
                }
              >
                Upside down
              </button>
              <button
                type="button"
                data-testid="assets-action-flag-arm"
                onClick={() =>
                  void flagActionFrame(project, characterId, actionId, current.index, "arm_side").then(refresh)
                }
              >
                Wrong arm/side
              </button>
              <button
                type="button"
                data-testid="assets-action-flag-mirror"
                onClick={() =>
                  void flagActionFrame(project, characterId, actionId, current.index, "mirrored").then(refresh)
                }
              >
                Mirrored
              </button>
              <button
                type="button"
                data-testid="assets-action-delete-frame"
                onClick={() =>
                  void deleteActionFrame(project, characterId, actionId, current.index)
                    .then(refresh)
                    .catch((err) => setNote(err instanceof Error ? err.message : "Delete failed"))
                }
              >
                Delete frame
              </button>
            </div>
          ) : null}
          {note ? <p className="text-[11px] text-studio-muted">{note}</p> : null}
        </>
      ) : (
        <p className="text-[11px] text-studio-muted">No frames on this shot yet.</p>
      )}
    </div>
  );
}

export default function ActionShotsSection({
  project,
  groups,
  onOpen,
  onTrash,
  onNew,
  onReload,
}: {
  project: string;
  groups: ActionShotGroup[];
  onOpen: (action: { id: string; name?: string; label: string; characterId: string | null }) => void;
  onTrash: (action: { id: string; name?: string; label: string; characterId: string | null }) => void;
  onNew: () => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [categoriesByChar, setCategoriesByChar] = useState<Record<string, ActionCategory[]>>({});
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      groups
        .filter((group) => group.characterId)
        .map((group) =>
          loadCharacterLibrary(project, group.characterId as string).then((lib) => [group.characterId as string, lib.categories] as const)
        )
    )
      .then((rows) => {
        if (cancelled) return;
        const next: Record<string, ActionCategory[]> = {};
        for (const [id, cats] of rows) next[id] = cats;
        setCategoriesByChar(next);
      })
      .catch(() => {
        /* default categories still work */
      });
    return () => {
      cancelled = true;
    };
  }, [project, groups]);

  const firstCharacter = groups.find((group) => group.characterId)?.characterId;

  return (
    <div className="studio-factory-rows" data-testid="assets-section-actions">
      {groups.length === 0 ? (
        <div className="studio-factory-thumbs">
          <button type="button" className="studio-factory-add" data-testid="assets-new-actions" onClick={onNew}>
            <span>+</span>
          </button>
        </div>
      ) : null}
      {groups.map((group) => {
        const categories = mergeCategories(group.characterId ? categoriesByChar[group.characterId] : undefined);
        const buckets = groupActionsByCategory(group.actions, categories).filter((bucket) => bucket.actions.length);
        return (
          <section key={group.characterId || "shared"} className="studio-factory-row" data-testid={`assets-actions-${group.characterId || "shared"}`}>
            <div className="studio-factory-row-head">
              <h4 className="studio-factory-row-title">{group.characterName}</h4>
              <span className="studio-factory-row-meta">{group.actions.length}</span>
            </div>
            {buckets.map((bucket) => {
              const key = `${group.characterId || "shared"}:${bucket.id}`;
              const expanded = open[key] !== false;
              return (
                <div key={bucket.id} className="studio-factory-cat" data-testid={`assets-action-cat-${bucket.id}`}>
                  <button
                    type="button"
                    className="studio-factory-cat-toggle"
                    data-open={expanded ? "true" : "false"}
                    onClick={() => setOpen((prev) => ({ ...prev, [key]: !expanded }))}
                  >
                    {expanded ? "▾" : "▸"} {bucket.label}
                    <span>{bucket.actions.length}</span>
                  </button>
                  {expanded ? (
                    <div className="studio-factory-thumbs">
                      {bucket.actions.map((action) => (
                        <div key={action.id} className="studio-factory-tile-wrap">
                          <ShotTile
                            project={project}
                            action={action}
                            onClick={() => onOpen(action)}
                          />
                          {action.characterId ? (
                            <CategorySelect
                              value={action.category || bucket.id}
                              categories={categories}
                              testId={`assets-action-cat-select-${action.name}`}
                              onChange={(id) => {
                                void patchActionCategory(project, action.characterId as string, action.name || action.id, id).then(onReload);
                              }}
                            />
                          ) : null}
                          <button
                            type="button"
                            className="studio-factory-trash"
                            data-testid={`assets-trash-action-${action.name}`}
                            title="Delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              onTrash(action);
                            }}
                          >
                            ⌫
                          </button>
                        </div>
                      ))}
                      <button type="button" className="studio-factory-add" data-testid="assets-new-actions" onClick={onNew}>
                        <span>+</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
      {firstCharacter ? (
        <form
          className="studio-factory-cat-new"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newLabel.trim()) return;
            void addActionCategory(project, firstCharacter, newLabel.trim()).then(() => {
              setNewLabel("");
              onReload();
            });
          }}
        >
          <input
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder="New category"
            data-testid="assets-action-new-category"
          />
          <button type="submit">Add</button>
        </form>
      ) : null}
    </div>
  );
}
