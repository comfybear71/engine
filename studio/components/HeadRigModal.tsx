"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKER_URL, workerFetch } from "@/lib/worker";

// ── Types ──────────────────────────────────────────────────────────

interface ShotInfo {
  id: string;
  name: string;
  category: string;
  status: string;
  shotType?: string;
  frameCount: number;
}

interface RigEntry {
  anchorX: number;
  anchorY: number;
  headScale: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function shotMediaUrl(project: string, characterId: string, shotId: string, rel: string): string {
  return `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(`${shotId}/${rel}`)}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// ── Component ───────────────────────────────────────────────────────

export default function HeadRigModal({
  project,
  characterId,
  onClose,
  inline,
}: {
  project: string;
  characterId: string;
  onClose?: () => void;
  inline?: boolean;
}) {
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [rigs, setRigs] = useState<Record<string, RigEntry>>({});
  const [bodyId, setBodyId] = useState("");
  const [headId, setHeadId] = useState("");
  const [rigKey, setRigKey] = useState("front");
  const [anchorX, setAnchorX] = useState(0.5);
  const [anchorY, setAnchorY] = useState(0.15);
  const [headScale, setHeadScale] = useState(0.7);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Preview playback state
  const [playing, setPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(1);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bodyFramesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const headFramesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const [previewLoading, setPreviewLoading] = useState(false);

  // Grok shot creator state
  const [grokType, setGrokType] = useState<"body" | "head">("body");
  const [grokPrompt, setGrokPrompt] = useState("");
  const [grokBusy, setGrokBusy] = useState(false);
  const [grokMsg, setGrokMsg] = useState("");

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyImgRef = useRef<HTMLImageElement | null>(null);
  const headImgRef = useRef<HTMLImageElement | null>(null);
  const [bodyNat, setBodyNat] = useState({ w: 0, h: 0 });
  const [headNat, setHeadNat] = useState({ w: 0, h: 0 });

  // Drag state
  const dragRef = useRef<{
    kind: "move" | "scale";
    startX: number;
    startY: number;
    origAnchorX: number;
    origAnchorY: number;
    origScale: number;
  } | null>(null);

  // Load shots + rigs
  useEffect(() => {
    (async () => {
      try {
        const [shotsRes, rigRes] = await Promise.all([
          workerFetch(`/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`),
          workerFetch(`/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig`),
        ]);
        if (shotsRes.ok) {
          const data: ShotInfo[] = await shotsRes.json();
          setShots(data.filter((s) => s.status === "ready"));
        }
        if (rigRes.ok) {
          const data = await rigRes.json();
          setRigs(data.rigs || {});
        }
      } catch {}
    })();
  }, [project, characterId]);

  // When rig key changes, load saved settings if they exist
  useEffect(() => {
    const entry = rigs[rigKey];
    if (entry) {
      setAnchorX(entry.anchorX);
      setAnchorY(entry.anchorY);
      setHeadScale(entry.headScale);
    }
  }, [rigKey, rigs]);

  // Load body image
  useEffect(() => {
    if (!bodyId) { bodyImgRef.current = null; setBodyNat({ w: 0, h: 0 }); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { bodyImgRef.current = img; setBodyNat({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = shotMediaUrl(project, characterId, bodyId, "cut/f_0001.png");
  }, [bodyId, project, characterId]);

  // Load head image
  useEffect(() => {
    if (!headId) { headImgRef.current = null; setHeadNat({ w: 0, h: 0 }); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { headImgRef.current = img; setHeadNat({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = shotMediaUrl(project, characterId, headId, "cut/f_0001.png");
  }, [headId, project, characterId]);

  // Draw canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // Checkerboard background
    const sz = 12;
    for (let y = 0; y < ch; y += sz) {
      for (let x = 0; x < cw; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? "#1a1a1a" : "#222";
        ctx.fillRect(x, y, sz, sz);
      }
    }

    const bodyImg = bodyImgRef.current;
    if (!bodyImg || bodyNat.w === 0) return;

    // Fit body into lower 70% of canvas, leaving headroom above
    const bodyZone = ch * 0.7;
    const scale = Math.min(cw / bodyNat.w, bodyZone / bodyNat.h) * 0.9;
    const bw = bodyNat.w * scale;
    const bh = bodyNat.h * scale;
    const bx = (cw - bw) / 2;
    const by = ch - bh - ch * 0.03; // body sits near bottom

    ctx.drawImage(bodyImg, bx, by, bw, bh);

    // Draw head overlay
    const headImg = headImgRef.current;
    if (headImg && headNat.w > 0) {
      const hw = headNat.w * headScale * scale;
      const hh = headNat.h * headScale * scale;
      const hx = bx + anchorX * bw - hw / 2;
      const hy = by + anchorY * bh - hh / 2;

      ctx.globalAlpha = 0.8;
      ctx.drawImage(headImg, hx, hy, hw, hh);
      ctx.globalAlpha = 1;

      // Dashed outline
      ctx.strokeStyle = "#e0a040";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(hx, hy, hw, hh);
      ctx.setLineDash([]);

      // Corner handles
      const handles = [
        [hx, hy], [hx + hw, hy],
        [hx, hy + hh], [hx + hw, hy + hh],
      ];
      for (const [cx, cy] of handles) {
        ctx.fillStyle = "#e0a040";
        ctx.fillRect(cx - 4, cy - 4, 8, 8);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - 4, cy - 4, 8, 8);
      }

      // Crosshair at anchor point
      const ax = bx + anchorX * bw;
      const ay = by + anchorY * bh;
      ctx.strokeStyle = "#e0a040";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay);
      ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10);
      ctx.stroke();
    }
  }, [bodyNat, headNat, anchorX, anchorY, headScale]);

  useEffect(() => { draw(); }, [draw]);

  // Mouse handlers for drag
  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || !bodyImgRef.current || bodyNat.w === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const cw = canvas.width;
    const ch = canvas.height;
    const bodyZone = ch * 0.7;
    const scale = Math.min(cw / bodyNat.w, bodyZone / bodyNat.h) * 0.9;
    const bw = bodyNat.w * scale;
    const bh = bodyNat.h * scale;
    const bx = (cw - bw) / 2;
    const by = ch - bh - ch * 0.03;

    // Check if clicking near a corner handle (scale)
    if (headImgRef.current && headNat.w > 0) {
      const hw = headNat.w * headScale * scale;
      const hh = headNat.h * headScale * scale;
      const hx = bx + anchorX * bw - hw / 2;
      const hy = by + anchorY * bh - hh / 2;
      const corners = [
        [hx, hy], [hx + hw, hy],
        [hx, hy + hh], [hx + hw, hy + hh],
      ];
      for (const [cx, cy] of corners) {
        if (Math.abs(mx - cx) < 10 && Math.abs(my - cy) < 10) {
          dragRef.current = {
            kind: "scale",
            startX: e.clientX,
            startY: e.clientY,
            origAnchorX: anchorX,
            origAnchorY: anchorY,
            origScale: headScale,
          };
          e.preventDefault();
          return;
        }
      }

      // Check if clicking inside head bounds (move)
      if (mx >= hx && mx <= hx + hw && my >= hy && my <= hy + hh) {
        dragRef.current = {
          kind: "move",
          startX: e.clientX,
          startY: e.clientY,
          origAnchorX: anchorX,
          origAnchorY: anchorY,
          origScale: headScale,
        };
        e.preventDefault();
        return;
      }
    }

    // Click on body (outside head) = set anchor position
    // Skip if head is loaded — only allow click-to-place when no head image yet
    if (!headImgRef.current || headNat.w === 0) {
      setAnchorX(clamp((mx - bx) / bw, 0, 1));
      setAnchorY((my - by) / bh);
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas || bodyNat.w === 0) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const bodyZone = ch * 0.7;
    const scale = Math.min(cw / bodyNat.w, bodyZone / bodyNat.h) * 0.9;
    const bw = bodyNat.w * scale;
    const bh = bodyNat.h * scale;

    if (drag.kind === "move") {
      const dx = (e.clientX - drag.startX) / bw;
      const dy = (e.clientY - drag.startY) / bh;
      setAnchorX(clamp(drag.origAnchorX + dx, 0, 1));
      setAnchorY(clamp(drag.origAnchorY + dy, -0.5, 1));
    } else if (drag.kind === "scale") {
      const dy = drag.startY - e.clientY;
      const factor = 1 + dy / 200;
      setHeadScale(clamp(drag.origScale * factor, 0.1, 3));
    }
  }

  function onMouseUp() {
    dragRef.current = null;
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.03 : 0.03;
    setHeadScale((s) => clamp(s + delta, 0.1, 3));
  }

  // Save rig
  async function handleSave() {
    setBusy("Saving...");
    setError(null);
    setSaved(false);
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: rigKey,
            anchorX: Math.round(anchorX * 1000) / 1000,
            anchorY: Math.round(anchorY * 1000) / 1000,
            headScale: Math.round(headScale * 1000) / 1000,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(body.error || "Save failed");
      }
      const data = await res.json();
      setRigs(data.rigs || {});
      setSaved(true);
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  // Delete rig
  async function handleDelete(key: string) {
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig/${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        const data = await res.json();
        setRigs(data.rigs || {});
      }
    } catch {}
  }

  // Get frame counts for selected shots
  const bodyShot = shots.find((s) => s.id === bodyId);
  const headShot = shots.find((s) => s.id === headId);
  const bodyFrameCount = bodyShot?.frameCount || 0;
  const headFrameCount = headShot?.frameCount || 0;
  const maxFrames = Math.max(bodyFrameCount, headFrameCount);

  // Preload frames for preview
  function preloadFrames(shotId: string, count: number, cache: Map<number, HTMLImageElement>) {
    cache.clear();
    const toLoad = Math.min(count, 200); // cap at 200 frames
    let loaded = 0;
    for (let i = 1; i <= toLoad; i++) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const pad = String(i).padStart(4, "0");
      img.onload = () => { cache.set(i, img); loaded++; if (loaded >= toLoad) setPreviewLoading(false); };
      img.onerror = () => { loaded++; if (loaded >= toLoad) setPreviewLoading(false); };
      img.src = shotMediaUrl(project, characterId, shotId, `cut/f_${pad}.png`);
    }
  }

  function handlePlay() {
    if (playing) {
      // Stop
      if (playTimerRef.current) clearInterval(playTimerRef.current);
      playTimerRef.current = null;
      setPlaying(false);
      return;
    }
    if (!bodyId || !headId || maxFrames === 0) return;

    // Preload frames
    setPreviewLoading(true);
    preloadFrames(bodyId, bodyFrameCount, bodyFramesRef.current);
    preloadFrames(headId, headFrameCount, headFramesRef.current);

    setPlaying(true);
    setPreviewFrame(1);

    // Play at ~12fps
    playTimerRef.current = setInterval(() => {
      setPreviewFrame((f) => {
        const next = f + 1;
        return next > maxFrames ? 1 : next;
      });
    }, 83);
  }

  // Draw preview frame when playing
  useEffect(() => {
    if (!playing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // Checkerboard
    const sz = 12;
    for (let y = 0; y < ch; y += sz) {
      for (let x = 0; x < cw; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? "#1a1a1a" : "#222";
        ctx.fillRect(x, y, sz, sz);
      }
    }

    // Body frame (loop within body's frame count)
    const bf = ((previewFrame - 1) % Math.max(bodyFrameCount, 1)) + 1;
    const bodyImg = bodyFramesRef.current.get(bf) || bodyImgRef.current;
    if (!bodyImg || bodyNat.w === 0) return;

    const bodyZone = ch * 0.7;
    const scale = Math.min(cw / bodyNat.w, bodyZone / bodyNat.h) * 0.9;
    const bw = bodyNat.w * scale;
    const bh = bodyNat.h * scale;
    const bx = (cw - bw) / 2;
    const by = ch - bh - ch * 0.03;
    ctx.drawImage(bodyImg, bx, by, bw, bh);

    // Head frame (loop within head's frame count)
    const hf = ((previewFrame - 1) % Math.max(headFrameCount, 1)) + 1;
    const headImg = headFramesRef.current.get(hf) || headImgRef.current;
    if (headImg && headNat.w > 0) {
      const hw = headNat.w * headScale * scale;
      const hh = headNat.h * headScale * scale;
      const hx = bx + anchorX * bw - hw / 2;
      const hy = by + anchorY * bh - hh / 2;
      ctx.drawImage(headImg, hx, hy, hw, hh);
    }

    // Frame counter
    ctx.fillStyle = "#e0a040";
    ctx.font = "12px monospace";
    ctx.fillText(`Frame ${previewFrame} / ${maxFrames}`, 8, ch - 8);
  }, [playing, previewFrame, bodyNat, headNat, anchorX, anchorY, headScale, bodyFrameCount, headFrameCount, maxFrames]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (playTimerRef.current) clearInterval(playTimerRef.current); };
  }, []);

  // Reload shots list
  async function reloadShots() {
    try {
      const res = await workerFetch(`/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`);
      if (res.ok) {
        const data: ShotInfo[] = await res.json();
        setShots(data.filter((s) => s.status === "ready"));
      }
    } catch {}
  }

  // Create a Grok shot
  async function handleGrokCreate() {
    if (!grokPrompt.trim()) return;
    setGrokBusy(true);
    setGrokMsg("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: grokPrompt.trim(),
            shotType: grokType,
            background: "green",
            duration: 6,
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setGrokMsg(data.error || "Failed to create shot");
      } else {
        const data = await res.json();
        setGrokMsg(`Creating ${grokType} shot "${data.shotId}" — will appear when ready`);
        setGrokPrompt("");
        // Poll for completion
        const poll = setInterval(async () => {
          await reloadShots();
          try {
            const check = await workerFetch(
              `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(data.shotId)}`
            );
            if (check.ok) {
              const info = await check.json();
              if (info.status === "ready" || info.status === "error") {
                clearInterval(poll);
                await reloadShots();
                setGrokMsg(info.status === "ready" ? `Shot "${data.shotId}" ready!` : `Error: ${info.error || "failed"}`);
              }
            }
          } catch {}
        }, 5000);
        // Stop polling after 12 minutes
        setTimeout(() => clearInterval(poll), 720000);
      }
    } catch (err) {
      setGrokMsg(err instanceof Error ? err.message : "Failed");
    }
    setGrokBusy(false);
  }

  // Filter shots into body/head categories
  const bodyShots = shots.filter((s) => s.shotType === "body" || s.category === "idle_stand" || s.category === "walks" || s.category === "mic");
  const headShots = shots.filter((s) => s.shotType === "head" || s.category === "expressions" || s.category === "head_moves" || s.category === "mouth_tongue");
  // If no type/category filtering works, show all
  const allShots = shots;

  const rigKeys = Object.keys(rigs);

  const CANVAS_W = 600;
  const CANVAS_H = 800;

  const content = (
        <div className={inline ? "overflow-y-auto p-2" : "min-h-0 flex-1 overflow-y-auto p-4"} style={inline ? { maxHeight: "calc(100vh - 120px)" } : undefined}>
          {/* Shot pickers */}
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-[11px] text-studio-muted">
              Body shot
              <select
                className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                value={bodyId}
                onChange={(e) => setBodyId(e.target.value)}
              >
                <option value="">— pick —</option>
                {(bodyShots.length > 0 ? bodyShots : allShots).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id} {s.shotType ? `(${s.shotType})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-studio-muted">
              Head shot
              <select
                className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                value={headId}
                onChange={(e) => setHeadId(e.target.value)}
              >
                <option value="">— pick —</option>
                {(headShots.length > 0 ? headShots : allShots).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id} {s.shotType ? `(${s.shotType})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-studio-muted">
              Rig name
              <select
                className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                value={rigKey}
                onChange={(e) => setRigKey(e.target.value)}
              >
                <option value="front">front</option>
                <option value="left_34">left 3/4</option>
                <option value="right_34">right 3/4</option>
                <option value="left_side">left side</option>
                <option value="right_side">right side</option>
                <option value="back">back</option>
              </select>
              <input
                type="text"
                className="ml-1 w-20 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                placeholder="custom..."
                value={rigKey}
                onChange={(e) => setRigKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))}
              />
            </label>
          </div>

          {/* Canvas */}
          <div className="flex gap-4">
            <div>
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                className="rounded-md border border-studio-border"
                style={{ cursor: "crosshair", width: CANVAS_W, height: CANVAS_H, maxHeight: "70vh", objectFit: "contain" }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onWheel={onWheel}
              />
              <p className="mt-1 text-[10px] text-studio-muted">
                Click = set position · Drag head = move · Corner handles = scale · Scroll = resize
              </p>
            </div>

            {/* Controls + saved rigs */}
            <div className="flex min-w-[200px] flex-col gap-3">
              <label className="text-[11px] text-studio-muted">
                Head scale: {headScale.toFixed(2)}
                <input
                  type="range"
                  min={0.1}
                  max={2.5}
                  step={0.01}
                  value={headScale}
                  onChange={(e) => setHeadScale(Number(e.target.value))}
                  className="studio-scrubber mt-1 w-full"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-studio-muted">
                  Anchor X
                  <input
                    type="number"
                    step={0.01}
                    min={0}
                    max={1}
                    value={anchorX.toFixed(3)}
                    onChange={(e) => setAnchorX(clamp(Number(e.target.value), 0, 1))}
                    className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  />
                </label>
                <label className="text-[11px] text-studio-muted">
                  Anchor Y
                  <input
                    type="number"
                    step={0.01}
                    min={-0.5}
                    max={1}
                    value={anchorY.toFixed(3)}
                    onChange={(e) => setAnchorY(clamp(Number(e.target.value), -0.5, 1))}
                    className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  />
                </label>
              </div>

              {error ? <p className="text-xs text-red-400">{error}</p> : null}
              {saved ? <p className="text-xs text-green-400">Saved!</p> : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-studio-accent px-3 py-2 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
                  disabled={busy != null || !bodyId || !headId}
                  onClick={() => void handleSave()}
                >
                  {busy || `Save "${rigKey}" rig`}
                </button>
                <button
                  type="button"
                  className={`rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-40 ${
                    playing
                      ? "bg-red-600 text-white hover:bg-red-500"
                      : "bg-emerald-600 text-white hover:bg-emerald-500"
                  }`}
                  disabled={!bodyId || !headId || previewLoading}
                  onClick={handlePlay}
                >
                  {previewLoading ? "Loading…" : playing ? "⏹ Stop" : "▶ Play"}
                </button>
              </div>

              {/* Saved rigs list */}
              {rigKeys.length > 0 ? (
                <div className="mt-2">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-studio-muted">Saved rigs</p>
                  {rigKeys.map((key) => {
                    const r = rigs[key];
                    return (
                      <div key={key} className="mb-1 flex items-center justify-between rounded bg-studio-raised px-2 py-1">
                        <button
                          type="button"
                          className="text-left text-xs text-neutral-200 hover:text-white"
                          onClick={() => {
                            setRigKey(key);
                            setAnchorX(r.anchorX);
                            setAnchorY(r.anchorY);
                            setHeadScale(r.headScale);
                          }}
                        >
                          <span className="font-medium">{key}</span>
                          <span className="ml-2 text-studio-muted">
                            s={r.headScale.toFixed(2)} x={r.anchorX.toFixed(2)} y={r.anchorY.toFixed(2)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="ml-2 text-[10px] text-red-400 hover:text-red-300"
                          onClick={() => void handleDelete(key)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          {/* ── Shot Browser — pick body & head visually ──── */}
          <div className="mt-4 rounded-md border border-studio-border bg-[#1a1a1a] p-3">
            <h3 className="mb-2 text-xs font-semibold text-neutral-300">Body Shots</h3>
            {bodyShots.length === 0 && allShots.length === 0 ? (
              <p className="text-[10px] text-studio-muted">No body shots yet — create one with Grok below</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(bodyShots.length > 0 ? bodyShots : allShots).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`group relative overflow-hidden rounded-md border-2 ${
                      bodyId === s.id ? "border-[#e0a040]" : "border-studio-border hover:border-neutral-500"
                    }`}
                    style={{ width: 80, height: 80 }}
                    onClick={() => setBodyId(s.id)}
                    title={s.name || s.id}
                  >
                    <img
                      src={shotMediaUrl(project, characterId, s.id, "poster.jpg")}
                      alt={s.name || s.id}
                      className="h-full w-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[9px] text-neutral-300">
                      {s.name || s.id}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <h3 className="mb-2 mt-3 text-xs font-semibold text-neutral-300">Head Shots</h3>
            {headShots.length === 0 && allShots.length === 0 ? (
              <p className="text-[10px] text-studio-muted">No head shots yet — create one with Grok below</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(headShots.length > 0 ? headShots : allShots).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`group relative overflow-hidden rounded-md border-2 ${
                      headId === s.id ? "border-[#e0a040]" : "border-studio-border hover:border-neutral-500"
                    }`}
                    style={{ width: 80, height: 80 }}
                    onClick={() => setHeadId(s.id)}
                    title={s.name || s.id}
                  >
                    <img
                      src={shotMediaUrl(project, characterId, s.id, "poster.jpg")}
                      alt={s.name || s.id}
                      className="h-full w-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[9px] text-neutral-300">
                      {s.name || s.id}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Grok Shot Creator ─────────────────────────── */}
          <div className="mt-4 rounded-md border border-studio-border bg-[#1a1a1a] p-3">
            <h3 className="mb-2 text-xs font-semibold text-[#e0a040]">Create Shot with Grok</h3>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[11px] text-studio-muted">
                Shot type
                <select
                  className="ml-2 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  value={grokType}
                  onChange={(e) => setGrokType(e.target.value as "body" | "head")}
                >
                  <option value="body">Body / Torso</option>
                  <option value="head">Head shot</option>
                </select>
              </label>
              <label className="flex-1 text-[11px] text-studio-muted">
                Prompt
                <input
                  type="text"
                  className="mt-1 w-full rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                  placeholder={grokType === "body" ? "cowboy standing with arms out, green screen" : "cowboy head talking, green screen"}
                  value={grokPrompt}
                  onChange={(e) => setGrokPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleGrokCreate(); }}
                />
              </label>
              <button
                type="button"
                className="rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
                disabled={grokBusy || !grokPrompt.trim()}
                onClick={() => void handleGrokCreate()}
              >
                {grokBusy ? "Creating…" : `Create ${grokType} shot`}
              </button>
            </div>
            {grokMsg ? <p className="mt-2 text-[11px] text-emerald-300">{grokMsg}</p> : null}
            <p className="mt-1 text-[10px] text-studio-muted">
              {grokType === "body"
                ? "Creates a torso/body shot (arms, poses, actions). Head will be added separately."
                : "Creates a head shot (mouth moving, expressions). Will be overlaid onto body."}
            </p>
          </div>
        </div>

  );

  if (inline) return content;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Build Character</h2>
            <p className="text-[11px] text-studio-muted">
              Pick a body shot and a head shot. Drag the head to position it, scroll to resize. Save the rig for each angle.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>
        {content}
        <div className="flex justify-end gap-2 border-t border-studio-border px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
