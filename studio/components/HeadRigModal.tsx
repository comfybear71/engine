"use client";

import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKER_URL, workerFetch } from "@/lib/worker";

// ── Types ──────────────────────────────────────────────────────────

interface ShotInfo {
  id: string;
  name: string;
  category: string;
  status: string;
  shotType?: string;
  frameCount: number;
  actionId?: string; // set when sent to Action Shots
  sourceBody?: string;
  sourceHead?: string;
}

/** One clip reference placed on a track. Many segments can reference the
 * same source shot (different frame ranges), and the source shot is never
 * modified — this is the "scratch board" recipe, not a destructive edit. */
interface Segment {
  id: string; // client-only, regenerated on load
  shotId: string;
  inFrame: number;
  outFrame: number;
  start: number; // 1-based position on this timeline's own output
}

interface HeadSegment extends Segment {
  anchorX: number;
  anchorY: number;
  headScale: number;
}

type StoredSegment = Omit<Segment, "id">;
type StoredHeadSegment = Omit<HeadSegment, "id">;

interface Keyframe {
  frame: number;
  anchorX: number;
  anchorY: number;
  headScale: number;
}

interface RigEntry {
  anchorX: number;
  anchorY: number;
  headScale: number;
  keyframes?: Keyframe[];
  bodySegments?: StoredSegment[];
  headSegments?: StoredHeadSegment[];
}

type TrackName = "body" | "head";

// ── Helpers ─────────────────────────────────────────────────────────

function shotMediaUrl(project: string, characterId: string, shotId: string, rel: string): string {
  return `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(`${shotId}/${rel}`)}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

let segCounter = 0;
function genSegId() {
  segCounter += 1;
  return `seg_${Date.now().toString(36)}_${segCounter}`;
}

function segLength(seg: { inFrame: number; outFrame: number }): number {
  return Math.max(1, seg.outFrame - seg.inFrame + 1);
}

function segEnd(seg: { start: number; inFrame: number; outFrame: number }): number {
  return seg.start + segLength(seg) - 1;
}

/** Whichever segment on this track covers `frame`, or null for a gap. */
function activeSegmentAt<T extends { start: number; inFrame: number; outFrame: number }>(
  segments: T[],
  frame: number
): T | null {
  for (const seg of segments) {
    if (frame >= seg.start && frame <= segEnd(seg)) return seg;
  }
  return null;
}

function sourceFrameOf(seg: { inFrame: number; start: number }, frame: number): number {
  return seg.inFrame + (frame - seg.start);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}

// ── Thumbnail ref picker ─────────────────────────────────────────────

function RefShotPicker({ allShots, value, onChange, project, characterId }: {
  allShots: ShotInfo[]; value: string; onChange: (id: string) => void; project: string; characterId: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const sel = allShots.find((s) => s.id === value);
  return (
    <div ref={wrapRef} className="relative w-full">
      <button type="button"
        className="flex w-full items-center gap-2 rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-left text-[12px] text-neutral-200"
        onClick={() => setOpen(!open)}>
        {sel ? (
          <>
            <img src={shotMediaUrl(project, characterId, sel.id, "poster.jpg")}
              className="h-7 w-10 rounded object-cover" alt="" />
            <span className="truncate">{sel.name || sel.id}</span>
          </>
        ) : <span className="text-neutral-400">Character ref</span>}
        <span className="ml-auto text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded border border-studio-border bg-[#1a1a1a] shadow-lg">
          <button type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] text-neutral-400 hover:bg-[#333]"
            onClick={() => { onChange(""); setOpen(false); }}>
            None
          </button>
          {allShots.map((s) => (
            <button key={s.id} type="button"
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-[#333] ${s.id === value ? "bg-[#2a2a2a] text-studio-accent" : "text-neutral-200"}`}
              onClick={() => { onChange(s.id); setOpen(false); }}>
              <img src={shotMediaUrl(project, characterId, s.id, "poster.jpg")}
                className="h-8 w-12 rounded object-cover" alt=""
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <span className="truncate">{s.name || s.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
  const [rigKey, setRigKey] = useState("front");
  const [charRefRel, setCharRefRel] = useState("");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // ── The multi-segment timeline (this rig key's "scratch board") ──
  const [bodySegments, setBodySegments] = useState<Segment[]>([]);
  const [headSegments, setHeadSegments] = useState<HeadSegment[]>([]);
  const [selectedSegment, setSelectedSegment] = useState<{ track: TrackName; id: string } | null>(null);
  const legacyKeyframesRef = useRef<Keyframe[] | undefined>(undefined); // round-tripped untouched

  // Playback / scrub
  const [playing, setPlaying] = useState(false);
  const [scrubFrame, setScrubFrame] = useState(1);
  const [fps, setFps] = useState(24);
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);

  // Drag state for moving/trimming segment blocks
  const dragSegRef = useRef<{
    mode: "move" | "trim";
    track: TrackName;
    id: string;
    edge?: "in" | "out";
    startClientX: number;
    origStart: number;
    origInFrame: number;
    origOutFrame: number;
  } | null>(null);
  const [, forceDragTick] = useState(0); // re-render while dragging segment blocks

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: TrackName; id: string } | null>(null);

  // Canvas drag state (move/scale a head segment's anchor)
  const canvasDragRef = useRef<{
    kind: "move" | "scale";
    startX: number;
    startY: number;
    origAnchorX: number;
    origAnchorY: number;
    origScale: number;
  } | null>(null);

  // Refs mirroring the latest state for the rAF playback loop (so the loop
  // doesn't need to restart every time a segment is edited)
  const segmentsRef = useRef<{ body: Segment[]; head: HeadSegment[] }>({ body: [], head: [] });
  useEffect(() => { segmentsRef.current = { body: bodySegments, head: headSegments }; }, [bodySegments, headSegments]);
  const selectedRef = useRef(selectedSegment);
  useEffect(() => { selectedRef.current = selectedSegment; }, [selectedSegment]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const playRafRef = useRef<number | null>(null);

  // Shot natural dimensions, cached per shot id (lazily loaded)
  const [shotDims, setShotDims] = useState<Record<string, { w: number; h: number }>>({});
  const shotDimsLoadingRef = useRef<Set<string>>(new Set());
  function ensureShotDims(shotId: string) {
    if (!shotId || shotDims[shotId] || shotDimsLoadingRef.current.has(shotId)) return;
    shotDimsLoadingRef.current.add(shotId);
    const img = new Image();
    img.onload = () => {
      setShotDims((prev) => ({ ...prev, [shotId]: { w: img.naturalWidth, h: img.naturalHeight } }));
    };
    img.onerror = () => { shotDimsLoadingRef.current.delete(shotId); };
    img.src = shotMediaUrl(project, characterId, shotId, "cut/f_0001.png");
  }

  // Per-frame image cache (shotId#frame -> Image), with a bump counter to
  // force a redraw once a requested frame finishes loading.
  const frameImgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const frameImgLoadingRef = useRef<Set<string>>(new Set());
  const [redrawTick, setRedrawTick] = useState(0);
  function getFrameImage(shotId: string, frame: number): HTMLImageElement | null {
    const key = `${shotId}#${frame}`;
    const cached = frameImgCacheRef.current.get(key);
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    if (frameImgLoadingRef.current.has(key)) return null;
    frameImgLoadingRef.current.add(key);
    const pad = String(Math.max(1, frame)).padStart(4, "0");
    const img = new Image();
    img.onload = () => { frameImgCacheRef.current.set(key, img); frameImgLoadingRef.current.delete(key); setRedrawTick((t) => t + 1); };
    img.onerror = () => { frameImgLoadingRef.current.delete(key); };
    img.src = shotMediaUrl(project, characterId, shotId, `cut/f_${pad}.png`);
    return null;
  }

  // Preload frame images for all segments so playback doesn't blink
  useEffect(() => {
    const segs = [...bodySegments, ...headSegments];
    for (const seg of segs) {
      for (let f = seg.inFrame; f <= seg.outFrame; f++) {
        const key = `${seg.shotId}#${f}`;
        if (!frameImgCacheRef.current.has(key)) {
          const pad = String(Math.max(1, f)).padStart(4, "0");
          const img = new Image();
          img.onload = () => { frameImgCacheRef.current.set(key, img); setRedrawTick((t) => t + 1); };
          img.src = shotMediaUrl(project, characterId, seg.shotId, `cut/f_${pad}.png`);
        }
      }
    }
  }, [bodySegments, headSegments, project, characterId]);

  // ── Load shots + rigs ──
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
          if (data.reference) setCharRefRel(data.reference);
        }
      } catch { /* worker may not be reachable yet */ }
    })();
  }, [project, characterId]);

  // ── When rig key changes, load its saved timeline (fresh client ids) ──
  useEffect(() => {
    const entry = rigs[rigKey];
    legacyKeyframesRef.current = entry?.keyframes;
    setBodySegments((entry?.bodySegments || []).map((s) => ({ ...s, id: genSegId() })));
    setHeadSegments((entry?.headSegments || []).map((s) => ({ ...s, id: genSegId() })));
    setSelectedSegment(null);
    setScrubFrame(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigKey, rigs]);

  // Filter out segments referencing deleted shots — separate effect so it
  // doesn't regenerate IDs or clear selection on every shots refresh.
  const shotIdsSet = useMemo(() => new Set(shots.map((s) => s.id)), [shots]);
  useEffect(() => {
    setBodySegments((prev) => {
      const filtered = prev.filter((s) => shotIdsSet.has(s.shotId));
      return filtered.length === prev.length ? prev : filtered;
    });
    setHeadSegments((prev) => {
      const filtered = prev.filter((s) => shotIdsSet.has(s.shotId));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [shotIdsSet]);

  const shotsById = useMemo(() => {
    const map = new Map<string, ShotInfo>();
    for (const s of shots) map.set(s.id, s);
    return map;
  }, [shots]);

  const maxFrames = useMemo(() => {
    let max = 1;
    for (const s of bodySegments) max = Math.max(max, segEnd(s));
    for (const s of headSegments) max = Math.max(max, segEnd(s));
    return max;
  }, [bodySegments, headSegments]);

  // Pre-fetch natural dimensions for every shot currently placed on the body track
  useEffect(() => {
    for (const s of bodySegments) ensureShotDims(s.shotId);
    for (const s of headSegments) ensureShotDims(s.shotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodySegments, headSegments]);

  const activeBody = useMemo(() => activeSegmentAt(bodySegments, scrubFrame), [bodySegments, scrubFrame]);
  const activeHead = useMemo(() => activeSegmentAt(headSegments, scrubFrame), [headSegments, scrubFrame]);
  const editingHead = useMemo(() => {
    if (selectedSegment?.track === "head") {
      const sel = headSegments.find((s) => s.id === selectedSegment.id);
      if (sel) return sel;
    }
    return activeHead;
  }, [selectedSegment, headSegments, activeHead]);

  // ── Client-side background removal (fallback when Python keying misses) ──
  // Client-side chroma key: detect whether frame has green or black bg from
  // a border sample, then key out that colour.  Caches result per image src.
  const chromaCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const stripBg = useCallback((img: HTMLImageElement): HTMLCanvasElement | HTMLImageElement => {
    try {
      const cached = chromaCacheRef.current.get(img.src);
      if (cached) return cached;

      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const c = off.getContext("2d", { willReadFrequently: true })!;
      c.drawImage(img, 0, 0);
      const id = c.getImageData(0, 0, w, h);
      const d = id.data;

      // Sample border pixels (top 8 rows) to detect bg colour
      const sampleN = Math.min(w * 8, d.length / 4);
      let gSum = 0, rSum = 0, bSum = 0, vSum = 0;
      for (let i = 0; i < sampleN; i++) {
        const off4 = i * 4;
        rSum += d[off4]; gSum += d[off4 + 1]; bSum += d[off4 + 2];
        vSum += Math.max(d[off4], d[off4 + 1], d[off4 + 2]);
      }
      const rAvg = rSum / sampleN, gAvg = gSum / sampleN, bAvg = bSum / sampleN;
      const vAvg = vSum / sampleN;
      const isGreen = gAvg > 80 && gAvg > rAvg + 25 && gAvg > bAvg + 25;
      const isBlack = vAvg < 35;

      if (isGreen) {
        // Green screen removal
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (g > 80 && g > r + 25 && g > b + 25) {
            d[i + 3] = 0;
          } else if (g > 60 && g > r && g > b) {
            const excess = g - Math.max(r, b);
            const fade = Math.min(excess / 60, 1);
            d[i + 3] = Math.round(d[i + 3] * (1 - fade));
            if (fade > 0) d[i + 1] = Math.min(g, Math.max(r, b));
          }
        }
      } else if (isBlack) {
        // Black background removal — flood from border through dark pixels
        // Build a binary mask of dark pixels (value < 30)
        const dark = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const v = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
          if (v < 30) dark[i] = 1;
        }
        // BFS flood fill from border dark pixels
        const bg = new Uint8Array(w * h);
        const queue: number[] = [];
        for (let x = 0; x < w; x++) {
          if (dark[x]) { bg[x] = 1; queue.push(x); }
          const bot = (h - 1) * w + x;
          if (dark[bot]) { bg[bot] = 1; queue.push(bot); }
        }
        for (let y = 1; y < h - 1; y++) {
          const l = y * w;
          if (dark[l]) { bg[l] = 1; queue.push(l); }
          const r = y * w + w - 1;
          if (dark[r]) { bg[r] = 1; queue.push(r); }
        }
        let qi = 0;
        while (qi < queue.length) {
          const idx = queue[qi++];
          const x = idx % w, y = (idx - x) / w;
          const neighbors = [
            y > 0 ? idx - w : -1,
            y < h - 1 ? idx + w : -1,
            x > 0 ? idx - 1 : -1,
            x < w - 1 ? idx + 1 : -1,
          ];
          for (const ni of neighbors) {
            if (ni >= 0 && dark[ni] && !bg[ni]) {
              bg[ni] = 1;
              queue.push(ni);
            }
          }
        }
        // Also flood into slightly-less-dark fringe (v < 45) connected to bg
        const softDark = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const v = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
          if (v < 45) softDark[i] = 1;
        }
        let changed = true;
        for (let pass = 0; pass < 3 && changed; pass++) {
          changed = false;
          for (let i = 0; i < w * h; i++) {
            if (bg[i] || !softDark[i]) continue;
            const x = i % w, y = (i - x) / w;
            if ((y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]) ||
                (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1])) {
              bg[i] = 1;
              changed = true;
            }
          }
        }
        // Apply: bg pixels become transparent, edge gets feathered
        for (let i = 0; i < w * h; i++) {
          if (bg[i]) d[i * 4 + 3] = 0;
        }
        // Simple 1px feather on edges
        for (let i = 0; i < w * h; i++) {
          if (bg[i]) continue;
          const x = i % w, y = (i - x) / w;
          let borderCount = 0;
          if (x > 0 && bg[i - 1]) borderCount++;
          if (x < w - 1 && bg[i + 1]) borderCount++;
          if (y > 0 && bg[i - w]) borderCount++;
          if (y < h - 1 && bg[i + w]) borderCount++;
          if (borderCount > 0) {
            d[i * 4 + 3] = Math.round(d[i * 4 + 3] * (1 - borderCount * 0.2));
          }
        }
      }

      c.putImageData(id, 0, 0);
      chromaCacheRef.current.set(img.src, off);
      // Keep cache from growing unbounded
      if (chromaCacheRef.current.size > 500) {
        const first = chromaCacheRef.current.keys().next().value;
        if (first) chromaCacheRef.current.delete(first);
      }
      return off;
    } catch {
      return img;
    }
  }, []);

  // ── Canvas drawing ──
  const CANVAS_W = 600;
  const CANVAS_H = 800;

  const drawFrame = useCallback((frame: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    const sz = 12;
    for (let y = 0; y < ch; y += sz) {
      for (let x = 0; x < cw; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? "#1a1a1a" : "#222";
        ctx.fillRect(x, y, sz, sz);
      }
    }

    const body = activeSegmentAt(segmentsRef.current.body, frame);
    const head = activeSegmentAt(segmentsRef.current.head, frame);

    // Layout basis: fit whichever body is active into the lower 70% of the
    // canvas. If there's no body at this frame, fall back to a generic zone
    // so a head-only segment can still be positioned.
    let scale = 1;
    let bw = cw * 0.6;
    let bh = ch * 0.6;
    let bx = (cw - bw) / 2;
    let by = ch - bh - ch * 0.03;

    if (body) {
      const img = getFrameImage(body.shotId, sourceFrameOf(body, frame));
      const dims = shotDims[body.shotId] || (img ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      if (dims && dims.w > 0) {
        const bodyZone = ch * 0.7;
        scale = Math.min(cw / dims.w, bodyZone / dims.h) * 0.9;
        bw = dims.w * scale;
        bh = dims.h * scale;
        bx = (cw - bw) / 2;
        by = ch - bh - ch * 0.03;
        if (img) {
          const clean = stripBg(img);
          ctx.drawImage(clean, bx, by, bw, bh);
        }
      }
    }

    if (head) {
      const img = getFrameImage(head.shotId, sourceFrameOf(head, frame));
      const dims = shotDims[head.shotId] || (img ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      if (dims && dims.w > 0) {
        if (img) {
          const hw = dims.w * head.headScale * scale;
          const hh = dims.h * head.headScale * scale;
          const hx = bx + head.anchorX * bw - hw / 2;
          const hy = by + head.anchorY * bh - hh / 2;
          // Strip any residual green, then draw twice so semi-transparent
          // edge pixels become fully opaque.
          const cleanHead = stripBg(img);
          ctx.drawImage(cleanHead, hx, hy, hw, hh);
          ctx.drawImage(cleanHead, hx, hy, hw, hh);

          const isEditing = selectedRef.current?.track === "head" ? selectedRef.current.id === head.id : true;
          if (isEditing) {
            ctx.strokeStyle = "#e0a040";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(hx, hy, hw, hh);
            ctx.setLineDash([]);

            const handles = [[hx, hy], [hx + hw, hy], [hx, hy + hh], [hx + hw, hy + hh]];
            for (const [cx, cy] of handles) {
              ctx.fillStyle = "#e0a040";
              ctx.fillRect(cx - 4, cy - 4, 8, 8);
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 1;
              ctx.strokeRect(cx - 4, cy - 4, 8, 8);
            }

            const ax = bx + head.anchorX * bw;
            const ay = by + head.anchorY * bh;
            ctx.strokeStyle = "#e0a040";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay);
            ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10);
            ctx.stroke();
          }
        }
      }
    }

    ctx.fillStyle = "#e0a040";
    ctx.font = "11px monospace";
    const bodyLabel = body ? `${shotsById.get(body.shotId)?.name || body.shotId} f${sourceFrameOf(body, frame)}` : "— body gap —";
    const headLabel = head ? `${shotsById.get(head.shotId)?.name || head.shotId} f${sourceFrameOf(head, frame)}` : "— head gap —";
    ctx.fillText(`F${frame}/${maxFrames}  Body: ${bodyLabel}  Head: ${headLabel}`, 8, ch - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotDims, maxFrames, shotsById, stripBg]);

  // Redraw whenever the scrub position, segments, selection, or a newly
  // loaded image/dim becomes available (while paused).
  useEffect(() => {
    if (playing) return;
    drawFrame(scrubFrame);
  }, [playing, scrubFrame, bodySegments, headSegments, selectedSegment, shotDims, redrawTick, drawFrame]);

  // ── Playback loop ──
  function handlePlay() {
    if (playing) {
      if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
      playRafRef.current = null;
      setPlaying(false);
      return;
    }
    if (maxFrames <= 1) return;
    setPlaying(true);
  }

  useEffect(() => {
    if (!playing) return;
    let frame = scrubFrame >= maxFrames ? 1 : scrubFrame;
    let lastTime = performance.now();

    function tick(now: number) {
      const interval = 1000 / Math.max(1, fps);
      if (now - lastTime >= interval) {
        lastTime = now;
        frame = frame >= maxFrames ? 1 : frame + 1;
        setScrubFrame(frame);
        drawFrame(frame);
      }
      playRafRef.current = requestAnimationFrame(tick);
    }
    playRafRef.current = requestAnimationFrame(tick);
    return () => { if (playRafRef.current) cancelAnimationFrame(playRafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, fps, maxFrames]);

  useEffect(() => {
    return () => { if (playRafRef.current) cancelAnimationFrame(playRafRef.current); };
  }, []);

  // ── Canvas mouse handlers (move/scale the editing head segment) ──
  function layoutBasis(frame: number) {
    const body = activeSegmentAt(segmentsRef.current.body, frame);
    const cw = CANVAS_W;
    const ch = CANVAS_H;
    if (body) {
      const img = frameImgCacheRef.current.get(`${body.shotId}#${sourceFrameOf(body, frame)}`);
      const dims = shotDims[body.shotId] || (img && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      if (dims && dims.w > 0) {
        const bodyZone = ch * 0.7;
        const scale = Math.min(cw / dims.w, bodyZone / dims.h) * 0.9;
        const bw = dims.w * scale;
        const bh = dims.h * scale;
        return { scale, bw, bh, bx: (cw - bw) / 2, by: ch - bh - ch * 0.03 };
      }
    }
    const bw = cw * 0.6;
    const bh = ch * 0.6;
    return { scale: 1, bw, bh, bx: (cw - bw) / 2, by: ch - bh - ch * 0.03 };
  }

  function onCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const head = editingHead;
    if (!head) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setSelectedSegment({ track: "head", id: head.id });

    // Check if click is near a corner handle for scale drag
    const { scale, bw, bh, bx, by } = layoutBasis(scrubFrame);
    const headDims = shotDims[head.shotId];
    if (headDims && headDims.w > 0) {
      const hw = headDims.w * head.headScale * scale;
      const hh = headDims.h * head.headScale * scale;
      const hx = bx + head.anchorX * bw - hw / 2;
      const hy = by + head.anchorY * bh - hh / 2;
      const cssScale = canvas.width / canvas.getBoundingClientRect().width;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * cssScale;
      const my = (e.clientY - rect.top) * cssScale;
      const corners = [[hx, hy], [hx + hw, hy], [hx, hy + hh], [hx + hw, hy + hh]];
      for (const [cx, cy] of corners) {
        if (Math.abs(mx - cx) < 14 && Math.abs(my - cy) < 14) {
          canvasDragRef.current = { kind: "scale", startX: e.clientX, startY: e.clientY, origAnchorX: head.anchorX, origAnchorY: head.anchorY, origScale: head.headScale };
          e.preventDefault();
          return;
        }
      }
    }

    // Default: move drag
    canvasDragRef.current = { kind: "move", startX: e.clientX, startY: e.clientY, origAnchorX: head.anchorX, origAnchorY: head.anchorY, origScale: head.headScale };
    e.preventDefault();
  }

  function updateHeadSegment(id: string, patch: Partial<HeadSegment>) {
    setHeadSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function onCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const drag = canvasDragRef.current;
    if (!drag || !editingHead) return;
    const canvas = canvasRef.current;
    const { bw, bh } = layoutBasis(scrubFrame);
    // Scale CSS pixel deltas to canvas pixel space
    const cssScale = canvas ? canvas.width / canvas.getBoundingClientRect().width : 1;
    if (drag.kind === "move") {
      const dx = (e.clientX - drag.startX) * cssScale / bw;
      const dy = (e.clientY - drag.startY) * cssScale / bh;
      updateHeadSegment(editingHead.id, {
        anchorX: clamp(drag.origAnchorX + dx, 0, 1),
        anchorY: clamp(drag.origAnchorY + dy, -0.5, 1),
      });
    } else if (drag.kind === "scale") {
      const dy = (drag.startY - e.clientY) * cssScale;
      const factor = 1 + dy / 200;
      updateHeadSegment(editingHead.id, { headScale: clamp(drag.origScale * factor, 0.1, 3) });
    }
  }

  function onCanvasMouseUp() {
    canvasDragRef.current = null;
  }

  function onCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!editingHead) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.03 : 0.03;
    updateHeadSegment(editingHead.id, { headScale: clamp(editingHead.headScale + delta, 0.1, 3) });
  }

  // ── Save / load rig ──
  async function handleSave() {
    setBusy("Saving...");
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        key: rigKey,
        bodySegments: bodySegments.map(({ id, ...rest }) => rest),
        headSegments: headSegments.map(({ id, ...rest }) => rest),
      };
      if (legacyKeyframesRef.current && legacyKeyframesRef.current.length > 0) {
        body.keyframes = legacyKeyframesRef.current;
      }
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(data.error || "Save failed");
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

  async function handleDeleteRig(key: string) {
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-rig/${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        const data = await res.json();
        setRigs(data.rigs || {});
      }
    } catch { /* best effort */ }
  }

  // ── Reload shots list ──
  async function reloadShots() {
    try {
      const res = await workerFetch(`/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`);
      if (res.ok) {
        const data: ShotInfo[] = await res.json();
        setShots(data.filter((s) => s.status === "ready"));
      }
    } catch { /* best effort */ }
  }

  // ── Add a shot (full frame range) to the end of a track ──
  function addToTrack(track: TrackName, shot: ShotInfo) {
    if (track === "body") {
      setBodySegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        return [...prev, { id: genSegId(), shotId: shot.id, inFrame: 1, outFrame: shot.frameCount || 1, start }];
      });
    } else {
      setHeadSegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        return [...prev, { id: genSegId(), shotId: shot.id, inFrame: 1, outFrame: shot.frameCount || 1, start, anchorX: 0.5, anchorY: 0.15, headScale: 1.0 }];
      });
    }
  }

  // ── Segment block drag (move / trim) on the timeline ──
  function onSegmentMouseDown(e: React.MouseEvent, track: TrackName, seg: Segment, edge?: "in" | "out") {
    e.stopPropagation();
    setSelectedSegment({ track, id: seg.id });
    dragSegRef.current = {
      mode: edge ? "trim" : "move",
      track, id: seg.id, edge,
      startClientX: e.clientX,
      origStart: seg.start, origInFrame: seg.inFrame, origOutFrame: seg.outFrame,
    };
    forceDragTick((t) => t + 1);
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragSegRef.current;
      const el = timelineRef.current;
      if (!drag || !el) return;
      const rect = el.getBoundingClientRect();
      const pxPerFrame = rect.width / Math.max(maxFrames, 1);
      const deltaFrames = Math.round((e.clientX - drag.startClientX) / Math.max(pxPerFrame, 0.01));
      const setter = drag.track === "body" ? setBodySegments : setHeadSegments;
      const shot = shotsById.get(
        (drag.track === "body" ? bodySegments : headSegments).find((s) => s.id === drag.id)?.shotId || ""
      );
      const srcFrameCount = shot?.frameCount || drag.origOutFrame;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (setter as any)((prev: Segment[]) => prev.map((s) => {
        if (s.id !== drag.id) return s;
        if (drag.mode === "move") {
          return { ...s, start: Math.max(1, drag.origStart + deltaFrames) };
        }
        if (drag.edge === "in") {
          const maxShift = drag.origOutFrame - drag.origInFrame; // can't trim past 1 frame left
          const shift = clamp(deltaFrames, Math.max(-(drag.origStart - 1), -(drag.origInFrame - 1)), maxShift);
          return { ...s, start: drag.origStart + shift, inFrame: drag.origInFrame + shift };
        }
        // out edge
        const minShift = -(drag.origOutFrame - drag.origInFrame); // keep length >= 1
        const maxShift = srcFrameCount - drag.origOutFrame;
        const shift = clamp(deltaFrames, minShift, maxShift);
        return { ...s, outFrame: drag.origOutFrame + shift };
      }));
    }
    function onUp() {
      if (dragSegRef.current) { dragSegRef.current = null; forceDragTick((t) => t + 1); }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxFrames, bodySegments, headSegments, shotsById]);

  // ── Playhead ruler scrubbing ──
  function scrubFromMouse(clientX: number) {
    const el = timelineRef.current;
    if (!el || playing) return;
    const rect = el.getBoundingClientRect();
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    const f = Math.max(1, Math.min(maxFrames, Math.round(pct * (maxFrames - 1) + 1)));
    setScrubFrame(f);
  }

  useEffect(() => {
    if (!draggingPlayhead) return;
    function onMove(e: MouseEvent) { scrubFromMouse(e.clientX); }
    function onUp() { setDraggingPlayhead(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingPlayhead, playing, maxFrames]);

  // ── Keyboard shortcuts (Resolve-style, now operating on segments) ──
  const clipboardRef = useRef<{ track: TrackName; seg: Segment | HeadSegment } | null>(null);

  function selectedSeg(): { track: TrackName; seg: Segment | HeadSegment } | null {
    if (!selectedSegment) return null;
    const list = selectedSegment.track === "body" ? bodySegments : headSegments;
    const seg = list.find((s) => s.id === selectedSegment.id);
    return seg ? { track: selectedSegment.track, seg } : null;
  }

  function deleteSelected() {
    const sel = selectedSeg();
    if (!sel) return;
    if (sel.track === "body") setBodySegments((prev) => prev.filter((s) => s.id !== sel.seg.id));
    else setHeadSegments((prev) => prev.filter((s) => s.id !== sel.seg.id));
    setSelectedSegment(null);
  }

  function copySelected() {
    const sel = selectedSeg();
    if (sel) clipboardRef.current = { track: sel.track, seg: sel.seg };
  }

  function pasteClipboard() {
    const clip = clipboardRef.current;
    if (!clip) return;
    if (clip.track === "body") {
      setBodySegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        const copy: Segment = { ...(clip.seg as Segment), id: genSegId(), start };
        return [...prev, copy];
      });
    } else {
      setHeadSegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        const copy: HeadSegment = { ...(clip.seg as HeadSegment), id: genSegId(), start };
        return [...prev, copy];
      });
    }
  }

  function bladeAtPlayhead() {
    // Use refs to avoid stale closures — the keyboard handler may hold old state
    const curBody = segmentsRef.current.body;
    const curHead = segmentsRef.current.head;
    const frame = scrubFrame;

    // Find segment under playhead — selected first, then auto-detect
    let track: TrackName | null = null;
    let segId: string | null = null;

    if (selectedSegment) {
      const list = selectedSegment.track === "body" ? curBody : curHead;
      const seg = list.find((s) => s.id === selectedSegment.id);
      if (seg && frame > seg.start && frame <= segEnd(seg)) {
        track = selectedSegment.track;
        segId = seg.id;
      }
    }

    if (!segId) {
      for (const s of curBody) {
        if (frame > s.start && frame <= segEnd(s)) { track = "body"; segId = s.id; break; }
      }
    }
    if (!segId) {
      for (const s of curHead) {
        if (frame > s.start && frame <= segEnd(s)) { track = "head"; segId = s.id; break; }
      }
    }
    if (!track || !segId) return;

    const secondId = genSegId();
    const splitter = (prev: any[]) => prev.flatMap((s: any) => {
      if (s.id !== segId) return [s];
      const splitSrc = sourceFrameOf(s, frame);
      const first = { ...s, outFrame: splitSrc - 1 };
      const second = { ...s, id: secondId, start: frame, inFrame: splitSrc };
      return [first, second];
    });

    if (track === "body") {
      setBodySegments(splitter as any);
    } else {
      setHeadSegments(splitter as any);
    }
    setSelectedSegment({ track, id: secondId });
  }

  function trimSelectedEdge(edge: "in" | "out") {
    const sel = selectedSeg();
    if (!sel) return;
    const seg = sel.seg;
    const end = segEnd(seg);
    if (edge === "in") {
      if (scrubFrame < seg.start || scrubFrame >= end) return;
      const shift = scrubFrame - seg.start;
      const patch = { start: seg.start + shift, inFrame: seg.inFrame + shift };
      if (sel.track === "body") setBodySegments((prev) => prev.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
      else setHeadSegments((prev) => prev.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
    } else {
      if (scrubFrame <= seg.start || scrubFrame > end) return;
      const newLen = scrubFrame - seg.start + 1;
      const patch = { outFrame: seg.inFrame + newLen - 1 };
      if (sel.track === "body") setBodySegments((prev) => prev.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
      else setHeadSegments((prev) => prev.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
    }
  }

  // ── Context menu handlers ──
  function handleCtxMenu(e: React.MouseEvent, track: TrackName, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedSegment({ track, id });
    setCtxMenu({ x: e.clientX, y: e.clientY, track, id });
  }
  function ctxDelete() {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    if (track === "body") setBodySegments((prev) => prev.filter((s) => s.id !== id));
    else setHeadSegments((prev) => prev.filter((s) => s.id !== id));
    setSelectedSegment(null);
    setCtxMenu(null);
  }
  function ctxCopy() {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    const list = track === "body" ? bodySegments : headSegments;
    const seg = list.find((s) => s.id === id);
    if (seg) clipboardRef.current = { track, seg };
    setCtxMenu(null);
  }
  function ctxPaste() {
    pasteClipboard();
    setCtxMenu(null);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === "b") { e.preventDefault(); bladeAtPlayhead(); return; }
      if (key === "delete" || key === "backspace") { deleteSelected(); return; }
      if (key === "i" && !ctrl) { e.preventDefault(); trimSelectedEdge("in"); return; }
      if (key === "o" && !ctrl) { e.preventDefault(); trimSelectedEdge("out"); return; }
      if (ctrl && key === "c") { copySelected(); return; }
      if (ctrl && key === "v") { pasteClipboard(); return; }
    }
    // Close context menu on click outside
    function onClickAnywhere() { setCtxMenu(null); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClickAnywhere);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("mousedown", onClickAnywhere); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSegment, bodySegments, headSegments, scrubFrame]);

  const playheadPct = `${((scrubFrame - 1) / Math.max(maxFrames - 1, 1)) * 100}%`;

  // ── Grok shot creator ──
  const [grokType, setGrokType] = useState<"body" | "head">("body");
  const [grokPrompt, setGrokPrompt] = useState("");
  const [grokDuration, setGrokDuration] = useState(6);
  const [grokBusy, setGrokBusy] = useState(false);
  const [grokMsg, setGrokMsg] = useState("");
  const [grokRefShotId, setGrokRefShotId] = useState(""); // "" = character reference
  const [grokRefFile, setGrokRefFile] = useState<File | null>(null); // custom uploaded ref image

  async function handleGrokCreate() {
    if (!grokPrompt.trim()) return;
    setGrokBusy(true);
    setGrokMsg("");
    try {
      let refBase64: string | undefined;
      if (grokRefFile) {
        refBase64 = await blobToBase64(grokRefFile);
      } else if (grokRefShotId) {
        const refRes = await workerFetch(
          `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(`${grokRefShotId}/poster.jpg`)}`
        );
        if (refRes.ok) refBase64 = await blobToBase64(await refRes.blob());
      }
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/make`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: grokType === "body"
              ? `${grokPrompt.trim()}, body only from neck down, show full neck and shoulders, no head, no face, cut off at the neck, the head is a separate layer`
              : `${grokPrompt.trim()}, head only from jawline up, no neck, no shoulders, no body, close-up head and face only, cut off cleanly at the jaw`,
            shotType: grokType,
            background: "green",
            duration: grokDuration,
            ...(refBase64 ? { refBase64 } : charRefRel ? { refRel: charRefRel } : {}),
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
          } catch { /* keep polling */ }
        }, 5000);
        setTimeout(() => clearInterval(poll), 720000);
      }
    } catch (err) {
      setGrokMsg(err instanceof Error ? err.message : "Failed");
    }
    setGrokBusy(false);
  }

  // ── Delete / import shots ──
  async function handleDeleteShot(shotId: string) {
    if (!confirm(`Delete shot "${shotId}"?`)) return;
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setBodySegments((prev) => prev.filter((s) => s.shotId !== shotId));
        setHeadSegments((prev) => prev.filter((s) => s.shotId !== shotId));
        await reloadShots();
      } else {
        const body = await res.text();
        alert(`Delete failed (${res.status}): ${body}`);
      }
    } catch (err) {
      alert(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const importRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importType, setImportType] = useState<"body" | "head">("body");

  async function handleImportFile(file: File, shotType: "body" | "head") {
    setImportBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("shotType", shotType);
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/import`,
        { method: "POST", body: formData }
      );
      if (res.ok) {
        await reloadShots();
      } else {
        const body = await res.text();
        alert(`Import failed (${res.status}): ${body}`);
      }
    } catch (err) {
      alert(`Import error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportBusy(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  // ── Bake the timeline into a new Action-Shots-ready combined shot ──
  const [bakeMsg, setBakeMsg] = useState("");
  const [bakeBusy, setBakeBusy] = useState(false);
  const [bakeName, setBakeName] = useState("");

  async function handleBake() {
    if (!bodySegments.length && !headSegments.length) return;
    setBakeBusy(true);
    setBakeMsg("");
    try {
      await handleSave(); // keep the recipe persisted alongside the bake
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/bake-timeline`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: bakeName || rigKey,
            fps,
            bodySegments: bodySegments.map(({ id, ...rest }) => rest),
            headSegments: headSegments.map(({ id, ...rest }) => rest),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Bake failed" }));
        setBakeMsg(data.error || "Failed");
      } else {
        const data = await res.json();
        setBakeMsg(`Baked shot "${data.id}" created!`);
        await reloadShots();
      }
    } catch (err) {
      setBakeMsg(err instanceof Error ? err.message : "Failed");
    }
    setBakeBusy(false);
  }

  async function handleSendToAction(shotId: string) {
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/use`,
        { method: "POST" }
      );
      if (res.ok) await reloadShots();
    } catch { /* best effort */ }
  }

  // ── Shot categorization ──
  // shotType wins — if set, only that bin gets the shot; category is a fallback for untyped shots
  const bodyShots = shots.filter((s) => {
    if (s.shotType) return s.shotType === "body";
    return s.category === "idle_stand" || s.category === "walks" || s.category === "mic";
  });
  const headShots = shots.filter((s) => {
    if (s.shotType) return s.shotType === "head";
    return s.category === "expressions" || s.category === "head_moves" || s.category === "mouth_tongue";
  });
  const combinedShots = shots.filter((s) => s.shotType === "combined");
  const allShots = shots;
  const rigKeys = Object.keys(rigs);

  const [mediaPanelOpen, setMediaPanelOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(220);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const timelineDragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Sidebar resize handler
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (sidebarDragRef.current) {
        const delta = e.clientX - sidebarDragRef.current.startX;
        setSidebarWidth(clamp(sidebarDragRef.current.startW + delta, 200, 500));
      }
      if (timelineDragRef.current) {
        const delta = timelineDragRef.current.startY - e.clientY;
        setTimelineHeight(clamp(timelineDragRef.current.startH + delta, 120, 500));
      }
    }
    function onUp() { sidebarDragRef.current = null; timelineDragRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const content = (
    <div className={inline ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "flex min-h-0 flex-1 flex-col"}>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ══════════ LEFT SIDEBAR — Media Bins + Grok ══════════ */}
        <div className={`shrink-0 bg-[#131313] transition-all ${mediaPanelOpen ? "" : "w-0 overflow-hidden"}`} style={mediaPanelOpen ? { width: sidebarWidth } : undefined}>
          <div className="flex h-full flex-col overflow-y-auto">
            {/* Import clip */}
            <div className="flex items-center gap-2 border-b border-[#222] px-3 py-2">
              <input ref={importRef} type="file" accept="video/*,.mp4,.mov,.webm" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f, importType); }} />
              <select className="rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-[12px] text-neutral-200"
                value={importType} onChange={(e) => setImportType(e.target.value as "body" | "head")}>
                <option value="body">Body clip</option>
                <option value="head">Head clip</option>
              </select>
              <button type="button"
                className="rounded bg-blue-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                disabled={importBusy}
                onClick={() => importRef.current?.click()}>
                {importBusy ? "Importing…" : "📁 Import Clip"}
              </button>
            </div>

            {/* Body Shots bin */}
            <MediaBin
              title="Body Shots"
              shots={bodyShots.length > 0 ? bodyShots : allShots}
              project={project} characterId={characterId}
              onAdd={(s) => addToTrack("body", s)} onDelete={handleDeleteShot}
            />

            {/* Head Shots bin */}
            <MediaBin
              title="Head Shots"
              shots={headShots.length > 0 ? headShots : allShots}
              project={project} characterId={characterId}
              onAdd={(s) => addToTrack("head", s)} onDelete={handleDeleteShot}
            />

            {/* Grok Creator — collapsible */}
            <GrokSection
              grokType={grokType} setGrokType={setGrokType}
              grokDuration={grokDuration} setGrokDuration={setGrokDuration}
              grokRefShotId={grokRefShotId} setGrokRefShotId={setGrokRefShotId}
              grokRefFile={grokRefFile} setGrokRefFile={setGrokRefFile}
              grokPrompt={grokPrompt} setGrokPrompt={setGrokPrompt}
              grokBusy={grokBusy} grokMsg={grokMsg}
              allShots={allShots}
              onCreate={() => void handleGrokCreate()}
              project={project} characterId={characterId}
            />

            {/* Bake output — collapsible */}
            <BakeSection
              bakeName={bakeName} setBakeName={setBakeName}
              bakeBusy={bakeBusy} bakeMsg={bakeMsg}
              bodySegments={bodySegments} headSegments={headSegments}
              combinedShots={combinedShots}
              project={project} characterId={characterId}
              onBake={() => void handleBake()}
              onSendToAction={(id) => void handleSendToAction(id)}
              onDeleteShot={handleDeleteShot}
            />
          </div>
        </div>

        {/* Sidebar resize handle */}
        {mediaPanelOpen && (
          <div
            className="shrink-0 cursor-col-resize bg-[#222] hover:bg-[#e0a040]/60 active:bg-[#e0a040]"
            style={{ width: 4 }}
            onMouseDown={(e) => { e.preventDefault(); sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth }; }}
          />
        )}

        {/* ══════════ MAIN AREA — Canvas + Timeline ══════════ */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Toggle sidebar + Rig controls */}
          <div className="flex items-center gap-3 border-b border-[#222] bg-[#161616] px-3 py-1.5">
            <button type="button" className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-[#333] hover:text-white"
              onClick={() => setMediaPanelOpen(!mediaPanelOpen)} title={mediaPanelOpen ? "Hide media panel" : "Show media panel"}>
              {mediaPanelOpen ? "◀" : "▶"}
            </button>
            <label className="text-[13px] text-studio-muted">
              Rig
              <select
                className="ml-1 rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-[12px] text-neutral-200"
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
                className="ml-1 w-20 rounded-md border border-studio-border bg-studio-raised px-1 py-1 text-[12px] text-neutral-200"
                placeholder="custom"
                value={rigKey}
                onChange={(e) => setRigKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))}
              />
            </label>
            <label className="text-[13px] text-studio-muted">
              FPS
              <input
                type="number" min={4} max={60}
                className="ml-1 w-14 rounded-md border border-studio-border bg-studio-raised px-1 py-1 text-[12px] text-neutral-200"
                value={fps}
                onChange={(e) => setFps(clamp(Number(e.target.value) || 24, 4, 60))}
              />
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="rounded bg-studio-accent px-3 py-1 text-[12px] font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
                disabled={busy != null || (!bodySegments.length && !headSegments.length)}
                onClick={() => void handleSave()}
              >
                {busy || `Save "${rigKey}"`}
              </button>
              {error ? <span className="text-[12px] text-red-400">{error}</span> : null}
              {saved ? <span className="text-[12px] text-green-400">Saved!</span> : null}
              {rigKeys.length > 0 && rigKeys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded px-2 py-1 text-[11px] ${rigKey === key ? "bg-[#e0a040] text-black font-semibold" : "bg-studio-raised text-neutral-400 hover:text-white"}`}
                  onClick={() => setRigKey(key)}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>

          {/* Canvas preview */}
          <div className="flex flex-1 flex-col items-center justify-center overflow-hidden bg-[#0a0a0a] p-3">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="rounded-md border border-studio-border"
              style={{ cursor: editingHead ? "crosshair" : "default", maxWidth: "100%", maxHeight: "55vh", aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
              onWheel={onCanvasWheel}
            />
            <p className="mt-1 text-[12px] text-studio-muted">
              {editingHead
                ? "Drag head = move · Corner handles = scale · Scroll = resize"
                : "Select a head segment to reposition it"}
            </p>
          </div>

        </div>{/* end main area flex-col */}
      </div>{/* end sidebar+main flex row */}

      {/* Timeline resize handle */}
      <div
        className="shrink-0 cursor-row-resize bg-[#222] hover:bg-[#e0a040]/60 active:bg-[#e0a040]"
        style={{ height: 5 }}
        onMouseDown={(e) => { e.preventDefault(); timelineDragRef.current = { startY: e.clientY, startH: timelineHeight }; }}
      />

      {/* ══════════ Multi-segment DaVinci-style Timeline ══════════ */}
      <div className="shrink-0 select-none overflow-hidden bg-[#0d0d0d]" style={{ height: timelineHeight }}>
        <div className="flex items-center justify-between border-b border-[#222] bg-[#181818] px-4 py-2">
          <div className="font-mono text-xl font-bold tracking-wider text-neutral-100" style={{ minWidth: 120 }}>
            {String(Math.floor((scrubFrame - 1) / (fps * 60))).padStart(2, "0")}
            <span className="text-neutral-500">:</span>
            {String(Math.floor(((scrubFrame - 1) / fps) % 60)).padStart(2, "0")}
            <span className="text-neutral-500">:</span>
            {String(Math.floor((scrubFrame - 1) % fps)).padStart(2, "0")}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="rounded px-2.5 py-1.5 text-lg text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setScrubFrame(1)} title="Go to start">⏮</button>
            <button type="button" className="rounded px-2.5 py-1.5 text-lg text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setScrubFrame((f) => Math.max(1, f - 1))} title="Previous frame">◀</button>
            <button
              type="button"
              className={`rounded-md px-4 py-1.5 text-sm font-semibold ${playing ? "bg-[#c83030] text-white hover:bg-[#a02828]" : "bg-[#2a2a2a] text-neutral-200 hover:bg-[#3a3a3a]"}`}
              disabled={maxFrames <= 1}
              onClick={handlePlay}
            >
              {playing ? "■" : "▶"}
            </button>
            <button type="button" className="rounded px-2.5 py-1.5 text-lg text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setScrubFrame((f) => Math.min(maxFrames, f + 1))} title="Next frame">▶</button>
            <button type="button" className="rounded px-2.5 py-1.5 text-lg text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setScrubFrame(maxFrames)} title="Go to end">⏭</button>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="h-8 w-8 rounded text-base text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setTimelineZoom((z) => Math.max(1, z - 0.5))} title="Zoom out">−</button>
            <span className="w-10 text-center font-mono text-[12px] text-neutral-500">{timelineZoom === 1 ? "Fit" : `${timelineZoom}×`}</span>
            <button type="button" className="h-8 w-8 rounded text-base text-neutral-400 hover:bg-[#333] hover:text-white" onClick={() => setTimelineZoom((z) => Math.min(6, z + 0.5))} title="Zoom in">+</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div style={{ minWidth: timelineZoom > 1 ? `${timelineZoom * 100}%` : undefined }}>
            {/* Ruler */}
            <div className="flex">
              <div className="w-[120px] shrink-0 border-r border-[#222] bg-[#141414]" />
              <div className="relative h-6 flex-1 cursor-pointer border-b border-[#222] bg-[#141414]" onMouseDown={(e) => { setDraggingPlayhead(true); scrubFromMouse(e.clientX); }}>
                {Array.from({ length: Math.min(Math.ceil(maxFrames / 10), 60) }, (_, i) => {
                  const f = (i + 1) * 10;
                  if (f > maxFrames) return null;
                  const pct = `${((f - 1) / Math.max(maxFrames - 1, 1)) * 100}%`;
                  return (
                    <Fragment key={f}>
                      <div className="absolute top-0 h-full w-px bg-[#2a2a2a]" style={{ left: pct }} />
                      <span className="absolute bottom-0.5 text-[11px] font-medium text-neutral-500" style={{ left: pct, transform: "translateX(-50%)" }}>{f}</span>
                    </Fragment>
                  );
                })}
                <div className="absolute top-0" style={{ left: playheadPct, zIndex: 20, transform: "translateX(-50%)", cursor: "ew-resize" }} onMouseDown={(e) => { e.stopPropagation(); setDraggingPlayhead(true); }}>
                  <svg width="16" height="20" viewBox="0 0 16 20" style={{ display: "block" }}>
                    <polygon points="0,0 16,0 16,10 8,20 0,10" fill="#e03030" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="flex">
              <div className="w-[120px] shrink-0" />
              <div ref={timelineRef} className="relative flex-1">
                <div style={{ marginLeft: -120 }}>
                  {/* ── BODY TRACK (V1) ── */}
                  <TrackRow
                    label="Body" code="V1" codeClass="bg-blue-600"
                    bg="#161e28" ringClass="ring-blue-500/40"
                    isSelected={(id) => selectedSegment?.track === "body" && selectedSegment.id === id}
                    segments={bodySegments}
                    maxFrames={maxFrames}
                    shotsById={shotsById}
                    project={project} characterId={characterId}
                    onSelect={(id) => setSelectedSegment({ track: "body", id })}
                    onSegMouseDown={(e, seg, edge) => onSegmentMouseDown(e, "body", seg, edge)}
                    onContextMenu={(e, id) => handleCtxMenu(e, "body", id)}
                    playheadPct={playheadPct}
                  />
                  {/* ── HEAD TRACK (V2) ── */}
                  <TrackRow
                    label="Head" code="V2" codeClass="bg-green-600"
                    bg="#161e16" ringClass="ring-green-500/40"
                    isSelected={(id) => selectedSegment?.track === "head" && selectedSegment.id === id}
                    segments={headSegments}
                    maxFrames={maxFrames}
                    shotsById={shotsById}
                    project={project} characterId={characterId}
                    onSelect={(id) => setSelectedSegment({ track: "head", id })}
                    onSegMouseDown={(e, seg, edge) => onSegmentMouseDown(e, "head", seg, edge)}
                    onContextMenu={(e, id) => handleCtxMenu(e, "head", id)}
                    playheadPct={playheadPct}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[#222] bg-[#161616] px-4 py-1.5">
          <div className="flex flex-wrap gap-3 text-[12px] text-neutral-500">
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Click</kbd> select</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Drag</kbd> move</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Drag edge</kbd> trim</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">I/O</kbd> trim at playhead</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Ctrl+B</kbd> split</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Del</kbd> remove</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Ctrl+C/V</kbd> copy/paste</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Right-click</kbd> menu</span>
          </div>
          <div className="flex items-center gap-4 font-mono text-[12px]">
            <span className="text-neutral-400">Frame <span className="text-neutral-200">{scrubFrame}</span> / {maxFrames}</span>
            <span className="text-neutral-400">Body <span className="text-blue-400">{bodySegments.length}</span> Head <span className="text-green-400">{headSegments.length}</span></span>
          </div>
        </div>
      </div>

      {/* ══════════ Bottom Navbar ══════════ */}
      <div className="flex shrink-0 items-center justify-between border-t border-[#222] bg-[#111] px-3" style={{ height: 32 }}>
        <span className="text-[11px] text-neutral-500">ENGINE</span>
      </div>

      {/* ── Right-click context menu ── */}
      {ctxMenu ? (
        <div
          className="fixed z-50 min-w-[160px] rounded border border-[#333] bg-[#1a1a1a] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
            onClick={ctxCopy}>
            <span className="w-4 text-center">📋</span> Copy <span className="ml-auto text-[12px] text-neutral-500">Ctrl+C</span>
          </button>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333] disabled:opacity-40"
            disabled={!clipboardRef.current}
            onClick={ctxPaste}>
            <span className="w-4 text-center">📌</span> Paste <span className="ml-auto text-[12px] text-neutral-500">Ctrl+V</span>
          </button>
          <div className="my-1 h-px bg-[#333]" />
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-[#333]"
            onClick={ctxDelete}>
            <span className="w-4 text-center">🗑</span> Delete <span className="ml-auto text-[12px] text-neutral-500">Del</span>
          </button>
        </div>
      ) : null}

    </div>
  );

  if (inline) return content;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[96vh] w-full max-w-7xl flex-col overflow-hidden rounded-md border border-studio-border bg-studio-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-studio-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Build Character</h2>
            <p className="text-[11px] text-studio-muted">
              Add body and head clips to the timeline, trim and position them, then bake into an Action Shot.
            </p>
          </div>
          <button type="button" className="text-sm text-studio-muted hover:text-white" onClick={onClose}>Close</button>
        </div>
        {content}
        <div className="flex justify-end gap-2 border-t border-studio-border px-4 py-3">
          <button type="button" className="rounded-md border border-studio-border px-3 py-1.5 text-xs text-neutral-200" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Grok sidebar section ─────────────────────────────────────────────

function GrokSection({ grokType, setGrokType, grokDuration, setGrokDuration, grokRefShotId, setGrokRefShotId, grokRefFile, setGrokRefFile, grokPrompt, setGrokPrompt, grokBusy, grokMsg, allShots, onCreate, project, characterId }: {
  grokType: "body" | "head"; setGrokType: (v: "body" | "head") => void;
  grokDuration: number; setGrokDuration: (v: number) => void;
  grokRefShotId: string; setGrokRefShotId: (v: string) => void;
  grokRefFile: File | null; setGrokRefFile: (v: File | null) => void;
  grokPrompt: string; setGrokPrompt: (v: string) => void;
  grokBusy: boolean; grokMsg: string;
  allShots: ShotInfo[];
  onCreate: () => void;
  project: string; characterId: string;
}) {
  const [open, setOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const refThumb = useMemo(() => grokRefFile ? URL.createObjectURL(grokRefFile) : null, [grokRefFile]);
  // clean up object URL on unmount or change
  useEffect(() => { return () => { if (refThumb) URL.revokeObjectURL(refThumb); }; }, [refThumb]);
  return (
    <div className="border-b border-[#222]">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-semibold text-[#e0a040] hover:bg-[#222]"
        onClick={() => setOpen(!open)}>
        <span className="text-[11px] text-neutral-500">{open ? "▼" : "▶"}</span>
        Create with Grok
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex gap-2">
            <select className="flex-1 rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-[12px] text-neutral-200"
              value={grokType} onChange={(e) => setGrokType(e.target.value as "body" | "head")}>
              <option value="body">Body</option>
              <option value="head">Head</option>
            </select>
            <select className="rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-[12px] text-neutral-200"
              value={grokDuration} onChange={(e) => setGrokDuration(Number(e.target.value))}>
              <option value={4}>4s</option>
              <option value={6}>6s</option>
              <option value={8}>8s</option>
              <option value={10}>10s</option>
            </select>
          </div>
          {/* Ref: pick from existing shots OR upload an image */}
          <div className="flex items-center gap-1.5">
            <div className="flex-1">
              <RefShotPicker allShots={allShots} value={grokRefFile ? "" : grokRefShotId}
                onChange={(id) => { setGrokRefShotId(id); setGrokRefFile(null); }} project={project} characterId={characterId} />
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setGrokRefFile(f); setGrokRefShotId(""); } }} />
            <button type="button" title="Upload ref image"
              className="shrink-0 rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-[12px] text-neutral-300 hover:bg-[#333]"
              onClick={() => fileRef.current?.click()}>
              📷
            </button>
          </div>
          {/* Show uploaded ref preview */}
          {grokRefFile && refThumb && (
            <div className="flex items-center gap-2 rounded border border-[#333] bg-[#1a1a1a] px-2 py-1">
              <img src={refThumb} className="h-10 w-14 rounded object-cover" alt="" />
              <span className="flex-1 truncate text-[11px] text-neutral-300">{grokRefFile.name}</span>
              <button type="button" className="text-[11px] text-red-400 hover:text-red-300"
                onClick={() => setGrokRefFile(null)}>✕</button>
            </div>
          )}
          <input type="text" className="w-full rounded border border-studio-border bg-studio-raised px-2 py-1.5 text-[12px] text-neutral-200"
            placeholder={grokType === "body" ? "body prompt…" : "head prompt…"}
            value={grokPrompt} onChange={(e) => setGrokPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onCreate(); }} />
          <button type="button"
            className="w-full rounded bg-studio-accent px-2 py-1.5 text-[12px] font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            disabled={grokBusy || !grokPrompt.trim()} onClick={onCreate}>
            {grokBusy ? "Creating…" : `Create ${grokType} shot`}
          </button>
          {grokMsg && <p className={`text-[12px] font-medium ${/error|fail/i.test(grokMsg) ? "text-red-400" : "text-emerald-300"}`}>{grokMsg}</p>}
        </div>
      )}
    </div>
  );
}

// ── Bake sidebar section ─────────────────────────────────────────────

function BakeSection({ bakeName, setBakeName, bakeBusy, bakeMsg, bodySegments, headSegments, combinedShots, project, characterId, onBake, onSendToAction, onDeleteShot }: {
  bakeName: string; setBakeName: (v: string) => void;
  bakeBusy: boolean; bakeMsg: string;
  bodySegments: Segment[]; headSegments: HeadSegment[];
  combinedShots: ShotInfo[];
  project: string; characterId: string;
  onBake: () => void;
  onSendToAction: (id: string) => void;
  onDeleteShot: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-[#222]">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-semibold text-emerald-400 hover:bg-[#222]"
        onClick={() => setOpen(!open)}>
        <span className="text-[11px] text-neutral-500">{open ? "▼" : "▶"}</span>
        Bake to Action Shot
        {combinedShots.length > 0 && <span className="ml-auto text-[11px] font-normal text-neutral-600">{combinedShots.length}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <input type="text" className="w-full rounded border border-studio-border bg-studio-raised px-2 py-1.5 text-[12px] text-neutral-200"
            placeholder="Shot name (optional)" value={bakeName} onChange={(e) => setBakeName(e.target.value)} />
          <button type="button"
            className="w-full rounded bg-emerald-600 px-2 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            disabled={bakeBusy || (!bodySegments.length && !headSegments.length)} onClick={onBake}>
            {bakeBusy ? "Baking…" : "Bake Timeline"}
          </button>
          {bakeMsg && <p className={`text-[12px] font-medium ${/fail/i.test(bakeMsg) ? "text-red-400" : "text-emerald-300"}`}>{bakeMsg}</p>}
          {combinedShots.map((s) => (
            <div key={s.id} className="group relative flex items-center gap-2 rounded border border-studio-border bg-[#111] p-2">
              <img src={shotMediaUrl(project, characterId, s.id, "poster.jpg")} alt={s.name || s.id}
                className="h-12 w-12 shrink-0 rounded object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-neutral-200">{s.name || s.id}</p>
                <p className="text-[11px] text-neutral-500">{s.frameCount}f</p>
                {s.actionId ? (
                  <span className="text-[11px] font-semibold text-emerald-400">✓ Action Shots</span>
                ) : (
                  <button type="button" className="rounded bg-blue-700 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-600"
                    onClick={() => onSendToAction(s.id)}>Send to Action Shots</button>
                )}
              </div>
              <button type="button" className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white group-hover:flex"
                onClick={() => onDeleteShot(s.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Track row sub-component ─────────────────────────────────────────

function TrackRow({
  label, code, codeClass, bg, ringClass, segments, maxFrames, shotsById, project, characterId,
  isSelected, onSelect, onSegMouseDown, onContextMenu, playheadPct,
}: {
  label: string;
  code: string;
  codeClass: string;
  bg: string;
  ringClass: string;
  segments: Segment[];
  maxFrames: number;
  shotsById: Map<string, ShotInfo>;
  project: string;
  characterId: string;
  isSelected: (id: string) => boolean;
  onSelect: (id: string) => void;
  onSegMouseDown: (e: React.MouseEvent, seg: Segment, edge?: "in" | "out") => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  playheadPct: string;
}) {
  return (
    <div className="flex">
      <div className="flex w-[120px] shrink-0 items-center gap-2 border-b border-r border-[#222] bg-[#161616] px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold text-white ${codeClass}`}>{code}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-neutral-300">{label}</div>
          <div className="text-[11px] text-neutral-500">{segments.length} clip{segments.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden border-b border-[#222]" style={{ height: 90, background: bg }}>
        {segments.map((seg) => {
          const shot = shotsById.get(seg.shotId);
          const left = `${((seg.start - 1) / Math.max(maxFrames, 1)) * 100}%`;
          const width = `${(segLength(seg) / Math.max(maxFrames, 1)) * 100}%`;
          const selected = isSelected(seg.id);
          return (
            <div
              key={seg.id}
              className={`absolute inset-y-0 cursor-move overflow-hidden rounded-sm border ${selected ? `border-[#e0a040] ring-1 ring-inset ${ringClass}` : "border-black/40"}`}
              style={{ left, width, zIndex: selected ? 6 : 2 }}
              onMouseDown={(e) => onSegMouseDown(e, seg)}
              onClick={(e) => { e.stopPropagation(); onSelect(seg.id); }}
              onContextMenu={(e) => { if (onContextMenu) onContextMenu(e, seg.id); }}
              title={`${shot?.name || seg.shotId} · frames ${seg.inFrame}-${seg.outFrame}`}
            >
              <div className="flex h-full">
                {(() => {
                  // Fixed thumbnail count across the whole timeline so body & head
                  // thumbnails are the same size and frame-aligned.
                  const THUMBS_ACROSS_TIMELINE = 48;
                  const step = Math.max(1, Math.round(maxFrames / THUMBS_ACROSS_TIMELINE));
                  const len = segLength(seg);
                  const count = Math.max(1, Math.ceil(len / step));
                  return Array.from({ length: count }, (_, i) => {
                    const srcFrame = seg.inFrame + Math.min(i * step, len - 1);
                    const pad = String(srcFrame).padStart(4, "0");
                    return (
                      <img key={i} src={shotMediaUrl(project, characterId, seg.shotId, `cut/f_${pad}.png`)} alt=""
                        className="h-full shrink-0 object-cover" style={{ width: `${100 / count}%`, background: "#0a0a0a" }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    );
                  });
                })()}
              </div>
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5">
                <span className="text-[11px] font-medium text-neutral-200">{shot?.name || seg.shotId}</span>
              </div>
              {/* Trim handles */}
              <div className="absolute inset-y-0 left-0 flex w-2 cursor-ew-resize items-center justify-center bg-[#e0a040]/60 hover:bg-[#e0a040]"
                onMouseDown={(e) => onSegMouseDown(e, seg, "in")} />
              <div className="absolute inset-y-0 right-0 flex w-2 cursor-ew-resize items-center justify-center bg-[#e0a040]/60 hover:bg-[#e0a040]"
                onMouseDown={(e) => onSegMouseDown(e, seg, "out")} />
            </div>
          );
        })}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: playheadPct, zIndex: 10 }} />
      </div>
    </div>
  );
}

// ── Collapsible media bin with rectangular hover-preview thumbnails ──

function MediaBin({
  title, shots, project, characterId, onAdd, onDelete, defaultOpen = true,
}: {
  title: string;
  shots: ShotInfo[];
  project: string;
  characterId: string;
  onAdd: (s: ShotInfo) => void;
  onDelete: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hoverShot, setHoverShot] = useState<string | null>(null);
  const [hoverFrame, setHoverFrame] = useState(1);
  const hoverInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  function startHover(shotId: string, frameCount: number) {
    setHoverShot(shotId);
    setHoverFrame(1);
    if (hoverInterval.current) clearInterval(hoverInterval.current);
    let f = 1;
    hoverInterval.current = setInterval(() => {
      f = f >= frameCount ? 1 : f + 1;
      setHoverFrame(f);
    }, 120);
  }
  function stopHover() {
    setHoverShot(null);
    if (hoverInterval.current) { clearInterval(hoverInterval.current); hoverInterval.current = null; }
  }

  return (
    <div className="border-b border-[#222]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-semibold text-neutral-300 hover:bg-[#222]"
        onClick={() => setOpen(!open)}
      >
        <span className="text-[11px] text-neutral-500">{open ? "▼" : "▶"}</span>
        {title}
        <span className="ml-auto text-[11px] font-normal text-neutral-600">{shots.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          {shots.length === 0 ? (
            <p className="px-1 text-[12px] text-neutral-600">No shots yet</p>
          ) : shots.map((s) => (
            <div key={s.id} className="group relative">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded border border-transparent px-1 py-1 text-left hover:border-[#e0a040] hover:bg-[#1e1e1e]"
                onClick={() => onAdd(s)}
                onMouseEnter={() => startHover(s.id, s.frameCount || 1)}
                onMouseLeave={stopHover}
                title={`Add "${s.name || s.id}" to track`}
              >
                <div className="relative h-[56px] w-[96px] shrink-0 overflow-hidden rounded bg-[#0a0a0a]">
                  <img
                    src={hoverShot === s.id
                      ? shotMediaUrl(project, characterId, s.id, `cut/f_${String(hoverFrame).padStart(4, "0")}.png`)
                      : shotMediaUrl(project, characterId, s.id, "poster.jpg")}
                    alt={s.name || s.id}
                    className="h-full w-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                  {hoverShot === s.id && (
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/80 px-1 text-[10px] text-neutral-300">f{hoverFrame}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-neutral-200">{s.name || s.id}</p>
                  <p className="text-[11px] text-neutral-500">{s.frameCount || "?"}f</p>
                </div>
              </button>
              <button
                type="button"
                className="absolute -right-0.5 -top-0.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white shadow hover:bg-red-500 group-hover:flex"
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                title="Delete shot"
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shot grid sub-component (legacy, kept for compatibility) ─────────

function ShotGrid({
  shots, project, characterId, onAdd, onDelete,
}: {
  shots: ShotInfo[];
  project: string;
  characterId: string;
  onAdd: (s: ShotInfo) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {shots.map((s) => (
        <div key={s.id} className="group relative" style={{ width: 80, height: 80 }}>
          <button
            type="button"
            className="relative overflow-hidden rounded-md border-2 border-studio-border hover:border-[#e0a040]"
            style={{ width: 80, height: 80 }}
            onClick={() => onAdd(s)}
            title={`Add "${s.name || s.id}" to track`}
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
            <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] font-bold text-[#e0a040]">+</span>
          </button>
          <button
            type="button"
            className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white shadow hover:bg-red-500"
            onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
            title="Delete shot"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
