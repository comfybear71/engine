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

import re
from pathlib import Path
from typing import Iterator, NamedTuple

import cv2
import numpy as np

from .asset_cache import AssetCache, anchor_after_rotation, point_after_rotation
from .background import fit_to_canvas, fit_to_canvas_camera
from .blend import draw_image
from .camera import CameraView, camera_view, scale_camera
from .ffmpeg_writer import write_frames
from .lipsync_natural import slot_head_bob
from .sequence import layer_at_sequence_frame
from .slots import Slot, _find_active_clip, active_drawing, drawing_align, is_hide_drawing, slot_is_visible
from .timeline_loader import (
    Child,
    Layer,
    Scene,
    Timeline,
    child_rotation_at,
    group_rotation_at,
    layer_view_at,
    transform_at,
)
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
    pivot_px: tuple[float, float] | None = None


def _visible_when_matches(visible_when: dict[str, list[str]], drawings: dict[str, str | None]) -> bool:
    """Same gate as ``slot_is_visible``: every named slot's drawing is allowed."""

    if not visible_when:
        return True
    for other_name, allowed in visible_when.items():
        if drawings.get(other_name) not in allowed:
            return False
    return True


_WALK_DRAWING = re.compile(r"^(walk|run)_", re.I)


def is_walk_frame_name(name: str | None) -> bool:
    """True for walk_side_01 / walk_side_long_stride_01, not a standing ``walk``."""

    return bool(name and _WALK_DRAWING.match(str(name).strip()))


def is_walk_cycle_drawing(drawings: dict[str, str | None] | None) -> bool:
    """True when the body piece on screen is a whole-body walk/run frame.

    Factory walks (and the painted ``walk_side_*`` set) replace torso/body
    with a hat-to-boots drawing. Overlay children — standing torso_rig,
    shirt, shorts, separate arms — and every other slot (head, hat, eyes,
    mouth, collar, legs) must not composite on top of that.
    """

    if not drawings:
        return False
    torso = drawings.get("torso")
    if torso:
        return is_walk_frame_name(torso)
    body = drawings.get("body")
    if body:
        return is_walk_frame_name(body)
    return False


def _place_child_on_parent(parent: _Placed, child: Child, local_frame: int) -> _Placed:
    """Place ``child`` in ``parent``'s local space, rotating the offset
    about the parent's pivot by the parent's current rotation.

    When the parent is flipped, offset rotation uses ``-parent.rotation``
    and the child is drawn at ``-child_rotation`` so a swing mirrors
    instead of rotating the same way on both facings.
    """

    child_rot = child_rotation_at(child, local_frame)
    if parent.flip_x:
        offset_rot = -parent.rotation
        draw_child_rot = -child_rot
    else:
        offset_rot = parent.rotation
        draw_child_rot = child_rot
    mirrored_x = -child.offset_x if parent.flip_x else child.offset_x
    rotated_x, rotated_y = rotate_offset_clockwise(mirrored_x, child.offset_y, offset_rot)
    return _Placed(
        z=child.z,
        x=parent.x + rotated_x * parent.scale,
        y=parent.y + rotated_y * parent.scale,
        scale=parent.scale * child.scale,
        flip_x=(parent.flip_x != child.flip_x),
        rotation=parent.rotation + draw_child_rot,
        opacity=parent.opacity * child.opacity,
        anchor=child.pivot,
        asset=child.asset,
        slots=child.slots,
        pivot_px=child.pivot_px,
    )


def _resolve_layer_placements(
    layer: Layer,
    local_frame: int = 0,
    world_scale: float = 1.0,
    drawings: dict[str, str | None] | None = None,
) -> list[_Placed]:
    t = transform_at(layer, local_frame)
    s = float(world_scale) if world_scale else 1.0
    root = _Placed(
        z=0, x=t.x * s, y=t.y * s, scale=t.scale * s, flip_x=t.flip_x, rotation=t.rotation,
        opacity=t.opacity, anchor=t.anchor, asset=layer.asset, slots=layer.slots,
    )
    placements = [root]
    placed_by_id: dict[str, _Placed] = {}

    # Same scaled space as ``root``. Children used to sit on unscaled (x, y,
    # scale) while the body/head slots used ``s`` -- Stage's 960×540 preview
    # then drew the head in half-res and the torso/arms in 1920 space.
    # Layer rotation (body lean) is composed into every child's offset and
    # world rotation so the whole rig turns about the layer anchor. Children
    # are placed parent-before-child so chains of any depth accumulate.
    layer_space = root._replace(slots={})
    hide_rig_base = is_walk_cycle_drawing(drawings)
    for child in _children_parent_before_child(layer.children):
        if hide_rig_base:
            # Whole-body walk frames already include body, legs, cape, arms.
            continue
        if drawings is not None and not _visible_when_matches(child.visible_when, drawings):
            continue
        if child.parent:
            if child.parent not in placed_by_id:
                continue
            parent_placed = placed_by_id[child.parent]
        else:
            parent_placed = layer_space
        placed = _place_child_on_parent(parent_placed, child, local_frame)
        placed_by_id[child.id] = placed
        placements.append(placed)

    return sorted(placements, key=lambda p: p.z)


def _children_parent_before_child(children: list[Child]) -> list[Child]:
    """Stable topological order: a parent is emitted before any child of it."""

    by_id = {child.id: child for child in children}
    ordered: list[Child] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(child: Child) -> None:
        if child.id in visited:
            return
        if child.id in visiting:
            return
        visiting.add(child.id)
        parent_id = child.parent
        if parent_id and parent_id in by_id:
            visit(by_id[parent_id])
        visiting.remove(child.id)
        visited.add(child.id)
        ordered.append(child)

    for child in children:
        visit(child)
    return ordered


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
    pivot: tuple[float, float] | None = None,
) -> None:
    """Draw a scaled/flipped/rotated asset so ``anchor`` stays at ``(x, y)``.

    ``AssetCache`` rotates about the image centre and expands the canvas.
    We then find where the original (post-scale) anchor landed in that
    expanded image and place the top-left so that point sits on ``(x, y)``.
    When ``pivot`` is given (unscaled image pixels), that point is used
    instead of the named ``anchor`` -- after scale and optional flip.
    """

    img = cache.get_variant(path, scale=scale, flip_x=flip_x, rotation=rotation)
    src_w, src_h = cache.pre_rotation_size(path, scale)
    if pivot is not None:
        raw = cache.get_raw(path)
        raw_h, raw_w = raw.shape[:2]
        sx = (src_w / raw_w) if raw_w else scale
        sy = (src_h / raw_h) if raw_h else scale
        px = float(pivot[0]) * sx
        py = float(pivot[1]) * sy
        if flip_x:
            px = src_w - px
        pivot_x, pivot_y = point_after_rotation(src_w, src_h, px, py, rotation)
    else:
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


LEGACY_FULL_HEAD_SLOTS = frozenset({"head", "face", "eyes"})


def _layer_view_at(layer: Layer, local_frame: int) -> str | None:
    """Active dialogue view, else held view_keyframes, else last started clip."""

    return layer_view_at(layer, local_frame)


def _suppressed_head_slots(layer: Layer) -> set[str]:
    group = layer.groups.get("head") if layer.groups else None
    if not group:
        return set()
    members = set(group)
    return {name for name in LEGACY_FULL_HEAD_SLOTS if name not in members}


def _sorted_slots(slots: dict[str, Slot]) -> list[tuple[str, Slot]]:
    """Sort by (z or 0, declaration order)."""

    items = list(slots.items())
    return [
        item
        for _, item in sorted(
            ((slot.z if slot.z is not None else 0, index), (name, slot))
            for index, (name, slot) in enumerate(items)
        )
    ]


def _draw_slot(
    canvas: np.ndarray,
    cache: AssetCache,
    slot: Slot,
    owner: _Placed,
    owner_local_frame_idx: int,
    fps: int,
    drawings: dict[str, str | None],
    view: str | None = None,
    group_rot: float = 0.0,
    group_pivot: tuple[float, float] | None = None,
    camera: CameraView | None = None,
) -> None:
    if not slot_is_visible(slot, drawings):
        return
    drawing = active_drawing(slot, owner_local_frame_idx, fps)
    if drawing is None or is_hide_drawing(drawing):
        return
    slot_view = view
    if slot_view is None and slot.dialogue is not None:
        clip = _find_active_clip(slot.dialogue, owner_local_frame_idx)
        slot_view = getattr(clip, "view", None) if clip is not None else None
    image_path = slot.resolve_image(drawing, view=slot_view)
    if image_path is None:
        return

    # Per-drawing align (Studio Save) sits on top of the slot offset/scale.
    # Same units as the panel: x/y in local pixels, scale as a multiplier.
    # Anchored at the (nudged) attachment point: image centre, or canvas.pivot.
    align = drawing_align(slot, drawing)
    local_x = slot.offset_x + align.x
    local_y = slot.offset_y + align.y
    # Rigid group rotation about the group pivot (typically the neck).
    # Flip mirrors the angle, same as child swings.
    group_draw = -group_rot if owner.flip_x else group_rot
    gx, gy = group_pivot if group_pivot is not None else (local_x, local_y)
    mirrored_x = -local_x if owner.flip_x else local_x
    mirrored_gx = -gx if owner.flip_x else gx
    rdx, rdy = rotate_offset_clockwise(mirrored_x - mirrored_gx, local_y - gy, group_draw)
    att_x = mirrored_gx + rdx
    att_y = gy + rdy
    rotated_x, rotated_y = rotate_offset_clockwise(att_x, att_y, owner.rotation)
    bob_dy, bob_rot = slot_head_bob(slot, owner_local_frame_idx)
    slot_x = owner.x + rotated_x * owner.scale
    slot_y = owner.y + rotated_y * owner.scale + bob_dy
    # Slot scale/rotation (and align.scale) are around the attachment point
    # (center, or the canvas neck pivot when set), so the offset stays put.
    slot_scale = owner.scale * (slot.scale if slot.scale else 1.0) * (align.scale if align.scale else 1.0)
    if camera is not None:
        slot_x, slot_y, slot_scale = camera.map_placement(slot_x, slot_y, slot_scale)
    slot_rotation = owner.rotation + slot.rotation + group_draw + bob_rot
    pivot = (slot.pivot_x, slot.pivot_y) if slot.has_canvas else None
    anchor = "center" if pivot is None else "top-left"

    _draw_transformed(
        canvas, cache, image_path,
        slot_x, slot_y, slot_scale, owner.flip_x, slot_rotation,
        anchor=anchor, opacity=owner.opacity, pivot=pivot,
    )


def _draw_layer(
    canvas: np.ndarray,
    layer: Layer,
    cache: AssetCache,
    layer_local_frame_idx: int,
    fps: int,
    world_scale: float = 1.0,
    camera: CameraView | None = None,
) -> None:
    if layer.sequence is not None:
        layer = layer_at_sequence_frame(layer, layer_local_frame_idx, fps)
        cache.note_sequence_frame(layer.id, layer.asset)
    drawings = _collect_slot_drawings(layer, layer_local_frame_idx, fps)
    hide_rig_base = is_walk_cycle_drawing(drawings)
    suppressed = _suppressed_head_slots(layer)
    layer_view = _layer_view_at(layer, layer_local_frame_idx)
    group_rot_by_slot: dict[str, float] = {}
    group_pivot_by_slot: dict[str, tuple[float, float]] = {}
    for group_name, members in (layer.groups or {}).items():
        rot = group_rotation_at(layer, group_name, layer_local_frame_idx)
        pivot_slot = None
        for member in members:
            if member in layer.slots:
                pivot_slot = layer.slots[member]
                break
            for child in layer.children:
                if member in child.slots:
                    pivot_slot = child.slots[member]
                    break
            if pivot_slot is not None:
                break
        pivot_xy = (pivot_slot.offset_x, pivot_slot.offset_y) if pivot_slot is not None else (0.0, 0.0)
        for member in members:
            group_rot_by_slot[member] = rot
            group_pivot_by_slot[member] = pivot_xy
    for placed in _resolve_layer_placements(
        layer, layer_local_frame_idx, world_scale=world_scale, drawings=drawings
    ):
        pivot = placed.pivot_px
        anchor = "top-left" if pivot is not None else placed.anchor
        draw_x, draw_y, draw_scale = placed.x, placed.y, placed.scale
        if camera is not None:
            draw_x, draw_y, draw_scale = camera.map_placement(draw_x, draw_y, draw_scale)
        _draw_transformed(
            canvas, cache, placed.asset,
            draw_x, draw_y, draw_scale, placed.flip_x, placed.rotation,
            anchor, placed.opacity, pivot=pivot,
        )
        for name, slot in _sorted_slots(placed.slots):
            if name in suppressed:
                continue
            if hide_rig_base and not is_walk_frame_name(drawings.get(name)):
                # Head, hat, eyes, mouth, legs, standing body — the walk
                # drawing already includes them.
                continue
            _draw_slot(
                canvas, cache, slot, placed, layer_local_frame_idx, fps, drawings,
                view=layer_view,
                group_rot=group_rot_by_slot.get(name, 0.0),
                group_pivot=group_pivot_by_slot.get(name),
                camera=camera,
            )


def compose_scene_frame(
    scene: Scene,
    local_frame: int,
    canvas_w: int,
    canvas_h: int,
    fps: int,
    cache: AssetCache,
    bg_fitted: np.ndarray | None = None,
    out_width: int | None = None,
    out_height: int | None = None,
) -> np.ndarray:
    """Compose one scene-local frame, honoring ``frame_step`` hold cadence.

    ``out_width`` / ``out_height`` compose onto a smaller canvas by scaling
    placements and camera into that space. Studio preview does **not** use
    this path: ``compose_frame`` matches CLI ``render()`` (full canvas, then
    ``scale_frame``).

    A non-identity camera is folded into each layer's placement (and the
    background sample) so pieces are resampled once from source. Zoom 1
    with the centre on the canvas centre skips that path entirely.
    """

    orig_w, orig_h = canvas_w, canvas_h
    world_scale = 1.0
    if out_width and out_height:
        canvas_w = max(2, int(out_width) - int(out_width) % 2)
        canvas_h = max(2, int(out_height) - int(out_height) % 2)
        world_scale = min(canvas_w / float(orig_w), canvas_h / float(orig_h))
        bg_fitted = None

    frame_step = max(1, scene.frame_step)
    composed_idx = local_frame - (local_frame % frame_step)
    view = camera_view(
        scale_camera(scene.camera, world_scale), canvas_w, canvas_h, composed_idx, fps
    )

    if view.is_identity:
        if bg_fitted is None:
            bg_raw = cache.get_raw(scene.background.asset)
            bg_fitted = fit_to_canvas(bg_raw, canvas_w, canvas_h, scene.background.fit)
        canvas = bg_fitted.copy()
        draw_camera = None
    else:
        bg_raw = cache.get_raw(scene.background.asset)
        canvas = fit_to_canvas_camera(
            bg_raw, canvas_w, canvas_h, scene.background.fit, view.cx, view.cy, view.zoom
        )
        draw_camera = view

    for layer in sorted(scene.layers, key=lambda l: l.z):
        if layer.is_visible_at(composed_idx, scene.total_frames):
            _draw_layer(
                canvas, layer, cache, composed_idx - layer.start_frame, fps,
                world_scale=world_scale, camera=draw_camera,
            )
    return canvas


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


def compose_frame(
    timeline: Timeline,
    frame_index: int,
    cache: AssetCache | None = None,
    width: int | None = None,
    height: int | None = None,
) -> np.ndarray:
    """Compose one global timeline frame the same way CLI ``render()`` does.

    Full-canvas compose first (identity camera / rig math). If ``width`` and
    ``height`` are set, ``scale_frame`` the result — the same resize CLI uses
    for a proxy render. Do not pre-scale placements here; that path drifted
    from the renderer (child offsets ignored ``world_scale``).
    """

    cache = cache if cache is not None else AssetCache()
    scene, local_frame = scene_at_frame(timeline, frame_index)
    canvas = compose_scene_frame(
        scene,
        local_frame,
        timeline.canvas.width,
        timeline.canvas.height,
        timeline.fps,
        cache,
    )
    if width and height:
        return scale_frame(canvas, width, height)
    return canvas


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
