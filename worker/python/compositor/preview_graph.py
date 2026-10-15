"""Serialize a loaded Timeline for the Studio canvas preview.

Studio draws Stage from this graph plus cached textures. Placement numbers
come from the same compositor functions the CLI uses, so a lock test can
compare the JS ``evaluateFrame`` draw list to :func:`evaluate_draw_ops`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .asset_cache import AssetCache
from .background import fit_to_canvas, fit_to_canvas_camera
from .camera import camera_view
from .compositor import (
    _collect_slot_drawings,
    _draw_transformed,
    _resolve_layer_placements,
    _sorted_slots,
    _suppressed_head_slots,
    scene_at_frame,
)
from .sequence import layer_at_sequence_frame
from .slots import (
    Slot,
    _find_active_clip,
    active_drawing,
    drawing_align,
    is_hide_drawing,
    slot_is_visible,
)
from .timeline_loader import Child, Layer, Timeline, group_rotation_at, layer_view_at
from .transform import rotate_offset_clockwise
from .lipsync_natural import slot_head_bob

_SIZE_CACHE: dict[str, tuple[int, int]] = {}


def probe_size(path: Path) -> tuple[int, int]:
    key = str(path)
    cached = _SIZE_CACHE.get(key)
    if cached is not None:
        return cached
    img = cv2.imread(key, cv2.IMREAD_UNCHANGED)
    if img is None:
        _SIZE_CACHE[key] = (1, 1)
        return 1, 1
    height, width = img.shape[:2]
    _SIZE_CACHE[key] = (int(width), int(height))
    return _SIZE_CACHE[key]


def rel_for(path: Path, project_dir: Path) -> str:
    abs_path = Path(path).resolve()
    try:
        return abs_path.relative_to(Path(project_dir).resolve()).as_posix()
    except ValueError:
        parts = abs_path.parts
        for marker in ("characters", "locations", "props", "backgrounds", "assets"):
            if marker in parts:
                return "/".join(parts[parts.index(marker) :])
        return abs_path.name


def _image_ref(path: Path, project_dir: Path) -> dict[str, Any]:
    width, height = probe_size(path)
    return {"rel": rel_for(path, project_dir), "width": width, "height": height}


def _dump_cues(cues) -> list[dict[str, Any]]:
    return [{"start": float(c.start), "end": float(c.end), "shape": c.shape} for c in cues or []]


def _dump_dialogue(clips) -> list[dict[str, Any]]:
    out = []
    for clip in clips or []:
        out.append(
            {
                "start_frame": int(getattr(clip, "start_frame", 0)),
                "duration_frames": int(getattr(clip, "duration_frames", 0)),
                "view": getattr(clip, "view", None),
                "cues": _dump_cues(getattr(clip, "cues", None)),
            }
        )
    return out


def _dump_slot(slot: Slot, project_dir: Path) -> dict[str, Any]:
    return {
        "offset_x": slot.offset_x,
        "offset_y": slot.offset_y,
        "scale": slot.scale,
        "rotation": slot.rotation,
        "z": slot.z,
        "images": {name: _image_ref(path, project_dir) for name, path in slot.images.items()},
        "images_by_view": {
            view: {name: _image_ref(path, project_dir) for name, path in pool.items()}
            for view, pool in (slot.images_by_view or {}).items()
        },
        "align": {
            name: {"x": align.x, "y": align.y, "scale": align.scale} for name, align in slot.align.items()
        },
        "visible_when": dict(slot.visible_when or {}),
        "keyframes": (
            [
                {"frame": kf.frame, "drawing": kf.drawing, "cycle": kf.cycle, "fps": kf.fps}
                for kf in slot.keyframes
            ]
            if slot.keyframes
            else None
        ),
        "cues": _dump_cues(slot.cues) if slot.cues is not None else None,
        "dialogue": _dump_dialogue(slot.dialogue) if slot.dialogue is not None else None,
        "head_bob_starts": list(slot.head_bob_starts or []),
        "head_bob_amp": slot.head_bob_amp,
        "head_bob_rotation": slot.head_bob_rotation,
        "canvas_w": slot.canvas_w,
        "canvas_h": slot.canvas_h,
        "pivot_x": slot.pivot_x,
        "pivot_y": slot.pivot_y,
        "exclude_from_lipsync": sorted(slot.exclude_from_lipsync),
    }


def _dump_child(child: Child, project_dir: Path) -> dict[str, Any]:
    width, height = probe_size(child.asset)
    return {
        "id": child.id,
        "parent": child.parent,
        "rel": rel_for(child.asset, project_dir),
        "width": width,
        "height": height,
        "z": child.z,
        "offset_x": child.offset_x,
        "offset_y": child.offset_y,
        "pivot": child.pivot,
        "scale": child.scale,
        "flip_x": child.flip_x,
        "rotation": child.rotation,
        "opacity": child.opacity,
        "slots": {name: _dump_slot(slot, project_dir) for name, slot in child.slots.items()},
        "rotationKeyframes": [
            {"frame": kf.frame, "rotation": kf.rotation, "ease": kf.ease} for kf in child.rotation_keyframes
        ],
        "pivot_px": list(child.pivot_px) if child.pivot_px is not None else None,
        "visible_when": dict(child.visible_when or {}),
    }


def _dump_layer(layer: Layer, project_dir: Path) -> dict[str, Any]:
    width, height = probe_size(layer.asset)
    transform = layer.transform
    return {
        "id": layer.id,
        "z": layer.z,
        "rel": rel_for(layer.asset, project_dir),
        "width": width,
        "height": height,
        "startFrame": layer.start_frame,
        "endFrame": layer.end_frame,
        "transform": {
            "x": transform.x,
            "y": transform.y,
            "scale": transform.scale,
            "rotation": transform.rotation,
            "flip_x": transform.flip_x,
            "opacity": transform.opacity,
            "anchor": transform.anchor,
        },
        "transformKeyframes": [
            {
                "frame": kf.frame,
                "x": kf.x,
                "y": kf.y,
                "scale": kf.scale,
                "rotation": kf.rotation,
                "ease": kf.ease,
            }
            for kf in layer.transform_keyframes
        ],
        "slots": {name: _dump_slot(slot, project_dir) for name, slot in layer.slots.items()},
        "children": [_dump_child(child, project_dir) for child in layer.children],
        "groups": dict(layer.groups or {}),
        "groupRotations": dict(layer.group_rotations or {}),
        "groupRotationKeyframes": {
            name: [{"frame": kf.frame, "rotation": kf.rotation, "ease": kf.ease} for kf in keyframes]
            for name, keyframes in (layer.group_rotation_keyframes or {}).items()
        },
        "dialogue": _dump_dialogue(layer.dialogue),
        "viewKeyframes": [{"frame": kf.frame, "view": kf.view} for kf in layer.view_keyframes],
        "sequence": _dump_sequence(layer, project_dir),
    }


def _dump_sequence(layer: Layer, project_dir: Path) -> dict[str, Any] | None:
    seq = layer.sequence
    if seq is None:
        return None
    # `files` (not `rel`) so the preview does not preload every frame up front.
    return {
        "fps": seq.fps,
        "trimIn": seq.trim_in,
        "files": [rel_for(frame, project_dir) for frame in seq.frames],
    }


def _background_fit(mode: str, src_w: int, src_h: int, canvas_w: int, canvas_h: int) -> dict[str, float]:
    fit_scale = min(canvas_w / src_w, canvas_h / src_h) if mode == "contain" else max(canvas_w / src_w, canvas_h / src_h)
    fitted_w = max(1, round(src_w * fit_scale))
    fitted_h = max(1, round(src_h * fit_scale))
    if mode == "contain":
        origin_x = (canvas_w - fitted_w) / 2.0
        origin_y = (canvas_h - fitted_h) / 2.0
    else:
        origin_x = -max(0, (fitted_w - canvas_w) // 2)
        origin_y = -max(0, (fitted_h - canvas_h) // 2)
    return {
        "fitScale": fit_scale,
        "fittedW": fitted_w,
        "fittedH": fitted_h,
        "originX": origin_x,
        "originY": origin_y,
    }


def dump_preview_graph(timeline: Timeline) -> dict[str, Any]:
    """JSON-safe graph: loaded Timeline (lip-sync already applied) plus sizes."""

    project_dir = timeline.project_dir
    scenes = []
    for scene in timeline.scenes:
        bg_w, bg_h = probe_size(scene.background.asset)
        camera = None
        if scene.camera is not None:
            camera = {
                "keyframes": [
                    {"frame": kf.frame, "x": kf.x, "y": kf.y, "zoom": kf.zoom, "ease": kf.ease}
                    for kf in scene.camera.keyframes
                ],
                "shake": None,
            }
            if scene.camera.shake is not None:
                camera["shake"] = {
                    "amplitude_px": scene.camera.shake.amplitude_px,
                    "frequency_hz": scene.camera.shake.frequency_hz,
                    "start_frame": scene.camera.shake.start_frame,
                    "end_frame": scene.camera.shake.end_frame,
                }
        scenes.append(
            {
                "id": scene.id,
                "totalFrames": scene.total_frames,
                "frameStep": scene.frame_step,
                "camera": camera,
                "background": {
                    "rel": rel_for(scene.background.asset, project_dir),
                    "width": bg_w,
                    "height": bg_h,
                    "fit": scene.background.fit,
                },
                "layers": [_dump_layer(layer, project_dir) for layer in scene.layers],
            }
        )
    return {
        "fps": timeline.fps,
        "canvas": {"width": timeline.canvas.width, "height": timeline.canvas.height},
        "totalFrames": timeline.total_frames,
        "scenes": scenes,
    }


def _slot_command(
    slot: Slot,
    owner,
    local_frame: int,
    fps: int,
    drawings: dict[str, str | None],
    view: str | None,
    group_rot: float,
    group_pivot: tuple[float, float] | None,
    camera,
    project_dir: Path,
) -> dict[str, Any] | None:
    if not slot_is_visible(slot, drawings):
        return None
    drawing = active_drawing(slot, local_frame, fps)
    if drawing is None or is_hide_drawing(drawing):
        return None
    slot_view = view
    if slot_view is None and slot.dialogue is not None:
        clip = _find_active_clip(slot.dialogue, local_frame)
        slot_view = getattr(clip, "view", None) if clip is not None else None
    image_path = slot.resolve_image(drawing, view=slot_view)
    if image_path is None:
        return None
    align = drawing_align(slot, drawing)
    local_x = slot.offset_x + align.x
    local_y = slot.offset_y + align.y
    group_draw = -group_rot if owner.flip_x else group_rot
    gx, gy = group_pivot if group_pivot is not None else (local_x, local_y)
    mirrored_x = -local_x if owner.flip_x else local_x
    mirrored_gx = -gx if owner.flip_x else gx
    rdx, rdy = rotate_offset_clockwise(mirrored_x - mirrored_gx, local_y - gy, group_draw)
    att_x = mirrored_gx + rdx
    att_y = gy + rdy
    rotated_x, rotated_y = rotate_offset_clockwise(att_x, att_y, owner.rotation)
    bob_dy, bob_rot = slot_head_bob(slot, local_frame)
    slot_x = owner.x + rotated_x * owner.scale
    slot_y = owner.y + rotated_y * owner.scale + bob_dy
    slot_scale = owner.scale * (slot.scale if slot.scale else 1.0) * (align.scale if align.scale else 1.0)
    if camera is not None:
        slot_x, slot_y, slot_scale = camera.map_placement(slot_x, slot_y, slot_scale)
    width, height = probe_size(image_path)
    pivot = [slot.pivot_x, slot.pivot_y] if slot.has_canvas else None
    return {
        "kind": "sprite",
        "rel": rel_for(image_path, project_dir),
        "width": width,
        "height": height,
        "x": slot_x,
        "y": slot_y,
        "scale": slot_scale,
        "flipX": owner.flip_x,
        "rotation": owner.rotation + slot.rotation + group_draw + bob_rot,
        "opacity": owner.opacity,
        "anchor": "top-left" if pivot is not None else "center",
        "pivot": pivot,
    }


def background_dest_rect(cmd: dict[str, Any], canvas_w: int, canvas_h: int) -> dict[str, float]:
    """Canvas-pixel dest rect for a bg command (same numbers Studio must draw)."""

    zoom = float(cmd.get("zoom") or 1)
    src_w = float(cmd.get("width") or canvas_w or 1)
    src_h = float(cmd.get("height") or canvas_h or 1)
    cx = canvas_w / 2.0 if cmd.get("cx") is None else float(cmd["cx"])
    cy = canvas_h / 2.0 if cmd.get("cy") is None else float(cmd["cy"])
    origin_x = float(cmd.get("originX") or 0)
    origin_y = float(cmd.get("originY") or 0)
    sx = float(cmd.get("sx") or zoom)
    sy = float(cmd.get("sy") or zoom)
    return {
        "x": canvas_w / 2.0 + (origin_x - cx) * zoom,
        "y": canvas_h / 2.0 + (origin_y - cy) * zoom,
        "w": src_w * sx,
        "h": src_h * sy,
    }


def evaluate_draw_ops(timeline: Timeline, frame_index: int) -> dict[str, Any]:
    """CLI compositor placements as a draw list (same numbers Studio must use)."""

    scene, local_frame = scene_at_frame(timeline, frame_index)
    fps = timeline.fps
    canvas_w, canvas_h = timeline.canvas.width, timeline.canvas.height
    step = max(1, scene.frame_step)
    composed = local_frame - (local_frame % step)
    view = camera_view(scene.camera, canvas_w, canvas_h, composed, fps)
    bg_w, bg_h = probe_size(scene.background.asset)
    fit = _background_fit(scene.background.fit, bg_w, bg_h, canvas_w, canvas_h)
    commands: list[dict[str, Any]] = [
        {
            "kind": "bg",
            "rel": rel_for(scene.background.asset, timeline.project_dir),
            "width": bg_w,
            "height": bg_h,
            "fit": scene.background.fit,
            "cx": view.cx,
            "cy": view.cy,
            "zoom": view.zoom,
            "originX": fit["originX"],
            "originY": fit["originY"],
            "sx": view.zoom * (fit["fittedW"] / max(bg_w, 1)),
            "sy": view.zoom * (fit["fittedH"] / max(bg_h, 1)),
        }
    ]
    draw_camera = None if view.is_identity else view
    for layer in sorted(scene.layers, key=lambda item: item.z):
        if not layer.is_visible_at(composed, scene.total_frames):
            continue
        local = composed - layer.start_frame
        layer = layer_at_sequence_frame(layer, local, fps)
        drawings = _collect_slot_drawings(layer, local, fps)
        suppressed = _suppressed_head_slots(layer)
        layer_view = layer_view_at(layer, local)
        group_rot_by_slot: dict[str, float] = {}
        group_pivot_by_slot: dict[str, tuple[float, float]] = {}
        for group_name, members in (layer.groups or {}).items():
            rot = group_rotation_at(layer, group_name, local)
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
        for placed in _resolve_layer_placements(layer, local, world_scale=1.0, drawings=drawings):
            draw_x, draw_y, draw_scale = placed.x, placed.y, placed.scale
            if draw_camera is not None:
                draw_x, draw_y, draw_scale = draw_camera.map_placement(draw_x, draw_y, draw_scale)
            width, height = probe_size(placed.asset)
            commands.append(
                {
                    "kind": "sprite",
                    "rel": rel_for(placed.asset, timeline.project_dir),
                    "width": width,
                    "height": height,
                    "x": draw_x,
                    "y": draw_y,
                    "scale": draw_scale,
                    "flipX": placed.flip_x,
                    "rotation": placed.rotation,
                    "opacity": placed.opacity,
                    "anchor": "top-left" if placed.pivot_px is not None else placed.anchor,
                    "pivot": list(placed.pivot_px) if placed.pivot_px is not None else None,
                }
            )
            for name, slot in _sorted_slots(placed.slots):
                if name in suppressed:
                    continue
                cmd = _slot_command(
                    slot,
                    placed,
                    local,
                    fps,
                    drawings,
                    layer_view,
                    group_rot_by_slot.get(name, 0.0),
                    group_pivot_by_slot.get(name),
                    draw_camera,
                    timeline.project_dir,
                )
                if cmd:
                    commands.append(cmd)
    return {
        "frame": int(frame_index),
        "canvas": {"width": canvas_w, "height": canvas_h},
        "fps": fps,
        "commands": commands,
    }


def rasterize_commands(
    commands: list[dict[str, Any]],
    project_dir: Path,
    canvas_w: int,
    canvas_h: int,
    cache: AssetCache | None = None,
) -> np.ndarray:
    """Draw a command list with the CLI blitter (for pixel-lock tests)."""

    cache = cache if cache is not None else AssetCache()

    def resolve(rel: str | None) -> Path | None:
        if not rel:
            return None
        direct = Path(project_dir) / rel
        if direct.exists():
            return direct
        for folder in (project_dir, project_dir.parent / "_global_assets"):
            candidate = Path(folder) / rel
            if candidate.exists():
                return candidate
        return None

    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    for cmd in commands:
        rel = cmd.get("rel")
        path = resolve(rel)
        if path is None:
            continue
        if cmd.get("kind") == "bg":
            raw = cache.get_raw(path)
            if abs(float(cmd.get("zoom") or 1) - 1.0) < 1e-9 and abs(
                float(cmd.get("cx") or canvas_w / 2) - canvas_w / 2
            ) < 1e-9 and abs(float(cmd.get("cy") or canvas_h / 2) - canvas_h / 2) < 1e-9:
                canvas = fit_to_canvas(raw, canvas_w, canvas_h, cmd.get("fit") or "cover")
            else:
                canvas = fit_to_canvas_camera(
                    raw,
                    canvas_w,
                    canvas_h,
                    cmd.get("fit") or "cover",
                    float(cmd["cx"]),
                    float(cmd["cy"]),
                    float(cmd["zoom"]),
                )
            continue
        pivot = cmd.get("pivot")
        _draw_transformed(
            canvas,
            cache,
            path,
            float(cmd["x"]),
            float(cmd["y"]),
            float(cmd["scale"]),
            bool(cmd.get("flipX")),
            float(cmd.get("rotation") or 0),
            cmd.get("anchor") or "center",
            float(cmd.get("opacity") if cmd.get("opacity") is not None else 1),
            pivot=(float(pivot[0]), float(pivot[1])) if pivot else None,
        )
    return canvas


def collect_rels(graph: dict[str, Any]) -> list[str]:
    rels: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            rel = node.get("rel")
            if isinstance(rel, str) and rel:
                rels.add(rel)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(graph)
    return sorted(rels)
