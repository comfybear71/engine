"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AssetsPanel from "@/components/AssetsPanel";
import CameraDrawer from "@/components/CameraDrawer";
import PanelSplitter from "@/components/PanelSplitter";
import { LayersInspector, MarksInspector, ScriptInspector } from "@/components/StageInspectors";
import { LeftIconRail, RightIconRail, type LeftPoolId, type RightDrawerId } from "@/components/StageRails";
import TimelineLanes from "@/components/TimelineLanes";
import TransportBar from "@/components/TransportBar";
import {
  chooseVideoFile,
  createFrameCache,
  frameFromElapsedMs,
  shouldFallbackToProxy,
  webAudioSchedule,
} from "@/lib/playback";
import { clampFrameIndex, scriptLineAtFrame } from "@/lib/playhead";
import {
  DEFAULT_STAGE_LAYOUT,
  clampStageLayout,
  loadStageLayout,
  saveStageLayout,
  type StageLayout,
} from "@/lib/stageLayout";
import {
  fetchPreviewFrame,
  loadLanes,
  loadPlayback,
  loadScript,
  loadStage,
  mediaUrl,
  renderVideoUrl,
  startPreviewRender,
  type LanesResponse,
  type Mark,
  type PlaybackStatus,
  type StageInfo,
  type StageLayer,
} from "@/lib/worker";

export default function StagePanel({
  project,
  script = "script.txt",
  workerUp,
  scriptEpoch,
  selectedLine,
  onSelectLine,
  onSaved,
  renderNonce,
}: {
  project: string | null;
  script?: string;
  workerUp: boolean;
  scriptEpoch: number;
  selectedLine: number | null;
  onSelectLine: (line: number | null) => void;
  onSaved: () => void;
  renderNonce: number | null;
}) {
  const [stage, setStage] = useState<StageInfo | null>(null);
  const [lanes, setLanes] = useState<LanesResponse | null>(null);
  const [scriptText, setScriptText] = useState("");
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(1);
  const [fps, setFps] = useState(24);
  const [canvas, setCanvas] = useState({ width: 1920, height: 1080 });
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedMark, setSelectedMark] = useState<{ location: string; name: string; mark: Mark } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playback, setPlayback] = useState<PlaybackStatus | null>(null);
  const [previewStatus, setPreviewStatus] = useState<"idle" | "rendering">("idle");
  const [leftPool, setLeftPool] = useState<LeftPoolId | null>(null);
  const [rightDrawer, setRightDrawer] = useState<RightDrawerId | null>(null);
  const [layout, setLayout] = useState<StageLayout>(DEFAULT_STAGE_LAYOUT);
  const previewUrlRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playingRef = useRef(false);
  const frameRef = useRef(0);
  const userSeekRef = useRef(false);
  const playableTotalRef = useRef<number | null>(null);
  const frameCacheRef = useRef(createFrameCache());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const proxyKickRef = useRef(false);

  playingRef.current = playing;
  frameRef.current = frame;

  const videoChoice = chooseVideoFile(playback);
  const videoSrc = project && videoChoice ? renderVideoUrl(project, renderNonce || undefined, script, videoChoice.file) : null;

  useEffect(() => {
    setLayout(loadStageLayout());
  }, []);

  useEffect(() => {
    saveStageLayout(layout);
  }, [layout]);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFrame(0);
    setPlaying(false);
    setSelectedMark(null);
    playableTotalRef.current = null;
    proxyKickRef.current = false;
    frameCacheRef.current.clear();
    audioBuffersRef.current.clear();
    stopAudio();
    Promise.all([loadStage(project, script), loadLanes(project, script), loadScript(project, script)])
      .then(([info, nextLanes, text]) => {
        if (cancelled) return;
        setStage(info);
        setLanes(nextLanes);
        setScriptText(text);
        setFps(info.fps);
        setCanvas(info.canvas);
        setSceneId(info.scenes[0]?.id ?? null);
        if (playableTotalRef.current == null && nextLanes.totalFrames > 0) {
          setTotalFrames(nextLanes.totalFrames);
        }
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
  }, [project, script, workerUp, scriptEpoch]);

  useEffect(() => {
    if (!project || !workerUp) {
      setPlayback(null);
      return;
    }
    let cancelled = false;
    loadPlayback(project, script)
      .then((status) => {
        if (cancelled) return;
        setPlayback(status);
        if (proxyKickRef.current && chooseVideoFile(status)) {
          proxyKickRef.current = false;
          setPlaying(true);
        }
      })
      .catch(() => {
        if (!cancelled) setPlayback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project, script, workerUp, renderNonce, scriptEpoch, previewStatus]);

  useEffect(() => {
    if (!project || !workerUp) return;
    if (playing && videoSrc) return;
    const cached = frameCacheRef.current.get(frame);
    if (cached) {
      setPreviewUrl(cached);
      return;
    }
    const controller = new AbortController();
    const requestFrame = clampFrameIndex(frame, totalFrames);
    const timer = window.setTimeout(() => {
      const started = performance.now();
      fetchPreviewFrame(project, requestFrame, controller.signal, script)
        .then(({ blob, meta }) => {
          const url = URL.createObjectURL(blob);
          frameCacheRef.current.put(requestFrame, url);
          previewUrlRef.current = url;
          setPreviewUrl(url);
          const nextTotal = meta.totalFrames > 0 ? meta.totalFrames : totalFrames;
          if (nextTotal > 0) {
            playableTotalRef.current = nextTotal;
            setTotalFrames(nextTotal);
          }
          const served = clampFrameIndex(Number.isFinite(meta.frame) ? meta.frame : requestFrame, nextTotal);
          if (!playingRef.current && served !== frame) setFrame(served);
          if (meta.fps) setFps(meta.fps);
          if (meta.canvasWidth && meta.canvasHeight) {
            setCanvas({ width: meta.canvasWidth, height: meta.canvasHeight });
          }
          if (meta.sceneId) setSceneId(meta.sceneId);
          setError(null);
          if (playingRef.current && !videoSrc && shouldFallbackToProxy(performance.now() - started, meta.fps || fps)) {
            void kickProxyRender();
          }
        })
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          setError(err.message);
        });
    }, playing ? 0 : 80);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // kickProxyRender is stable enough via ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, script, workerUp, frame, playing, videoSrc, totalFrames, fps]);

  useEffect(() => {
    return () => {
      frameCacheRef.current.clear();
      stopAudio();
      audioCtxRef.current?.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentScene = useMemo(
    () => stage?.scenes.find((s) => s.id === sceneId) || stage?.scenes[0] || null,
    [stage, sceneId]
  );

  const locationMarks = useMemo(() => {
    if (!stage) return [] as { location: string; name: string; mark: Mark }[];
    const out: { location: string; name: string; mark: Mark }[] = [];
    const locations = currentScene?.location
      ? [currentScene.location]
      : Object.keys(stage.marksByLocation);
    for (const location of locations) {
      const marks = stage.marksByLocation[location] || {};
      for (const [name, mark] of Object.entries(marks)) {
        out.push({ location, name, mark });
      }
    }
    return out;
  }, [stage, currentScene]);

  const layers: StageLayer[] = currentScene?.layers || [];
  const maxFrame = Math.max(0, totalFrames - 1);
  const scriptLines = useMemo(() => scriptText.split("\n"), [scriptText]);
  const playheadLine = useMemo(
    () => scriptLineAtFrame(lanes?.blocks || [], frame),
    [lanes, frame]
  );
  const cameraBlocks = useMemo(
    () => (lanes?.blocks || []).filter((block) => block.lane === "camera"),
    [lanes]
  );

  const seekTo = useCallback(
    (nextFrame: number, scriptLine: number | null) => {
      const clamped = clampFrameIndex(nextFrame, totalFrames);
      setFrame(clamped);
      userSeekRef.current = true;
      const line = scriptLine ?? scriptLineAtFrame(lanes?.blocks || [], clamped);
      onSelectLine(line);
      const video = videoRef.current;
      if (video && videoSrc) {
        video.currentTime = clamped / Math.max(fps, 1);
      }
    },
    [fps, videoSrc, lanes, totalFrames, onSelectLine]
  );

  function stopAudio() {
    for (const source of audioSourcesRef.current) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    audioSourcesRef.current = [];
  }

  async function ensureAudioContext(): Promise<AudioContext | null> {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  async function loadAudioBuffers() {
    if (!project || !playback) return;
    const ctx = await ensureAudioContext();
    if (!ctx) return;
    await Promise.all(
      playback.audio
        .filter((clip) => clip.exists)
        .map(async (clip) => {
          if (audioBuffersRef.current.has(clip.rel)) return;
          try {
            const res = await fetch(mediaUrl(project, clip.rel));
            if (!res.ok) return;
            const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
            audioBuffersRef.current.set(clip.rel, buffer);
          } catch {
            /* missing or undecodable line audio */
          }
        })
    );
  }

  async function startLineAudio(fromFrame: number) {
    stopAudio();
    if (!playback) return;
    const ctx = await ensureAudioContext();
    if (!ctx) return;
    await loadAudioBuffers();
    for (const clip of playback.audio) {
      if (!clip.exists) continue;
      const buffer = audioBuffersRef.current.get(clip.rel);
      if (!buffer) continue;
      const schedule = webAudioSchedule(
        { startFrame: clip.startFrame, endFrame: clip.endFrame, durationSec: buffer.duration },
        fromFrame,
        fps,
        totalFrames
      );
      if (!schedule) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(ctx.currentTime + schedule.delaySec, schedule.offsetSec);
      audioSourcesRef.current.push(source);
    }
  }

  async function kickProxyRender() {
    if (!project || proxyKickRef.current || previewStatus === "rendering") return;
    if (playback?.proxy?.upToDate || playback?.render?.upToDate) return;
    proxyKickRef.current = true;
    setPlaying(false);
    stopAudio();
    setPreviewStatus("rendering");
    try {
      await startPreviewRender(project, script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview render failed");
      proxyKickRef.current = false;
    } finally {
      setPreviewStatus("idle");
    }
  }

  useEffect(() => {
    if (!playing) {
      stopAudio();
      const video = videoRef.current;
      if (video) video.pause();
      return;
    }
    if (videoSrc) {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = frameRef.current / Math.max(fps, 1);
      void video.play().catch(() => setPlaying(false));
      return () => {
        video.pause();
      };
    }
    let cancelled = false;
    const originMsRef = { current: performance.now() - (frameRef.current / Math.max(fps, 1)) * 1000 };
    void startLineAudio(frameRef.current);
    const prefetch = (from: number) => {
      if (!project) return;
      for (let i = 0; i < 8; i += 1) {
        const next = from + i;
        if (next > maxFrame) break;
        void frameCacheRef.current.ensure(next, async () => {
          const { blob } = await fetchPreviewFrame(project, next, undefined, script);
          return URL.createObjectURL(blob);
        });
      }
    };
    prefetch(frameRef.current);
    const tick = () => {
      if (cancelled || !playingRef.current) return;
      if (userSeekRef.current) {
        userSeekRef.current = false;
        originMsRef.current = performance.now() - (frameRef.current / Math.max(fps, 1)) * 1000;
        void startLineAudio(frameRef.current);
      }
      const next = frameFromElapsedMs(performance.now() - originMsRef.current, 0, fps, totalFrames);
      if (next !== frameRef.current) {
        setFrame(next);
        const line = scriptLineAtFrame(lanes?.blocks || [], next);
        if (line != null) onSelectLine(line);
        const url = frameCacheRef.current.get(next);
        if (url) setPreviewUrl(url);
        prefetch(next + 1);
      }
      if (next >= maxFrame) {
        setPlaying(false);
        return;
      }
      window.requestAnimationFrame(tick);
    };
    const raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      stopAudio();
    };
    // Start/stop only — frame is read from refs so scrubbing does not restart playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, videoSrc, fps, maxFrame, totalFrames]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== "Space" && event.key !== " ") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      event.preventDefault();
      if (previewStatus === "rendering") return;
      setPlaying((value) => !value);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewStatus]);

  function onVideoTimeUpdate() {
    const video = videoRef.current;
    if (!video || !playing) return;
    if (userSeekRef.current) {
      userSeekRef.current = false;
    }
    const next = Math.max(0, Math.min(maxFrame, Math.round(video.currentTime * fps)));
    setFrame(next);
    const line = scriptLineAtFrame(lanes?.blocks || [], next);
    if (line != null) onSelectLine(line);
  }

  function onRewind() {
    setPlaying(false);
    stopAudio();
    seekTo(0, scriptLineAtFrame(lanes?.blocks || [], 0));
  }

  function onStop() {
    setPlaying(false);
    stopAudio();
    seekTo(0, scriptLineAtFrame(lanes?.blocks || [], 0));
  }

  function onTogglePlay() {
    if (previewStatus === "rendering") return;
    if (!playing && frame >= maxFrame) {
      seekTo(0, scriptLineAtFrame(lanes?.blocks || [], 0));
    }
    setPlaying((value) => !value);
  }

  if (!project) {
    return <div className="flex flex-1 items-center justify-center text-sm text-studio-muted">Pick a project to open the stage.</div>;
  }

  const showVideo = Boolean(videoSrc);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="stage-workspace">
      <LeftIconRail
        active={leftPool}
        onToggle={(id) => setLeftPool((current) => (current === id ? null : id))}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {leftPool ? (
            <>
              <div
                className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-studio-border bg-studio-panel"
                style={{ width: layout.leftWidth }}
                data-testid="left-media-pool"
              >
                <AssetsPanel
                  project={project}
                  workerUp={workerUp}
                  variant="pool"
                  poolSection={leftPool}
                />
              </div>
              <PanelSplitter
                axis="x"
                label="Resize media pool"
                testId="splitter-left"
                onDrag={(delta) =>
                  setLayout((current) => clampStageLayout({ ...current, leftWidth: current.leftWidth + delta }))
                }
                onReset={() =>
                  setLayout((current) => clampStageLayout({ ...current, leftWidth: DEFAULT_STAGE_LAYOUT.leftWidth }))
                }
              />
            </>
          ) : null}

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-black/40">
            <div className="flex min-h-0 flex-1 items-center justify-center p-3">
              <div className="relative inline-block max-h-full max-w-full">
                {showVideo && videoSrc ? null : previewUrl ? (
                  // Worker-served preview PNG
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrl}
                    alt={`Frame ${frame}`}
                    className="max-h-full max-w-full rounded-sm object-contain shadow-2xl"
                  />
                ) : (
                  <div className="flex h-[280px] w-[500px] max-w-full items-center justify-center rounded-sm border border-studio-border bg-studio-raised text-sm text-studio-muted">
                    {previewStatus === "rendering"
                      ? "Rendering preview…"
                      : loading
                        ? "Parsing script…"
                        : "Waiting for preview…"}
                  </div>
                )}
                {videoSrc ? (
                  <video
                    ref={videoRef}
                    className={showVideo ? "max-h-full max-w-full rounded-sm object-contain shadow-2xl" : "hidden"}
                    src={videoSrc}
                    playsInline
                    onTimeUpdate={onVideoTimeUpdate}
                    onEnded={() => {
                      setPlaying(false);
                      seekTo(maxFrame, scriptLineAtFrame(lanes?.blocks || [], maxFrame));
                    }}
                    onError={() => {
                      setPlayback((current) =>
                        current ? { ...current, render: null, proxy: current.proxy?.file === videoChoice?.file ? null : current.proxy } : current
                      );
                      setPlaying(false);
                    }}
                  />
                ) : null}
                {previewStatus === "rendering" ? (
                  <div
                    className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-medium text-white"
                    data-testid="preview-render-overlay"
                  >
                    Rendering preview…
                  </div>
                ) : null}
                {previewUrl && selectedMark && !showVideo ? (
                  <div
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-studio-accent shadow"
                    style={{
                      left: `${(selectedMark.mark.x / canvas.width) * 100}%`,
                      top: `${(selectedMark.mark.y / canvas.height) * 100}%`,
                    }}
                    title={selectedMark.name}
                  >
                    <span className="absolute left-4 top-[-6px] whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {selectedMark.name}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            {error ? <p className="px-3 pb-1 text-xs text-red-400">{error}</p> : null}
            <TransportBar
              frame={frame}
              maxFrame={maxFrame}
              fps={fps}
              script={script}
              playing={playing}
              usingVideo={Boolean(showVideo && videoChoice?.kind === "render")}
              previewStatus={previewStatus}
              onRewind={onRewind}
              onTogglePlay={onTogglePlay}
              onStop={onStop}
            />

            {rightDrawer ? (
              <aside
                className="absolute bottom-0 right-0 top-0 z-20 flex flex-col border-l border-studio-border bg-studio-panel shadow-2xl"
                style={{ width: layout.rightWidth }}
                data-testid="right-drawer"
              >
                <div className="absolute bottom-0 left-0 top-0 -ml-1.5">
                  <PanelSplitter
                    axis="x"
                    label="Resize inspector"
                    testId="splitter-right"
                    onDrag={(delta) =>
                      setLayout((current) =>
                        clampStageLayout({ ...current, rightWidth: current.rightWidth - delta })
                      )
                    }
                    onReset={() =>
                      setLayout((current) =>
                        clampStageLayout({ ...current, rightWidth: DEFAULT_STAGE_LAYOUT.rightWidth })
                      )
                    }
                  />
                </div>
                {rightDrawer === "marks" ? (
                  <MarksInspector
                    locationLabel={currentScene?.location ? `Location ${currentScene.location}` : "All locations"}
                    marks={locationMarks}
                    selected={selectedMark}
                    onSelect={setSelectedMark}
                    onClose={() => setRightDrawer(null)}
                  />
                ) : null}
                {rightDrawer === "layers" ? (
                  <LayersInspector layers={layers} onClose={() => setRightDrawer(null)} />
                ) : null}
                {rightDrawer === "script" ? (
                  <ScriptInspector
                    lines={scriptLines}
                    playheadLine={playheadLine ?? selectedLine}
                    blocks={lanes?.blocks || []}
                    onSeek={seekTo}
                    onClose={() => setRightDrawer(null)}
                  />
                ) : null}
                {rightDrawer === "camera" ? (
                  <CameraDrawer
                    project={project}
                    scriptName={script}
                    scriptText={scriptText}
                    sceneId={sceneId}
                    playheadLine={playheadLine ?? selectedLine}
                    cameraBlocks={cameraBlocks}
                    selectedLine={selectedLine}
                    onSeek={seekTo}
                    onSaved={onSaved}
                    onClose={() => setRightDrawer(null)}
                  />
                ) : null}
              </aside>
            ) : null}
          </div>
        </div>

        <PanelSplitter
          axis="y"
          label="Resize timeline"
          testId="splitter-timeline"
          onDrag={(delta) =>
            setLayout((current) =>
              clampStageLayout({ ...current, timelineHeight: current.timelineHeight - delta })
            )
          }
          onReset={() =>
            setLayout((current) =>
              clampStageLayout({ ...current, timelineHeight: DEFAULT_STAGE_LAYOUT.timelineHeight })
            )
          }
        />
        <div className="shrink-0 overflow-hidden" style={{ height: layout.timelineHeight }}>
          <TimelineLanes
            project={project}
            lanes={lanes}
            frame={frame}
            selectedLine={selectedLine}
            onSeek={seekTo}
            totalFrames={totalFrames}
            playing={playing}
          />
        </div>
      </div>
      <RightIconRail
        active={rightDrawer}
        onToggle={(id) => setRightDrawer((current) => (current === id ? null : id))}
      />
    </div>
  );
}
