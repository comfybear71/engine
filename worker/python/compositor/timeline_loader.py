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
class Layer:
    id: str
    asset: Path
    z: int
    transform: Transform
    start_frame: int = 0
    end_frame: int | None = None  # None => visible through end of scene
    character_id: str | None = None
    audio: Path | None = None
    audio_start_frame: int = 0
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

    def all_audio_clips(self) -> list[AudioClip]:
        """All audio referenced anywhere in the timeline, with global start times."""

        clips: list[AudioClip] = []
        elapsed_frames = 0
        for scene in self.scenes:
            scene_start_seconds = elapsed_frames / float(self.fps)
            if scene.audio is not None:
                clips.append(AudioClip(path=scene.audio, start_seconds=scene_start_seconds))
            for layer in scene.layers:
                if layer.audio is not None:
                    layer_start_seconds = scene_start_seconds + layer.audio_start_frame / float(self.fps)
                    clips.append(AudioClip(path=layer.audio, start_seconds=layer_start_seconds))
            elapsed_frames += scene.total_frames
        return clips


def _resolve(project_dir: Path, rel_path: str) -> Path:
    return (project_dir / rel_path).resolve()


def _frames_from_seconds(seconds: float, fps: int) -> int:
    return max(0, round(seconds * fps))


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


def _build_slot(raw: dict, project_dir: Path) -> Slot:
    images = {name: _resolve(project_dir, p) for name, p in raw["images"].items()}
    offset = raw.get("offset", {})

    cues = None
    keyframes = None
    if "lipsync" in raw:
        cues = lipsync.get_cues(raw["lipsync"], project_dir)
    else:
        raw_keyframes = sorted(raw["keyframes"], key=lambda k: k["frame"])
        keyframes = [SlotKeyframe(frame=int(k["frame"]), drawing=k["drawing"]) for k in raw_keyframes]

    return Slot(
        images=images,
        offset_x=float(offset.get("x", 0.0)),
        offset_y=float(offset.get("y", 0.0)),
        keyframes=keyframes,
        cues=cues,
    )


def _build_slots(raw: dict | None, project_dir: Path) -> dict[str, Slot]:
    if not raw:
        return {}
    return {name: _build_slot(slot_raw, project_dir) for name, slot_raw in raw.items()}


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
        slots=_build_slots(raw.get("slots"), project_dir),
    )


def _build_layer(raw: dict, project_dir: Path, fps: int) -> Layer:
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

    audio_path = _resolve(project_dir, raw["audio"]) if "audio" in raw else None

    return Layer(
        id=raw["id"],
        character_id=raw.get("character_id"),
        asset=_resolve(project_dir, raw["asset"]),
        z=int(raw["z"]),
        transform=_build_transform(raw["transform"]),
        start_frame=start_frame,
        end_frame=end_frame,
        audio=audio_path,
        audio_start_frame=start_frame,
        slots=_build_slots(raw.get("slots"), project_dir),
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


def _scene_total_frames(raw_duration: dict, project_dir: Path, fps: int) -> int:
    if "frames" in raw_duration:
        return int(raw_duration["frames"])
    audio_path = _resolve(project_dir, raw_duration["from_audio"])
    duration_s = probe_duration_seconds(audio_path)
    padding = int(raw_duration.get("padding_frames", 0))
    return _frames_from_seconds(duration_s, fps) + padding


def _build_scene(raw: dict, project_dir: Path, fps: int) -> Scene:
    total_frames = _scene_total_frames(raw["duration"], project_dir, fps)
    background = Background(
        asset=_resolve(project_dir, raw["background"]["asset"]),
        fit=raw["background"].get("fit", "cover"),
    )
    layers = [_build_layer(l, project_dir, fps) for l in raw.get("layers", [])]
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
    scenes = [_build_scene(s, project_dir, fps) for s in raw["scenes"]]

    return Timeline(
        series=raw["series"],
        episode=str(raw["episode"]),
        fps=fps,
        canvas=canvas,
        scenes=scenes,
        project_dir=project_dir,
    )
