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
  const [resizeMode, setResizeMode] = useState(false);
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
        <button type="button" onClick={() => setResizeMode(!resizeMode)} className="shots-btn"
          style={{ background: resizeMode ? "#e0a040" : undefined, color: resizeMode ? "#111" : undefined }}>
          {resizeMode ? "Cancel Resize" : "Resize Head"}
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

      {/* Resize head mode */}
      {resizeMode && (
        <ResizeHeadPanel
          project={project}
          characterId={characterId}
          shotId={shotId}
          frameUrl={currentCutUrl}
          onDone={() => { setResizeMode(false); load(); onReload(); }}
          onCancel={() => setResizeMode(false)}
        />
      )}

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

// ── Resize Head Panel ──────────────────────────────────────────────

function ResizeHeadPanel({
  project,
  characterId,
  shotId,
  frameUrl,
  onDone,
  onCancel,
}: {
  project: string;
  characterId: string;
  shotId: string;
  frameUrl: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [neckY, setNeckY] = useState(0.35);
  const [headScale, setHeadScale] = useState(0.7);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [imgLoaded, setImgLoaded] = useState(false);

  // Load the frame image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.src = frameUrl;
  }, [frameUrl]);

  // Draw preview whenever neckY, headScale, or image changes
  useEffect(() => {
    if (!imgLoaded || !imgRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const maxW = 360;
    const maxH = 300;
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const dw = Math.round(img.width * scale);
    const dh = Math.round(img.height * scale);
    canvas.width = dw;
    canvas.height = dh;

    // Clear
    ctx.clearRect(0, 0, dw, dh);

    const splitRow = Math.round(neckY * dh);
    const headH = splitRow;
    const bodyY = splitRow;
    const bodyH = dh - splitRow;

    // Draw scaled head
    const scaledHeadH = Math.round(headH * headScale);
    const scaledHeadW = Math.round(dw * headScale);
    const headX = Math.round((dw - scaledHeadW) / 2);
    const headY = splitRow - scaledHeadH;

    // Source head region from image
    const srcSplitRow = Math.round(neckY * img.height);
    ctx.drawImage(img, 0, 0, img.width, srcSplitRow,
                  headX, headY, scaledHeadW, scaledHeadH);

    // Draw body unchanged
    ctx.drawImage(img, 0, srcSplitRow, img.width, img.height - srcSplitRow,
                  0, bodyY, dw, bodyH);

    // Draw neck line
    ctx.strokeStyle = "#e0a040";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, splitRow);
    ctx.lineTo(dw, splitRow);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = "#e0a040";
    ctx.font = "12px sans-serif";
    ctx.fillText("← neck line", 4, splitRow - 4);
  }, [imgLoaded, neckY, headScale]);

  // Click on canvas to set neck line
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    setNeckY(Math.max(0.05, Math.min(0.95, y)));
  };

  const handleApply = async () => {
    setApplying(true);
    setError("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/resize-head`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ neckY, headScale }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Resize failed");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
    setApplying(false);
  };

  return (
    <div className="shots-resize-panel">
      <div className="shots-resize-layout">
        <div className="shots-resize-preview">
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{ cursor: "crosshair" }}
          />
          <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
            Click to set neck line position
          </div>
        </div>
        <div className="shots-resize-controls">
          <label className="shots-field">
            <span>Neck position: {Math.round(neckY * 100)}%</span>
            <input type="range" min={5} max={95} value={Math.round(neckY * 100)}
              onChange={(e) => setNeckY(Number(e.target.value) / 100)} />
          </label>
          <label className="shots-field">
            <span>Head scale: {headScale.toFixed(2)}x</span>
            <input type="range" min={10} max={200} value={Math.round(headScale * 100)}
              onChange={(e) => setHeadScale(Number(e.target.value) / 100)} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={handleApply} disabled={applying}
              className="shots-action-btn" style={{ flex: 1 }}>
              {applying ? "Applying to all frames…" : "Apply to all frames"}
            </button>
            <button type="button" onClick={onCancel} className="shots-btn" style={{ flex: "0 0 auto" }}>
              Cancel
            </button>
          </div>
          {error && <div className="shots-error" style={{ marginTop: 6 }}>{error}</div>}
          <div style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
            Originals backed up to _pre_resize/ folder
          </div>
        </div>
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
  const [rigLoaded, setRigLoaded] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyImgRef = useRef<HTMLImageElement | null>(null);
  const headImgRef = useRef<HTMLImageElement | null>(null);

  // Auto-load saved head rig settings
  useEffect(() => {
    (async () => {
      try {
        const res = await workerFetch(
          `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig`
        );
        if (!res.ok) return;
        const data = await res.json();
        const rigs = data.rigs || {};
        // Use first available rig as default
        const keys = Object.keys(rigs);
        if (keys.length > 0) {
          const first = rigs[keys[0]];
          setAnchorX(first.anchorX);
          setAnchorY(first.anchorY);
          setHeadScale(first.headScale);
          setRigLoaded(keys[0]);
        }
      } catch {}
    })();
  }, [project, characterId]);

  // Draw preview whenever inputs change
  const drawPreview = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    // Clear to dark bg
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, cvs.width, cvs.height);

    const bodyImg = bodyImgRef.current;
    if (!bodyImg || !bodyImg.complete || !bodyImg.naturalWidth) {
      ctx.fillStyle = "#555";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Pick a body and head shot", cvs.width / 2, cvs.height / 2);
      return;
    }

    // Fit body into canvas
    const bw = bodyImg.naturalWidth;
    const bh = bodyImg.naturalHeight;
    const scale = Math.min(cvs.width / bw, cvs.height / bh);
    const dx = (cvs.width - bw * scale) / 2;
    const dy = (cvs.height - bh * scale) / 2;
    ctx.drawImage(bodyImg, dx, dy, bw * scale, bh * scale);

    // Draw head if loaded
    const headImg = headImgRef.current;
    if (headImg && headImg.complete && headImg.naturalWidth) {
      const hw = headImg.naturalWidth * headScale;
      const hh = headImg.naturalHeight * headScale;
      // Anchor in body-image coords, then to canvas coords
      const cx = dx + anchorX * bw * scale;
      const cy = dy + anchorY * bh * scale;
      ctx.drawImage(headImg, cx - (hw * scale) / 2, cy - (hh * scale) / 2, hw * scale, hh * scale);
    }

    // Draw crosshair at anchor
    const ax = dx + anchorX * bw * scale;
    const ay = dy + anchorY * bh * scale;
    ctx.strokeStyle = "#e0a040";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay);
    ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10);
    ctx.stroke();
  }, [anchorX, anchorY, headScale]);

  // Load body frame 1 when bodyId changes
  useEffect(() => {
    bodyImgRef.current = null;
    if (!bodyId) { drawPreview(); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { bodyImgRef.current = img; drawPreview(); };
    img.src = shotMediaUrl(project, characterId, bodyId, "cut/f_0001.png");
  }, [bodyId, project, characterId, drawPreview]);

  // Load head frame 1 when headId changes
  useEffect(() => {
    headImgRef.current = null;
    if (!headId) { drawPreview(); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { headImgRef.current = img; drawPreview(); };
    img.src = shotMediaUrl(project, characterId, headId, "cut/f_0001.png");
  }, [headId, project, characterId, drawPreview]);

  // Redraw when anchor/scale changes
  useEffect(() => { drawPreview(); }, [drawPreview]);

  // Click on canvas to set anchor
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cvs = canvasRef.current;
    const bodyImg = bodyImgRef.current;
    if (!cvs || !bodyImg || !bodyImg.naturalWidth) return;
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Reverse the body fit math
    const bw = bodyImg.naturalWidth;
    const bh = bodyImg.naturalHeight;
    const scale = Math.min(cvs.width / bw, cvs.height / bh);
    const dx = (cvs.width - bw * scale) / 2;
    const dy = (cvs.height - bh * scale) / 2;
    const nx = Math.max(0, Math.min(1, (mx - dx) / (bw * scale)));
    const ny = Math.max(0, Math.min(1, (my - dy) / (bh * scale)));
    setAnchorX(Math.round(nx * 100) / 100);
    setAnchorY(Math.round(ny * 100) / 100);
  };

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
    <div className="shots-combine-panel">
      <div className="shots-new-header">
        <span>Combine head + body</span>
        <button type="button" className="shots-close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="shots-combine-layout">
        {/* Left: preview */}
        <div className="shots-combine-preview">
          <canvas
            ref={canvasRef}
            width={400}
            height={500}
            onClick={handleCanvasClick}
            style={{ cursor: "crosshair", borderRadius: 4, border: "1px solid #333" }}
          />
          <div style={{ fontSize: 10, color: "#666", marginTop: 4, textAlign: "center" }}>
            Click to place head anchor · Orange crosshair = anchor point
          </div>
        </div>

        {/* Right: controls */}
        <div className="shots-combine-controls">
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
            Name (optional)
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
          </div>

          <div className="shots-field">
            Head scale
            <input
              type="range" min={0.1} max={2} step={0.05}
              value={headScale}
              onChange={(e) => setHeadScale(+e.target.value)}
              style={{ width: "100%" }}
            />
            <span style={{ fontSize: 11, color: "#aaa" }}>{headScale.toFixed(2)}×</span>
          </div>

          {rigLoaded ? (
            <div style={{ fontSize: 11, color: "#e0a040", marginBottom: 4 }}>
              Using saved rig: {rigLoaded}
            </div>
          ) : null}

          {error && <div className="shots-error">{error}</div>}

          <button
            type="button"
            className="shots-make-btn"
            disabled={busy || !bodyId || !headId}
            onClick={handleCombine}
          >
            {busy ? "Combining…" : "Combine all frames"}
          </button>
        </div>
      </div>
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

  // Only show completed combined shots from the Build Character page
  const combinedShots = shots.filter((s) => s.shotType === "combined" && s.status === "ready");

  return (
    <div className="shots-page" data-testid="shots-page">
      {/* Top bar — simplified: combined shots come from Build Character page */}
      <div className="shots-topbar">
        <span style={{ fontSize: 11, color: "#999" }}>
          Combined clips from Build Character appear here. Use the character page to create new ones.
        </span>
      </div>

      {loading ? (
        <div className="shots-loading">Loading shots…</div>
      ) : combinedShots.length === 0 ? (
        <div className="shots-empty">
          No combined shots yet. Go to the character page to combine head + body shots, then send them here.
        </div>
      ) : (
        <div className="shots-category" data-testid="shots-cat-combined">
          <div className="shots-category-header">Combined Clips</div>
          <div className="shots-grid">
            {combinedShots.map((shot) => (
              <ShotCard
                key={shot.id}
                project={project}
                characterId={characterId}
                shot={shot}
                onClick={() => {
                  if (shot.status === "ready") {
                    setSelectedShot(shot.id);
                  }
                }}
                onDelete={async () => {
                  if (!confirm("Delete this combined shot?")) return;
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
      )}
    </div>
  );
}
