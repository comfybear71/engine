"""Flipbook layers: a baked Action Shot played as a sequence of full-frame PNGs."""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .timeline_loader import Layer


@dataclass(frozen=True)
class FrameSequence:
    frames: tuple[Path, ...]
    fps: float
    trim_in: float = 0.0


def sequence_frame_index(seq: FrameSequence, local_frame: int, project_fps: int) -> int:
    """Index into ``seq.frames`` for a layer-local project frame.

    Mirrors ``sequenceFrameIndex`` in shared/placement.js.
    """

    seconds = seq.trim_in + max(0, local_frame) / float(max(1, project_fps))
    index = int(math.floor(seconds * seq.fps + 1e-6))
    return max(0, min(index, len(seq.frames) - 1))


def layer_at_sequence_frame(layer: "Layer", local_frame: int, project_fps: int) -> "Layer":
    """``layer`` with ``asset`` swapped to the sequence frame shown at ``local_frame``."""

    seq = layer.sequence
    if seq is None or not seq.frames:
        return layer
    asset = seq.frames[sequence_frame_index(seq, local_frame, project_fps)]
    if asset == layer.asset:
        return layer
    return dataclasses.replace(layer, asset=asset)
