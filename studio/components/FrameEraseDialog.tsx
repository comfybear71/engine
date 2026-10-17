"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { workerFetch } from "@/lib/worker";
import { formatFrameList, frameBaseRel, frameMaskRel, parseFrameList } from "@/lib/frameErase";

type Props = {
  shotId: string;
  shotName: string;
  frameCount: number;
  initialFrame: number;
  project: string;
  characterId: string;
  /** Builds the URL of a file inside the shot folder, e.g. "cut/f_0001.png". */
  mediaUrl: (rel: string, version?: number) => string;
  /** Called when the dialog closes after anything was changed, so previews can reload. */
  onChanged: (shotId: string) => void;
  onClose: () => void;
};

type Mode = "erase" | "restore";

/** `readable` loads it with CORS so it can be drawn onto a canvas we later read back (the mask). */
function loadImage(src: string, readable = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (readable) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export default function FrameEraseDialog({ shotId, shotName, frameCount, initialFrame, project, characterId, mediaUrl, onChanged, onClose }: Props) {
  const [frame, setFrame] = useState(() => Math.max(1, Math.min(frameCount, Math.round(initialFrame) || 1)));
  const [erased, setErased] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>("erase");
  const [brush, setBrush] = useState(24);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rangeText, setRangeText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [, forceTick] = useState(0);

  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const paintingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const dirtyRef = useRef(false);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const erasedRef = useRef<Set<number>>(new Set());
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const base = `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}`;

  const draw = useCallback(() => {
    const canvas = displayRef.current;
    const img = baseRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const cell = Math.max(8, Math.round(w / 40));
    for (let y = 0; y < h; y += cell) {
      for (let x = 0; x < w; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? "#2a2a2a" : "#1d1d1d";
        ctx.fillRect(x, y, cell, h - y < cell ? h - y : cell);
      }
    }
    ctx.drawImage(img, 0, 0, w, h);
    const tint = tintRef.current;
    if (tint) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tint, 0, 0);
      ctx.globalAlpha = 1;
    }
    const cur = cursorRef.current;
    if (cur) {
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, brush / 2, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, w / 400);
      ctx.strokeStyle = mode === "erase" ? "#ff5a5a" : "#6aff8a";
      ctx.stroke();
    }
  }, [brush, mode]);

  useEffect(() => { draw(); }, [draw, loaded]);

  /** Redraw the red "erased" layer from the mask (after loading a frame or undoing). */
  function rebuildTint() {
    const mask = maskRef.current;
    const tint = tintRef.current;
    const mctx = mask?.getContext("2d");
    const tctx = tint?.getContext("2d");
    if (!mask || !tint || !mctx || !tctx) return;
    const src = mctx.getImageData(0, 0, mask.width, mask.height);
    const out = tctx.createImageData(mask.width, mask.height);
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i] > 127) {
        out.data[i] = 255; out.data[i + 1] = 40; out.data[i + 2] = 40; out.data[i + 3] = 255;
      }
    }
    tctx.putImageData(out, 0, 0);
  }

  const refreshErased = useCallback(async () => {
    try {
      const res = await workerFetch(`${base}/erase`);
      if (res.ok) {
        const data = await res.json();
        const frames: number[] = Array.isArray(data.frames) ? data.frames : [];
        erasedRef.current = new Set(frames);
        setErased(frames);
        return erasedRef.current;
      }
    } catch { /* leave the list as it was */ }
    return erasedRef.current;
  }, [base]);

  const loadFrame = useCallback(async (n: number) => {
    setLoaded(false);
    setError("");
    undoRef.current = [];
    const stamp = Date.now();
    const rel = frameBaseRel(n, erasedRef.current);
    const img = await loadImage(mediaUrl(rel, stamp));
    if (frameRef.current !== n) return;
    if (!img) {
      setError(`Could not load frame ${n}.`);
      return;
    }
    baseRef.current = img;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = displayRef.current;
    if (canvas) { canvas.width = w; canvas.height = h; }
    const mask = document.createElement("canvas");
    mask.width = w;
    mask.height = h;
    const mctx = mask.getContext("2d");
    if (mctx) {
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, w, h);
      if (erasedRef.current.has(n)) {
        const saved = await loadImage(mediaUrl(frameMaskRel(n), stamp), true);
        if (saved && frameRef.current === n) mctx.drawImage(saved, 0, 0, w, h);
      }
    }
    if (frameRef.current !== n) return;
    maskRef.current = mask;
    const tint = document.createElement("canvas");
    tint.width = w;
    tint.height = h;
    tintRef.current = tint;
    try {
      rebuildTint();
    } catch {
      setError("Could not read this frame's saved erase.");
      return;
    }
    setLoaded(true);
  }, [mediaUrl]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await refreshErased();
      if (alive) await loadFrame(frame);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  function queueSave(task: () => Promise<void>) {
    saveChainRef.current = saveChainRef.current.then(task, task);
    return saveChainRef.current;
  }

  async function saveMask(frames: number[], note: string) {
    const mask = maskRef.current;
    if (!mask) return;
    const png = mask.toDataURL("image/png");
    await queueSave(async () => {
      setStatus("Saving…");
      try {
        const res = await workerFetch(`${base}/erase`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frames, mask: png }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Save failed" }));
          throw new Error(data.error || "Save failed");
        }
        const data = await res.json();
        const list: number[] = Array.isArray(data.frames) ? data.frames : [];
        erasedRef.current = new Set(list);
        setErased(list);
        dirtyRef.current = true;
        setStatus(note);
        setError("");
      } catch (err) {
        setStatus("");
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = displayRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function paintTo(p: { x: number; y: number }) {
    const mask = maskRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) return;
    const from = lastPointRef.current || p;
    ctx.strokeStyle = mode === "erase" ? "#fff" : "#000";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2);
    ctx.fill();
    const tctx = tintRef.current?.getContext("2d");
    if (tctx) {
      tctx.globalCompositeOperation = mode === "erase" ? "source-over" : "destination-out";
      tctx.strokeStyle = "#ff2828";
      tctx.fillStyle = "#ff2828";
      tctx.lineCap = "round";
      tctx.lineJoin = "round";
      tctx.lineWidth = brush;
      tctx.beginPath();
      tctx.moveTo(from.x, from.y);
      tctx.lineTo(p.x, p.y);
      tctx.stroke();
      tctx.beginPath();
      tctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2);
      tctx.fill();
      tctx.globalCompositeOperation = "source-over";
    }
    lastPointRef.current = p;
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!loaded || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const mask = maskRef.current;
    const ctx = mask?.getContext("2d");
    if (mask && ctx) undoRef.current = [...undoRef.current.slice(-29), ctx.getImageData(0, 0, mask.width, mask.height)];
    paintingRef.current = true;
    lastPointRef.current = null;
    const p = point(e);
    cursorRef.current = p;
    paintTo(p);
    draw();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = point(e);
    cursorRef.current = p;
    if (paintingRef.current) paintTo(p);
    draw();
  }

  function onPointerUp() {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    lastPointRef.current = null;
    void saveMask([frameRef.current], `Saved frame ${frameRef.current}`);
  }

  function undoStroke() {
    const snap = undoRef.current[undoRef.current.length - 1];
    const mask = maskRef.current;
    const ctx = mask?.getContext("2d");
    if (!snap || !mask || !ctx) return;
    undoRef.current = undoRef.current.slice(0, -1);
    ctx.putImageData(snap, 0, 0);
    rebuildTint();
    draw();
    forceTick((n) => n + 1);
    void saveMask([frameRef.current], `Saved frame ${frameRef.current}`);
  }

  async function putBack(frames: number[] | null, label: string) {
    await queueSave(async () => {
      setStatus("Putting back…");
      try {
        const res = await workerFetch(`${base}/erase/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frames ? { frames } : {}),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Could not put back" }));
          throw new Error(data.error || "Could not put back");
        }
        const data = await res.json();
        const list: number[] = Array.isArray(data.frames) ? data.frames : [];
        erasedRef.current = new Set(list);
        setErased(list);
        dirtyRef.current = true;
        setStatus(label);
        setError("");
      } catch (err) {
        setStatus("");
        setError(err instanceof Error ? err.message : "Could not put back");
      }
    });
    await loadFrame(frameRef.current);
  }

  async function copyToRange() {
    const frames = parseFrameList(rangeText, frameCount);
    if (!frames) {
      setError(`Type frame numbers from 1 to ${frameCount}, like 12-18 or 3, 5, 9.`);
      return;
    }
    await saveMask(frames, `Same erase saved on ${frames.length} frame${frames.length === 1 ? "" : "s"} (${formatFrameList(frames)})`);
  }

  function go(next: number) {
    const n = Math.max(1, Math.min(frameCount, next));
    if (n !== frame) setFrame(n);
  }

  function close() {
    void saveChainRef.current.then(() => {
      if (dirtyRef.current) onChanged(shotId);
      onClose();
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); undoStroke(); return; }
      if (typing) return;
      e.stopPropagation();
      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(frameRef.current - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(frameRef.current + 1); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const thisErased = erased.includes(frame);
  const btn = "rounded border border-[#333] px-2 py-1 text-[12px] text-neutral-200 hover:bg-[#2a2a2a] disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" data-testid="frame-erase" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-full w-full max-w-[900px] flex-col overflow-hidden rounded-lg border border-[#333] bg-[#161616] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-4 py-2.5">
          <div className="text-sm font-semibold text-neutral-100">{shotName} · erase parts of frames</div>
          <button type="button" className="text-sm text-neutral-400 hover:text-white" onClick={close} data-testid="frame-erase-close">Done</button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <p className="text-[12px] text-neutral-400">
            Paint over anything you want gone, such as a hand. Each stroke saves straight away. The picture is only hidden, so you can always put the frame back. Red shows what is erased.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={() => go(frame - 1)} disabled={frame <= 1} data-testid="frame-erase-prev">◀</button>
            <span className="text-[12px] text-neutral-300">Frame</span>
            <input
              type="number" min={1} max={frameCount} value={frame}
              onChange={(e) => go(Number(e.target.value) || 1)}
              className="w-16 rounded border border-[#333] bg-black/40 px-2 py-1 text-[12px] text-white"
              data-testid="frame-erase-frame"
            />
            <span className="text-[12px] text-neutral-500">of {frameCount}</span>
            <button type="button" className={btn} onClick={() => go(frame + 1)} disabled={frame >= frameCount} data-testid="frame-erase-next">▶</button>
            <input
              type="range" min={1} max={frameCount} value={frame}
              onChange={(e) => go(Number(e.target.value))}
              className="min-w-[160px] flex-1"
              data-testid="frame-erase-slider"
            />
            {thisErased ? <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] text-red-300" data-testid="frame-erase-flag">erased on this frame</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={`${btn} ${mode === "erase" ? "!border-red-400 text-red-300" : ""}`} onClick={() => setMode("erase")} data-testid="frame-erase-mode-erase">Erase</button>
            <button type="button" className={`${btn} ${mode === "restore" ? "!border-emerald-400 text-emerald-300" : ""}`} onClick={() => setMode("restore")} data-testid="frame-erase-mode-restore" title="Paint back what you erased by mistake">Paint back</button>
            <span className="ml-2 text-[12px] text-neutral-400">Brush</span>
            <input type="range" min={4} max={160} value={brush} onChange={(e) => setBrush(Number(e.target.value))} data-testid="frame-erase-brush" />
            <span className="w-8 text-[12px] text-neutral-500">{brush}</span>
            <button type="button" className={btn} onClick={undoStroke} disabled={undoRef.current.length === 0} data-testid="frame-erase-undo">Undo stroke</button>
            <button type="button" className={btn} onClick={() => void putBack([frame], `Frame ${frame} put back`)} disabled={!thisErased} data-testid="frame-erase-reset-frame">Put this frame back</button>
          </div>
          <div className="flex justify-center rounded border border-[#2a2a2a] bg-black p-2">
            <canvas
              ref={displayRef}
              data-testid="frame-erase-canvas"
              className="max-h-[52vh] max-w-full touch-none"
              style={{ cursor: "none", opacity: loaded ? 1 : 0.4 }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => { cursorRef.current = null; draw(); }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-neutral-400">Use the same erase on frames</span>
            <input
              type="text" value={rangeText} placeholder="e.g. 12-18, 22"
              onChange={(e) => setRangeText(e.target.value)}
              className="w-40 rounded border border-[#333] bg-black/40 px-2 py-1 text-[12px] text-white"
              data-testid="frame-erase-range"
            />
            <button type="button" className={btn} onClick={() => void copyToRange()} disabled={!loaded} data-testid="frame-erase-copy-range">Copy erase there</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-neutral-400" data-testid="frame-erase-list">
              {erased.length ? `Erased frames: ${formatFrameList(erased)}` : "No frames erased yet."}
            </span>
            {erased.length ? (
              <button
                type="button" className={btn} data-testid="frame-erase-reset-all"
                onClick={() => { if (confirm("Put every erased frame of this clip back as it was?")) void putBack(null, "All frames put back"); }}
              >Put all frames back</button>
            ) : null}
            <span className="ml-auto text-emerald-300" data-testid="frame-erase-status">{status}</span>
          </div>
          {erased.length ? (
            <div className="flex flex-wrap gap-1">
              {erased.slice(0, 80).map((n) => (
                <button key={n} type="button" className={`${btn} !px-1.5 !py-0.5 ${n === frame ? "!border-[#e0a040]" : ""}`} onClick={() => go(n)} data-testid={`frame-erase-chip-${n}`}>{n}</button>
              ))}
            </div>
          ) : null}
          {error ? <p className="text-[12px] text-red-400" data-testid="frame-erase-error">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
