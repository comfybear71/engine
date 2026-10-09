import type { DialogueClip, TimelineDoc, TimelineLayer, TimelineScene } from "@/lib/worker";

const PX_PER_FRAME = 2;
const WORDS_PER_SECOND = 2.5;
const ESTIMATE_PAD_SECONDS = 0.3;

function clipDurationFrames(clip: DialogueClip, fps: number): number {
  if (typeof clip.estimated_duration_seconds === "number") {
    return Math.max(1, Math.round(clip.estimated_duration_seconds * fps));
  }
  const words = (clip.text || "").trim().split(/\s+/).filter(Boolean).length || 1;
  return Math.max(1, Math.round((words / WORDS_PER_SECOND + ESTIMATE_PAD_SECONDS) * fps));
}

function clipAbsoluteStart(layer: TimelineLayer, clip: DialogueClip): number {
  return (layer.timing?.start_frame || 0) + clip.start_frame;
}

type LaneClip = {
  text: string;
  start: number;
  duration: number;
  estimated: boolean;
};

function sceneLanes(scene: TimelineScene, fps: number): { character: string; clips: LaneClip[] }[] {
  const byCharacter = new Map<string, LaneClip[]>();
  for (const layer of scene.layers || []) {
    const character = layer.character_id || layer.id;
    const clips = byCharacter.get(character) || [];
    for (const clip of layer.dialogue || []) {
      clips.push({
        text: clip.text || clip.audio,
        start: clipAbsoluteStart(layer, clip),
        duration: clipDurationFrames(clip, fps),
        estimated: Boolean(clip.estimated),
      });
    }
    byCharacter.set(character, clips);
  }
  return [...byCharacter.entries()].map(([character, clips]) => ({
    character,
    clips: clips.sort((a, b) => a.start - b.start),
  }));
}

function sceneLengthFrames(scene: TimelineScene, fps: number, lanes: { clips: LaneClip[] }[]): number {
  if (typeof scene.duration?.frames === "number") return scene.duration.frames;
  let last = 0;
  for (const lane of lanes) {
    for (const clip of lane.clips) last = Math.max(last, clip.start + clip.duration);
  }
  return Math.max(last + (scene.duration?.padding_frames || 0), fps);
}

function FrameRuler({ frames, fps }: { frames: number; fps: number }) {
  const major = fps;
  const ticks: number[] = [];
  for (let f = 0; f <= frames; f += major) ticks.push(f);
  return (
    <div className="relative h-6 border-b border-neutral-800 text-[10px] text-neutral-500">
      {ticks.map((frame) => (
        <div
          key={frame}
          className="absolute top-0 h-full border-l border-neutral-700 pl-1"
          style={{ left: frame * PX_PER_FRAME }}
        >
          {frame}
        </div>
      ))}
    </div>
  );
}

export function Timeline({ timeline }: { timeline: TimelineDoc | null }) {
  if (!timeline) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-neutral-500">
        No timeline.json yet. Save a valid script to generate one.
      </div>
    );
  }

  const fps = timeline.fps || 24;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
        {timeline.series || "Untitled"} / {timeline.episode ?? "—"} · {fps} fps · {timeline.scenes.length} scene
        {timeline.scenes.length === 1 ? "" : "s"}
        <span className="ml-3 text-neutral-600">hatched blocks are estimated / silent</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {timeline.scenes.map((scene) => {
          const lanes = sceneLanes(scene, fps);
          const frames = sceneLengthFrames(scene, fps, lanes);
          return (
            <section key={scene.id} className="border-b border-neutral-800">
              <div className="sticky left-0 z-10 bg-neutral-950 px-3 py-1 text-xs font-medium text-neutral-300">
                {scene.id}
              </div>
              <div className="min-w-full" style={{ width: Math.max(frames * PX_PER_FRAME + 120, 400) }}>
                <div className="pl-28">
                  <FrameRuler frames={frames} fps={fps} />
                </div>
                {lanes.map((lane) => (
                  <div key={lane.character} className="flex items-stretch">
                    <div className="sticky left-0 z-10 w-28 shrink-0 truncate bg-neutral-950 px-3 py-1.5 text-xs text-neutral-400">
                      {lane.character}
                    </div>
                    <div className="relative h-8 flex-1">
                      {lane.clips.map((clip, index) => (
                        <div
                          key={`${clip.start}-${index}`}
                          title={clip.text}
                          className={
                            clip.estimated
                              ? "absolute top-1 h-6 overflow-hidden rounded-sm border border-dashed border-amber-500/70 bg-amber-500/15 px-1 text-[10px] leading-6 text-amber-100"
                              : "absolute top-1 h-6 overflow-hidden rounded-sm border border-sky-500/50 bg-sky-500/25 px-1 text-[10px] leading-6 text-sky-50"
                          }
                          style={{
                            left: clip.start * PX_PER_FRAME,
                            width: Math.max(clip.duration * PX_PER_FRAME, 8),
                          }}
                        >
                          {clip.text}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {lanes.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-neutral-600">No character lanes in this scene.</div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
