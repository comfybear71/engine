"use client";

import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WORKER_URL, loadBodyMotion, redoTalkingHeadClip, resumeTalkingHead, stopTalkingHead, undoTalkingHeadRedo, workerFetch } from "@/lib/worker";
import { clampFollow, followDy, followKey, neckPosition } from "@/lib/headFollow";
import { groupTalkShots, orderLtxChains, placeTalkWindows, placeTalkWindowsAtAudio, type TalkGroup, type TalkMeta, type TalkShot } from "@/lib/talkingHead";
import { clipDetailsText, promptSaysMouthClosed } from "@/lib/clipDetails";
import DialogueAudioDialog from "@/components/DialogueAudioDialog";
import TalkingHeadDialog from "@/components/TalkingHeadDialog";
import type { TalkingHeadRange } from "@/lib/worker";
import FrameEraseDialog from "@/components/FrameEraseDialog";
import { audioAtFrame, audioLaneHasShot, audioLaneItems, audioPeaks, deriveAudioPieces, shotHasAudio, sliceAudioPeaks, SHOT_AUDIO_REL, type AudioLaneItem } from "@/lib/headRigAudio";
import {
  alphaBox,
  fitToStandard,
  matchStandard,
  medianBox,
  standardFromHead,
  targetHeightFraction,
  visibleHeadRect,
  BASE_RIG_KEY,
  type Box,
  type FrameSize,
  type HeadStandard,
} from "@/lib/headStandard";
import {
  applySpeed,
  clampTrim,
  collectSnapTargets,
  normalizeSpeed,
  placeInFreeSlot,
  repeatSegment,
  rippleDelete,
  snapClipStart,
  snapEdgeFrame,
  sourceFrameAt,
  splitSegment,
  trackSegEnd,
  trackSegLength,
  trimPatch,
} from "@/lib/headTimeline";

// ── Types ──────────────────────────────────────────────────────────

interface ShotInfo {
  id: string;
  name: string;
  category: string;
  status: string;
  shotType?: string;
  frameCount: number;
  fps?: number;
  actionId?: string; // set when sent to Action Shots
  sourceBody?: string;
  sourceHead?: string;
  in?: number;
  out?: number;
  error?: string;
  engine?: string;
  hasPrevious?: boolean;
  talk?: TalkMeta;
  prompt?: string;
  requestId?: string;
  keyMode?: string;
  background?: string;
  refImage?: string;
  headSizeTarget?: number;
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
  speed?: number; // this clip alone: 2 = twice as fast, 0.5 = half speed
  reverse?: boolean;
  bodyScale?: number; // body clips only: 1 = as drawn; the head stays attached at full size
  bodyPivotX?: number; // body clips only: point of the body (fractions of its frame) that stays put when resized
  bodyPivotY?: number;
  bodyOffsetX?: number; // body clips only: shift right (+) / left (-) as a fraction of the body frame; the head moves with it
  bodyOffsetY?: number; // body clips only: shift down (+) / up (-)
  bodyInFront?: boolean; // body clips only: draw the body over the head (hands in front of the face)
}

interface HeadSegment extends Segment {
  anchorX: number;
  anchorY: number;
  headScale: number;
  followBody?: number; // head clips only: 0/absent = fixed; 1 = moves up and down exactly with the body
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
  audioSegments?: StoredSegment[];
}

type TrackName = "body" | "head" | "audio";

// ── Helpers ─────────────────────────────────────────────────────────

function shotMediaUrl(project: string, characterId: string, shotId: string, rel: string, v?: number): string {
  const base = `${WORKER_URL}/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/media?rel=${encodeURIComponent(`${shotId}/${rel}`)}`;
  return v ? `${base}&v=${v}` : base;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

const BODY_SCALE_MIN = 0.5;
const BODY_SCALE_MAX = 1.5;

function bodyUserScale(seg: { bodyScale?: number } | null | undefined): number {
  const n = Number(seg?.bodyScale);
  return Number.isFinite(n) && n > 0 ? clamp(n, BODY_SCALE_MIN, BODY_SCALE_MAX) : 1;
}

function bodyPivot(seg: { bodyPivotX?: number; bodyPivotY?: number } | null | undefined): { x: number; y: number } {
  const x = Number(seg?.bodyPivotX);
  const y = Number(seg?.bodyPivotY);
  return { x: Number.isFinite(x) ? clamp(x, 0, 1) : 0.5, y: Number.isFinite(y) ? clamp(y, 0, 1) : 1 };
}

const BODY_OFFSET_LIMIT = 1;

function bodyOffset(seg: { bodyOffsetX?: number; bodyOffsetY?: number } | null | undefined): { x: number; y: number } {
  const x = Number(seg?.bodyOffsetX);
  const y = Number(seg?.bodyOffsetY);
  return {
    x: Number.isFinite(x) ? clamp(x, -BODY_OFFSET_LIMIT, BODY_OFFSET_LIMIT) : 0,
    y: Number.isFinite(y) ? clamp(y, -BODY_OFFSET_LIMIT, BODY_OFFSET_LIMIT) : 0,
  };
}

/** Body rectangle after the user's size and shift: it grows or shrinks about its pivot (the neck once the size has been set), so the head does not move; the shift then moves the whole figure. */
function scaledBodyRect(
  base: { x: number; y: number; w: number; h: number },
  seg: { bodyScale?: number; bodyPivotX?: number; bodyPivotY?: number; bodyOffsetX?: number; bodyOffsetY?: number } | null | undefined
): { x: number; y: number; w: number; h: number } {
  const s = bodyUserScale(seg);
  const pivot = bodyPivot(seg);
  const off = bodyOffset(seg);
  return {
    x: base.x + pivot.x * base.w * (1 - s) + off.x * base.w,
    y: base.y + pivot.y * base.h * (1 - s) + off.y * base.h,
    w: base.w * s,
    h: base.h * s,
  };
}

/** The unscaled body frame's bottom edge in the preview, as a fraction of the canvas height: the ground line. */
const GROUND_FRACTION = 0.97;

let segCounter = 0;
function genSegId() {
  segCounter += 1;
  return `seg_${Date.now().toString(36)}_${segCounter}`;
}

function segLength(seg: { inFrame: number; outFrame: number; speed?: number }): number {
  return trackSegLength(seg);
}

function segEnd(seg: { start: number; inFrame: number; outFrame: number; speed?: number }): number {
  return seg.start + segLength(seg) - 1;
}

/** Whichever segment on this track covers `frame`, or null for a gap. */
function activeSegmentAt<T extends { start: number; inFrame: number; outFrame: number; speed?: number }>(
  segments: T[],
  frame: number
): T | null {
  for (const seg of segments) {
    if (frame >= seg.start && frame <= segEnd(seg)) return seg;
  }
  return null;
}

function sourceFrameOf(
  seg: { inFrame: number; outFrame: number; start: number; speed?: number; reverse?: boolean },
  frame: number
): number {
  return sourceFrameAt(seg, frame);
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
  const [talkShots, setTalkShots] = useState<ShotInfo[]>([]);
  const [talkBusy, setTalkBusy] = useState<string | null>(null);
  const [dialogueOpen, setDialogueOpen] = useState(false);
  const [dialogueRange, setDialogueRange] = useState<TalkingHeadRange | null>(null);
  const [talkMenu, setTalkMenu] = useState<TalkMenuState | null>(null);
  const [detailsShotId, setDetailsShotId] = useState<string | null>(null);
  const [eraseTarget, setEraseTarget] = useState<{ shotId: string; frame: number } | null>(null);
  const [rigs, setRigs] = useState<Record<string, RigEntry>>({});
  const [rigKey, setRigKey] = useState("front");
  const [charRefRel, setCharRefRel] = useState("");
  const [standard, setStandard] = useState<HeadStandard | null>(null);
  const standardRef = useRef<HeadStandard | null>(null);
  useEffect(() => { standardRef.current = standard; }, [standard]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // ── The multi-segment timeline (this rig key's "scratch board") ──
  const [bodySegments, setBodySegments] = useState<Segment[]>([]);
  const [headSegments, setHeadSegments] = useState<HeadSegment[]>([]);
  const [audioSegments, setAudioSegments] = useState<Segment[]>([]);
  const [shotsLoaded, setShotsLoaded] = useState(false);
  const audioDerivePendingRef = useRef<StoredHeadSegment[] | null>(null);
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
  const [snapGuide, setSnapGuide] = useState<number | null>(null);

  // Undo / redo of the whole recipe (body + head tracks). A drag or a burst
  // of wheel/handle edits counts as one step.
  type Snapshot = { body: Segment[]; head: HeadSegment[]; audio: Segment[] };
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const prevSnapRef = useRef<Snapshot>({ body: [], head: [], audio: [] });
  const skipHistoryRef = useRef(true);
  const gestureBaseRef = useRef<Snapshot | null>(null);
  const lastPushAtRef = useRef(0);
  const [, historyTick] = useState(0);

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: TrackName; id: string } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const [ctxPos, setCtxPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) { setCtxPos({ x: ctxMenu.x, y: ctxMenu.y }); return; }
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setCtxPos({ x: Math.max(margin, Math.min(ctxMenu.x, maxX)), y: Math.max(margin, Math.min(ctxMenu.y, maxY)) });
  }, [ctxMenu]);

  // Canvas drag state (move/scale a head segment's anchor)
  const canvasDragRef = useRef<{
    kind: "move" | "scale" | "bodyMove";
    bodyId?: string;
    baseW?: number;
    baseH?: number;
    cssScale?: number;
    origOffsetX?: number;
    origOffsetY?: number;
    startX: number;
    startY: number;
    origAnchorX: number;
    origAnchorY: number;
    origScale: number;
  } | null>(null);

  // Refs mirroring the latest state for the rAF playback loop (so the loop
  // doesn't need to restart every time a segment is edited)
  const segmentsRef = useRef<{ body: Segment[]; head: HeadSegment[]; audio: Segment[] }>({ body: [], head: [], audio: [] });
  useEffect(() => { segmentsRef.current = { body: bodySegments, head: headSegments, audio: audioSegments }; }, [bodySegments, headSegments, audioSegments]);
  const selectedRef = useRef(selectedSegment);
  useEffect(() => { selectedRef.current = selectedSegment; }, [selectedSegment]);

  const [showGround, setShowGround] = useState(true);
  const showGroundRef = useRef(showGround);
  useEffect(() => { showGroundRef.current = showGround; }, [showGround]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const playRafRef = useRef<number | null>(null);

  // Shot natural dimensions, cached per shot id (lazily loaded)
  const [shotDims, setShotDims] = useState<Record<string, { w: number; h: number }>>({});
  const shotDimsLoadingRef = useRef<Set<string>>(new Set());
  const shotDimsVersionRef = useRef<Record<string, number>>({});
  function ensureShotDims(shotId: string, force = false) {
    if (!shotId) return;
    if (!force && (shotDims[shotId] || shotDimsLoadingRef.current.has(shotId))) return;
    const version = mediaVersion[shotId] || 0;
    shotDimsLoadingRef.current.add(shotId);
    const img = new Image();
    img.onload = () => {
      shotDimsLoadingRef.current.delete(shotId);
      if ((shotDimsVersionRef.current[shotId] || 0) !== version) return;
      setShotDims((prev) => ({ ...prev, [shotId]: { w: img.naturalWidth, h: img.naturalHeight } }));
    };
    img.onerror = () => { shotDimsLoadingRef.current.delete(shotId); };
    img.src = shotMediaUrl(project, characterId, shotId, "cut/f_0001.png", version);
  }

  // Bumped per-shot whenever a shot's frames are re-keyed on disk (see
  // handleReprocessShot), so cached <img> elements and the worker's media
  // cache headers are bypassed and the fixed, transparent frames reload.
  const [mediaVersion, setMediaVersion] = useState<Record<string, number>>({});

  // Per-frame image cache (shotId#frame#version -> Image), with a bump
  // counter to force a redraw once a requested frame finishes loading.
  const frameImgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [redrawTick, setRedrawTick] = useState(0);
  function getFrameImage(shotId: string, frame: number): HTMLImageElement | null {
    const v = mediaVersion[shotId] || 0;
    const key = `${shotId}#${frame}#${v}`;
    const cached = frameImgCacheRef.current.get(key);
    if (cached) return cached;
    const pad = String(Math.max(1, frame)).padStart(4, "0");
    const img = new Image();
    img.onload = () => { frameImgCacheRef.current.set(key, img); setRedrawTick((t) => t + 1); };
    img.onerror = () => { /* prevent infinite retry — frame image missing */ };
    img.src = shotMediaUrl(project, characterId, shotId, `cut/f_${pad}.png`, v);
    return null;
  }

  // How each body clip moves up and down (measured by the worker, same numbers as the bake),
  // for head clips set to follow the body. Keyed by body clip and neck position.
  const bodyMotionRef = useRef<Map<string, number[] | "loading" | "failed">>(new Map());
  /** Pixels the head sits lower (+) or higher (-) than its anchor at `frame` because it follows the body. */
  function headFollowShift(head: HeadSegment, frame: number, bodyHeight: number): number {
    const follow = clampFollow(head.followBody);
    if (follow <= 0) return 0;
    const body = activeSegmentAt(segmentsRef.current.body, frame);
    if (!body) return 0;
    const key = followKey(body.shotId, head.anchorX);
    const known = bodyMotionRef.current.get(key);
    if (known === undefined) {
      bodyMotionRef.current.set(key, "loading");
      loadBodyMotion(project, characterId, body.shotId, neckPosition(head.anchorX))
        .then((offsets) => bodyMotionRef.current.set(key, offsets))
        .catch(() => bodyMotionRef.current.set(key, "failed"))
        .finally(() => setRedrawTick((t) => t + 1));
      return 0;
    }
    return Array.isArray(known) ? followDy(known, sourceFrameOf(body, frame), follow, bodyHeight) : 0;
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
          setTalkShots(data.filter((s) => s.talk));
          setShotsLoaded(true);
        }
        if (rigRes.ok) {
          const data = await rigRes.json();
          setRigs(data.rigs || {});
          if (data.reference) setCharRefRel(data.reference);
          setStandard(data.standard || null);
        }
      } catch { /* worker may not be reachable yet */ }
    })();
  }, [project, characterId]);

  // ── When rig key changes, load its saved timeline (fresh client ids) ──
  useEffect(() => {
    const entry = rigs[rigKey];
    legacyKeyframesRef.current = entry?.keyframes;
    skipHistoryRef.current = true;
    undoRef.current = [];
    redoRef.current = [];
    gestureBaseRef.current = null;
    setBodySegments((entry?.bodySegments || []).map((s) => ({ ...s, id: genSegId() })));
    setHeadSegments((entry?.headSegments || []).map((s) => ({ ...s, id: genSegId() })));
    // Rigs saved before the audio lane existed have no audioSegments: build the lane once from their head clips.
    audioDerivePendingRef.current = null;
    if (entry?.audioSegments) {
      setAudioSegments(entry.audioSegments.map((s) => ({ ...s, id: genSegId() })));
    } else if (entry?.headSegments?.length && shotsLoaded) {
      setAudioSegments(deriveAudioPieces(entry.headSegments, shotsById, genSegId));
    } else {
      setAudioSegments([]);
      if (entry?.headSegments?.length) audioDerivePendingRef.current = entry.headSegments;
    }
    setSelectedSegment(null);
    setScrubFrame(1);
    historyTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigKey, rigs]);

  useEffect(() => {
    const current: Snapshot = { body: bodySegments, head: headSegments, audio: audioSegments };
    const previous = prevSnapRef.current;
    prevSnapRef.current = current;
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    if (previous.body === current.body && previous.head === current.head && previous.audio === current.audio) return;
    const now = Date.now();
    if (dragSegRef.current || canvasDragRef.current) {
      if (!gestureBaseRef.current) gestureBaseRef.current = previous;
      return;
    }
    redoRef.current = [];
    if (now - lastPushAtRef.current < 350) {
      lastPushAtRef.current = now;
      return;
    }
    lastPushAtRef.current = now;
    undoRef.current = [...undoRef.current.slice(-79), previous];
    historyTick((n) => n + 1);
  }, [bodySegments, headSegments, audioSegments]);

  function commitGesture() {
    const base = gestureBaseRef.current;
    gestureBaseRef.current = null;
    if (!base) return;
    redoRef.current = [];
    undoRef.current = [...undoRef.current.slice(-79), base];
    lastPushAtRef.current = Date.now();
    historyTick((n) => n + 1);
  }

  function applySnapshot(snap: Snapshot) {
    skipHistoryRef.current = true;
    prevSnapRef.current = snap;
    setBodySegments(snap.body);
    setHeadSegments(snap.head);
    setAudioSegments(snap.audio);
    setSelectedSegment(null);
  }

  function undo() {
    const snap = undoRef.current[undoRef.current.length - 1];
    if (!snap) return;
    undoRef.current = undoRef.current.slice(0, -1);
    redoRef.current = [...redoRef.current, { body: segmentsRef.current.body, head: segmentsRef.current.head, audio: segmentsRef.current.audio }];
    applySnapshot(snap);
    historyTick((n) => n + 1);
  }

  function redo() {
    const snap = redoRef.current[redoRef.current.length - 1];
    if (!snap) return;
    redoRef.current = redoRef.current.slice(0, -1);
    undoRef.current = [...undoRef.current, { body: segmentsRef.current.body, head: segmentsRef.current.head, audio: segmentsRef.current.audio }];
    applySnapshot(snap);
    historyTick((n) => n + 1);
  }

  // Remove segments whose shot was deleted. A talking-head clip that is being
  // redone is not "ready" for a while but still exists, so its segments stay.
  const shotIdsSet = useMemo(() => new Set([...shots, ...talkShots].map((s) => s.id)), [shots, talkShots]);
  useEffect(() => {
    setBodySegments((prev) => {
      const filtered = prev.filter((s) => shotIdsSet.has(s.shotId));
      return filtered.length === prev.length ? prev : filtered;
    });
    setHeadSegments((prev) => {
      const filtered = prev.filter((s) => shotIdsSet.has(s.shotId));
      return filtered.length === prev.length ? prev : filtered;
    });
    setAudioSegments((prev) => {
      const filtered = prev.filter((s) => shotIdsSet.has(s.shotId));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [shotIdsSet]);

  const shotsById = useMemo(() => {
    const map = new Map<string, ShotInfo>();
    for (const s of shots) map.set(s.id, s);
    return map;
  }, [shots]);

  useEffect(() => {
    const heads = audioDerivePendingRef.current;
    if (!heads || !shotsLoaded) return;
    audioDerivePendingRef.current = null;
    skipHistoryRef.current = true;
    setAudioSegments(deriveAudioPieces(heads, shotsById, genSegId));
  }, [shotsLoaded, shotsById]);

  const maxFrames = useMemo(() => {
    let max = 1;
    for (const s of bodySegments) max = Math.max(max, segEnd(s));
    for (const s of headSegments) max = Math.max(max, segEnd(s));
    for (const s of audioSegments) max = Math.max(max, segEnd(s));
    return max;
  }, [bodySegments, headSegments, audioSegments]);

  // A redone or re-keyed clip can come back at a different pixel size (Grok vs
  // LTX), so forget the old size and read it again; until it arrives the
  // preview falls back to each loaded frame's own size, so nothing is stretched.
  useEffect(() => {
    for (const shotId of Object.keys(mediaVersion)) {
      const version = mediaVersion[shotId] || 0;
      if ((shotDimsVersionRef.current[shotId] || 0) === version) continue;
      shotDimsVersionRef.current[shotId] = version;
      setShotDims((prev) => {
        if (!(shotId in prev)) return prev;
        const next = { ...prev };
        delete next[shotId];
        return next;
      });
      ensureShotDims(shotId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaVersion]);

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

  const editingBody = useMemo(() => {
    if (selectedSegment?.track === "body") {
      const sel = bodySegments.find((s) => s.id === selectedSegment.id);
      if (sel) return sel;
    }
    return activeBody;
  }, [selectedSegment, bodySegments, activeBody]);

  function setBodyScale(id: string, value: number, all = false) {
    const next = Math.round(clamp(value, BODY_SCALE_MIN, BODY_SCALE_MAX) * 100) / 100;
    const reset = Math.abs(next - 1) < 0.005;
    const source = segmentsRef.current.body.find((s) => s.id === id);
    // The first time a body is resized, remember where its head sits so the
    // body grows around the neck and the head does not move.
    let pivot = { x: source?.bodyPivotX, y: source?.bodyPivotY };
    if (!reset && (pivot.x == null || pivot.y == null)) {
      const head = activeSegmentAt(segmentsRef.current.head, scrubFrame);
      pivot = head ? { x: clamp(head.anchorX, 0, 1), y: clamp(head.anchorY, 0, 1) } : { x: 0.5, y: 0.2 };
    }
    setBodySegments((prev) =>
      prev.map((s) => {
        if (!all && s.id !== id) return s;
        if (reset) {
          const { bodyScale: _scale, bodyPivotX: _px, bodyPivotY: _py, ...rest } = s;
          void _scale; void _px; void _py;
          return rest;
        }
        return { ...s, bodyScale: next, bodyPivotX: pivot.x, bodyPivotY: pivot.y };
      })
    );
    setSaved(false);
  }

  /** Shift a body clip (and the head riding on it). Values are fractions of the body frame; zero removes the shift. */
  function setBodyOffset(id: string, x: number, y: number, all = false) {
    const nx = Math.round(clamp(x, -BODY_OFFSET_LIMIT, BODY_OFFSET_LIMIT) * 1000) / 1000;
    const ny = Math.round(clamp(y, -BODY_OFFSET_LIMIT, BODY_OFFSET_LIMIT) * 1000) / 1000;
    setBodySegments((prev) =>
      prev.map((s) => {
        if (!all && s.id !== id) return s;
        const { bodyOffsetX: _ox, bodyOffsetY: _oy, ...rest } = s;
        void _ox; void _oy;
        const next: Segment = { ...rest };
        if (nx !== 0) next.bodyOffsetX = nx;
        if (ny !== 0) next.bodyOffsetY = ny;
        return next;
      })
    );
    setSaved(false);
  }

  function setBodyInFront(id: string, value: boolean, all = false) {
    setBodySegments((prev) =>
      prev.map((s) => {
        if (!all && s.id !== id) return s;
        if (value) return { ...s, bodyInFront: true };
        const { bodyInFront: _front, ...rest } = s;
        void _front;
        return rest;
      })
    );
    setSaved(false);
  }

  // ── Visible head size (alpha box per shot) for the head standard ──
  type HeadMetrics = { box: Box; frame: FrameSize };
  const headMetricsRef = useRef<Map<string, HeadMetrics | null>>(new Map());
  const headMetricsLoadingRef = useRef<Map<string, Promise<HeadMetrics | null>>>(new Map());
  const [metricsTick, setMetricsTick] = useState(0);
  const rigKeyRef = useRef(rigKey);
  useEffect(() => { rigKeyRef.current = rigKey; }, [rigKey]);
  const shotsByIdRef = useRef(new Map<string, ShotInfo>());
  useEffect(() => { shotsByIdRef.current = new Map(shots.map((s) => [s.id, s])); }, [shots]);

  const mediaVersionRef = useRef(mediaVersion);
  useEffect(() => { mediaVersionRef.current = mediaVersion; }, [mediaVersion]);
  function metricsKey(shotId: string): string {
    return `${shotId}#${mediaVersionRef.current[shotId] || 0}`;
  }

  /** Median visible-head box over up to 9 frames of the whole shot, in source pixels. */
  function measureShotHead(shotId: string): Promise<HeadMetrics | null> {
    const key = metricsKey(shotId);
    const cached = headMetricsRef.current.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = headMetricsLoadingRef.current.get(key);
    if (inflight) return inflight;
    const version = mediaVersionRef.current[shotId] || 0;
    const count = Math.max(1, shotsByIdRef.current.get(shotId)?.frameCount || 1);
    const picks = Array.from(new Set(
      Array.from({ length: Math.min(9, count) }, (_, i) => (count === 1 ? 1 : 1 + Math.round((i * (count - 1)) / (Math.min(9, count) - 1))))
    ));
    const promise = (async (): Promise<HeadMetrics | null> => {
      const boxes: Box[] = [];
      let frame: FrameSize | null = null;
      for (const f of picks) {
        try {
          const pad = String(f).padStart(4, "0");
          // The `m=pixels` suffix keeps this CORS request off the cache entry of the plain <img>
          // loads, which carry no Access-Control-Allow-Origin header and would make fetch() fail.
          const res = await fetch(`${shotMediaUrl(project, characterId, shotId, `cut/f_${pad}.png`, version)}&m=pixels`);
          if (!res.ok) continue;
          const bitmap = await createImageBitmap(await res.blob());
          const k = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
          const w = Math.max(1, Math.round(bitmap.width * k));
          const h = Math.max(1, Math.round(bitmap.height * k));
          const off = document.createElement("canvas");
          off.width = w;
          off.height = h;
          const octx = off.getContext("2d");
          if (!octx) continue;
          octx.drawImage(bitmap, 0, 0, w, h);
          const box = alphaBox(octx.getImageData(0, 0, w, h).data, w, h);
          frame = { w: bitmap.width, h: bitmap.height };
          if (box) boxes.push({ x: box.x / k, y: box.y / k, w: box.w / k, h: box.h / k });
        } catch { /* skip an unreadable frame */ }
      }
      const median = medianBox(boxes);
      const result = median && frame ? { box: median, frame } : null;
      headMetricsRef.current.set(key, result);
      headMetricsLoadingRef.current.delete(key);
      setMetricsTick((t) => t + 1);
      return result;
    })();
    headMetricsLoadingRef.current.set(key, promise);
    return promise;
  }

  useEffect(() => {
    for (const seg of headSegments) void measureShotHead(seg.shotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSegments.map((s) => s.shotId).join("|"), mediaVersion, shots]);

  /** Body frame the head fractions refer to: the active body at `frame` (or the first body clip when `fallbackToFirst`). */
  function bodyDimsFor(frame: number, fallbackToFirst = false): FrameSize | null {
    const active = activeSegmentAt(segmentsRef.current.body, frame) || (fallbackToFirst ? segmentsRef.current.body[0] : undefined);
    const dims = active ? shotDims[active.shotId] : null;
    const userScale = bodyUserScale(active);
    return dims && dims.w > 0 ? { w: dims.w * userScale, h: dims.h * userScale } : null;
  }

  type HeadGeometry = {
    box: Box;
    frame: FrameSize;
    body: FrameSize;
    rect: Box;
  };

  function headGeometry(head: HeadSegment, frame: number): HeadGeometry | null {
    const metrics = headMetricsRef.current.get(metricsKey(head.shotId));
    const body = bodyDimsFor(frame);
    if (!metrics || !body) return null;
    const rect = visibleHeadRect(metrics.box, metrics.frame, head, body);
    return { box: metrics.box, frame: metrics.frame, body, rect };
  }

  const headMatchInfo = (() => {
    if (!editingHead || !standard) return null;
    const metrics = headMetricsRef.current.get(metricsKey(editingHead.shotId));
    const body = bodyDimsFor(scrubFrame, true);
    if (!metrics || !body) return null;
    return matchStandard({ box: metrics.box, placement: editingHead, body, standard, rigKey });
  })();
  const headStatusText = !editingHead
    ? standard ? "Standard head size is set." : "No standard head size yet."
    : !standard
      ? "No standard yet: size the front head how you want it, then Set as standard."
      : headMatchInfo
        ? `Head ${Math.round(headMatchInfo.ratio * 100)}% of standard${headMatchInfo.state === "match" ? " ✓" : ""}`
        : "Measuring head…";

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
    let bodyImg: HTMLImageElement | null = null;
    let bodyDrawn = !body?.bodyInFront;

    if (body) {
      const img = getFrameImage(body.shotId, sourceFrameOf(body, frame));
      const dims = shotDims[body.shotId] || (img ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      if (dims && dims.w > 0) {
        const bodyZone = ch * 0.7;
        scale = Math.min(cw / dims.w, bodyZone / dims.h) * 0.9;
        const baseW = dims.w * scale;
        const baseH = dims.h * scale;
        const rect = scaledBodyRect({ x: (cw - baseW) / 2, y: ch - baseH - ch * 0.03, w: baseW, h: baseH }, body);
        bw = rect.w;
        bh = rect.h;
        bx = rect.x;
        by = rect.y;
        bodyImg = img || null;
        if (img && !body.bodyInFront) ctx.drawImage(img, bx, by, bw, bh);
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
          const followDyPx = headFollowShift(head, frame, bh);
          const hy = by + head.anchorY * bh - hh / 2 + followDyPx;
          // Draw twice -- keyed PNGs can have semi-transparent pixels from
          // green-screen removal; a second pass makes them fully opaque.
          ctx.drawImage(img, hx, hy, hw, hh);
          ctx.drawImage(img, hx, hy, hw, hh);
          if (bodyImg && !bodyDrawn) {
            ctx.drawImage(bodyImg, bx, by, bw, bh);
            bodyDrawn = true;
          }

          const isEditing = selectedRef.current?.track === "head" && selectedRef.current.id === head.id;
          const geo = headGeometry(head, frame);
          const std = standardRef.current;
          const rigNow = rigKeyRef.current;
          // Visible-head box (what is compared with the standard); the whole
          // source frame is only the fallback until it has been measured.
          const box = geo
            ? { x: bx + geo.rect.x * scale, y: by + geo.rect.y * scale + followDyPx, w: geo.rect.w * scale, h: geo.rect.h * scale }
            : { x: hx, y: hy, w: hw, h: hh };

          let matched = false;
          if (geo && std) {
            const tgtH = targetHeightFraction(std, rigNow) * geo.body.h * scale;
            const tgtCy = by + std.centerY * geo.body.h * scale;
            const guideHalfW = Math.max(box.w / 2, 40) + 24;
            const gx = bx + std.centerX * geo.body.w * scale;
            ctx.save();
            ctx.strokeStyle = "rgba(80, 220, 120, 0.9)";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 4]);
            for (const gy of [tgtCy - tgtH / 2, tgtCy + tgtH / 2]) {
              ctx.beginPath();
              ctx.moveTo(gx - guideHalfW, gy);
              ctx.lineTo(gx + guideHalfW, gy);
              ctx.stroke();
            }
            ctx.restore();
            matched = matchStandard({ box: geo.box, placement: head, body: geo.body, standard: std, rigKey: rigNow }).state === "match";
          }

          if (isEditing) {
            const color = matched ? "#3ecf6a" : "#e0a040";
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            ctx.setLineDash([]);

            const handles = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]];
            for (const [cx, cy] of handles) {
              ctx.fillStyle = color;
              ctx.fillRect(cx - 4, cy - 4, 8, 8);
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 1;
              ctx.strokeRect(cx - 4, cy - 4, 8, 8);
            }

            const ax = bx + head.anchorX * bw;
            const ay = by + head.anchorY * bh;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay);
            ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10);
            ctx.stroke();
          }
        }
      }
    }

    if (bodyImg && !bodyDrawn) ctx.drawImage(bodyImg, bx, by, bw, bh);

    if (showGroundRef.current) {
      const groundY = Math.round(ch * GROUND_FRACTION) + 0.5;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(cw, groundY);
      ctx.stroke();
      const feetY = body ? Math.round(by + bh) + 0.5 : null;
      if (feetY != null && Math.abs(feetY - groundY) > 1.5) {
        ctx.strokeStyle = "rgba(224, 160, 64, 0.9)";
        ctx.beginPath();
        ctx.moveTo(0, feetY);
        ctx.lineTo(cw, feetY);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.font = "10px monospace";
      ctx.fillText("ground", cw - 46, groundY - 4);
    }

    ctx.fillStyle = "#e0a040";
    ctx.font = "11px monospace";
    const bodyLabel = body ? `${shotsById.get(body.shotId)?.name || body.shotId} f${sourceFrameOf(body, frame)}` : "— body gap —";
    const headLabel = head ? `${shotsById.get(head.shotId)?.name || head.shotId} f${sourceFrameOf(head, frame)}` : "— head gap —";
    ctx.fillText(`F${frame}/${maxFrames}  Body: ${bodyLabel}  Head: ${headLabel}`, 8, ch - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotDims, maxFrames, shotsById]);

  // Redraw whenever the scrub position, segments, selection, or a newly
  // loaded image/dim becomes available (while paused).
  useEffect(() => {
    if (playing) return;
    drawFrame(scrubFrame);
  }, [playing, scrubFrame, bodySegments, headSegments, selectedSegment, shotDims, redrawTick, metricsTick, standard, rigKey, showGround, drawFrame]);

  // ── Dialogue audio: each talking-head clip carries the slice of audio it was made from ──
  const [soundOn, setSoundOn] = useState(true);
  const soundOnRef = useRef(soundOn);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioNowRef = useRef<string | null>(null);
  const [auditionSeg, setAuditionSeg] = useState<string | null>(null);
  const auditionRef = useRef<{ el: HTMLAudioElement; stopAt: number } | null>(null);
  const [wavePeaks, setWavePeaks] = useState<Record<string, { peaks: number[]; duration: number }>>({});
  const waveLoadingRef = useRef<Set<string>>(new Set());

  const audioUrlFor = useCallback(
    (shotId: string) => shotMediaUrl(project, characterId, shotId, SHOT_AUDIO_REL, mediaVersionRef.current[shotId]),
    [project, characterId]
  );

  function audioElFor(shotId: string): HTMLAudioElement {
    let el = audioElsRef.current.get(shotId);
    if (!el) {
      el = new Audio(audioUrlFor(shotId));
      el.preload = "auto";
      audioElsRef.current.set(shotId, el);
    }
    return el;
  }

  function stopAudio() {
    audioNowRef.current = null;
    audioElsRef.current.forEach((el) => { if (!el.paused) el.pause(); });
  }

  function stopAudition() {
    const a = auditionRef.current;
    if (a) { a.el.pause(); auditionRef.current = null; }
    setAuditionSeg(null);
  }

  /** Keep the dialogue under the playhead playing at the right spot (called every frame while playing). */
  function syncAudio(frame: number) {
    if (!soundOnRef.current) { stopAudio(); return; }
    const at = audioAtFrame(segmentsRef.current.audio, shotsByIdRef.current, frame, fps);
    if (!at || at.rate < 0.25 || at.rate > 4) { stopAudio(); return; }
    const el = audioElFor(at.shotId);
    if (audioNowRef.current !== at.segId) {
      audioElsRef.current.forEach((other) => { if (other !== el && !other.paused) other.pause(); });
      audioNowRef.current = at.segId;
      el.currentTime = at.timeSec;
      el.playbackRate = at.rate;
      void el.play().catch(() => undefined);
      return;
    }
    el.playbackRate = at.rate;
    if (Math.abs(el.currentTime - at.timeSec) > 0.4) el.currentTime = at.timeSec;
    if (el.paused && !el.ended) void el.play().catch(() => undefined);
  }

  function toggleAudition(item: AudioLaneItem) {
    if (auditionSeg === item.segId) { stopAudition(); return; }
    stopAudition();
    if (playing) handlePlay();
    stopAudio();
    const el = audioElFor(item.shotId);
    el.playbackRate = 1;
    el.currentTime = item.fromSec;
    auditionRef.current = { el, stopAt: item.toSec };
    setAuditionSeg(item.segId);
    const onTime = () => {
      const a = auditionRef.current;
      if (!a || a.el !== el) { el.removeEventListener("timeupdate", onTime); return; }
      if (el.currentTime >= a.stopAt || el.ended) {
        el.removeEventListener("timeupdate", onTime);
        stopAudition();
      }
    };
    el.addEventListener("timeupdate", onTime);
    void el.play().catch(() => stopAudition());
  }

  const audioItems = useMemo(
    () => audioLaneItems(audioSegments, shotsById, fps),
    [audioSegments, shotsById, fps]
  );

  useEffect(() => {
    for (const item of audioItems) {
      const key = `${item.shotId}#${mediaVersion[item.shotId] || 0}`;
      if (wavePeaks[key] || waveLoadingRef.current.has(key)) continue;
      waveLoadingRef.current.add(key);
      (async () => {
        try {
          const res = await fetch(shotMediaUrl(project, characterId, item.shotId, SHOT_AUDIO_REL, mediaVersion[item.shotId]));
          if (!res.ok) return;
          const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctx) return;
          const ctx = new Ctx();
          try {
            const buf = await ctx.decodeAudioData(await res.arrayBuffer());
            setWavePeaks((prev) => ({ ...prev, [key]: { peaks: audioPeaks(buf.getChannelData(0), 600), duration: buf.duration } }));
          } finally {
            void ctx.close();
          }
        } catch {
          // No waveform for this clip: the block is still shown and playable.
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioItems, mediaVersion, project, characterId]);

  useEffect(() => {
    if (!playing) { stopAudio(); return; }
    stopAudition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    if (!soundOn) { stopAudio(); stopAudition(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundOn]);

  useEffect(() => {
    const els = audioElsRef.current;
    return () => {
      els.forEach((el) => el.pause());
      els.clear();
    };
  }, []);

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
    const startFrame = scrubFrame >= maxFrames ? 1 : scrubFrame;
    const startTime = performance.now();
    let frame = startFrame;
    syncAudio(frame);

    // The playhead follows the real clock (a busy preview drops pictures
    // instead of running slow), so the dialogue never has to be rewound to
    // catch up, which sounded like an echo.
    function tick(now: number) {
      const interval = 1000 / Math.max(1, fps);
      const steps = Math.floor((now - startTime) / interval);
      const next = ((startFrame - 1 + steps) % Math.max(1, maxFrames)) + 1;
      if (next !== frame) {
        frame = next;
        setScrubFrame(frame);
        drawFrame(frame);
        syncAudio(frame);
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
        const baseW = dims.w * scale;
        const baseH = dims.h * scale;
        const rect = scaledBodyRect({ x: (cw - baseW) / 2, y: ch - baseH - ch * 0.03, w: baseW, h: baseH }, body);
        return { scale, bw: rect.w, bh: rect.h, bx: rect.x, by: rect.y };
      }
    }
    const bw = cw * 0.6;
    const bh = ch * 0.6;
    return { scale: 1, bw, bh, bx: (cw - bw) / 2, by: ch - bh - ch * 0.03 };
  }

  function onCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const head = editingHead;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const cssScale = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * cssScale;
    const my = (e.clientY - rect.top) * cssScale;
    const { scale, bw, bh, bx, by } = layoutBasis(scrubFrame);

    // With a body clip selected, dragging the body (anywhere that is not the
    // head) shifts it; the head rides along because it is anchored to the body.
    const selectedBody = selectedSegment?.track === "body" ? editingBody : null;
    if (selectedBody) {
      let onHead = false;
      const headDimsNow = head ? shotDims[head.shotId] : null;
      if (head && headDimsNow && headDimsNow.w > 0) {
        const geo = headGeometry(head, scrubFrame);
        const hw = geo ? geo.rect.w * scale : headDimsNow.w * head.headScale * scale;
        const hh = geo ? geo.rect.h * scale : headDimsNow.h * head.headScale * scale;
        const hx = geo ? bx + geo.rect.x * scale : bx + head.anchorX * bw - hw / 2;
        const hy = (geo ? by + geo.rect.y * scale : by + head.anchorY * bh - hh / 2) + headFollowShift(head, scrubFrame, bh);
        onHead = mx >= hx - 16 && mx <= hx + hw + 16 && my >= hy - 16 && my <= hy + hh + 16;
      }
      if (!onHead) {
        const s = bodyUserScale(selectedBody);
        const off = bodyOffset(selectedBody);
        canvasDragRef.current = {
          kind: "bodyMove",
          bodyId: selectedBody.id,
          startX: e.clientX,
          startY: e.clientY,
          baseW: bw / s,
          baseH: bh / s,
          cssScale,
          origOffsetX: off.x,
          origOffsetY: off.y,
          origAnchorX: 0,
          origAnchorY: 0,
          origScale: 1,
        };
        e.preventDefault();
        return;
      }
    }
    if (!head) return;

    // Check corner handles for scale drag (only if dims known). The box is the
    // visible head once measured, otherwise the whole source frame.
    const headDims = shotDims[head.shotId];
    const hitMargin = 16;
    if (headDims && headDims.w > 0) {
      const geo = headGeometry(head, scrubFrame);
      let hx: number;
      let hy: number;
      let hw: number;
      let hh: number;
      if (geo) {
        hx = bx + geo.rect.x * scale;
        hy = by + geo.rect.y * scale;
        hw = geo.rect.w * scale;
        hh = geo.rect.h * scale;
      } else {
        hw = headDims.w * head.headScale * scale;
        hh = headDims.h * head.headScale * scale;
        hx = bx + head.anchorX * bw - hw / 2;
        hy = by + head.anchorY * bh - hh / 2;
      }
      hy += headFollowShift(head, scrubFrame, bh);
      const corners = [[hx, hy], [hx + hw, hy], [hx, hy + hh], [hx + hw, hy + hh]];
      for (const [cx, cy] of corners) {
        if (Math.abs(mx - cx) < 14 && Math.abs(my - cy) < 14) {
          setSelectedSegment({ track: "head", id: head.id });
          canvasDragRef.current = { kind: "scale", startX: e.clientX, startY: e.clientY, origAnchorX: head.anchorX, origAnchorY: head.anchorY, origScale: head.headScale };
          e.preventDefault();
          return;
        }
      }

      // Click fell outside the head's bounding box (plus a small margin) --
      // treat this as "click away" and deselect instead of starting a drag.
      const insideBox = mx >= hx - hitMargin && mx <= hx + hw + hitMargin && my >= hy - hitMargin && my <= hy + hh + hitMargin;
      if (!insideBox) {
        setSelectedSegment(null);
        return;
      }
    }

    // Inside the box, or dims not loaded yet (fall back to "drag anywhere" so
    // repositioning still works before the image has finished loading).
    setSelectedSegment({ track: "head", id: head.id });
    canvasDragRef.current = { kind: "move", startX: e.clientX, startY: e.clientY, origAnchorX: head.anchorX, origAnchorY: head.anchorY, origScale: head.headScale };
    e.preventDefault();
  }

  /** New scale for a head that grows/shrinks about the middle of its visible box, not the frame centre. */
  function rescaleKeepingHeadCentre(
    head: HeadSegment,
    nextScale: number,
    from?: { origAnchorX: number; origAnchorY: number; origScale: number }
  ): Partial<HeadSegment> {
    const base: HeadSegment = from ? { ...head, anchorX: from.origAnchorX, anchorY: from.origAnchorY, headScale: from.origScale } : head;
    const metrics = headMetricsRef.current.get(metricsKey(head.shotId));
    const body = bodyDimsFor(scrubFrame);
    if (!metrics || !body) return { headScale: nextScale };
    const { box, frame } = metrics;
    const boxCx = box.x + box.w / 2 - frame.w / 2;
    const boxCy = box.y + box.h / 2 - frame.h / 2;
    const centreX = base.anchorX * body.w + boxCx * base.headScale;
    const centreY = base.anchorY * body.h + boxCy * base.headScale;
    return {
      headScale: nextScale,
      anchorX: clamp((centreX - boxCx * nextScale) / body.w, 0, 1),
      anchorY: clamp((centreY - boxCy * nextScale) / body.h, -0.5, 1.5),
    };
  }

  function updateHeadSegment(id: string, patch: Partial<HeadSegment>) {
    setHeadSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  /** How much a head clip follows the body's up-and-down motion; zero removes it. */
  function setHeadFollow(id: string, value: number, all = false) {
    const next = clampFollow(value);
    setHeadSegments((prev) =>
      prev.map((s) => {
        if (!all && s.id !== id) return s;
        const { followBody: _follow, ...rest } = s;
        void _follow;
        return next > 0 ? { ...rest, followBody: next } : rest;
      })
    );
    setSaved(false);
  }

  // ── Head standard actions ──
  const [headNote, setHeadNote] = useState<string | null>(null);

  async function putStandard(next: HeadStandard | null): Promise<boolean> {
    const base = `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/head-standard`;
    const res = next
      ? await workerFetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
      : await workerFetch(base, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Could not save the head standard" }));
      throw new Error(data.error || "Could not save the head standard");
    }
    const data = await res.json();
    setStandard(data.standard || null);
    return true;
  }

  async function handleSetStandard() {
    const head = editingHead;
    if (!head) return;
    setError(null);
    const metrics = await measureShotHead(head.shotId);
    const body = bodyDimsFor(scrubFrame, true);
    if (!metrics || !body) {
      setError("Needs a body clip and a readable head clip to measure the head.");
      return;
    }
    try {
      const next = standardFromHead({ box: metrics.box, frame: metrics.frame, placement: head, body, rigKey, current: standard });
      await putStandard(next);
      const isBase = rigKey === BASE_RIG_KEY || !standard;
      setHeadNote(isBase ? "Standard head set from this clip." : `Size for "${rigKey}" saved (${Math.round((next.views?.[rigKey] ?? 1) * 100)}% of standard).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the head standard");
    }
  }

  async function handleClearStandard() {
    try {
      await putStandard(null);
      setHeadNote("Standard cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear the head standard");
    }
  }

  async function fitPatchFor(seg: HeadSegment, std: HeadStandard | null): Promise<Partial<HeadSegment> | null> {
    if (!std) return null;
    const metrics = await measureShotHead(seg.shotId);
    const body = bodyDimsFor(scrubFrame, true);
    if (!metrics || !body) return null;
    return fitToStandard({ box: metrics.box, frame: metrics.frame, body, standard: std, rigKey: rigKeyRef.current });
  }

  async function handleFitHeads(onlyId?: string) {
    const targets = onlyId ? headSegments.filter((s) => s.id === onlyId) : headSegments;
    const patches = new Map<string, Partial<HeadSegment>>();
    for (const seg of targets) {
      const patch = await fitPatchFor(seg, standard);
      if (patch) patches.set(seg.id, patch);
    }
    if (patches.size === 0) {
      setError("Could not measure the heads yet -- add a body clip first.");
      return;
    }
    setError(null);
    setHeadSegments((prev) => prev.map((s) => (patches.has(s.id) ? { ...s, ...patches.get(s.id)! } : s)));
    setHeadNote(`Fitted ${patches.size} head${patches.size === 1 ? "" : "s"} to the standard. Save to keep.`);
    setSaved(false);
  }

  function onCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const drag = canvasDragRef.current;
    if (drag?.kind === "bodyMove" && drag.bodyId) {
      const css = drag.cssScale || 1;
      const dx = ((e.clientX - drag.startX) * css) / (drag.baseW || 1);
      const dy = ((e.clientY - drag.startY) * css) / (drag.baseH || 1);
      setBodyOffset(drag.bodyId, (drag.origOffsetX || 0) + dx, (drag.origOffsetY || 0) + dy);
      return;
    }
    if (!drag || !editingHead) return;
    const { bw, bh } = layoutBasis(scrubFrame);
    if (drag.kind === "move") {
      const dx = (e.clientX - drag.startX) / bw;
      const dy = (e.clientY - drag.startY) / bh;
      updateHeadSegment(editingHead.id, {
        anchorX: clamp(drag.origAnchorX + dx, 0, 1),
        anchorY: clamp(drag.origAnchorY + dy, -0.5, 1),
      });
    } else if (drag.kind === "scale") {
      const dy = drag.startY - e.clientY;
      const factor = 1 + dy / 200;
      updateHeadSegment(editingHead.id, rescaleKeepingHeadCentre(editingHead, clamp(drag.origScale * factor, 0.1, 3), drag));
    }
  }

  function onCanvasMouseUp() {
    if (canvasDragRef.current) {
      canvasDragRef.current = null;
      commitGesture();
    }
  }

  function onCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (selectedSegment?.track === "body" && editingBody) {
      e.preventDefault();
      setBodyScale(editingBody.id, bodyUserScale(editingBody) + (e.deltaY > 0 ? -0.02 : 0.02));
      return;
    }
    if (!editingHead) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.03 : 0.03;
    updateHeadSegment(editingHead.id, rescaleKeepingHeadCentre(editingHead, clamp(editingHead.headScale + delta, 0.1, 3)));
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
        audioSegments: audioSegments.map(({ id, ...rest }) => rest),
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
        const remaining: Record<string, unknown> = data.rigs || {};
        setRigs(remaining as Record<string, RigEntry>);
        if (key === rigKey) setRigKey(Object.keys(remaining)[0] || "front");
      } else {
        const data = await res.json().catch(() => ({ error: "Delete failed" }));
        alert(`Could not delete "${key}": ${data.error || res.status}`);
      }
    } catch (err) {
      alert(`Could not delete "${key}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Reload shots list ──
  async function reloadShots() {
    try {
      const res = await workerFetch(`/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots`);
      if (res.ok) {
        const data: ShotInfo[] = await res.json();
        setShots(data.filter((s) => s.status === "ready"));
        setTalkShots(data.filter((s) => s.talk));
      }
    } catch { /* best effort */ }
  }

  // ── Talking heads (chained Grok clips made from Stage audio) ──
  const talkGroups = useMemo(() => groupTalkShots(talkShots), [talkShots]);
  const talkActive = talkShots.some((s) => s.status === "queued" || s.status === "making");
  useEffect(() => {
    if (!talkActive) return;
    const id = window.setInterval(() => { void reloadShots(); }, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talkActive, project, characterId]);

  const talkWasActive = useRef(false);
  useEffect(() => {
    if (talkWasActive.current && !talkActive) {
      setMediaVersion((prev) => {
        const next = { ...prev };
        for (const s of talkShots) next[s.id] = (next[s.id] || 0) + 1;
        return next;
      });
    }
    talkWasActive.current = talkActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talkActive]);

  function openTalkMenu(e: React.MouseEvent, shot: { id?: string; talk?: TalkMeta; status: string; engine?: string; hasPrevious?: boolean }) {
    if (!shot.talk) return;
    e.preventDefault();
    e.stopPropagation();
    if (shot.status === "queued" || shot.status === "making") return;
    setTalkMenu({
      x: e.clientX,
      y: e.clientY,
      shotId: shot.id || "",
      group: shot.talk.group,
      index: shot.talk.index,
      engine: shot.engine || shot.talk.engine || "grok",
      hasPrevious: shot.hasPrevious === true,
    });
  }

  async function handleResumeTalk(group: string) {
    setTalkBusy(group);
    try {
      await resumeTalkingHead(project, characterId, group);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume the talking head");
    }
    await reloadShots();
    setTalkBusy(null);
  }

  async function handleRedoTalkClip(group: string, index: number, engine?: "grok" | "ltx") {
    const was = talkShots.find((s) => s.talk?.group === group && s.talk.index === index);
    const wasEngine = was?.engine || was?.talk?.engine || "grok";
    const n = was?.talk?.number ? `LTX ${String(was.talk.number).padStart(2, "0")}` : `clip ${index + 1}`;
    const message = engine === "grok"
      ? `${wasEngine === "grok" ? "Redo" : "Send"} ${n} ${wasEngine === "grok" ? "with Grok" : "to Grok"}?\n\nGrok makes the mouth move to the exact words (it cannot hear the audio, so the match is looser than LTX). This uses Grok credits for one clip. The other clips are kept, the clip keeps its black backdrop and head keying, any copies of it on the timeline stay in place, and you can press Undo to get the old clip back.`
      : engine === "ltx"
        ? `${wasEngine === "ltx" ? "Redo" : "Send back to LTX:"} ${n}${wasEngine === "ltx" ? " with LTX" : ""}?\n\nThis uses Comfy Cloud credits for one clip. The other clips are kept, any copies of it on the timeline stay in place, and you can press Undo to get the old clip back.`
        : `Regenerate ${n} with a new seed?\n\nThis uses credits for one clip with the engine it was made with. The other clips are kept, and you can press Undo to get the old clip back.`;
    if (!confirm(message)) return;
    setTalkBusy(group);
    try {
      await redoTalkingHeadClip(project, characterId, group, index, false, engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not redo the clip");
    }
    await reloadShots();
    setTalkBusy(null);
  }


  async function handleUndoRedoClip(group: string, index: number) {
    if (!confirm(`Go back to the previous version of clip ${index + 1}?\n\nThe current version of clip ${index + 1} is discarded.`)) return;
    setTalkBusy(group);
    try {
      await undoTalkingHeadRedo(project, characterId, group, index);
      const restored = talkShots.find((s) => s.talk?.group === group && s.talk.index === index);
      if (restored) bumpMediaVersion(restored.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore the previous clip");
    }
    await reloadShots();
    setTalkBusy(null);
  }

  async function handleStopTalk(group: string) {
    if (!confirm("Stop this talking head and remove the clips that are not finished?\n\nA Comfy Cloud clip is cancelled right away; a Grok clip already sent is still billed. Finished clips are kept.")) return;
    setTalkBusy(group);
    try {
      await stopTalkingHead(project, characterId, group);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop the talking head");
    }
    await reloadShots();
    setTalkBusy(null);
  }


  /** `atAudioTime`: start where the audio sits in its recording (so separate lines keep their gaps) instead of after the last head clip. */
  function placeTalkGroup(group: TalkGroup, atAudioTime = false) {
    const ready = group.shots.filter((s) => s.status === "ready");
    if (!ready.length) return;
    const ids = ready.map(() => genSegId());
    const headNow = segmentsRef.current.head;
    let placed = atAudioTime
      ? placeTalkWindowsAtAudio(group.shots, fps)
      : placeTalkWindows(group.shots, headNow.length ? Math.max(...headNow.map(segEnd)) + 1 : 1);
    if (atAudioTime && placed.length) {
      const length = placed.reduce((sum, p) => sum + (p.outFrame - p.inFrame + 1), 0);
      const start = placeInFreeSlot(headNow, placed[0].start, length);
      if (start !== placed[0].start) placed = placeTalkWindows(group.shots, start);
    }
    setHeadSegments((prev) => [
      ...prev,
      ...placed.map((p, i) => ({
        id: ids[i], ...p, anchorX: 0.5, anchorY: 0.15, headScale: 1.0,
      })),
    ]);
    addDialogueFor(placed);
    if (standardRef.current) {
      placed.forEach((p, i) => {
        void fitPatchFor({ id: ids[i], ...p, anchorX: 0.5, anchorY: 0.15, headScale: 1 }, standardRef.current).then((patch) => {
          if (patch) setHeadSegments((prev) => prev.map((seg) => (seg.id === ids[i] ? { ...seg, ...patch } : seg)));
        });
      });
    }
  }

  /** Put the audio of clips just placed on the head track onto the Dialogue lane (once per clip; after that the lane is independent). */
  function addDialogueFor(placed: { shotId: string; start: number; inFrame: number; outFrame: number }[]) {
    setAudioSegments((prev) => {
      let next = prev;
      for (const p of placed) {
        if (!shotHasAudio(shotsByIdRef.current.get(p.shotId)) || audioLaneHasShot(next, p.shotId)) continue;
        const start = placeInFreeSlot(next, p.start, p.outFrame - p.inFrame + 1);
        next = [...next, { id: genSegId(), shotId: p.shotId, inFrame: p.inFrame, outFrame: p.outFrame, start }];
      }
      return next;
    });
  }

  /** Put this clip's own audio on the Dialogue lane at the playhead (or where the clip sits), even if it is already there. */
  function addClipAudioToLane(shotId: string, at: number) {
    const shot = shotsByIdRef.current.get(shotId);
    if (!shotHasAudio(shot)) return;
    const outFrame = shot?.frameCount || 1;
    const id = genSegId();
    setAudioSegments((prev) => [...prev, { id, shotId, inFrame: 1, outFrame, start: placeInFreeSlot(prev, at, outFrame) }]);
    setSelectedSegment({ track: "audio", id });
    setSaved(false);
  }

  // ── Add a shot (full frame range) to the end of a track ──
  function addToTrack(track: TrackName, shot: ShotInfo) {
    if (track === "body") {
      setBodySegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        return [...prev, { id: genSegId(), shotId: shot.id, inFrame: 1, outFrame: shot.frameCount || 1, start }];
      });
    } else {
      const id = genSegId();
      const headNow = segmentsRef.current.head;
      const headStart = headNow.length ? Math.max(...headNow.map(segEnd)) + 1 : 1;
      setHeadSegments((prev) => {
        const start = prev.length ? Math.max(...prev.map(segEnd)) + 1 : 1;
        return [...prev, { id, shotId: shot.id, inFrame: 1, outFrame: shot.frameCount || 1, start, anchorX: 0.5, anchorY: 0.15, headScale: 1.0 }];
      });
      addDialogueFor([{ shotId: shot.id, start: headStart, inFrame: 1, outFrame: shot.frameCount || 1 }]);
      if (standardRef.current) {
        void fitPatchFor({ id, shotId: shot.id, inFrame: 1, outFrame: shot.frameCount || 1, start: 1, anchorX: 0.5, anchorY: 0.15, headScale: 1 }, standardRef.current).then((patch) => {
          if (patch) setHeadSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
        });
      }
    }
  }

  // ── Segment block drag (move / trim) on the timeline ──
  function onSegmentMouseDown(e: React.MouseEvent, track: TrackName, seg: Segment, edge?: "in" | "out") {
    if (e.button !== 0) return;
    e.preventDefault();
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
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pxPerFrame = rect.width / Math.max(maxFrames, 1);
      const deltaFrames = Math.round((e.clientX - drag.startClientX) / Math.max(pxPerFrame, 0.01));
      const setter = setterOf(drag.track);
      const list = segmentsRef.current[drag.track];
      const current = list.find((s) => s.id === drag.id);
      if (!current) return;
      const others = list.filter((s) => s.id !== drag.id);
      const shot = shotsById.get(current.shotId);
      const srcFrameCount = shot?.frameCount || drag.origOutFrame;
      const orig = { ...current, start: drag.origStart, inFrame: drag.origInFrame, outFrame: drag.origOutFrame };
      const thresholdFrames = e.altKey ? 0 : Math.max(1, Math.round(8 / Math.max(pxPerFrame, 0.01)));
      const targets = collectSnapTargets({
        playhead: scrubFrame,
        tracks: [segmentsRef.current.body, segmentsRef.current.head, segmentsRef.current.audio],
        ignoreId: drag.id,
      });

      let patch: Partial<Segment>;
      let snappedTo: number | null = null;
      if (drag.mode === "move") {
        const length = segLength(orig);
        const snapped = snapClipStart(drag.origStart + deltaFrames, length, targets, thresholdFrames);
        snappedTo = snapped.snappedTo;
        patch = { start: placeInFreeSlot(others, snapped.start, length) };
      } else if (drag.edge === "in") {
        let shift = deltaFrames;
        const snapped = snapEdgeFrame(drag.origStart + shift, targets, thresholdFrames);
        if (snapped.snappedTo != null) {
          shift = snapped.frame - drag.origStart;
          snappedTo = snapped.snappedTo;
        }
        shift = clampTrim({ edge: "in", seg: orig, others, shift, sourceFrameCount: srcFrameCount });
        patch = trimPatch(orig, "in", shift);
      } else {
        let shift = deltaFrames;
        const origEnd = trackSegEnd(orig);
        const snapped = snapEdgeFrame(origEnd + 1 + shift, targets, thresholdFrames);
        if (snapped.snappedTo != null) {
          shift = snapped.frame - 1 - origEnd;
          snappedTo = snapped.snappedTo;
        }
        shift = clampTrim({ edge: "out", seg: orig, others, shift, sourceFrameCount: srcFrameCount });
        patch = trimPatch(orig, "out", shift);
      }
      setSnapGuide(snappedTo);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (setter as any)((prev: Segment[]) => prev.map((s) => (s.id === drag.id ? { ...s, ...patch } : s)));
    }
    function onUp() {
      if (dragSegRef.current) {
        dragSegRef.current = null;
        setSnapGuide(null);
        commitGesture();
        forceDragTick((t) => t + 1);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxFrames, shotsById, scrubFrame]);

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
    const list = listOf(selectedSegment.track);
    const seg = list.find((s) => s.id === selectedSegment.id);
    return seg ? { track: selectedSegment.track, seg } : null;
  }

  function deleteSelected(ripple = false) {
    const sel = selectedSeg();
    if (!sel) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (setterOf(sel.track) as any)((prev: Segment[]) => (ripple ? rippleDelete(prev, sel.seg.id) : prev.filter((s) => s.id !== sel.seg.id)));
    setSelectedSegment(null);
  }

  function copySelected() {
    const sel = selectedSeg();
    if (sel) clipboardRef.current = { track: sel.track, seg: sel.seg };
  }

  function cutSelected() {
    copySelected();
    deleteSelected(false);
  }

  /** Paste (or duplicate) the clipboard clip on its own track at `at`, in the nearest free slot. */
  function pasteClipboard(at?: number) {
    const clip = clipboardRef.current;
    if (!clip) return;
    const length = segLength(clip.seg);
    const where = at ?? scrubFrame;
    const newId = genSegId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (setterOf(clip.track) as any)((prev: Segment[]) => {
      const start = placeInFreeSlot(prev, where, length);
      return [...prev, { ...clip.seg, id: newId, start }];
    });
    setSelectedSegment({ track: clip.track, id: newId });
  }

  function duplicateSelected() {
    const sel = selectedSeg();
    if (!sel) return;
    clipboardRef.current = { track: sel.track, seg: sel.seg };
    pasteClipboard(segEnd(sel.seg) + 1);
  }

  function bladeAtPlayhead() {
    const curBody = segmentsRef.current.body;
    const curHead = segmentsRef.current.head;
    const curAudio = segmentsRef.current.audio;
    const frame = scrubFrame;
    const straddles = (seg: Segment) => frame > seg.start && frame <= segEnd(seg);

    const targets = new Set<string>();
    const sel = selectedRef.current;
    if (sel) {
      const picked = segmentsRef.current[sel.track].find((seg) => seg.id === sel.id);
      if (picked && straddles(picked)) targets.add(picked.id);
    }
    if (targets.size === 0) {
      for (const seg of curBody) if (straddles(seg)) targets.add(seg.id);
      for (const seg of curHead) if (straddles(seg)) targets.add(seg.id);
      for (const seg of curAudio) if (straddles(seg)) targets.add(seg.id);
    }
    if (targets.size === 0) return;

    const newIds = new Map<string, string>();
    for (const id of targets) newIds.set(id, genSegId());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const splitter = (prev: any[]) => prev.flatMap((seg: any) => {
      if (!targets.has(seg.id)) return [seg];
      return splitSegment(seg, frame, newIds.get(seg.id) as string) ?? [seg];
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBodySegments(splitter as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setHeadSegments(splitter as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setAudioSegments(splitter as any);

    if (sel && targets.has(sel.id)) setSelectedSegment({ track: sel.track, id: newIds.get(sel.id) as string });
  }

  function trimSelectedEdge(edge: "in" | "out") {
    const sel = selectedSeg();
    if (!sel) return;
    const seg = sel.seg;
    const end = segEnd(seg);
    if (edge === "in") {
      if (scrubFrame < seg.start || scrubFrame >= end) return;
      const patch = trimPatch(seg, "in", scrubFrame - seg.start);
      editTrack(sel.track, (list) => list.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
    } else {
      if (scrubFrame <= seg.start || scrubFrame > end) return;
      const patch = trimPatch(seg, "out", scrubFrame - end);
      editTrack(sel.track, (list) => list.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)));
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
    editTrack(track, (list) => list.filter((s) => s.id !== id));
    setSelectedSegment(null);
    setCtxMenu(null);
  }
  function ctxCopy() {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    const seg = listOf(track).find((s) => s.id === id);
    if (seg) clipboardRef.current = { track, seg };
    setCtxMenu(null);
  }
  function ctxSplit() {
    bladeAtPlayhead();
    setCtxMenu(null);
  }
  function ctxDuplicate() {
    duplicateSelected();
    setCtxMenu(null);
  }
  function ctxRipple() {
    deleteSelected(true);
    setCtxMenu(null);
  }
  function listOf(track: TrackName): Segment[] {
    return track === "body" ? bodySegments : track === "head" ? headSegments : audioSegments;
  }
  function setterOf(track: TrackName) {
    return track === "body" ? setBodySegments : track === "head" ? setHeadSegments : setAudioSegments;
  }
  function editTrack(track: TrackName, fn: (list: Segment[]) => Segment[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (setterOf(track) as any)(fn);
    setSaved(false);
  }
  function talkShotForSegment(track: TrackName, id: string): ShotInfo | null {
    if (track !== "head") return null;
    const seg = headSegments.find((s) => s.id === id);
    return (seg && talkShots.find((s) => s.id === seg.shotId && s.talk)) || null;
  }
  function ctxRedoClip(engine: "grok" | "ltx") {
    if (!ctxMenu) return;
    const talk = talkShotForSegment(ctxMenu.track, ctxMenu.id)?.talk;
    setCtxMenu(null);
    if (talk) void handleRedoTalkClip(talk.group, talk.index, engine);
  }
  function ctxUndoClipRedo() {
    if (!ctxMenu) return;
    const talk = talkShotForSegment(ctxMenu.track, ctxMenu.id)?.talk;
    setCtxMenu(null);
    if (talk) void handleUndoRedoClip(talk.group, talk.index);
  }
  function ctxSetSpeed(speed: number) {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    editTrack(track, (list) => applySpeed(list, id, speed));
    setCtxMenu(null);
  }
  function ctxCustomSpeed() {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    const seg = listOf(track).find((s) => s.id === id);
    const answer = window.prompt("Speed for this clip only (1 = normal, 2 = twice as fast, 0.5 = half speed)", String(seg?.speed ?? 1));
    setCtxMenu(null);
    if (answer == null) return;
    const value = Number(answer.replace(/x$/i, "").trim());
    if (!Number.isFinite(value) || value <= 0) return;
    editTrack(track, (list) => applySpeed(list, id, value));
  }
  function ctxReverse() {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    editTrack(track, (list) => list.map((s) => (s.id === id ? { ...s, reverse: s.reverse ? undefined : true } : s)));
    setCtxMenu(null);
  }
  function ctxRepeat(pingPong: boolean) {
    if (!ctxMenu) return;
    const { track, id } = ctxMenu;
    const answer = window.prompt(
      pingPong
        ? "How many extra back-and-forth copies? (each one plays the clip the other way round)"
        : "How many extra copies after this clip?",
      "3"
    );
    setCtxMenu(null);
    if (answer == null) return;
    const times = Math.floor(Number(answer));
    if (!Number.isFinite(times) || times < 1) return;
    editTrack(track, (list) => repeatSegment(list, id, times, genSegId, pingPong).segments);
  }
  function ctxPaste() {
    pasteClipboard();
    setCtxMenu(null);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === "b") { e.preventDefault(); bladeAtPlayhead(); return; }
      if (ctrl && key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (ctrl && key === "y") { e.preventDefault(); redo(); return; }
      if (ctrl && key === "c") { e.preventDefault(); copySelected(); return; }
      if (ctrl && key === "x") { e.preventDefault(); cutSelected(); return; }
      if (ctrl && key === "v") { e.preventDefault(); pasteClipboard(); return; }
      if (ctrl && key === "d") { e.preventDefault(); duplicateSelected(); return; }
      if (key === "delete" || key === "backspace") { e.preventDefault(); deleteSelected(e.shiftKey); return; }
      if (ctrl || e.altKey) return;
      if (key === "i") { e.preventDefault(); trimSelectedEdge("in"); return; }
      if (key === "o") { e.preventDefault(); trimSelectedEdge("out"); return; }
      if (key === " ") { e.preventDefault(); handlePlay(); return; }
      if (key === "arrowleft") { e.preventDefault(); if (!playing) setScrubFrame((f) => Math.max(1, f - (e.shiftKey ? 10 : 1))); return; }
      if (key === "arrowright") { e.preventDefault(); if (!playing) setScrubFrame((f) => Math.min(maxFrames, f + (e.shiftKey ? 10 : 1))); return; }
      if (key === "home") { e.preventDefault(); if (!playing) setScrubFrame(1); return; }
      if (key === "end") { e.preventDefault(); if (!playing) setScrubFrame(maxFrames); return; }
      if (key === "escape") { setSelectedSegment(null); setCtxMenu(null); }
    }
    // Close context menu on click outside
    function onClickAnywhere() { setCtxMenu(null); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClickAnywhere);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("mousedown", onClickAnywhere); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSegment, bodySegments, headSegments, audioSegments, scrubFrame, playing, maxFrames]);

  const playheadPct = `${((scrubFrame - 1) / Math.max(maxFrames - 1, 1)) * 100}%`;

  // ── Grok shot creator ──
  const [grokType, setGrokType] = useState<GrokShotType>("body");
  const [grokPrompt, setGrokPrompt] = useState("");
  const [grokDuration, setGrokDuration] = useState(6);
  const [grokBusy, setGrokBusy] = useState(false);
  const [grokMsg, setGrokMsg] = useState("");
  const [grokRefShotId, setGrokRefShotId] = useState(""); // "" = character reference
  const [grokRefFile, setGrokRefFile] = useState<File | null>(null); // custom uploaded ref image
  const [grokContinue, setGrokContinue] = useState(false); // start from the ref shot's last frame

  async function handleGrokCreate() {
    if (!grokPrompt.trim()) return;
    setGrokBusy(true);
    setGrokMsg("");
    try {
      const continueFrom = grokContinue && !grokRefFile && grokRefShotId ? grokRefShotId : "";
      let refBase64: string | undefined;
      if (grokRefFile) {
        refBase64 = await blobToBase64(grokRefFile);
      } else if (grokRefShotId && !grokContinue) {
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
            prompt: grokShotPrompt(grokType, grokPrompt),
            shotType: grokType,
            background: "green",
            duration: grokDuration,
            ...(continueFrom
              ? { continueShotId: continueFrom }
              : refBase64 ? { refBase64 } : charRefRel ? { refRel: charRefRel } : {}),
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setGrokMsg(data.error || "Failed to create shot");
      } else {
        const data = await res.json();
        setGrokMsg(`Creating ${grokType === "full" ? "full body" : grokType} shot "${data.shotId}"${continueFrom ? ` from the last frame of "${continueFrom}"` : ""} — will appear when ready`);
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
        setAudioSegments((prev) => prev.filter((s) => s.shotId !== shotId));
        await reloadShots();
      } else {
        const body = await res.text();
        alert(`Delete failed (${res.status}): ${body}`);
      }
    } catch (err) {
      alert(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Re-key a shot's background in place (fixes black/dark backgrounds
  // left over from an older, less robust keyer — no Grok call needed) ──
  const [reprocessingShotId, setReprocessingShotId] = useState<string | null>(null);
  const [reprocessAllBusy, setReprocessAllBusy] = useState(false);
  const [reprocessMsg, setReprocessMsg] = useState("");

  function bumpMediaVersion(shotId: string) {
    setMediaVersion((prev) => ({ ...prev, [shotId]: (prev[shotId] || 0) + 1 }));
  }

  async function handleReprocessShot(shotId: string) {
    setReprocessingShotId(shotId);
    setReprocessMsg("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/${encodeURIComponent(shotId)}/reprocess`,
        { method: "POST" }
      );
      if (res.ok) {
        bumpMediaVersion(shotId);
        await reloadShots();
      } else {
        const data = await res.json().catch(() => ({ error: "Reprocess failed" }));
        alert(`Fix background failed: ${data.error || res.status}`);
      }
    } catch (err) {
      alert(`Fix background error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setReprocessingShotId(null);
  }

  async function handleReprocessAll() {
    if (!confirm("Re-key every body/head shot's background? This re-reads already-captured frames (no new Grok generations) and may take a minute per shot.")) return;
    setReprocessAllBusy(true);
    setReprocessMsg("");
    try {
      const res = await workerFetch(
        `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/shots/reprocess-all`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = await res.json();
        const results: Array<{ shotId: string; ok: boolean }> = data.results || [];
        for (const r of results) if (r.ok) bumpMediaVersion(r.shotId);
        const failed = results.filter((r) => !r.ok).length;
        setReprocessMsg(failed
          ? `Fixed ${results.length - failed} of ${results.length} shots — ${failed} failed.`
          : `Fixed backgrounds on ${results.length} shot${results.length === 1 ? "" : "s"}.`);
        await reloadShots();
      } else {
        const data = await res.json().catch(() => ({ error: "Reprocess failed" }));
        setReprocessMsg(data.error || "Failed");
      }
    } catch (err) {
      setReprocessMsg(err instanceof Error ? err.message : "Failed");
    }
    setReprocessAllBusy(false);
  }

  const importRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importType, setImportType] = useState<GrokShotType>("body");

  async function handleImportFile(file: File, shotType: GrokShotType) {
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
  const bodyCats = new Set(["idle_stand", "walks", "mic"]);
  const headCats = new Set(["expressions", "head_moves", "mouth_tongue"]);
  const bodyShots = shots.filter((s) => s.shotType === "body" || (!s.shotType && bodyCats.has(s.category || "")));
  const headShots = shots.filter((s) => !s.talk && (s.shotType === "head" || (!s.shotType && headCats.has(s.category || ""))));
  const fullShots = shots.filter((s) => s.shotType === "full");
  const combinedShots = shots.filter((s) => s.shotType === "combined");
  // Shots that don't match any category go into body by default
  const uncategorized = shots.filter((s) => !s.shotType && !bodyCats.has(s.category || "") && !headCats.has(s.category || "") && s.shotType !== "combined");
  const bodyWithUncategorized = [...bodyShots, ...uncategorized];
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
    <div className="flex min-h-0 flex-1 select-none flex-col [&_input]:select-text [&_textarea]:select-text" onDragStart={(e) => { if ((e.target as HTMLElement).tagName === "IMG") e.preventDefault(); }}>
      <div className="flex min-h-0 flex-1">
        {/* ══════════ LEFT SIDEBAR — Media Bins + Grok ══════════ */}
        <div className={`shrink-0 bg-[#131313] transition-all ${mediaPanelOpen ? "" : "w-0 overflow-hidden"}`} style={mediaPanelOpen ? { width: sidebarWidth } : undefined}>
          <div className="flex h-full flex-col overflow-y-auto">
            {/* Import clip */}
            <div className="flex items-center gap-2 border-b border-[#222] px-3 py-2">
              <input ref={importRef} type="file" accept="video/*,.mp4,.mov,.webm" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f, importType); }} />
              <select className="rounded border border-studio-border bg-studio-raised px-1.5 py-1 text-[12px] text-neutral-200"
                value={importType} onChange={(e) => setImportType(e.target.value as GrokShotType)}>
                <option value="body">Body clip</option>
                <option value="head">Head clip</option>
                <option value="full">Full body clip</option>
              </select>
              <button type="button"
                className="rounded bg-blue-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                disabled={importBusy}
                onClick={() => importRef.current?.click()}>
                {importBusy ? "Importing…" : "📁 Import Clip"}
              </button>
              <button type="button"
                className="rounded bg-neutral-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-neutral-600 disabled:opacity-40"
                disabled={reprocessAllBusy}
                title="Re-key every shot's background from its already-captured frames — no new Grok generations"
                onClick={() => void handleReprocessAll()}>
                {reprocessAllBusy ? "Fixing…" : "🩹 Fix All Backgrounds"}
              </button>
            </div>
            <div className="flex items-center gap-2 border-b border-[#222] px-3 py-2">
              <button type="button"
                className="rounded bg-neutral-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-neutral-600"
                data-testid="dialogue-audio-open"
                title="Import the real recording of this character's lines, pick the parts he speaks, and make talking heads for them"
                onClick={() => setDialogueOpen(true)}>
                🎙 Dialogue audio…
              </button>
            </div>
            {reprocessMsg ? (
              <p className={`border-b border-[#222] px-3 py-1 text-[11px] font-medium ${/fail/i.test(reprocessMsg) ? "text-red-400" : "text-emerald-300"}`}>{reprocessMsg}</p>
            ) : null}

            {/* Full Body Shots bin: head and body together, no head rig needed */}
            <MediaBin
              title="Full Body Shots"
              shots={fullShots}
              project={project} characterId={characterId} mediaVersion={mediaVersion}
              reprocessingShotId={reprocessingShotId}
              onAdd={(s) => addToTrack("body", s)} onDelete={handleDeleteShot} onReprocess={handleReprocessShot}
              onClipMenu={openTalkMenu}
            />

            {/* Body Shots bin */}
            <MediaBin
              title="Body Shots"
              shots={bodyWithUncategorized}
              project={project} characterId={characterId} mediaVersion={mediaVersion}
              reprocessingShotId={reprocessingShotId}
              onAdd={(s) => addToTrack("body", s)} onDelete={handleDeleteShot} onReprocess={handleReprocessShot}
              onClipMenu={openTalkMenu}
            />

            {/* Head Shots bin */}
            <MediaBin
              title="Head Shots"
              shots={headShots}
              project={project} characterId={characterId} mediaVersion={mediaVersion}
              reprocessingShotId={reprocessingShotId}
              onAdd={(s) => addToTrack("head", s)} onDelete={handleDeleteShot} onReprocess={handleReprocessShot}
              onClipMenu={openTalkMenu}
            />

            {talkShots.length > 0 && (
              <LtxSection
                shots={talkShots}
                project={project} characterId={characterId} mediaVersion={mediaVersion}
                busyGroup={talkBusy}
                onAdd={(s) => addToTrack("head", s)}
                onPlace={(g) => placeTalkGroup(g)}
                onPlaceAtAudio={(g) => placeTalkGroup(g, true)}
                onResume={(g) => void handleResumeTalk(g)}
                onStop={(g) => void handleStopTalk(g)}
                onClipMenu={openTalkMenu}
                onDelete={handleDeleteShot}
              />
            )}

            {/* Grok Creator — collapsible */}
            <GrokSection
              grokType={grokType} setGrokType={setGrokType}
              grokDuration={grokDuration} setGrokDuration={setGrokDuration}
              grokRefShotId={grokRefShotId} setGrokRefShotId={setGrokRefShotId}
              grokRefFile={grokRefFile} setGrokRefFile={setGrokRefFile}
              grokContinue={grokContinue} setGrokContinue={setGrokContinue}
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                <span key={key} className="relative inline-flex">
                  <button
                    type="button"
                    data-testid={`rig-key-${key}`}
                    className={`rounded px-2 py-1 text-[11px] ${rigKey === key ? "bg-[#e0a040] text-black font-semibold" : "bg-studio-raised text-neutral-400 hover:text-white"}`}
                    onClick={() => setRigKey(key)}
                  >
                    {key}
                  </button>
                  <button
                    type="button"
                    data-testid={`rig-delete-${key}`}
                    className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold leading-none text-white shadow hover:bg-red-500"
                    title={`Delete the saved "${key}" timeline`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete the saved "${key}" timeline? This removes that saved layout from this character and cannot be undone. Your clips and shots are not deleted.`)) void handleDeleteRig(key);
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Canvas preview */}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-[#0a0a0a] p-3">
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                className="rounded-md border border-studio-border"
                style={{ cursor: selectedSegment?.track === "body" && editingBody ? "move" : editingHead ? "crosshair" : "default", width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                onMouseDown={onCanvasMouseDown}
                onMouseMove={onCanvasMouseMove}
                onMouseUp={onCanvasMouseUp}
                onMouseLeave={onCanvasMouseUp}
                onWheel={onCanvasWheel}
              />
            </div>
            <p className="mt-1 shrink-0 text-[12px] text-studio-muted">
              {selectedSegment?.track === "body"
                ? "Body clip selected · Drag = shift it (head goes with it) · Scroll or Body size = resize"
                : editingHead
                  ? "Drag head = move · Corner handles = scale · Scroll = resize"
                  : "Select a head segment to reposition it"}
            </p>
            <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-2 text-[12px]" data-testid="body-size-bar">
              <span className="text-studio-muted">Body size</span>
              <input
                type="range"
                data-testid="body-size-slider"
                min={BODY_SCALE_MIN * 100}
                max={BODY_SCALE_MAX * 100}
                step={1}
                disabled={!editingBody}
                value={Math.round(bodyUserScale(editingBody) * 100)}
                onChange={(e) => editingBody && setBodyScale(editingBody.id, Number(e.target.value) / 100)}
                className="w-40"
                title="Resize this body clip around its neck, so the head stays where it is and keeps its own size."
              />
              <span className="w-10 text-right font-mono text-neutral-300" data-testid="body-size-value">
                {Math.round(bodyUserScale(editingBody) * 100)}%
              </span>
              <button
                type="button"
                data-testid="body-size-reset"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingBody || bodyUserScale(editingBody) === 1}
                onClick={() => editingBody && setBodyScale(editingBody.id, 1)}
              >
                Reset
              </button>
              <button
                type="button"
                data-testid="body-size-all"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingBody || bodySegments.length < 2}
                onClick={() => editingBody && setBodyScale(editingBody.id, bodyUserScale(editingBody), true)}
                title="Give every body clip on the timeline this size"
              >
                Same for all body clips
              </button>
              <label className="flex items-center gap-1 text-neutral-300" title="Draw this body clip over the head, e.g. so hands pointing at the eyes are in front of the face">
                <input
                  type="checkbox"
                  data-testid="body-front-toggle"
                  disabled={!editingBody}
                  checked={editingBody?.bodyInFront === true}
                  onChange={(e) => editingBody && setBodyInFront(editingBody.id, e.target.checked)}
                />
                Body in front of head
              </label>
              <button
                type="button"
                data-testid="body-front-all"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingBody || bodySegments.length < 2}
                onClick={() => editingBody && setBodyInFront(editingBody.id, editingBody.bodyInFront === true, true)}
                title="Give every body clip the same front/back order as this one"
              >
                Same for all
              </button>
            </div>
            <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-2 text-[12px]" data-testid="body-position-bar">
              <span className="text-studio-muted">Body position</span>
              {([
                ["up", "\u25B2", 0, -1, "Shift the body up (the head goes with it). Shift-click = bigger step"],
                ["down", "\u25BC", 0, 1, "Shift the body down"],
                ["left", "\u25C0", -1, 0, "Shift the body left"],
                ["right", "\u25B6", 1, 0, "Shift the body right"],
              ] as const).map(([name, label, dx, dy, title]) => (
                <button
                  key={name}
                  type="button"
                  data-testid={`body-shift-${name}`}
                  className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                  disabled={!editingBody}
                  title={title}
                  onClick={(e) => {
                    if (!editingBody) return;
                    const step = e.shiftKey ? 0.05 : 0.01;
                    const off = bodyOffset(editingBody);
                    setBodyOffset(editingBody.id, off.x + dx * step, off.y + dy * step);
                  }}
                >
                  {label}
                </button>
              ))}
              <span className="font-mono text-neutral-300" data-testid="body-shift-value">
                {Math.round(bodyOffset(editingBody).x * 100)}% , {Math.round(bodyOffset(editingBody).y * 100)}%
              </span>
              <button
                type="button"
                data-testid="body-shift-reset"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingBody || (bodyOffset(editingBody).x === 0 && bodyOffset(editingBody).y === 0)}
                onClick={() => editingBody && setBodyOffset(editingBody.id, 0, 0)}
              >
                Reset position
              </button>
              <button
                type="button"
                data-testid="body-shift-all"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingBody || bodySegments.length < 2}
                onClick={() => {
                  if (!editingBody) return;
                  const off = bodyOffset(editingBody);
                  setBodyOffset(editingBody.id, off.x, off.y, true);
                }}
                title="Give every body clip this position"
              >
                Same for all body clips
              </button>
              <label className="flex items-center gap-1 text-neutral-300" title="Dotted line along the bottom of the body frame (white). If the body is shifted or resized, a second amber line shows where its bottom edge now is.">
                <input
                  type="checkbox"
                  data-testid="ground-line-toggle"
                  checked={showGround}
                  onChange={(e) => setShowGround(e.target.checked)}
                />
                Ground line
              </label>
            </div>
            <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-2 text-[12px]" data-testid="head-follow-bar">
              <span className="text-studio-muted">Head follows body</span>
              <input
                type="range"
                data-testid="head-follow-slider"
                min={0}
                max={150}
                step={5}
                disabled={!editingHead}
                value={Math.round(clampFollow(editingHead?.followBody) * 100)}
                onChange={(e) => editingHead && setHeadFollow(editingHead.id, Number(e.target.value) / 100)}
                className="w-40"
                title="Make this head clip rise and fall with the body as it walks. 0 = the head stays put. 100 = it moves exactly as much as the body. Set the head's height first, at a moment when the body is in the middle of its bob."
              />
              <span className="w-12 text-right font-mono text-neutral-300" data-testid="head-follow-value">
                {clampFollow(editingHead?.followBody) > 0 ? `${Math.round(clampFollow(editingHead?.followBody) * 100)}%` : "Off"}
              </span>
              <button
                type="button"
                data-testid="head-follow-all"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingHead || headSegments.length < 2}
                onClick={() => editingHead && setHeadFollow(editingHead.id, clampFollow(editingHead.followBody), true)}
                title="Give every head clip on the timeline this follow amount"
              >
                Same for all heads
              </button>
            </div>
            <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-2 text-[12px]" data-testid="head-standard-bar">
              <span
                data-testid="head-standard-status"
                className={headMatchInfo?.state === "match" ? "text-green-400" : "text-studio-muted"}
              >
                {headStatusText}
              </span>
              <button
                type="button"
                data-testid="head-standard-set"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!editingHead}
                onClick={() => void handleSetStandard()}
                title="Use this head's visible size as the character's standard"
              >
                {!standard || rigKey === BASE_RIG_KEY ? "Set as standard" : `Set size for ${rigKey}`}
              </button>
              <button
                type="button"
                data-testid="head-standard-fit"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!standard || !editingHead}
                onClick={() => editingHead && void handleFitHeads(editingHead.id)}
              >
                Fit to standard
              </button>
              <button
                type="button"
                data-testid="head-standard-fit-all"
                className="rounded bg-studio-raised px-2 py-0.5 text-neutral-200 hover:text-white disabled:opacity-40"
                disabled={!standard || headSegments.length === 0}
                onClick={() => void handleFitHeads()}
              >
                Fit all heads
              </button>
              {standard ? (
                <button
                  type="button"
                  className="text-neutral-500 underline hover:text-neutral-300"
                  onClick={() => void handleClearStandard()}
                >
                  Clear standard
                </button>
              ) : null}
              {headNote ? <span className="text-studio-muted">{headNote}</span> : null}
            </div>
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
            <label className="flex items-center gap-1 text-[12px] text-neutral-400" title="Play the dialogue audio of the talking-head clips while the timeline plays">
              <input type="checkbox" data-testid="head-rig-sound" checked={soundOn} onChange={(e) => setSoundOn(e.target.checked)} />
              Sound
            </label>
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
              <div className="relative h-6 flex-1 cursor-pointer select-none border-b border-[#222] bg-[#141414]" onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setDraggingPlayhead(true); scrubFromMouse(e.clientX); }}>
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
                <div className="absolute top-0" style={{ left: playheadPct, zIndex: 20, transform: "translateX(-50%)", cursor: "ew-resize" }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setDraggingPlayhead(true); }}>
                  <svg width="16" height="20" viewBox="0 0 16 20" style={{ display: "block" }}>
                    <polygon points="0,0 16,0 16,10 8,20 0,10" fill="#e03030" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="flex">
              <div className="w-[120px] shrink-0" />
              <div ref={timelineRef} className="relative flex-1">
                {snapGuide != null ? (
                  <div
                    className="pointer-events-none absolute inset-y-0 z-30 w-px bg-yellow-300"
                    style={{ left: `${((snapGuide - 1) / Math.max(maxFrames, 1)) * 100}%` }}
                    data-testid="head-rig-snap-guide"
                  />
                ) : null}
                <div style={{ marginLeft: -120 }}>
                  {/* ── BODY TRACK (V1) ── */}
                  <TrackRow
                    label="Body" code="V1" codeClass="bg-blue-600"
                    bg="#161e28" ringClass="ring-blue-500/40"
                    isSelected={(id) => selectedSegment?.track === "body" && selectedSegment.id === id}
                    segments={bodySegments}
                    maxFrames={maxFrames}
                    shotsById={shotsById}
                    project={project} characterId={characterId} mediaVersion={mediaVersion}
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
                    project={project} characterId={characterId} mediaVersion={mediaVersion}
                    onSelect={(id) => setSelectedSegment({ track: "head", id })}
                    onSegMouseDown={(e, seg, edge) => onSegmentMouseDown(e, "head", seg, edge)}
                    onContextMenu={(e, id) => handleCtxMenu(e, "head", id)}
                    playheadPct={playheadPct}
                  />
                  {/* ── DIALOGUE AUDIO (A1): the audio each talking-head clip was made from ── */}
                  <AudioLane
                    items={audioItems}
                    maxFrames={maxFrames}
                    shotsById={shotsById}
                    mediaVersion={mediaVersion}
                    wavePeaks={wavePeaks}
                    auditionSeg={auditionSeg}
                    selectedId={selectedSegment?.track === "audio" ? selectedSegment.id : null}
                    onSelect={(id) => setSelectedSegment({ track: "audio", id })}
                    onSegMouseDown={(e, id, edge) => {
                      const seg = audioSegments.find((x) => x.id === id);
                      if (seg) onSegmentMouseDown(e, "audio", seg, edge);
                    }}
                    onContextMenu={(e, id) => handleCtxMenu(e, "audio", id)}
                    onAudition={toggleAudition}
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
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Shift+Del</kbd> ripple delete</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Ctrl+C/X/V/D</kbd> copy/cut/paste at playhead/duplicate</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Ctrl+Z</kbd> undo</span>
            <span><kbd className="rounded bg-[#222] px-1.5 py-0.5 text-neutral-400">Alt</kbd> no snap</span>
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

      {talkMenu ? (
        <TalkClipMenu
          menu={talkMenu}
          busy={talkBusy !== null}
          onClose={() => setTalkMenu(null)}
          onRedo={(engine) => { const m = talkMenu; setTalkMenu(null); void handleRedoTalkClip(m.group, m.index, engine); }}
          onUndo={() => { const m = talkMenu; setTalkMenu(null); void handleUndoRedoClip(m.group, m.index); }}
          onDetails={() => { const m = talkMenu; setTalkMenu(null); setDetailsShotId(m.shotId); }}
          onErase={() => { const m = talkMenu; setTalkMenu(null); setEraseTarget({ shotId: m.shotId, frame: 1 }); }}
        />
      ) : null}

      {dialogueOpen ? (
        <DialogueAudioDialog
          project={project}
          characterId={characterId}
          made={talkShots.map((s) => ({ audioRel: s.talk?.audioRel, audioInSec: s.talk?.audioInSec }))}
          onClose={() => setDialogueOpen(false)}
          onMake={setDialogueRange}
        />
      ) : null}
      {dialogueRange ? (
        <TalkingHeadDialog
          project={project}
          characterId={characterId}
          range={dialogueRange}
          onClose={() => setDialogueRange(null)}
          onStarted={() => { setDialogueRange(null); void reloadShots(); }}
        />
      ) : null}

      {(() => {
        const detailsShot = detailsShotId ? talkShots.find((s) => s.id === detailsShotId) || null : null;
        return detailsShot ? (
          <ClipDetailsDialog
            shot={detailsShot}
            project={project}
            characterId={characterId}
            version={mediaVersion[detailsShot.id]}
            onClose={() => setDetailsShotId(null)}
          />
        ) : null;
      })()}

      {(() => {
        const eraseShot = eraseTarget ? shots.find((s) => s.id === eraseTarget.shotId) || null : null;
        return eraseTarget && eraseShot ? (
          <FrameEraseDialog
            key={eraseTarget.shotId}
            shotId={eraseShot.id}
            shotName={eraseShot.name || eraseShot.id}
            frameCount={Math.max(1, eraseShot.frameCount || 1)}
            initialFrame={eraseTarget.frame}
            project={project}
            characterId={characterId}
            mediaUrl={(rel, v) => shotMediaUrl(project, characterId, eraseShot.id, rel, v)}
            onChanged={(id) => { bumpMediaVersion(id); void reloadShots(); }}
            onClose={() => setEraseTarget(null)}
          />
        ) : null;
      })()}

      {/* ── Right-click context menu ── */}
      {ctxMenu ? (
        <div
          ref={ctxMenuRef}
          data-testid="segment-context-menu"
          className="fixed z-50 min-w-[200px] overflow-y-auto rounded border border-[#333] bg-[#1a1a1a] py-1 shadow-xl"
          style={{ left: ctxPos.x, top: ctxPos.y, maxHeight: "calc(100vh - 16px)" }}
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
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
            onClick={ctxDuplicate}>
            <span className="w-4 text-center">⧉</span> Duplicate <span className="ml-auto text-[12px] text-neutral-500">Ctrl+D</span>
          </button>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
            onClick={ctxSplit}>
            <span className="w-4 text-center">✂</span> Split at playhead <span className="ml-auto text-[12px] text-neutral-500">Ctrl+B</span>
          </button>
          <div className="my-1 h-px bg-[#333]" />
          {ctxMenu.track === "body" ? (() => {
            const seg = bodySegments.find((s) => s.id === ctxMenu.id);
            const front = seg?.bodyInFront === true;
            return (
              <>
                <button type="button" data-testid="ctx-body-front" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
                  onClick={() => { if (seg) setBodyInFront(seg.id, !front); setCtxMenu(null); }}>
                  <span className="w-4 text-center">🧍</span> {front ? "Put head in front of body" : "Put body in front of head"}
                </button>
                <div className="my-1 h-px bg-[#333]" />
              </>
            );
          })() : null}
          {(() => {
            const seg = listOf(ctxMenu.track).find((s) => s.id === ctxMenu.id);
            const current = normalizeSpeed(seg?.speed);
            return (
              <>
                <div className="px-3 pt-1 text-[11px] uppercase tracking-wide text-neutral-500">
                  Speed of this clip {current !== 1 ? `(${current}×)` : ""}
                </div>
                <div className="flex flex-wrap gap-1 px-3 py-1.5">
                  {[0.25, 0.5, 1, 2, 4].map((v) => (
                    <button key={v} type="button" data-testid={`ctx-speed-${v}`}
                      className={`rounded border px-2 py-1 text-[12px] hover:bg-[#333] ${current === v ? "border-[#e0a040] text-[#e0a040]" : "border-[#333] text-neutral-200"}`}
                      onClick={() => ctxSetSpeed(v)}>{v}×</button>
                  ))}
                  <button type="button" data-testid="ctx-speed-custom"
                    className="rounded border border-[#333] px-2 py-1 text-[12px] text-neutral-200 hover:bg-[#333]"
                    onClick={ctxCustomSpeed}>Custom…</button>
                </div>
                <button type="button" data-testid="ctx-reverse" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
                  onClick={ctxReverse}>
                  <span className="w-4 text-center">⇄</span> Reverse {seg?.reverse ? <span className="ml-auto text-[12px] text-[#e0a040]">on</span> : null}
                </button>
                <button type="button" data-testid="ctx-repeat" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
                  onClick={() => ctxRepeat(false)}>
                  <span className="w-4 text-center">⟳</span> Repeat this clip…
                </button>
                <button type="button" data-testid="ctx-pingpong" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
                  onClick={() => ctxRepeat(true)}>
                  <span className="w-4 text-center">↔</span> Ping-pong loop…
                </button>
              </>
            );
          })()}
          {ctxMenu.track !== "audio" ? (() => {
            const seg = listOf(ctxMenu.track).find((s) => s.id === ctxMenu.id);
            if (!seg) return null;
            const frame = scrubFrame >= seg.start && scrubFrame <= segEnd(seg) ? sourceFrameAt(seg, scrubFrame) : seg.inFrame;
            return (
              <>
                <div className="my-1 h-px bg-[#333]" />
                <button type="button" data-testid="ctx-erase-frames" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333]"
                  onClick={() => { setCtxMenu(null); setEraseTarget({ shotId: seg.shotId, frame }); }}
                  title="Paint away part of a frame, such as a stray hand. The picture is only hidden and can be put back.">
                  <span className="w-4 text-center">✎</span> Erase parts of frames…
                </button>
              </>
            );
          })() : null}
          {(() => {
            const clip = talkShotForSegment(ctxMenu.track, ctxMenu.id);
            if (!clip?.talk) return null;
            const engine = clip.engine || clip.talk.engine || "grok";
            const label = clip.name || `Clip ${clip.talk.index + 1}`;
            const busy = talkBusy !== null;
            const itemClass = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333] disabled:opacity-40";
            return (
              <>
                <div className="my-1 h-px bg-[#333]" />
                <div className="px-3 pt-1 text-[11px] uppercase tracking-wide text-neutral-500" data-testid="ctx-talk-label">
                  {label} · made with {engine === "ltx" ? "LTX" : "Grok"}
                </div>
                <button type="button" disabled={busy} className={itemClass} data-testid="ctx-redo-ltx" onClick={() => ctxRedoClip("ltx")}
                  title="Regenerate this clip with LTX (Comfy Cloud credits). Every copy of it on the timeline updates.">
                  <span className="w-4 text-center">🎙</span> Redo with LTX
                </button>
                <button type="button" className={itemClass} data-testid="ctx-clip-details"
                  onClick={() => { setCtxMenu(null); setDetailsShotId(clip.id); }}
                  title="See the prompt, audio range and start image this clip was made from.">
                  <span className="w-4 text-center">ⓘ</span> Details
                </button>
                {shotHasAudio(clip) ? (
                  <button type="button" className={itemClass} data-testid="ctx-add-audio"
                    onClick={() => {
                      const at = headSegments.find((x) => x.id === ctxMenu.id)?.start ?? scrubFrame;
                      setCtxMenu(null);
                      addClipAudioToLane(clip.id, at);
                    }}
                    title="Put another copy of this clip's audio on the Dialogue lane, where this clip sits.">
                    <span className="w-4 text-center">♪</span> Add its audio to Dialogue
                  </button>
                ) : null}
                <button type="button" disabled={busy} className={itemClass} data-testid="ctx-redo-grok" onClick={() => ctxRedoClip("grok")}
                  title="Regenerate this clip with Grok (Grok credits). Every copy of it on the timeline updates.">
                  <span className="w-4 text-center">🅶</span> Redo with Grok
                </button>
                {clip.hasPrevious ? (
                  <button type="button" disabled={busy} className={itemClass} data-testid="ctx-undo-redo" onClick={ctxUndoClipRedo}>
                    <span className="w-4 text-center">↩</span> Undo last redo
                  </button>
                ) : null}
              </>
            );
          })()}
          <div className="my-1 h-px bg-[#333]" />
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-[#333]"
            onClick={ctxRipple}>
            <span className="w-4 text-center">⇤</span> Ripple delete <span className="ml-auto text-[12px] text-neutral-500">Shift+Del</span>
          </button>
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

type TalkMenuState = { x: number; y: number; shotId: string; group: string; index: number; engine: string; hasPrevious: boolean };

function TalkClipMenu({ menu, busy, onClose, onRedo, onUndo, onDetails, onErase }: {
  menu: TalkMenuState;
  busy: boolean;
  onClose: () => void;
  onDetails: () => void;
  onErase: () => void;
  onRedo: (engine: "grok" | "ltx") => void;
  onUndo: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(menu.x, window.innerWidth - el.offsetWidth - margin));
    const top = Math.max(margin, Math.min(menu.y, window.innerHeight - el.offsetHeight - margin));
    setPos({ left, top });
  }, [menu.x, menu.y]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    function onAway() { onClose(); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onAway);
    window.addEventListener("blur", onAway);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onAway);
      window.removeEventListener("blur", onAway);
    };
  }, [onClose]);

  const current = menu.engine === "ltx" ? "ltx" : "grok";
  const itemClass = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-[#333] disabled:opacity-40";
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[240px] overflow-y-auto rounded border border-[#333] bg-[#1a1a1a] py-1 shadow-xl"
      style={{ left: pos.left, top: pos.top, maxHeight: "calc(100vh - 16px)" }}
      data-testid="talk-clip-menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
        Clip {menu.index + 1} · made with {current === "ltx" ? "LTX" : "Grok"}
      </p>
      <button type="button" disabled={busy} className={itemClass} data-testid="talk-menu-grok" onClick={() => onRedo("grok")}
        title="Grok moves the mouth to the exact words. It cannot hear the audio, so it is looser than LTX.">
        <span className="w-4 text-center">🅶</span> {current === "grok" ? "Redo with Grok" : "Send to Grok instead"}
      </button>
      <button type="button" disabled={busy} className={itemClass} data-testid="talk-menu-ltx" onClick={() => onRedo("ltx")}
        title="LTX lip-syncs to the audio (Comfy Cloud credits).">
        <span className="w-4 text-center">🎙</span> {current === "ltx" ? "Redo with LTX" : "Send back to LTX"}
      </button>
      <button type="button" className={itemClass} data-testid="talk-menu-details" onClick={onDetails}
        title="See the prompt, audio range and start image this clip was made from.">
        <span className="w-4 text-center">ⓘ</span> Details
      </button>
      <button type="button" className={itemClass} data-testid="talk-menu-erase" onClick={onErase}
        title="Paint away part of a frame, such as a stray hand. The picture is only hidden and can be put back.">
        <span className="w-4 text-center">✎</span> Erase parts of frames…
      </button>
      {menu.hasPrevious ? (
        <>
          <div className="my-1 h-px bg-[#333]" />
          <button type="button" disabled={busy} className={itemClass} data-testid="talk-menu-undo" onClick={onUndo}>
            <span className="w-4 text-center">↩</span> Undo last redo
          </button>
        </>
      ) : null}
    </div>
  );
}

// ── LTX sidebar section ──────────────────────────────────────────────

const TALK_STATE_LABEL: Record<string, string> = { queued: "Queued", making: "Generating", ready: "Ready", stopped: "Stopped", error: "Failed" };

/**
 * Every talking-head clip, numbered and labelled with its place in the source
 * audio. Clips are ordinary shots: nothing here deletes a whole batch, and a
 * clip only goes if you delete that clip.
 */
function LtxSection({ shots, project, characterId, mediaVersion, busyGroup, onAdd, onPlace, onPlaceAtAudio, onResume, onStop, onClipMenu, onDelete }: {
  shots: ShotInfo[];
  project: string; characterId: string;
  mediaVersion: Record<string, number>;
  busyGroup: string | null;
  onAdd: (shot: ShotInfo) => void;
  onPlace: (group: TalkGroup) => void;
  onPlaceAtAudio: (group: TalkGroup) => void;
  onResume: (group: string) => void;
  onStop: (group: string) => void;
  onClipMenu: (e: React.MouseEvent, shot: ShotInfo) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const chains = useMemo(() => orderLtxChains(groupTalkShots(shots)), [shots]);
  const byId = useMemo(() => new Map(shots.map((s) => [s.id, s])), [shots]);
  return (
    <div className="border-b border-[#222]" data-testid="ltx-section">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-semibold text-[#e0a040] hover:bg-[#222]"
        onClick={() => setOpen(!open)}>
        <span className="text-[11px] text-neutral-500">{open ? "▼" : "▶"}</span>
        LTX
        <span className="ml-auto text-[11px] font-normal text-neutral-500">{shots.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          {chains.map(({ key, audioLabel, group }) => {
            const inProgress = group.state === "making" || group.state === "queued";
            const busy = busyGroup === group.group;
            return (
              <div key={key} className="rounded border border-[#2a2a2a]" data-testid={`ltx-chain-${key}`}>
                <div className="flex items-center gap-1.5 border-b border-[#2a2a2a] px-1.5 py-1 text-[10px] text-neutral-500">
                  <span className="min-w-0 flex-1 truncate" title={audioLabel}>{audioLabel}</span>
                  {inProgress ? (
                    <span className="text-amber-300">Generating {group.readyCount}/{group.shots.length}</span>
                  ) : group.state === "stopped" ? (
                    <span className="text-red-400">Failed</span>
                  ) : null}
                  {inProgress ? (
                    <button type="button" disabled={busy} data-testid="ltx-stop"
                      className="rounded bg-red-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500 disabled:opacity-40"
                      title="Stop making the unfinished clips (finished clips are kept)"
                      onClick={() => onStop(group.group)}>■ Stop</button>
                  ) : null}
                  {group.state === "stopped" ? (
                    <button type="button" disabled={busy} data-testid="ltx-retry"
                      className="rounded bg-red-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500 disabled:opacity-40"
                      title="Continue from the clip that failed"
                      onClick={() => onResume(group.group)}>{busy ? "…" : "Retry"}</button>
                  ) : null}
                  {group.readyCount > 0 && !inProgress ? (
                    <button type="button" disabled={busy} data-testid="ltx-place"
                      className="rounded border border-studio-border px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-[#333] disabled:opacity-40"
                      title="Put this batch's clips on the head track, one after another"
                      onClick={() => onPlace(group)}>Place</button>
                  ) : null}
                  {group.readyCount > 0 && !inProgress && group.shots[0]?.talk?.audioInSec != null ? (
                    <button type="button" disabled={busy} data-testid="ltx-place-at-audio"
                      className="rounded border border-studio-border px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-[#333] disabled:opacity-40"
                      title="Put this batch on the head track at the time its audio sits in the recording, so separate lines keep the gaps between them"
                      onClick={() => onPlaceAtAudio(group)}>At audio time</button>
                  ) : null}
                </div>
                {group.shots.map((talkShot) => {
                  const full = byId.get(talkShot.id);
                  if (!full) return null;
                  const engine = full.engine || full.talk?.engine || "grok";
                  const ready = full.status === "ready";
                  return (
                    <div key={full.id} className="group relative" data-testid={`ltx-clip-${full.id}`}
                      onContextMenu={(e) => onClipMenu(e, full)}>
                      <button type="button" disabled={!ready}
                        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-[#1e1e1e] disabled:opacity-60"
                        onClick={() => onAdd(full)}
                        title={ready ? `Add "${full.name || full.id}" to the head track. Right-click to redo with LTX or Grok.` : full.error || TALK_STATE_LABEL[full.status] || full.status}>
                        <div className="h-[36px] w-[64px] shrink-0 overflow-hidden rounded bg-[#0a0a0a]">
                          <img src={shotMediaUrl(project, characterId, full.id, "poster.jpg", mediaVersion[full.id])} alt=""
                            className="h-full w-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-medium text-neutral-200" data-testid="ltx-clip-name">{full.name || full.id}</p>
                          <p className={`text-[11px] ${full.status === "error" ? "text-red-400" : ready ? "text-neutral-500" : "text-amber-300"}`}>
                            {ready ? `${(full.talk?.windowSec ?? 0).toFixed(1)}s` : TALK_STATE_LABEL[full.status] || full.status}
                            {" · "}{engine === "ltx" ? "LTX" : "Grok"}
                            {full.hasPrevious ? " · has undo" : ""}
                          </p>
                        </div>
                      </button>
                      <button type="button"
                        className="absolute right-6 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded bg-neutral-700 text-[11px] text-neutral-200 hover:bg-neutral-500 group-hover:flex"
                        title="Redo with LTX or Grok"
                        data-testid={`ltx-menu-${full.id}`}
                        onClick={(e) => { e.stopPropagation(); onClipMenu(e, full); }}>⋯</button>
                      <button type="button"
                        className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white hover:bg-red-500 group-hover:flex"
                        title="Delete this clip"
                        onClick={(e) => { e.stopPropagation(); onDelete(full.id); }}>✕</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Grok sidebar section ─────────────────────────────────────────────

type GrokShotType = "body" | "head" | "full";

function grokShotPrompt(type: GrokShotType, text: string): string {
  const prompt = text.trim();
  if (type === "full") {
    return `${prompt}, the whole character in frame from head to feet, head and face fully visible, same character as the reference, nothing cut off`;
  }
  if (type === "body") {
    return `${prompt}, body only from neck down, show full neck and shoulders, no head, no face, cut off at the neck, the head is a separate layer`;
  }
  return `${prompt}, head only from jawline up, no neck, no shoulders, no body, close-up head and face only, cut off cleanly at the jaw`;
}

function GrokSection({ grokType, setGrokType, grokDuration, setGrokDuration, grokRefShotId, setGrokRefShotId, grokRefFile, setGrokRefFile, grokContinue, setGrokContinue, grokPrompt, setGrokPrompt, grokBusy, grokMsg, allShots, onCreate, project, characterId }: {
  grokType: GrokShotType; setGrokType: (v: GrokShotType) => void;
  grokDuration: number; setGrokDuration: (v: number) => void;
  grokRefShotId: string; setGrokRefShotId: (v: string) => void;
  grokRefFile: File | null; setGrokRefFile: (v: File | null) => void;
  grokContinue: boolean; setGrokContinue: (v: boolean) => void;
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
              value={grokType} onChange={(e) => setGrokType(e.target.value as GrokShotType)}>
              <option value="body">Body</option>
              <option value="head">Head</option>
              <option value="full">Full body</option>
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
          {grokRefShotId && !grokRefFile && (
            <div className="flex overflow-hidden rounded border border-studio-border text-[11px]" data-testid="grok-start-frame">
              <button type="button" data-testid="grok-start-first"
                className={`flex-1 px-2 py-1 ${!grokContinue ? "bg-studio-accent/20 text-studio-accent" : "bg-studio-raised text-neutral-400 hover:bg-[#333]"}`}
                onClick={() => setGrokContinue(false)}>
                Start from its poster
              </button>
              <button type="button" data-testid="grok-start-last"
                title="Grok starts from the final frame of that shot, so the new clip carries on from where it stopped"
                className={`flex-1 border-l border-studio-border px-2 py-1 ${grokContinue ? "bg-studio-accent/20 text-studio-accent" : "bg-studio-raised text-neutral-400 hover:bg-[#333]"}`}
                onClick={() => setGrokContinue(true)}>
                Continue from last frame
              </button>
            </div>
          )}
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
            placeholder={grokContinue && grokRefShotId && !grokRefFile ? "what happens next…" : grokType === "body" ? "body prompt…" : grokType === "full" ? "full body prompt…" : "head prompt…"}
            value={grokPrompt} onChange={(e) => setGrokPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onCreate(); }} />
          <button type="button"
            className="w-full rounded bg-studio-accent px-2 py-1.5 text-[12px] font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            disabled={grokBusy || !grokPrompt.trim()} onClick={onCreate}>
            {grokBusy ? "Creating…" : `Create ${grokType === "full" ? "full body" : grokType} shot`}
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
  label, code, codeClass, bg, ringClass, segments, maxFrames, shotsById, project, characterId, mediaVersion,
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
  mediaVersion: Record<string, number>;
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
              className={`absolute inset-y-0 cursor-move select-none overflow-hidden rounded-sm border ${selected ? `border-[#e0a040] ring-1 ring-inset ${ringClass}` : "border-black/40"}`}
              style={{ left, width, zIndex: selected ? 6 : 2 }}
              onMouseDown={(e) => onSegMouseDown(e, seg)}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onSelect(seg.id); }}
              onContextMenu={(e) => { if (onContextMenu) onContextMenu(e, seg.id); }}
              title={`${shot?.name || seg.shotId} · frames ${seg.inFrame}-${seg.outFrame}${seg.speed && seg.speed !== 1 ? ` · ${seg.speed}×` : ""}${seg.reverse ? " · reversed" : ""}`}
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
                    const srcFrame = sourceFrameAt(seg, seg.start + Math.min(i * step, len - 1));
                    const pad = String(srcFrame).padStart(4, "0");
                    return (
                      <img key={i} src={shotMediaUrl(project, characterId, seg.shotId, `cut/f_${pad}.png`, mediaVersion[seg.shotId])} alt=""
                        draggable={false}
                        className="pointer-events-none h-full shrink-0 select-none object-cover" style={{ width: `${100 / count}%`, background: "#0a0a0a" }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    );
                  });
                })()}
              </div>
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5">
                <span className="text-[11px] font-medium text-neutral-200">{shot?.name || seg.shotId}</span>
                {seg.speed && seg.speed !== 1 ? <span className="ml-1 rounded bg-black/70 px-1 text-[10px] font-bold text-[#e0a040]">{seg.speed}×</span> : null}
                {seg.reverse ? <span className="ml-1 rounded bg-black/70 px-1 text-[10px] font-bold text-[#e0a040]">⇄</span> : null}
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

// ── Clip details ────────────────────────────────────────────────────

function ClipDetailsDialog({ shot, project, characterId, version, onClose }: {
  shot: ShotInfo;
  project: string;
  characterId: string;
  version?: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [startRel, setStartRel] = useState<"ltx_start.png" | "start_frame.png" | null>("ltx_start.png");
  const text = clipDetailsText(shot);
  const closedMouth = promptSaysMouthClosed(shot.prompt);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose} data-testid="clip-details">
      <div
        className="flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-lg border border-[#333] bg-[#161616] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-4 py-2.5">
          <div className="text-sm font-semibold text-neutral-100">{shot.name || shot.id} · details</div>
          <button type="button" className="text-sm text-neutral-400 hover:text-white" onClick={onClose}>Close</button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {closedMouth ? (
            <p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200" data-testid="clip-details-warning">
              This prompt tells the character to keep the mouth closed: no transcript words were found for this window. If the audio does have speech here, the transcript timing is off.
            </p>
          ) : null}
          <pre className="whitespace-pre-wrap break-words rounded bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-neutral-200" data-testid="clip-details-text">{text}</pre>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">Audio of this clip</div>
              <audio controls preload="none" className="w-full" src={shotMediaUrl(project, characterId, shot.id, SHOT_AUDIO_REL, version)} data-testid="clip-details-audio" />
            </div>
            {startRel ? (
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                  {startRel === "ltx_start.png" ? "Start image sent to LTX" : "Start image"}
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={startRel}
                  src={shotMediaUrl(project, characterId, shot.id, startRel, version)}
                  alt="start image"
                  className="max-h-[180px] rounded border border-[#2a2a2a] bg-black object-contain"
                  data-testid="clip-details-start"
                  onError={() => setStartRel(startRel === "ltx_start.png" ? "start_frame.png" : null)}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#2a2a2a] px-4 py-2.5">
          <button type="button" className="rounded bg-[#2a2a2a] px-3 py-1.5 text-sm text-neutral-100 hover:bg-[#3a3a3a]" data-testid="clip-details-copy" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dialogue audio lane ─────────────────────────────────────────────

function AudioLane({
  items, maxFrames, shotsById, mediaVersion, wavePeaks, auditionSeg, selectedId, onSelect, onSegMouseDown, onContextMenu, onAudition, playheadPct,
}: {
  items: AudioLaneItem[];
  maxFrames: number;
  shotsById: Map<string, ShotInfo>;
  mediaVersion: Record<string, number>;
  wavePeaks: Record<string, { peaks: number[]; duration: number }>;
  auditionSeg: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSegMouseDown: (e: React.MouseEvent, id: string, edge?: "in" | "out") => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onAudition: (item: AudioLaneItem) => void;
  playheadPct: string;
}) {
  return (
    <div className="flex" data-testid="audio-lane">
      <div className="flex w-[120px] shrink-0 items-center gap-2 border-b border-r border-[#222] bg-[#161616] px-3 py-2">
        <span className="rounded bg-purple-600 px-1.5 py-0.5 text-[11px] font-bold text-white">A1</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-neutral-300">Dialogue</div>
          <div className="text-[11px] text-neutral-500">{items.length} piece{items.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden border-b border-[#222]" style={{ height: 52, background: "#1a1624" }}>
        {items.length === 0 ? (
          <div className="pointer-events-none flex h-full items-center px-3 text-[11px] text-neutral-600">
            Talking-head clips (LTX / Grok) put their audio here. It stays when you change the picture.
          </div>
        ) : null}
        {items.map((item) => {
          const shot = shotsById.get(item.shotId);
          const left = `${((item.start - 1) / Math.max(maxFrames, 1)) * 100}%`;
          const width = `${(item.length / Math.max(maxFrames, 1)) * 100}%`;
          const wave = wavePeaks[`${item.shotId}#${mediaVersion[item.shotId] || 0}`];
          const slice = wave ? sliceAudioPeaks(wave.peaks, wave.duration, item.fromSec, item.toSec) : [];
          const selected = selectedId === item.segId;
          const playingThis = auditionSeg === item.segId;
          const n = slice.length;
          const path = n
            ? `M0,50 ${slice.map((v, i) => `L${i},${50 - Math.max(1, v * 48)}`).join(" ")} L${n - 1},50 ${slice
                .map((v, i) => `L${n - 1 - i},${50 + Math.max(1, slice[n - 1 - i] * 48)}`)
                .join(" ")} Z`
            : "";
          return (
            <div
              key={item.segId}
              data-testid={`audio-piece-${item.segId}`}
              className={`absolute inset-y-0 select-none overflow-hidden rounded-sm border ${selected ? "border-[#e0a040]" : "border-black/40"}`}
              style={{ left, width, background: "#2b2140", zIndex: selected ? 6 : 2 }}
              title={`${shot?.name || item.shotId} audio · ${item.fromSec.toFixed(1)}–${item.toSec.toFixed(1)} s${item.reverse ? " · reversed clip: silent" : ""}${item.speed !== 1 ? ` · ${item.speed}×` : ""}`}
              onClick={(e) => { e.stopPropagation(); onSelect(item.segId); }}
              onMouseDown={(e) => onSegMouseDown(e, item.segId)}
              onContextMenu={(e) => onContextMenu(e, item.segId)}
            >
              <div
                className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-white/20 hover:bg-[#e0a040]"
                data-testid={`audio-trim-in-${item.segId}`}
                onMouseDown={(e) => onSegMouseDown(e, item.segId, "in")}
              />
              <div
                className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-white/20 hover:bg-[#e0a040]"
                data-testid={`audio-trim-out-${item.segId}`}
                onMouseDown={(e) => onSegMouseDown(e, item.segId, "out")}
              />
              {n ? (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(1, n - 1)} 100`} preserveAspectRatio="none">
                  <path d={path} fill="#b48cff" fillOpacity={item.reverse ? 0.25 : 0.85} />
                </svg>
              ) : null}
              <button
                type="button"
                data-testid={`audio-play-${item.segId}`}
                className="absolute left-1 top-1 z-10 rounded bg-black/70 px-1.5 text-[11px] text-neutral-100 hover:bg-black"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onAudition(item); }}
                title={playingThis ? "Stop" : "Hear just this piece"}
              >
                {playingThis ? "■" : "▶"}
              </button>
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 pl-8 text-[11px] text-neutral-200">
                {shot?.name || item.shotId}
              </div>
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
  title, shots, project, characterId, mediaVersion, reprocessingShotId, onAdd, onDelete, onReprocess, onClipMenu, defaultOpen = true,
}: {
  title: string;
  shots: ShotInfo[];
  project: string;
  characterId: string;
  mediaVersion: Record<string, number>;
  reprocessingShotId: string | null;
  onAdd: (s: ShotInfo) => void;
  onDelete: (id: string) => void;
  onReprocess: (id: string) => void;
  onClipMenu?: (e: React.MouseEvent, shot: ShotInfo) => void;
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
            <div key={s.id} className="group relative" onContextMenu={s.talk && onClipMenu ? (e) => onClipMenu(e, s) : undefined}>
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
                      ? shotMediaUrl(project, characterId, s.id, `cut/f_${String(hoverFrame).padStart(4, "0")}.png`, mediaVersion[s.id])
                      : shotMediaUrl(project, characterId, s.id, "poster.jpg", mediaVersion[s.id])}
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
                className="absolute -left-0.5 -top-0.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-[10px] shadow hover:bg-neutral-500 disabled:opacity-40 group-hover:flex"
                disabled={reprocessingShotId === s.id}
                onClick={(e) => { e.stopPropagation(); onReprocess(s.id); }}
                title="Fix background (re-key this shot's frames, no new Grok generation)"
              >{reprocessingShotId === s.id ? "…" : "🩹"}</button>
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
  shots, project, characterId, mediaVersion, reprocessingShotId, onAdd, onDelete, onReprocess,
}: {
  shots: ShotInfo[];
  project: string;
  characterId: string;
  mediaVersion: Record<string, number>;
  reprocessingShotId: string | null;
  onAdd: (s: ShotInfo) => void;
  onDelete: (id: string) => void;
  onReprocess: (id: string) => void;
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
              src={shotMediaUrl(project, characterId, s.id, "poster.jpg", mediaVersion[s.id])}
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
          <button
            type="button"
            disabled={reprocessingShotId === s.id}
            className="absolute -bottom-1 -left-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-bold text-white shadow hover:bg-neutral-700 disabled:opacity-60"
            onClick={(e) => { e.stopPropagation(); onReprocess(s.id); }}
            title="Fix background (re-key this shot's frames, no new Grok generation)"
          >
            {reprocessingShotId === s.id ? "…" : "🩹"}
          </button>
        </div>
      ))}
    </div>
  );
}
