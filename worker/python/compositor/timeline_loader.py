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
from dataclasses import dataclass, field, replace
from pathlib import Path

from . import lipsync
from . import lipsync_natural
from .camera import Camera, CameraKeyframe, Shake
from .interpolate import interpolate_scalar
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
class TransformKeyframe:
    """One sample of a layer's animated transform. Omitted properties are
    not interpolated from this keyframe (see :func:`transform_at`)."""

    frame: int
    x: float | None = None
    y: float | None = None
    scale: float | None = None
    rotation: float | None = None
    ease: str = "linear"


@dataclass(frozen=True)
class RotationKeyframe:
    frame: int
    rotation: float
    ease: str = "linear"


@dataclass(frozen=True)
class Child:
    """A cut-out rig part nested under a parent Layer (head, arm, hand, ...).

    Position/scale/flip are relative to the parent's own transform; see
    docs/timeline-schema.md for the exact composition rules. A child may
    name one other child as ``parent`` (one level of nesting, no cycles).
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
    parent: str | None = None
    rotation_keyframes: list[RotationKeyframe] = field(default_factory=list)


@dataclass(frozen=True)
class WordTiming:
    word: str
    start: float
    end: float


@dataclass(frozen=True)
class DialogueClip:
    """One spoken line's audio, placed at a layer-local frame.

    ``start_frame`` is relative to the owning layer's ``timing.start_frame``,
    not the scene. Absolute mix time is
    ``scene_start + layer.start_frame + clip.start_frame``. A character
    layer carries a *list* of these (``Layer.dialogue``) so a real scene
    can give one character many lines without a separate layer per line.
    ``duration_frames`` and ``cues`` are both resolved once at load time
    (ffprobe + the lipsync resolution order), not per render frame.
    """

    audio: Path
    start_frame: int
    duration_frames: int
    cues: list[lipsync.MouthCue]
    text: str | None = None
    estimated: bool = False  # True => no WAV yet; silent preview at duration_frames
    view: str | None = None  # head/mouth set for this line; compositor falls back to front
    trim_in: float = 0.0  # seconds into the source file
    source_duration_seconds: float | None = None
    words: list[WordTiming] = field(default_factory=list)


@dataclass(frozen=True)
class Layer:
    id: str
    asset: Path
    z: int
    transform: Transform
    start_frame: int = 0
    end_frame: int | None = None  # None => visible through end of scene
    character_id: str | None = None
    prop_id: str | None = None
    dialogue: list[DialogueClip] = field(default_factory=list)
    slots: dict[str, Slot] = field(default_factory=dict)
    children: list[Child] = field(default_factory=list)
    transform_keyframes: list[TransformKeyframe] = field(default_factory=list)

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
    in_seconds: float = 0.0
    duration_seconds: float | None = None


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
                    clip_start_seconds = scene_start_seconds + (
                        layer.start_frame + dialogue_clip.start_frame
                    ) / float(self.fps)
                    play_s = dialogue_clip.duration_frames / float(self.fps)
                    source_s = dialogue_clip.source_duration_seconds
                    trimmed = dialogue_clip.trim_in > 1e-6 or (
                        source_s is not None and play_s + 1e-6 < source_s
                    )
                    clips.append(
                        AudioClip(
                            path=dialogue_clip.audio,
                            start_seconds=clip_start_seconds,
                            in_seconds=dialogue_clip.trim_in,
                            duration_seconds=play_s if trimmed else None,
                        )
                    )
            elapsed_frames += scene.total_frames
        return clips


def transform_at(layer: Layer, local_frame: int) -> Transform:
    """Layer transform at a layer-local frame, with ``transform_keyframes``.

    Properties never mentioned in any keyframe keep the static
    ``layer.transform`` value. ``flip_x``, ``anchor`` and ``opacity`` are
    never keyframed (flip by adding a new layer). Held before the first
    keyframe that specifies a property and after the last.
    """

    base = layer.transform
    kfs = layer.transform_keyframes
    if not kfs:
        return base
    return Transform(
        x=interpolate_scalar([(k.frame, k.x, k.ease) for k in kfs if k.x is not None], local_frame, base.x),
        y=interpolate_scalar([(k.frame, k.y, k.ease) for k in kfs if k.y is not None], local_frame, base.y),
        scale=interpolate_scalar(
            [(k.frame, k.scale, k.ease) for k in kfs if k.scale is not None], local_frame, base.scale
        ),
        rotation=interpolate_scalar(
            [(k.frame, k.rotation, k.ease) for k in kfs if k.rotation is not None], local_frame, base.rotation
        ),
        anchor=base.anchor,
        flip_x=base.flip_x,
        opacity=base.opacity,
    )


def child_rotation_at(child: Child, local_frame: int) -> float:
    """Child rotation at a layer-local frame, with ``rotation_keyframes``."""

    kfs = child.rotation_keyframes
    if not kfs:
        return child.rotation
    return interpolate_scalar(
        [(k.frame, k.rotation, k.ease) for k in kfs], local_frame, child.rotation
    )


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


def _source_duration_seconds(
    clip_raw: dict,
    project_dir: Path,
    lines_by_audio: dict[str, dict],
) -> tuple[float, bool]:
    """Return ``(source_duration_seconds, estimated)`` for one dialogue clip.

    A real audio file on disk always wins (ffprobe). Otherwise the
    estimated length already stored on the clip, then the matching
    ``lines.json`` entry, then a word-count estimate from the clip's
    ``text``.
    """

    audio_rel = clip_raw["audio"]
    audio_path = _resolve(project_dir, audio_rel)
    if audio_path.is_file():
        return probe_duration_seconds(audio_path), False

    if "estimated_duration_seconds" in clip_raw and "trim_in" not in clip_raw and "trim_out" not in clip_raw:
        return float(clip_raw["estimated_duration_seconds"]), True

    line = lines_by_audio.get(audio_rel)
    if line is not None and line.get("estimated_duration_seconds") is not None and "trim_in" not in clip_raw and "trim_out" not in clip_raw:
        return float(line["estimated_duration_seconds"]), True

    text = clip_raw.get("text")
    if text:
        return _estimate_duration_seconds(text), True

    raise FileNotFoundError(
        f"Dialogue audio is missing ({audio_path}) and no estimated "
        f"duration is stored on the clip or in lines.json"
    )


def _apply_trim_window(source_seconds: float, clip_raw: dict) -> tuple[float, float, float]:
    """Return ``(play_seconds, trim_in, trim_out)`` from optional clip trim."""

    trim_in = float(clip_raw["trim_in"]) if clip_raw.get("trim_in") is not None else 0.0
    trim_out = float(clip_raw["trim_out"]) if clip_raw.get("trim_out") is not None else source_seconds
    if trim_in < 0:
        trim_in = 0.0
    if trim_out > source_seconds:
        trim_out = source_seconds
    play = max(0.0, trim_out - trim_in)
    return play, trim_in, trim_out


def _clip_duration_seconds(
    clip_raw: dict,
    project_dir: Path,
    lines_by_audio: dict[str, dict],
) -> tuple[float, bool]:
    """Return ``(play_duration_seconds, estimated)`` for one dialogue clip."""

    source_s, estimated = _source_duration_seconds(clip_raw, project_dir, lines_by_audio)
    play_s, _trim_in, _trim_out = _apply_trim_window(source_s, clip_raw)
    if estimated and "estimated_duration_seconds" in clip_raw and (
        "trim_in" in clip_raw or "trim_out" in clip_raw
    ):
        # Parser already stored the play length for a silent/estimated clip.
        return float(clip_raw["estimated_duration_seconds"]), True
    return play_s, estimated


def _slice_cues(
    cues: list[lipsync.MouthCue], trim_in: float, trim_out: float
) -> list[lipsync.MouthCue]:
    out: list[lipsync.MouthCue] = []
    for cue in cues:
        if cue.end <= trim_in or cue.start >= trim_out:
            continue
        start = max(0.0, cue.start - trim_in)
        end = max(0.0, min(trim_out, cue.end) - trim_in)
        if end > start:
            out.append(lipsync.MouthCue(start=start, end=end, shape=cue.shape))
    return out


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
    images_by_view = {
        str(view_name): {name: _resolve(project_dir, p) for name, p in mapping.items()}
        for view_name, mapping in (raw.get("images_by_view") or {}).items()
        if isinstance(mapping, dict)
    }
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
        keyframes = [_build_slot_keyframe(k) for k in raw_keyframes]

    visible_when = {
        name: [str(d) for d in drawings]
        for name, drawings in raw.get("visible_when", {}).items()
    }

    return Slot(
        images=images,
        offset_x=float(offset.get("x", 0.0)),
        offset_y=float(offset.get("y", 0.0)),
        scale=float(raw.get("scale", 1.0)),
        rotation=float(raw.get("rotation", 0.0)),
        keyframes=keyframes,
        cues=cues,
        dialogue=dialogue_ref,
        visible_when=visible_when,
        images_by_view=images_by_view,
    )


def _build_slot_keyframe(raw: dict) -> SlotKeyframe:
    if "cycle" in raw:
        return SlotKeyframe(
            frame=int(raw["frame"]),
            cycle=[str(d) for d in raw["cycle"]],
            fps=float(raw["fps"]),
        )
    return SlotKeyframe(frame=int(raw["frame"]), drawing=raw["drawing"])


def _build_slots(raw: dict | None, project_dir: Path, dialogue: list[DialogueClip] | None = None) -> dict[str, Slot]:
    if not raw:
        return {}
    return {name: _build_slot(slot_raw, project_dir, dialogue) for name, slot_raw in raw.items()}


def _build_rotation_keyframes(raw: list[dict] | None) -> list[RotationKeyframe]:
    if not raw:
        return []
    return [
        RotationKeyframe(
            frame=int(k["frame"]),
            rotation=float(k["rotation"]),
            ease=k.get("ease", "linear"),
        )
        for k in sorted(raw, key=lambda item: item["frame"])
    ]


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
        parent=raw.get("parent"),
        rotation_keyframes=_build_rotation_keyframes(raw.get("rotation_keyframes")),
    )


def _validate_children(layer_id: str, children_raw: list[dict]) -> None:
    """Parent must exist, no deeper than one level, no cycles."""

    if not children_raw:
        return
    ids = [c["id"] for c in children_raw]
    id_set = set(ids)
    parents: dict[str, str] = {}
    uses_parent = any("parent" in c and c["parent"] for c in children_raw)
    if uses_parent and len(ids) != len(id_set):
        raise ValueError(
            f"layer {layer_id!r} has duplicate child ids; ids must be unique "
            f"when a child names a parent"
        )
    for child in children_raw:
        parent = child.get("parent")
        if not parent:
            continue
        child_id = child["id"]
        if parent not in id_set:
            raise ValueError(
                f"layer {layer_id!r} child {child_id!r} parent {parent!r} does not exist"
            )
        if parent == child_id:
            raise ValueError(
                f"layer {layer_id!r} child {child_id!r} cannot be its own parent"
            )
        parents[child_id] = parent
    for child_id, parent_id in parents.items():
        if parent_id in parents:
            raise ValueError(
                f"layer {layer_id!r} child {child_id!r} parent {parent_id!r} is "
                f"itself parented (only one level of nesting is allowed; no cycles)"
            )


def _layer_slot_names(layer_raw: dict) -> set[str]:
    names = set(layer_raw.get("slots", {}))
    for child in layer_raw.get("children", []):
        names.update(child.get("slots", {}))
    return names


def _validate_visible_when(layer_id: str, layer_raw: dict) -> None:
    names = _layer_slot_names(layer_raw)

    def check(slots_raw: dict | None, owner: str) -> None:
        if not slots_raw:
            return
        for slot_name, slot in slots_raw.items():
            for ref in slot.get("visible_when", {}):
                if ref not in names:
                    raise ValueError(
                        f"{owner} slot {slot_name!r} visible_when refers to "
                        f"unknown slot {ref!r} on layer {layer_id!r}"
                    )

    check(layer_raw.get("slots"), f"layer {layer_id!r}")
    for child in layer_raw.get("children", []):
        check(child.get("slots"), f"child {child['id']!r}")


def _raw_dialogue_clips(layer_raw: dict) -> list[dict]:
    """Raw `dialogue` entries, plus the legacy single-`audio` shorthand
    normalized into the same shape (one clip at layer-local start_frame 0,
    i.e. when the layer becomes visible). Shared by `_scene_total_frames`
    (which only has raw JSON to work with) and `_build_layer`."""

    dialogue_raw = list(layer_raw.get("dialogue", []))
    if "audio" in layer_raw and not dialogue_raw:
        dialogue_raw = [{"audio": layer_raw["audio"], "start_frame": 0}]
    return dialogue_raw


def _build_dialogue_clip(
    raw: dict,
    project_dir: Path,
    fps: int,
    lines_by_audio: dict[str, dict],
) -> DialogueClip:
    audio_path = _resolve(project_dir, raw["audio"])
    source_s, estimated = _source_duration_seconds(raw, project_dir, lines_by_audio)
    play_s, trim_in, trim_out = _apply_trim_window(source_s, raw)
    if estimated and "estimated_duration_seconds" in raw:
        play_s = float(raw["estimated_duration_seconds"])

    if estimated:
        # No WAV (and therefore no Rhubarb cues) -- mouth stays on X.
        cues: list[lipsync.MouthCue] = []
    else:
        lipsync_config: dict = {"audio": raw["audio"]}
        if "cues" in raw:
            lipsync_config["cues"] = raw["cues"]
        if "text" in raw:
            lipsync_config["dialogue_text"] = raw["text"]
        cues = _slice_cues(lipsync.get_cues(lipsync_config, project_dir), trim_in, trim_out)

    view = raw.get("view")
    words = [
        WordTiming(word=str(w["word"]), start=float(w["start"]), end=float(w["end"]))
        for w in raw.get("words") or []
        if isinstance(w, dict) and w.get("word") is not None
    ]
    return DialogueClip(
        audio=audio_path,
        start_frame=int(raw["start_frame"]),
        duration_frames=_frames_from_seconds(play_s, fps),
        cues=cues,
        text=raw.get("text"),
        estimated=estimated,
        view=str(view) if view else None,
        trim_in=trim_in,
        source_duration_seconds=source_s,
        words=words,
    )


def _find_named_slot(layer: Layer, name: str) -> Slot | None:
    if name in layer.slots:
        return layer.slots[name]
    for child in layer.children:
        if name in child.slots:
            return child.slots[name]
    return None


def _remap_slots(
    slots: dict[str, Slot],
    *,
    dialogue: list[DialogueClip] | None,
    bob_starts: list[int],
    bob_amp: float,
    bob_rot: float,
    blink_slot: Slot | None,
) -> dict[str, Slot]:
    remapped: dict[str, Slot] = {}
    for name, slot in slots.items():
        next_slot = slot
        if slot.dialogue is not None:
            next_slot = replace(next_slot, dialogue=dialogue)
        if blink_slot is not None and name == "eyes":
            next_slot = replace(next_slot, keyframes=blink_slot.keyframes)
        if name in lipsync_natural.HEAD_SLOT_NAMES:
            next_slot = replace(
                next_slot,
                head_bob_starts=list(bob_starts),
                head_bob_amp=bob_amp,
                head_bob_rotation=bob_rot,
            )
        remapped[name] = next_slot
    return remapped


def apply_natural_lipsync(
    layer: Layer,
    *,
    fps: int,
    scene_frames: int,
    settings: lipsync_natural.LipSyncSettings,
    seed: int,
) -> Layer:
    """Min-hold, smoothing, loud mouths, blinks, and head bob on one layer."""

    mouth = _find_named_slot(layer, "mouth")
    dialogue: list[DialogueClip] = []
    bob_starts: list[int] = []
    layer_end = layer.end_frame if layer.end_frame is not None else scene_frames
    visible_frames = max(0, layer_end - layer.start_frame)

    for clip in layer.dialogue:
        cues = lipsync_natural.process_mouth_cues(
            clip.cues,
            duration_frames=clip.duration_frames,
            fps=fps,
            smoothing=settings.smoothing,
        )
        available = lipsync_natural.drawing_names(mouth, clip.view)
        if not clip.estimated and clip.audio.is_file():
            cues = lipsync_natural.apply_loud_to_cues(
                cues,
                clip.audio,
                trim_in=clip.trim_in,
                threshold_percentile=settings.loud_threshold,
                available=available,
            )
            play_s = clip.duration_frames / float(fps) if fps else 0.0
            stress = lipsync_natural.clip_stress_times(
                clip.words,
                clip.audio,
                trim_in=clip.trim_in,
                play_seconds=play_s,
                threshold_percentile=settings.loud_threshold,
            )
            bob_starts.extend(
                lipsync_natural.head_bob_starts(
                    stress,
                    trim_in=clip.trim_in,
                    clip_start_frame=clip.start_frame,
                    fps=fps,
                    duration_frames=visible_frames,
                )
            )
        dialogue.append(replace(clip, cues=cues))

    if settings.head_bob == "off":
        bob_starts = []
        bob_amp = 0.0
        bob_rot = 0.0
    else:
        bob_amp = settings.head_bob_amp
        bob_rot = settings.head_bob_rotation

    eyes = _find_named_slot(layer, "eyes")
    blink_slot = None
    if settings.blinks and eyes is not None:
        blink_kfs = lipsync_natural.insert_auto_blinks(
            eyes.keyframes,
            eyes.images,
            duration_frames=visible_frames,
            fps=fps,
            seed=seed,
            every=settings.blink_every,
            blink_frames=settings.blink_frames,
        )
        blink_slot = replace(eyes, keyframes=blink_kfs)

    dialogue_ref = dialogue or None
    new_slots = _remap_slots(
        layer.slots,
        dialogue=dialogue_ref,
        bob_starts=bob_starts,
        bob_amp=bob_amp,
        bob_rot=bob_rot,
        blink_slot=blink_slot,
    )
    new_children = [
        replace(
            child,
            slots=_remap_slots(
                child.slots,
                dialogue=dialogue_ref,
                bob_starts=bob_starts,
                bob_amp=bob_amp,
                bob_rot=bob_rot,
                blink_slot=blink_slot,
            ),
        )
        for child in layer.children
    ]
    return replace(layer, dialogue=dialogue, slots=new_slots, children=new_children)


def _build_layer(
    raw: dict,
    project_dir: Path,
    fps: int,
    lines_by_audio: dict[str, dict],
    *,
    scene_frames: int,
    studio_lipsync: dict,
    seed: int,
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

    _validate_children(raw["id"], raw.get("children", []))
    _validate_visible_when(raw["id"], raw)

    transform_keyframes = [
        TransformKeyframe(
            frame=int(k["frame"]),
            x=k.get("x"),
            y=k.get("y"),
            scale=float(k["scale"]) if "scale" in k else None,
            rotation=float(k["rotation"]) if "rotation" in k else None,
            ease=k.get("ease", "linear"),
        )
        for k in sorted(raw.get("transform_keyframes", []), key=lambda item: item["frame"])
    ]

    return Layer(
        id=raw["id"],
        character_id=raw.get("character_id"),
        prop_id=raw.get("prop_id"),
        asset=_resolve(project_dir, raw["asset"]),
        z=int(raw["z"]),
        transform=_build_transform(raw["transform"]),
        start_frame=start_frame,
        end_frame=end_frame,
        dialogue=dialogue,
        slots=_build_slots(raw.get("slots"), project_dir, dialogue=dialogue or None),
        children=[_build_child(c, project_dir) for c in raw.get("children", [])],
        transform_keyframes=transform_keyframes,
    )
    character = lipsync_natural.load_character_config(project_dir, layer.character_id)
    settings = lipsync_natural.merge_lipsync_settings(studio_lipsync, character)
    char_seed = lipsync_natural.project_seed(project_dir, layer.character_id or layer.id)
    return apply_natural_lipsync(
        layer,
        fps=fps,
        scene_frames=scene_frames,
        settings=settings,
        seed=seed ^ char_seed,
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
            ease=k.get("ease", "linear"),
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
            layer_start = int(layer_raw.get("timing", {}).get("start_frame", 0))
            for clip_raw in _raw_dialogue_clips(layer_raw):
                found_any = True
                duration_s, _estimated = _clip_duration_seconds(clip_raw, project_dir, lines_by_audio)
                end_frame = (
                    layer_start
                    + int(clip_raw["start_frame"])
                    + _frames_from_seconds(duration_s, fps)
                )
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
    studio_lipsync = lipsync_natural.load_studio_lipsync(project_dir)
    seed = lipsync_natural.project_seed(project_dir)
    layers = [
        _build_layer(
            l,
            project_dir,
            fps,
            lines_by_audio,
            scene_frames=total_frames,
            studio_lipsync=studio_lipsync,
            seed=seed,
        )
        for l in raw.get("layers", [])
    ]
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


def load_timeline(
    timeline_path: Path,
    schema_path: Path | None = None,
    project_dir: Path | None = None,
) -> Timeline:
    """Load, schema-validate, and resolve a timeline.json into a Timeline.

    Asset/audio paths inside the JSON are relative to ``project_dir`` (the
    folder that contains the project's ``script.txt``), not to wherever the
    timeline file happens to sit. Preview writes a throwaway copy under
    ``/tmp`` and must still resolve against the real project.
    """

    timeline_path = Path(timeline_path).resolve()
    project_dir = Path(project_dir).resolve() if project_dir is not None else timeline_path.parent

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
