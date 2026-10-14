"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WORKER_URL, workerFetch } from "@/lib/worker";

// ── Types ───────────────────────────────────────────────────────────

interface ShotInfo {
  id: string;
  name: string;
  filename: string;
  prompt: string;
  refImage: string;
  background: string;
  fps: number;
  frameCount: number;
  in: number;
  out: number;
  category: string;
  createdAt: string;
  status: string;
  error?: string;
  actionId?: string;
  _thumbCount?: number;
  shotType?: string;        // "head" | "body" | "full" | "combined"
  sourceBody?: string;
  sourceHead?: string;
}

interface ShotFrame {
  n: number;
  thumb: string;
  cut: string;
  deleted: boolean;
}

interface ShotDetail extends ShotInfo {
  frames: ShotFrame[];
}

// ── Category display ────────────────────────────────────────────────

const CATEGORIES = [
  { id: "expressions", label: "Expressions" },
  { id: "mouth_tongue", label: "Mouth/Tongue" },
  { id: "walks", label: "Walks" },
  { id: "turns_looks", label: "Turns" },
  { id: "head_moves", label: "Head moves" },
  { id: "mic", label: "Mic" },
  { id: "arms_gestures", label: "Arms/Gestures" },
  { id: "idle_stand", label: "Idle/Stand" },
  { id: "inserts", label: "Inserts" },
  { id: "other", label: "Other" },
];

// ── Helpers ─────────────────────────────────────────────────────────

function shotMediaUrl(project: string, characterId: string, shotId: string, rel: string): string {
  return `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(`${shotId}/${rel}`)}`;
}

// ── New Shot Panel ──────────────────────────────────────────────────

function NewShotPanel({
  project,
  characterId,
  onClose,
  onCreated,
}: {
  project: string;
  characterId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [background, setBackground] = useState<"green" | "black">("green");
  const [duration, setDuration] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleMake = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/make`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.trim(), background, duration }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error || "Failed to start shot");
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="shots-new-panel" data-testid="shots-new-panel">
      <div className="shots-new-header">
        <span>+ New shot</span>
        <button type="button" onClick={onClose} className="shots-close-btn">✕</button>
      </div>
      <label className="shots-field">
        <span>Prompt</span>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="walks to the left, side view"
          onKeyDown={(e) => e.key === "Enter" && handleMake()}
          autoFocus
        />
      </label>
      <div className="shots-row">
        <label className="shots-field">
          <span>Background</span>
          <select value={background} onChange={(e) => setBackground(e.target.value as "green" | "black")}>
            <option value="green">Green</option>
            <option value="black">Black</option>
          </select>
        </label>
        <label className="shots-field">
          <span>Length</span>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[4, 6, 8, 10].map((d) => (
              <option key={d} value={d}>{d}s</option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="shots-error">{error}</div>}
      <button
        type="button"
        className="shots-make-btn"
        onClick={handleMake}
        disabled={loading || !prompt.trim()}
      >
        {loading ? "Starting…" : "Make it"}
      </button>
    </div>
  );
}

// ── Shot Card ───────────────────────────────────────────────────────

function ShotCard({
  project,
  characterId,
  shot,
  onClick,
  onDelete,
}: {
  project: string;
  characterId: string;
  shot: ShotInfo;
  onClick: () => void;
  onDelete: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hovering, setHovering] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const posterUrl = shotMediaUrl(project, characterId, shot.id, "poster.jpg");
  const previewUrl = shotMediaUrl(project, characterId, shot.id, "preview.mp4");
  const isMaking = shot.status === "making";
  const isError = shot.status === "error";

  const handleMouseEnter = () => {
    setHovering(true);
    if (videoRef.current && shot.status === "ready") {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  // Build thumb URLs
  const thumbCount = shot._thumbCount || shot.frameCount || 0;
  const thumbUrls: string[] = [];
  for (let i = 1; i <= Math.min(thumbCount, shot.out || thumbCount); i++) {
    if (i < (shot.in || 1)) continue;
    thumbUrls.push(shotMediaUrl(project, characterId, shot.id, `thumb/f_${String(i).padStart(4, "0")}.jpg`));
  }

  return (
    <div
      className="shots-card"
      data-testid={`shot-card-${shot.id}`}
      data-status={shot.status}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="shots-card-poster">
        {isMaking ? (
          <div className="shots-card-making">
            <div className="shots-spinner" />
            <span>Making…</span>
          </div>
        ) : isError ? (
          <div className="shots-card-error">
            <span>⚠</span>
            <span className="shots-error-msg">{shot.error || "Failed"}</span>
          </div>
        ) : (
          <>
            <img src={posterUrl} alt={shot.name} loading="lazy" />
            {hovering && (
              <video
                ref={videoRef}
                src={previewUrl}
                muted
                loop
                playsInline
                preload="none"
                className="shots-card-video"
              />
            )}
          </>
        )}
        {shot.status === "ready" && (
          <span className="shots-badge">{shot.frameCount} frames</span>
        )}
        <button
          type="button"
          className="shots-card-delete"
          title="Delete shot"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >✕</button>
      </div>
      <div className="shots-card-name">{shot.name || shot.id}</div>
      {/* Horizontal scroll strip of thumbnails */}
      {thumbUrls.length > 0 && (
        <div className="shots-strip" ref={stripRef}>
          {thumbUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              loading="lazy"
              className="shots-strip-thumb"
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shot Detail View ────────────────────────────────────────────────

function ShotDetailView({
  project,
  characterId,
  shotId,
  onBack,
  onReload,
}: {
  project: string;
  characterId: string;
  shotId: string;
  onBack: () => void;
  onReload: () => void;
}) {
  const [detail, setDetail] = useState<ShotDetail | null>(null);
  const [error, setError] = useState("");
  const [currentFrame, setCurrentFrame] = useState(1);
  const [inFrame, setInFrame] = useState(1);
  const [outFrame, setOutFrame] = useState(1);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}`
      );
      if (!res.ok) throw new Error("Failed to load shot");
      const data: ShotDetail = await res.json();
      setDetail(data);
      setInFrame(data.in || 1);
      setOutFrame(data.out || data.frameCount);
      setName(data.name || data.id);
      setCategory(data.category || "other");
      setCurrentFrame(data.in || 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }, [project, characterId, shotId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, category, in: inFrame, out: outFrame }),
        }
      );
      onReload();
    } catch {}
    setSaving(false);
  };

  const handleDelete = async (frameN: number) => {
    try {
      await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/frames/${frameN}`,
        { method: "DELETE" }
      );
      load();
    } catch {}
  };

  const handleSaveSlot = async (frameN: number) => {
    try {
      await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/frames/${frameN}/save-slot`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: "body", view: "front" }),
        }
      );
    } catch {}
  };

  const handleUseAsActionShot = async () => {
    setSaving(true);
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/use`,
        { method: "POST" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Failed");
      }
      const result = await res.json();
      setError("");
      onReload();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
    setSaving(false);
  };

  if (error && !detail) return <div className="shots-error">{error}</div>;
  if (!detail) return <div className="shots-loading">Loading…</div>;

  const previewUrl = shotMediaUrl(project, characterId, shotId, "preview.mp4");
  const currentCutUrl = shotMediaUrl(
    project, characterId, shotId,
    `cut/f_${String(currentFrame).padStart(4, "0")}.png`
  );

  return (
    <div className="shots-detail" data-testid="shots-detail">
      <div className="shots-detail-header">
        <button type="button" onClick={onBack} className="shots-back-btn">← Back</button>
        <span className="shots-detail-title">{name}</span>
      </div>

      {/* Big player area */}
      <div className="shots-detail-player">
        <img src={currentCutUrl} alt={`Frame ${currentFrame}`} className="shots-detail-frame" />
        <div className="shots-detail-framenum">Frame {currentFrame} / {detail.frameCount}</div>
      </div>

      {/* Scrub bar */}
      <div className="shots-scrub">
        <input
          type="range"
          min={1}
          max={detail.frameCount}
          value={currentFrame}
          onChange={(e) => setCurrentFrame(Number(e.target.value))}
          className="shots-scrub-slider"
        />
      </div>

      {/* In/Out handles */}
      <div className="shots-inout">
        <label>
          In: <input type="number" min={1} max={outFrame} value={inFrame}
            onChange={(e) => setInFrame(Math.max(1, Math.min(Number(e.target.value), outFrame)))} />
        </label>
        <label>
          Out: <input type="number" min={inFrame} max={detail.frameCount} value={outFrame}
            onChange={(e) => setOutFrame(Math.max(inFrame, Math.min(Number(e.target.value), detail.frameCount)))} />
        </label>
        <span className="shots-inout-count">{outFrame - inFrame + 1} frames selected</span>
      </div>

      {/* Rename / Category */}
      <div className="shots-meta-edit">
        <label className="shots-field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="shots-field">
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={handleSave} disabled={saving} className="shots-save-btn">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* Per-frame actions */}
      <div className="shots-frame-actions">
        <button type="button" onClick={() => handleDelete(currentFrame)} className="shots-btn-danger">
          Delete frame {currentFrame}
        </button>
        <button type="button" onClick={() => handleSaveSlot(currentFrame)} className="shots-btn">
          Save to slot
        </button>
      </div>

      {/* Use as Action Shot */}
      <div className="shots-use-action">
        <button
          type="button"
          onClick={handleUseAsActionShot}
          disabled={saving}
          className="shots-action-btn"
        >
          {saving ? "Creating…" : "Use as Action Shot"}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!confirm("Delete this entire shot?")) return;
            setSaving(true);
            try {
              const res = await workerFetch(
                `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}`,
                { method: "DELETE" }
              );
              if (!res.ok) {
                const body = await res.json().catch(() => ({ error: "Delete failed" }));
                setError(body.error || "Delete failed");
                setSaving(false);
                return;
              }
              onReload();
              onBack();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Delete failed");
            }
            setSaving(false);
          }}
          disabled={saving}
          className="shots-btn-danger"
        >
          Delete shot
        </button>
        {detail.actionId && (
          <span className="shots-action-done">✓ Action: {detail.actionId}</span>
        )}
      </div>

      {error && <div className="shots-error">{error}</div>}

      {/* Frame strip at bottom */}
      <div className="shots-detail-strip">
        {detail.frames
          .filter((f) => !f.deleted)
          .map((f) => (
            <img
              key={f.n}
              src={shotMediaUrl(project, characterId, shotId, f.thumb)}
              alt={`Frame ${f.n}`}
              loading="lazy"
              className={`shots-strip-thumb ${f.n === currentFrame ? "active" : ""} ${
                f.n < inFrame || f.n > outFrame ? "trimmed" : ""
              }`}
              onClick={() => setCurrentFrame(f.n)}
            />
          ))}
      </div>
    </div>
  );
}

// ── Combine Panel ──────────────────────────────────────────────────

function CombinePanel({
  project,
  characterId,
  shots,
  onClose,
  onCreated,
}: {
  project: string;
  characterId: string;
  shots: ShotInfo[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const readyShots = shots.filter((s) => s.status === "ready");
  const [bodyId, setBodyId] = useState("");
  const [headId, setHeadId] = useState("");
  const [anchorX, setAnchorX] = useState(0.5);
  const [anchorY, setAnchorY] = useState(0.15);
  const [headScale, setHeadScale] = useState(1.0);
  const [combineName, setCombineName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleCombine = async () => {
    if (!bodyId || !headId) { setError("Pick both a body and head shot"); return; }
    if (bodyId === headId) { setError("Body and head must be different shots"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/combine`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bodyId, headId,
            anchorX, anchorY,
            headScale,
            name: combineName || undefined,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Combine failed" }));
        throw new Error(body.error || "Combine failed");
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Combine failed");
    }
    setBusy(false);
  };

  return (
    <div className="shots-new-panel">
      <div className="shots-new-header">
        <span>Combine head + body</span>
        <button type="button" className="shots-close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="shots-field">
        Body shot
        <select value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
          <option value="">— pick body —</option>
          {readyShots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id} ({s.frameCount}f)
            </option>
          ))}
        </select>
      </div>

      <div className="shots-field">
        Head shot
        <select value={headId} onChange={(e) => setHeadId(e.target.value)}>
          <option value="">— pick head —</option>
          {readyShots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id} ({s.frameCount}f)
            </option>
          ))}
        </select>
      </div>

      <div className="shots-field">
        Combined name (optional)
        <input
          value={combineName}
          onChange={(e) => setCombineName(e.target.value)}
          placeholder="e.g. rodney_talk_front"
        />
      </div>

      <div className="shots-row">
        <div className="shots-field">
          Anchor X
          <input
            type="number" min={0} max={1} step={0.05}
            value={anchorX} onChange={(e) => setAnchorX(+e.target.value)}
          />
        </div>
        <div className="shots-field">
          Anchor Y
          <input
            type="number" min={0} max={1} step={0.05}
            value={anchorY} onChange={(e) => setAnchorY(+e.target.value)}
          />
        </div>
        <div className="shots-field">
          Head scale
          <input
            type="number" min={0.1} max={3} step={0.05}
            value={headScale} onChange={(e) => setHeadScale(+e.target.value)}
          />
        </div>
      </div>

      <div style={{ fontSize: 11, color: "#888", padding: "2px 0" }}>
        Anchor = where head sits on body (0,0 top-left → 1,1 bottom-right).
        Default 0.5, 0.15 = centred near top. Head loops if fewer frames.
      </div>

      {error && <div className="shots-error">{error}</div>}

      <button
        type="button"
        className="shots-make-btn"
        disabled={busy || !bodyId || !headId}
        onClick={handleCombine}
      >
        {busy ? "Combining…" : "Combine"}
      </button>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────

export default function ActionShotsPage({
  project,
  characterId,
  onReload,
}: {
  project: string;
  characterId: string;
  onReload?: () => void;
}) {
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showCombine, setShowCombine] = useState(false);
  const [selectedShot, setSelectedShot] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadShots = useCallback(async () => {
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`
      );
      if (res.ok) {
        const data: ShotInfo[] = await res.json();
        setShots(data);
      }
    } catch {}
    setLoading(false);
  }, [project, characterId]);

  useEffect(() => {
    loadShots();
  }, [loadShots]);

  // Poll for making shots
  useEffect(() => {
    const hasMaking = shots.some((s) => s.status === "making");
    if (hasMaking && !pollRef.current) {
      pollRef.current = setInterval(loadShots, 5000);
    } else if (!hasMaking && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [shots, loadShots]);

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp4,video/mp4";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImportError("");
      const formData = new FormData();
      formData.append("video", file);
      try {
        const res = await workerFetch(
          `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/import`,
          { method: "POST", body: formData }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Import failed" }));
          throw new Error(body.error || "Import failed");
        }
        loadShots();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Import failed");
      }
    };
    input.click();
  };

  const handleRetry = async (shotId: string) => {
    try {
      await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/retry`,
        { method: "POST" }
      );
      loadShots();
    } catch {}
  };

  // If a shot is selected, show detail view
  if (selectedShot) {
    return (
      <ShotDetailView
        project={project}
        characterId={characterId}
        shotId={selectedShot}
        onBack={() => { setSelectedShot(null); loadShots(); }}
        onReload={() => { loadShots(); onReload?.(); }}
      />
    );
  }

  // Group shots by category
  const grouped = new Map<string, ShotInfo[]>();
  for (const shot of shots) {
    const cat = shot.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(shot);
  }

  return (
    <div className="shots-page" data-testid="shots-page">
      {/* Top bar */}
      <div className="shots-topbar">
        <button type="button" className="shots-btn-accent" onClick={() => setShowNew(true)}>
          + New shot
        </button>
        <button type="button" className="shots-btn" onClick={handleImport}>
          Import MP4
        </button>
        <button type="button" className="shots-btn" onClick={() => setShowCombine(true)}>
          Combine head+body
        </button>
      </div>

      {importError && <div className="shots-error">{importError}</div>}

      {showNew && (
        <NewShotPanel
          project={project}
          characterId={characterId}
          onClose={() => setShowNew(false)}
          onCreated={loadShots}
        />
      )}

      {showCombine && (
        <CombinePanel
          project={project}
          characterId={characterId}
          shots={shots}
          onClose={() => setShowCombine(false)}
          onCreated={loadShots}
        />
      )}

      {loading ? (
        <div className="shots-loading">Loading shots…</div>
      ) : shots.length === 0 ? (
        <div className="shots-empty">
          No shots yet. Click &quot;+ New shot&quot; to make one with Grok, or &quot;Import MP4&quot; for clips from grok.com.
        </div>
      ) : (
        /* Category sections */
        CATEGORIES.map((cat) => {
          const catShots = grouped.get(cat.id);
          if (!catShots || catShots.length === 0) return null;
          return (
            <div key={cat.id} className="shots-category" data-testid={`shots-cat-${cat.id}`}>
              <div className="shots-category-header">{cat.label}</div>
              <div className="shots-grid">
                {catShots.map((shot) => (
                  <ShotCard
                    key={shot.id}
                    project={project}
                    characterId={characterId}
                    shot={shot}
                    onClick={() => {
                      if (shot.status === "error") {
                        handleRetry(shot.id);
                      } else if (shot.status === "ready") {
                        setSelectedShot(shot.id);
                      }
                    }}
                    onDelete={async () => {
                      if (!confirm("Delete this shot?")) return;
                      try {
                        const res = await workerFetch(
                          `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shot.id)}`,
                          { method: "DELETE" }
                        );
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({ error: "Delete failed" }));
                          alert(body.error || "Delete failed");
                          return;
                        }
                        loadShots();
                      } catch (err) {
                        alert(err instanceof Error ? err.message : "Delete failed");
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
