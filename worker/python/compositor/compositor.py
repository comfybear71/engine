"""The main compositing loop: timeline -> stream of canvas-sized BGR frames.

``iter_frames`` is a generator. It yields one frame at a time and holds at
most one frame (plus the cached assets) in memory -- it never builds a
list of frames for a scene or the whole render. That matters because a
feature-length episode at 1920x1080 could easily be tens of gigabytes of
raw frames; this is what lets ``render()`` stream them straight into
FFmpeg's stdin frame-by-frame instead of buffering in RAM or on disk.

Each top-level ``Layer`` -- a character or a location prop -- is composited
as a self-contained local rig: its own base image plus any ``children``
(head, arms, ...), stacked among themselves by their own ``z`` (relative to
the parent, not the scene), with the parent's position/scale/flip applied to
all of them. Any ``slots`` attached to the layer or to a specific child
(mouth, eyes, hand pose, ...) are drawn immediately on top of their owner,
at the owner's effective position. Props and characters share one scene
layer list and are drawn together in ascending ``z``; the background is
painted first and stays behind every layer.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, NamedTuple

import cv2
import numpy as np

from .asset_cache import AssetCache, anchor_after_rotation
from .background import fit_to_canvas
from .blend import draw_image
from .camera import apply_camera
from .ffmpeg_writer import write_frames
from .slots import Slot, active_drawing, slot_is_visible
from .timeline_loader import Child, Layer, Scene, Timeline, child_rotation_at, transform_at
from .transform import rotate_offset_clockwise


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


def _place_child_on_parent(parent: _Placed, child: Child, local_frame: int) -> _Placed:
    """Place ``child`` in ``parent``'s local space, rotating the offset
    about the parent's pivot by the parent's current rotation."""

    mirrored_x = -child.offset_x if parent.flip_x else child.offset_x
    rotated_x, rotated_y = rotate_offset_clockwise(mirrored_x, child.offset_y, parent.rotation)
    return _Placed(
        z=child.z,
        x=parent.x + rotated_x * parent.scale,
        y=parent.y + rotated_y * parent.scale,
        scale=parent.scale * child.scale,
        flip_x=(parent.flip_x != child.flip_x),
        rotation=parent.rotation + child_rotation_at(child, local_frame),
        opacity=parent.opacity * child.opacity,
        anchor=child.pivot,
        asset=child.asset,
        slots=child.slots,
    )


def _resolve_layer_placements(layer: Layer, local_frame: int = 0) -> list[_Placed]:
    t = transform_at(layer, local_frame)
    root = _Placed(
        z=0, x=t.x, y=t.y, scale=t.scale, flip_x=t.flip_x, rotation=t.rotation,
        opacity=t.opacity, anchor=t.anchor, asset=layer.asset, slots=layer.slots,
    )
    placements = [root]
    placed_by_id: dict[str, _Placed] = {}

    # Top-level children (no child.parent) stay at their unrotated offset
    # relative to the layer -- layer.rotation is still not composed into
    # child placement (documented limitation). Their own rotation is applied
    # around their own pivot via the pivot-fixed draw path.
    for child in layer.children:
        if child.parent:
            continue
        layer_space = _Placed(
            z=0, x=t.x, y=t.y, scale=t.scale, flip_x=t.flip_x, rotation=0.0,
            opacity=t.opacity, anchor=t.anchor, asset=layer.asset, slots={},
        )
        placed = _place_child_on_parent(layer_space, child, local_frame)
        placed_by_id[child.id] = placed
        placements.append(placed)

    for child in layer.children:
        if not child.parent:
            continue
        parent_placed = placed_by_id[child.parent]
        placed = _place_child_on_parent(parent_placed, child, local_frame)
        placed_by_id[child.id] = placed
        placements.append(placed)

    return sorted(placements, key=lambda p: p.z)


def _draw_transformed(
    canvas: np.ndarray,
    cache: AssetCache,
    path: Path,
    x: float,
    y: float,
    scale: float,
    flip_x: bool,
    rotation: float,
    anchor: str,
    opacity: float,
) -> None:
    """Draw a scaled/flipped/rotated asset so ``anchor`` stays at ``(x, y)``.

    ``AssetCache`` rotates about the image centre and expands the canvas.
    We then find where the original (post-scale) anchor landed in that
    expanded image and place the top-left so that point sits on ``(x, y)``.
    """

    img = cache.get_variant(path, scale=scale, flip_x=flip_x, rotation=rotation)
    src_w, src_h = cache.pre_rotation_size(path, scale)
    pivot_x, pivot_y = anchor_after_rotation(src_w, src_h, anchor, rotation)
    draw_image(canvas, img, x - pivot_x, y - pivot_y, anchor="top-left", opacity=opacity)


def _collect_slot_drawings(layer: Layer, local_frame: int, fps: int) -> dict[str, str | None]:
    drawings: dict[str, str | None] = {}
    for name, slot in layer.slots.items():
        drawings[name] = active_drawing(slot, local_frame, fps)
    for child in layer.children:
        for name, slot in child.slots.items():
            drawings[name] = active_drawing(slot, local_frame, fps)
    return drawings


def _draw_slot(
    canvas: np.ndarray,
    cache: AssetCache,
    slot: Slot,
    owner: _Placed,
    owner_local_frame_idx: int,
    fps: int,
    drawings: dict[str, str | None],
) -> None:
    if not slot_is_visible(slot, drawings):
        return
    drawing = active_drawing(slot, owner_local_frame_idx, fps)
    image_path = slot.resolve_image(drawing)
    if image_path is None:
        return

    mirrored_x = -slot.offset_x if owner.flip_x else slot.offset_x
    rotated_x, rotated_y = rotate_offset_clockwise(mirrored_x, slot.offset_y, owner.rotation)
    slot_x = owner.x + rotated_x * owner.scale
    slot_y = owner.y + rotated_y * owner.scale
    # Slot scale/rotation are around the attachment point (center anchor),
    # so the offset stays put when the drawing is resized.
    slot_scale = owner.scale * (slot.scale if slot.scale else 1.0)
    slot_rotation = owner.rotation + slot.rotation

    _draw_transformed(
        canvas, cache, image_path,
        slot_x, slot_y, slot_scale, owner.flip_x, slot_rotation,
        anchor="center", opacity=owner.opacity,
    )


def _draw_layer(canvas: np.ndarray, layer: Layer, cache: AssetCache, layer_local_frame_idx: int, fps: int) -> None:
    drawings = _collect_slot_drawings(layer, layer_local_frame_idx, fps)
    for placed in _resolve_layer_placements(layer, layer_local_frame_idx):
        _draw_transformed(
            canvas, cache, placed.asset,
            placed.x, placed.y, placed.scale, placed.flip_x, placed.rotation,
            placed.anchor, placed.opacity,
        )
        for slot in placed.slots.values():
            _draw_slot(canvas, cache, slot, placed, layer_local_frame_idx, fps, drawings)


def compose_scene_frame(
    scene: Scene,
    local_frame: int,
    canvas_w: int,
    canvas_h: int,
    fps: int,
    cache: AssetCache,
    bg_fitted: np.ndarray | None = None,
) -> np.ndarray:
    """Compose one scene-local frame, honoring ``frame_step`` hold cadence."""

    if bg_fitted is None:
        bg_raw = cache.get_raw(scene.background.asset)
        bg_fitted = fit_to_canvas(bg_raw, canvas_w, canvas_h, scene.background.fit)

    frame_step = max(1, scene.frame_step)
    composed_idx = local_frame - (local_frame % frame_step)
    canvas = bg_fitted.copy()
    for layer in sorted(scene.layers, key=lambda l: l.z):
        if layer.is_visible_at(composed_idx, scene.total_frames):
            _draw_layer(canvas, layer, cache, composed_idx - layer.start_frame, fps)
    return apply_camera(canvas, scene.camera, composed_idx, fps)


def iter_scene_frames(scene: Scene, canvas_w: int, canvas_h: int, fps: int, cache: AssetCache) -> Iterator[np.ndarray]:
    bg_raw = cache.get_raw(scene.background.asset)
    bg_fitted = fit_to_canvas(bg_raw, canvas_w, canvas_h, scene.background.fit)

    # Character and prop layers share this list and are drawn together in
    # ascending z. The fitted background is painted first and stays behind
    # every layer.
    frame_step = max(1, scene.frame_step)

    held_canvas: np.ndarray | None = None
    for frame_idx in range(scene.total_frames):
        if held_canvas is None or frame_idx % frame_step == 0:
            held_canvas = compose_scene_frame(
                scene, frame_idx, canvas_w, canvas_h, fps, cache, bg_fitted=bg_fitted
            )
        # On held frames (frame_step > 1) we deliberately re-yield the exact
        # same array instead of recomposing -- the classic cut-out "on Ns"
        # cadence. Audio is unaffected: it's mixed by FFmpeg against wall-clock
        # start times, never against this per-frame compositing loop.
        yield held_canvas


def clamp_preview_frame(timeline: Timeline, frame_index: int) -> int:
    """Clamp a Studio preview request onto ``[0, total_frames-1]``."""

    total = int(timeline.total_frames or 0)
    if total <= 0:
        return 0
    try:
        index = int(frame_index)
    except (TypeError, ValueError):
        return 0
    return max(0, min(index, total - 1))


def scene_at_frame(timeline: Timeline, frame_index: int) -> tuple[Scene, int]:
    """Return ``(scene, local_frame)`` for a 0-based global frame index."""

    if frame_index < 0:
        raise ValueError(f"frame_index must be >= 0, got {frame_index}")
    elapsed = 0
    for scene in timeline.scenes:
        if frame_index < elapsed + scene.total_frames:
            return scene, frame_index - elapsed
        elapsed += scene.total_frames
    raise ValueError(
        f"frame_index {frame_index} is past the end of the timeline ({timeline.total_frames} frames)"
    )


def compose_frame(timeline: Timeline, frame_index: int, cache: AssetCache | None = None) -> np.ndarray:
    """Compose one global timeline frame (used by the Studio preview-frame API)."""

    cache = cache if cache is not None else AssetCache()
    scene, local_frame = scene_at_frame(timeline, frame_index)
    return compose_scene_frame(
        scene, local_frame, timeline.canvas.width, timeline.canvas.height, timeline.fps, cache
    )


def iter_frames(timeline: Timeline, cache: AssetCache | None = None) -> Iterator[np.ndarray]:
    """Yield every frame of the full timeline, in order, scene by scene."""

    cache = cache if cache is not None else AssetCache()
    canvas_w, canvas_h = timeline.canvas.width, timeline.canvas.height
    for scene in timeline.scenes:
        yield from iter_scene_frames(scene, canvas_w, canvas_h, timeline.fps, cache)


def scale_frame(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    """Resize a composed BGR frame for a low-res proxy without changing layout math."""
    out_w = max(2, int(width) - int(width) % 2)
    out_h = max(2, int(height) - int(height) % 2)
    src_h, src_w = frame.shape[:2]
    if src_w == out_w and src_h == out_h:
        return frame
    interp = cv2.INTER_AREA if out_w * out_h < src_w * src_h else cv2.INTER_LINEAR
    return cv2.resize(frame, (out_w, out_h), interpolation=interp)


def render(
    timeline: Timeline,
    output_path: Path,
    codec: str = "h264",
    width: int | None = None,
    height: int | None = None,
) -> Path:
    """Render a Timeline to ``output_path``, streaming frames into FFmpeg."""

    estimated, total = timeline.dialogue_line_counts()
    if total:
        print(f"{estimated} of {total} lines are estimated/silent")

    out_w = int(width) if width else timeline.canvas.width
    out_h = int(height) if height else timeline.canvas.height
    out_w = max(2, out_w - out_w % 2)
    out_h = max(2, out_h - out_h % 2)

    cache = AssetCache()
    frames = iter_frames(timeline, cache)
    if out_w != timeline.canvas.width or out_h != timeline.canvas.height:
        frames = (scale_frame(frame, out_w, out_h) for frame in frames)
    write_frames(
        frames,
        output_path=output_path,
        width=out_w,
        height=out_h,
        fps=timeline.fps,
        codec=codec,
        audio_clips=timeline.all_audio_clips(),
        total_frames=timeline.total_frames,
    )
    return Path(output_path)
