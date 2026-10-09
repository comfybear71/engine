"""Generic named drawing-swap slots (Toon Boom/Moho style).

A slot is a single attachment point that shows exactly one named drawing at
a time. A mouth driven by Rhubarb cues, a pair of eyes that blink, and a
hand that swaps between "fist"/"flat"/"point" poses are all the *same*
mechanism here -- only the driver differs:

- A ``keyframes``-driven slot holds its drawing until the next keyframe
  ("held until changed"), e.g. a blink or a hand pose change.
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

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from . import lipsync

FALLBACK_SHAPE = lipsync.DEFAULT_SHAPE  # "X": used as the generic idle fallback


@dataclass(frozen=True)
class SlotKeyframe:
    frame: int
    drawing: str


@dataclass(frozen=True)
class Slot:
    images: dict[str, Path]
    offset_x: float = 0.0
    offset_y: float = 0.0
    keyframes: list[SlotKeyframe] | None = None  # held-until-changed driver
    cues: list[lipsync.MouthCue] | None = None  # single-clip lipsync driver
    # Dialogue-list driver: a sequence of objects each exposing
    # .start_frame (int), .duration_frames (int) and .cues (list[MouthCue]).
    # Typed loosely (not as timeline_loader.DialogueClip) to avoid a circular
    # import -- timeline_loader already imports this module.
    dialogue: Sequence[object] | None = None

    def resolve_image(self, drawing: str | None) -> Path | None:
        if drawing is not None and drawing in self.images:
            return self.images[drawing]
        if FALLBACK_SHAPE in self.images:
            return self.images[FALLBACK_SHAPE]
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
        held: str | None = None
        for kf in slot.keyframes:  # pre-sorted ascending by frame
            if kf.frame <= owner_local_frame_idx:
                held = kf.drawing
            else:
                break
        return held if held is not None else slot.keyframes[0].drawing

    return None
