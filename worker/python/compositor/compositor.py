"""The main compositing loop: timeline -> stream of canvas-sized BGR frames.

``iter_frames`` is a generator. It yields one frame at a time and holds at
most one frame (plus the cached assets) in memory -- it never builds a
list of frames for a scene or the whole render. That matters because a
feature-length episode at 1920x1080 could easily be tens of gigabytes of
raw frames; this is what lets ``render()`` stream them straight into
FFmpeg's stdin frame-by-frame instead of buffering in RAM or on disk.

Each top-level ``Layer`` is composited as a self-contained local rig: its
own base image plus any ``children`` (head, arms, ...), stacked among
themselves by their own ``z`` (relative to the parent, not the scene), with
the parent's position/scale/flip applied to all of them. Any ``slots``
attached to the layer or to a specific child (mouth, eyes, hand pose, ...)
are drawn immediately on top of their owner, at the owner's effective
position.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, NamedTuple

import numpy as np

from .asset_cache import AssetCache
from .background import fit_to_canvas
from .blend import draw_image
from .camera import apply_camera
from .ffmpeg_writer import write_frames
from .slots import Slot, active_drawing
from .timeline_loader import Layer, Scene, Timeline


class _Placed(NamedTuple):
    """A fully-resolved, world-space placement for one drawable (the
    parent's own base image, or one of its children)."""

    z: int
    x: float
    y: float
    scale: float
    flip_x: bool
    rotation: float
    opacity: float
    anchor: str
    asset: Path
    slots: dict[str, Slot]


def _resolve_layer_placements(layer: Layer) -> list[_Placed]:
    t = layer.transform
    placements = [
        _Placed(
            z=0, x=t.x, y=t.y, scale=t.scale, flip_x=t.flip_x, rotation=t.rotation,
            opacity=t.opacity, anchor=t.anchor, asset=layer.asset, slots=layer.slots,
        )
    ]
    for child in layer.children:
        mirrored_offset_x = -child.offset_x if t.flip_x else child.offset_x
        child_x = t.x + mirrored_offset_x * t.scale
        child_y = t.y + child.offset_y * t.scale
        placements.append(
            _Placed(
                z=child.z,
                x=child_x,
                y=child_y,
                scale=t.scale * child.scale,
                flip_x=(t.flip_x != child.flip_x),  # composed (XOR): inherits parent flip by default
                rotation=child.rotation,
                opacity=t.opacity * child.opacity,
                anchor=child.pivot,
                asset=child.asset,
                slots=child.slots,
            )
        )
    return sorted(placements, key=lambda p: p.z)


def _draw_slot(canvas: np.ndarray, cache: AssetCache, slot: Slot, owner: _Placed, owner_local_frame_idx: int, fps: int) -> None:
    drawing = active_drawing(slot, owner_local_frame_idx, fps)
    image_path = slot.resolve_image(drawing)
    if image_path is None:
        return

    mirrored_offset_x = -slot.offset_x if owner.flip_x else slot.offset_x
    slot_x = owner.x + mirrored_offset_x * owner.scale
    slot_y = owner.y + slot.offset_y * owner.scale

    img = cache.get_variant(image_path, scale=owner.scale, flip_x=owner.flip_x)
    draw_image(canvas, img, slot_x, slot_y, anchor="center", opacity=owner.opacity)


def _draw_layer(canvas: np.ndarray, layer: Layer, cache: AssetCache, layer_local_frame_idx: int, fps: int) -> None:
    for placed in _resolve_layer_placements(layer):
        img = cache.get_variant(placed.asset, scale=placed.scale, flip_x=placed.flip_x, rotation=placed.rotation)
        draw_image(canvas, img, placed.x, placed.y, anchor=placed.anchor, opacity=placed.opacity)
        for slot in placed.slots.values():
            _draw_slot(canvas, cache, slot, placed, layer_local_frame_idx, fps)


def iter_scene_frames(scene: Scene, canvas_w: int, canvas_h: int, fps: int, cache: AssetCache) -> Iterator[np.ndarray]:
    bg_raw = cache.get_raw(scene.background.asset)
    bg_fitted = fit_to_canvas(bg_raw, canvas_w, canvas_h, scene.background.fit)

    sorted_layers = sorted(scene.layers, key=lambda l: l.z)
    frame_step = max(1, scene.frame_step)

    held_canvas: np.ndarray | None = None
    for frame_idx in range(scene.total_frames):
        if held_canvas is None or frame_idx % frame_step == 0:
            canvas = bg_fitted.copy()
            for layer in sorted_layers:
                if layer.is_visible_at(frame_idx, scene.total_frames):
                    _draw_layer(canvas, layer, cache, frame_idx - layer.start_frame, fps)
            canvas = apply_camera(canvas, scene.camera, frame_idx, fps)
            held_canvas = canvas
        # On held frames (frame_step > 1) we deliberately re-yield the exact
        # same array instead of recomposing -- the classic cut-out "on Ns"
        # cadence. Audio is unaffected: it's mixed by FFmpeg against wall-clock
        # start times, never against this per-frame compositing loop.
        yield held_canvas


def iter_frames(timeline: Timeline, cache: AssetCache | None = None) -> Iterator[np.ndarray]:
    """Yield every frame of the full timeline, in order, scene by scene."""

    cache = cache if cache is not None else AssetCache()
    canvas_w, canvas_h = timeline.canvas.width, timeline.canvas.height
    for scene in timeline.scenes:
        yield from iter_scene_frames(scene, canvas_w, canvas_h, timeline.fps, cache)


def render(
    timeline: Timeline,
    output_path: Path,
    codec: str = "h264",
) -> Path:
    """Render a Timeline to ``output_path``, streaming frames into FFmpeg."""

    estimated, total = timeline.dialogue_line_counts()
    if total:
        print(f"{estimated} of {total} lines are estimated/silent")

    cache = AssetCache()
    frames = iter_frames(timeline, cache)
    write_frames(
        frames,
        output_path=output_path,
        width=timeline.canvas.width,
        height=timeline.canvas.height,
        fps=timeline.fps,
        codec=codec,
        audio_clips=timeline.all_audio_clips(),
        total_frames=timeline.total_frames,
    )
    return Path(output_path)
