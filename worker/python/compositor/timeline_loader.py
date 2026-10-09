"""Loads timeline.json into typed, render-ready dataclasses.

All asset/audio paths in the raw JSON are relative to the *project folder*
(the directory containing timeline.json), never to the process's current
working directory. This module is the single place that resolves them to
absolute paths, and the single place that fills in schema defaults and
derives audio-based durations, so the rest of the compositor only ever
deals with fully-resolved, frame-accurate data.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import lipsync
from .camera import Camera, CameraKeyframe, Shake
from .media_probe import probe_duration_seconds
from .schema_validate import validate_timeline
from .slots import Slot, SlotKeyframe

DEFAULT_CANVAS_WIDTH = 1920
DEFAULT_CANVAS_HEIGHT = 1080
DEFAULT_ANCHOR = "bottom-center"

# Same word-count estimate the script parser uses when a WAV is missing
# (see worker/src/parser/scriptParser.js). Kept here so a hand-written
# timeline that only has `text` still gets a silent preview length.
WORDS_PER_SECOND = 2.5
ESTIMATE_PAD_SECONDS = 0.3


@dataclass(frozen=True)
class Canvas:
    width: int = DEFAULT_CANVAS_WIDTH
    height: int = DEFAULT_CANVAS_HEIGHT


@dataclass(frozen=True)
class Transform:
    x: float
    y: float
    scale: float = 1.0
    anchor: str = DEFAULT_ANCHOR
    flip_x: bool = False
    rotation: float = 0.0
    opacity: float = 1.0


@dataclass(frozen=True)
class Child:
    """A cut-out rig part nested under a parent Layer (head, arm, hand, ...).

    Position/scale/flip are relative to the parent's own transform; see
    docs/timeline-schema.md for the exact composition rules. Children are a
    single level deep: a Child cannot itself have children.
    """

    id: str
    asset: Path
    z: int
    offset_x: float = 0.0
    offset_y: float = 0.0
    pivot: str = "center"
    scale: float = 1.0
    flip_x: bool = False
    rotation: float = 0.0
    opacity: float = 1.0
    slots: dict[str, Slot] = field(default_factory=dict)


@dataclass(frozen=True)
class DialogueClip:
    """One spoken line's audio, placed at an explicit scene-relative frame.

    A character layer carries a *list* of these (``Layer.dialogue``) so a
    real scene can give one character many lines without a separate layer
    per line. ``duration_frames`` and ``cues`` are both resolved once at
    load time (ffprobe + the lipsync resolution order), not per render
    frame.
    """

    audio: Path
    start_frame: int
    duration_frames: int
    cues: list[lipsync.MouthCue]
    text: str | None = None
    estimated: bool = False  # True => no WAV yet; silent preview at duration_frames


@dataclass(frozen=True)
class Layer:
    id: str
    asset: Path
    z: int
    transform: Transform
    start_frame: int = 0
    end_frame: int | None = None  # None => visible through end of scene
    character_id: str | None = None
    dialogue: list[DialogueClip] = field(default_factory=list)
    slots: dict[str, Slot] = field(default_factory=dict)
    children: list[Child] = field(default_factory=list)

    def is_visible_at(self, frame_idx: int, scene_total_frames: int) -> bool:
        end = self.end_frame if self.end_frame is not None else scene_total_frames
        return self.start_frame <= frame_idx < end


@dataclass(frozen=True)
class Background:
    asset: Path
    fit: str = "cover"


@dataclass(frozen=True)
class AudioClip:
    """A single audio source to mix into the final render."""

    path: Path
    start_seconds: float


@dataclass(frozen=True)
class Scene:
    id: str
    total_frames: int
    background: Background
    layers: list[Layer]
    camera: Camera | None = None
    audio: Path | None = None
    frame_step: int = 1


@dataclass(frozen=True)
class Timeline:
    series: str
    episode: str
    fps: int
    canvas: Canvas
    scenes: list[Scene]
    project_dir: Path

    @property
    def total_frames(self) -> int:
        return sum(s.total_frames for s in self.scenes)

    def dialogue_line_counts(self) -> tuple[int, int]:
        """Return ``(estimated_or_silent, total)`` dialogue clip counts."""

        total = 0
        estimated = 0
        for scene in self.scenes:
            for layer in scene.layers:
                for clip in layer.dialogue:
                    total += 1
                    if clip.estimated:
                        estimated += 1
        return estimated, total

    def all_audio_clips(self) -> list[AudioClip]:
        """Real audio files to mix in, with global start times.

        Estimated/silent dialogue clips are omitted here -- they have no
        file to mix. The FFmpeg writer always lays down a full-length
        silence bed so those gaps (and scenes with no audio at all) still
        produce one audio stream covering the whole render.
        """

        clips: list[AudioClip] = []
        elapsed_frames = 0
        for scene in self.scenes:
            scene_start_seconds = elapsed_frames / float(self.fps)
            if scene.audio is not None:
                clips.append(AudioClip(path=scene.audio, start_seconds=scene_start_seconds))
            for layer in scene.layers:
                for dialogue_clip in layer.dialogue:
                    if dialogue_clip.estimated:
                        continue
                    clip_start_seconds = scene_start_seconds + dialogue_clip.start_frame / float(self.fps)
                    clips.append(AudioClip(path=dialogue_clip.audio, start_seconds=clip_start_seconds))
            elapsed_frames += scene.total_frames
        return clips


def _resolve(project_dir: Path, rel_path: str) -> Path:
    return (project_dir / rel_path).resolve()


def _frames_from_seconds(seconds: float, fps: int) -> int:
    return max(0, round(seconds * fps))


def _estimate_duration_seconds(text: str) -> float:
    """Same formula the script parser uses: words / 2.5 + 0.3 seconds."""

    word_count = len([w for w in text.split() if w]) or 1
    return word_count / WORDS_PER_SECOND + ESTIMATE_PAD_SECONDS


def _load_lines_manifest(project_dir: Path) -> dict[str, dict]:
    """Index ``lines.json`` by ``audio_path``, if that manifest exists."""

    path = project_dir / "lines.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    by_audio: dict[str, dict] = {}
    for line in data.get("lines", []):
        audio_path = line.get("audio_path")
        if audio_path:
            by_audio[audio_path] = line
    return by_audio


def _clip_duration_seconds(
    clip_raw: dict,
    project_dir: Path,
    lines_by_audio: dict[str, dict],
) -> tuple[float, bool]:
    """Return ``(duration_seconds, estimated)`` for one dialogue clip.

    A real audio file on disk always wins (ffprobe). Otherwise the
    estimated length already stored on the clip, then the matching
    ``lines.json`` entry, then a word-count estimate from the clip's
    ``text``.
    """

    audio_rel = clip_raw["audio"]
    audio_path = _resolve(project_dir, audio_rel)
    if audio_path.is_file():
        return probe_duration_seconds(audio_path), False

    if "estimated_duration_seconds" in clip_raw:
        return float(clip_raw["estimated_duration_seconds"]), True

    line = lines_by_audio.get(audio_rel)
    if line is not None and line.get("estimated_duration_seconds") is not None:
        return float(line["estimated_duration_seconds"]), True

    text = clip_raw.get("text")
    if text:
        return _estimate_duration_seconds(text), True

    raise FileNotFoundError(
        f"Dialogue audio is missing ({audio_path}) and no estimated "
        f"duration is stored on the clip or in lines.json"
    )


def _build_transform(raw: dict) -> Transform:
    return Transform(
        x=float(raw["x"]),
        y=float(raw["y"]),
        scale=float(raw.get("scale", 1.0)),
        anchor=raw.get("anchor", DEFAULT_ANCHOR),
        flip_x=bool(raw.get("flip_x", False)),
        rotation=float(raw.get("rotation", 0.0)),
        opacity=float(raw.get("opacity", 1.0)),
    )


def _build_slot(raw: dict, project_dir: Path, dialogue: list[DialogueClip] | None) -> Slot:
    images = {name: _resolve(project_dir, p) for name, p in raw["images"].items()}
    offset = raw.get("offset", {})

    cues = None
    keyframes = None
    dialogue_ref = None
    if "lipsync" in raw:
        lipsync_raw = raw["lipsync"]
        if lipsync_raw.get("source") == "dialogue":
            if not dialogue:
                raise ValueError(
                    "slot lipsync source 'dialogue' requires this layer to have a "
                    "non-empty 'dialogue' (or legacy 'audio')"
                )
            dialogue_ref = dialogue
        else:
            cues = lipsync.get_cues(lipsync_raw, project_dir)
    else:
        raw_keyframes = sorted(raw["keyframes"], key=lambda k: k["frame"])
        keyframes = [SlotKeyframe(frame=int(k["frame"]), drawing=k["drawing"]) for k in raw_keyframes]

    return Slot(
        images=images,
        offset_x=float(offset.get("x", 0.0)),
        offset_y=float(offset.get("y", 0.0)),
        keyframes=keyframes,
        cues=cues,
        dialogue=dialogue_ref,
    )


def _build_slots(raw: dict | None, project_dir: Path, dialogue: list[DialogueClip] | None = None) -> dict[str, Slot]:
    if not raw:
        return {}
    return {name: _build_slot(slot_raw, project_dir, dialogue) for name, slot_raw in raw.items()}


def _build_child(raw: dict, project_dir: Path) -> Child:
    offset = raw.get("offset", {})
    return Child(
        id=raw["id"],
        asset=_resolve(project_dir, raw["asset"]),
        z=int(raw["z"]),
        offset_x=float(offset.get("x", 0.0)),
        offset_y=float(offset.get("y", 0.0)),
        pivot=raw.get("pivot", "center"),
        scale=float(raw.get("scale", 1.0)),
        flip_x=bool(raw.get("flip_x", False)),
        rotation=float(raw.get("rotation", 0.0)),
        opacity=float(raw.get("opacity", 1.0)),
        slots=_build_slots(raw.get("slots"), project_dir, dialogue=None),
    )


def _raw_dialogue_clips(layer_raw: dict) -> list[dict]:
    """Raw `dialogue` entries, plus the legacy single-`audio` shorthand
    normalized into the same shape (one clip starting at the layer's own
    timing.start_frame). Shared by `_scene_total_frames` (which only has
    raw JSON to work with) and `_build_layer`."""

    dialogue_raw = list(layer_raw.get("dialogue", []))
    if "audio" in layer_raw and not dialogue_raw:
        timing = layer_raw.get("timing", {})
        start_frame = int(timing.get("start_frame", 0))
        dialogue_raw = [{"audio": layer_raw["audio"], "start_frame": start_frame}]
    return dialogue_raw


def _build_dialogue_clip(
    raw: dict,
    project_dir: Path,
    fps: int,
    lines_by_audio: dict[str, dict],
) -> DialogueClip:
    audio_path = _resolve(project_dir, raw["audio"])
    duration_s, estimated = _clip_duration_seconds(raw, project_dir, lines_by_audio)

    if estimated:
        # No WAV (and therefore no Rhubarb cues) -- mouth stays on X.
        cues: list[lipsync.MouthCue] = []
    else:
        lipsync_config: dict = {"audio": raw["audio"]}
        if "cues" in raw:
            lipsync_config["cues"] = raw["cues"]
        if "text" in raw:
            lipsync_config["dialogue_text"] = raw["text"]
        cues = lipsync.get_cues(lipsync_config, project_dir)

    return DialogueClip(
        audio=audio_path,
        start_frame=int(raw["start_frame"]),
        duration_frames=_frames_from_seconds(duration_s, fps),
        cues=cues,
        text=raw.get("text"),
        estimated=estimated,
    )


def _build_layer(
    raw: dict,
    project_dir: Path,
    fps: int,
    lines_by_audio: dict[str, dict],
) -> Layer:
    timing = raw.get("timing", {})
    start_frame = int(timing.get("start_frame", 0))

    end_frame: int | None
    if "end_frame" in timing:
        end_frame = int(timing["end_frame"])
    elif "end_from_audio" in timing:
        audio_path = _resolve(project_dir, timing["end_from_audio"])
        duration_s = probe_duration_seconds(audio_path)
        end_frame = start_frame + _frames_from_seconds(duration_s, fps)
    else:
        end_frame = None

    dialogue = [
        _build_dialogue_clip(d, project_dir, fps, lines_by_audio)
        for d in sorted(_raw_dialogue_clips(raw), key=lambda d: d["start_frame"])
    ]

    return Layer(
        id=raw["id"],
        character_id=raw.get("character_id"),
        asset=_resolve(project_dir, raw["asset"]),
        z=int(raw["z"]),
        transform=_build_transform(raw["transform"]),
        start_frame=start_frame,
        end_frame=end_frame,
        dialogue=dialogue,
        slots=_build_slots(raw.get("slots"), project_dir, dialogue=dialogue or None),
        children=[_build_child(c, project_dir) for c in raw.get("children", [])],
    )


def _build_camera(raw: dict | None) -> Camera | None:
    if raw is None:
        return None
    keyframes = [
        CameraKeyframe(
            frame=int(k["frame"]),
            x=k.get("x"),
            y=k.get("y"),
            zoom=float(k.get("zoom", 1.0)),
        )
        for k in raw.get("keyframes", [])
    ]
    shake_raw = raw.get("shake")
    shake = (
        Shake(
            amplitude_px=float(shake_raw.get("amplitude_px", 0.0)),
            frequency_hz=float(shake_raw.get("frequency_hz", 8.0)),
            start_frame=int(shake_raw.get("start_frame", 0)),
            end_frame=shake_raw.get("end_frame"),
        )
        if shake_raw
        else None
    )
    return Camera(keyframes=keyframes, shake=shake)


def _scene_total_frames(
    raw_duration: dict,
    project_dir: Path,
    fps: int,
    layers_raw: list[dict],
    lines_by_audio: dict[str, dict],
) -> int:
    if "frames" in raw_duration:
        return int(raw_duration["frames"])

    if "from_audio" in raw_duration:
        audio_path = _resolve(project_dir, raw_duration["from_audio"])
        duration_s = probe_duration_seconds(audio_path)
        padding = int(raw_duration.get("padding_frames", 0))
        return _frames_from_seconds(duration_s, fps) + padding

    if raw_duration.get("from_dialogue"):
        padding = int(raw_duration.get("padding_frames", 0))
        max_end_frame = 0
        found_any = False
        for layer_raw in layers_raw:
            for clip_raw in _raw_dialogue_clips(layer_raw):
                found_any = True
                duration_s, _estimated = _clip_duration_seconds(clip_raw, project_dir, lines_by_audio)
                end_frame = int(clip_raw["start_frame"]) + _frames_from_seconds(duration_s, fps)
                max_end_frame = max(max_end_frame, end_frame)
        if not found_any:
            raise ValueError(
                "scene duration 'from_dialogue' requires at least one layer with "
                "a non-empty 'dialogue' (or legacy 'audio')"
            )
        return max_end_frame + padding

    raise ValueError(f"Unrecognized scene duration config: {raw_duration!r}")


def _build_scene(raw: dict, project_dir: Path, fps: int, lines_by_audio: dict[str, dict]) -> Scene:
    total_frames = _scene_total_frames(
        raw["duration"], project_dir, fps, raw.get("layers", []), lines_by_audio
    )
    background = Background(
        asset=_resolve(project_dir, raw["background"]["asset"]),
        fit=raw["background"].get("fit", "cover"),
    )
    layers = [_build_layer(l, project_dir, fps, lines_by_audio) for l in raw.get("layers", [])]
    scene_audio = _resolve(project_dir, raw["audio"]) if "audio" in raw else None
    return Scene(
        id=raw["id"],
        total_frames=total_frames,
        background=background,
        layers=layers,
        camera=_build_camera(raw.get("camera")),
        audio=scene_audio,
        frame_step=int(raw.get("frame_step", 1)),
    )


def load_timeline(timeline_path: Path, schema_path: Path | None = None) -> Timeline:
    """Load, schema-validate, and resolve a timeline.json into a Timeline."""

    timeline_path = Path(timeline_path).resolve()
    project_dir = timeline_path.parent

    with open(timeline_path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    validate_timeline(raw, schema_path)

    canvas_raw = raw.get("canvas", {})
    canvas = Canvas(
        width=int(canvas_raw.get("width", DEFAULT_CANVAS_WIDTH)),
        height=int(canvas_raw.get("height", DEFAULT_CANVAS_HEIGHT)),
    )
    fps = int(raw["fps"])
    lines_by_audio = _load_lines_manifest(project_dir)
    scenes = [_build_scene(s, project_dir, fps, lines_by_audio) for s in raw["scenes"]]

    return Timeline(
        series=raw["series"],
        episode=str(raw["episode"]),
        fps=fps,
        canvas=canvas,
        scenes=scenes,
        project_dir=project_dir,
    )
