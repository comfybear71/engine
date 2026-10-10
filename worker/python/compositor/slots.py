"""Generic named drawing-swap slots (Toon Boom/Moho style).

A slot is a single attachment point that shows exactly one named drawing at
a time. A mouth driven by Rhubarb cues, a pair of eyes that blink, and a
hand that swaps between "fist"/"flat"/"point" poses are all the *same*
mechanism here -- only the driver differs:

- A ``keyframes``-driven slot holds its drawing until the next keyframe
  ("held until changed"), e.g. a blink or a hand pose change. A keyframe
  may instead give ``cycle`` + ``fps`` to loop a list of drawings from
  that frame until the next keyframe.
- A ``cues``-driven slot is fed by a single Rhubarb cue timeline (see
  :mod:`compositor.lipsync`) -- a one-off lip-synced line with no need for
  the full dialogue-list machinery below.
- A ``dialogue``-driven slot (the normal case for a character's mouth) is
  fed by the owning layer's *list* of dialogue clips (see
  ``compositor.timeline_loader.DialogueClip``): each clip's own cues apply
  within that clip's ``[start_frame, start_frame + duration_frames)``
  window, and the slot shows the idle shape in the gaps between lines.

All three resolve to the same question -- "what drawing is active at this
(owner-relative) frame?" -- via :func:`active_drawing`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from . import lipsync

FALLBACK_SHAPE = lipsync.DEFAULT_SHAPE  # "X": used as the generic idle fallback


@dataclass(frozen=True)
class SlotKeyframe:
    frame: int
    drawing: str | None = None
    cycle: list[str] | None = None
    fps: float | None = None


@dataclass(frozen=True)
class Slot:
    images: dict[str, Path]
    offset_x: float = 0.0
    offset_y: float = 0.0
    scale: float = 1.0
    rotation: float = 0.0
    keyframes: list[SlotKeyframe] | None = None  # held-until-changed / cycle driver
    cues: list[lipsync.MouthCue] | None = None  # single-clip lipsync driver
    # Dialogue-list driver: a sequence of objects each exposing
    # .start_frame (int), .duration_frames (int) and .cues (list[MouthCue]).
    # Typed loosely (not as timeline_loader.DialogueClip) to avoid a circular
    # import -- timeline_loader already imports this module.
    dialogue: Sequence[object] | None = None
    # Slot only draws when each named slot's active drawing is in the list.
    visible_when: dict[str, list[str]] = field(default_factory=dict)
    # Optional per-head-view mouth sheets (mouth_left_side/, …). Missing
    # views fall back to "front", then to ``images``.
    images_by_view: dict[str, dict[str, Path]] = field(default_factory=dict)
    # Subtle head bob on mouth/face/eyes only (layer-local start frames).
    head_bob_starts: list[int] = field(default_factory=list)
    head_bob_amp: float = 0.0
    head_bob_rotation: float = 0.0

    def resolve_image(self, drawing: str | None, view: str | None = None) -> Path | None:
        pools: list[dict[str, Path]] = []
        if view:
            named = self.images_by_view.get(view)
            if named:
                pools.append(named)
            if view != "front":
                front = self.images_by_view.get("front")
                if front:
                    pools.append(front)
        pools.append(self.images)
        names: list[str] = []
        if drawing:
            names.append(drawing)
            # B_loud.png is optional; fall back to B.png when the loud
            # variant was never drawn.
            if drawing.endswith("_loud"):
                names.append(drawing[: -len("_loud")])
        for name in names:
            for pool in pools:
                if name in pool:
                    return pool[name]
        for pool in pools:
            if FALLBACK_SHAPE in pool:
                return pool[FALLBACK_SHAPE]
        if self.images:
            return next(iter(self.images.values()))
        return None


def _find_active_clip(dialogue: Sequence[object], owner_local_frame_idx: int):
    for clip in dialogue:  # expected pre-sorted ascending by start_frame
        if clip.start_frame <= owner_local_frame_idx < clip.start_frame + clip.duration_frames:
            return clip
    return None


def active_drawing(slot: Slot, owner_local_frame_idx: int, fps: int) -> str | None:
    """Which drawing name is active at ``owner_local_frame_idx`` (frames
    since the slot's owner became visible)."""

    if slot.dialogue is not None:
        clip = _find_active_clip(slot.dialogue, owner_local_frame_idx)
        if clip is None:
            return FALLBACK_SHAPE  # between lines: idle/closed mouth
        clip_local_seconds = (owner_local_frame_idx - clip.start_frame) / float(fps)
        return lipsync.shape_at_time(clip.cues, clip_local_seconds)

    if slot.cues is not None:
        t_seconds = owner_local_frame_idx / float(fps)
        return lipsync.shape_at_time(slot.cues, t_seconds)

    if slot.keyframes:
        held_kf: SlotKeyframe | None = None
        for kf in slot.keyframes:  # pre-sorted ascending by frame
            if kf.frame <= owner_local_frame_idx:
                held_kf = kf
            else:
                break
        if held_kf is None:
            held_kf = slot.keyframes[0]
        if held_kf.cycle:
            # Loop from this keyframe's frame until the next keyframe takes
            # over. The compositor only asks about recomputed frames, so a
            # scene ``frame_step`` of N>1 already holds the drawing on the
            # frames in between.
            elapsed = max(0, owner_local_frame_idx - held_kf.frame)
            cycle_fps = held_kf.fps if held_kf.fps is not None else float(fps)
            index = int((elapsed / float(fps)) * cycle_fps) % len(held_kf.cycle)
            return held_kf.cycle[index]
        return held_kf.drawing

    return None


def slot_is_visible(slot: Slot, active_drawings: dict[str, str | None]) -> bool:
    """True unless ``visible_when`` names a slot whose current drawing is
    not in the allowed list."""

    if not slot.visible_when:
        return True
    for other_name, allowed in slot.visible_when.items():
        if active_drawings.get(other_name) not in allowed:
            return False
    return True
