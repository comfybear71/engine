"""Group Pose rotation, in-place [Do] restore, standing bob, silent View."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from compositor.asset_cache import AssetCache
from compositor.compositor import _draw_layer, compose_scene_frame
from compositor.slots import Slot, SlotKeyframe
from compositor.timeline_loader import (
    Layer,
    Transform,
    TransformKeyframe,
    load_timeline,
    transform_at,
)


def _paint_blob(img: np.ndarray, x: int, y: int, bgr: tuple[int, int, int], radius: int = 1) -> None:
    """A few pixels so rotation interpolation still leaves a detectable colour."""
    h, w = img.shape[:2]
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            px, py = x + dx, y + dy
            if 0 <= px < w and 0 <= py < h:
                img[py, px, 0] = bgr[0]
                img[py, px, 1] = bgr[1]
                img[py, px, 2] = bgr[2]
                img[py, px, 3] = 255


def _write_marked(path: Path, w: int, h: int, pivot: tuple[int, int], mark: tuple[int, int], bgr: tuple[int, int, int]) -> Path:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    px, py = pivot
    mx, my = mark
    _paint_blob(img, px, py, (0, 255, 0))  # green neck
    _paint_blob(img, mx, my, bgr)
    cv2.imwrite(str(path), img)
    return path


def _write_solid(path: Path, w: int, h: int, bgr: tuple[int, int, int], alpha: int = 255) -> Path:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    cv2.imwrite(str(path), img)
    return path


def _has_color(canvas: np.ndarray, bgr: tuple[int, int, int], tol: int = 40) -> bool:
    b, g, r = bgr
    return bool(
        np.any(
            (np.abs(canvas[:, :, 0].astype(int) - b) < tol)
            & (np.abs(canvas[:, :, 1].astype(int) - g) < tol)
            & (np.abs(canvas[:, :, 2].astype(int) - r) < tol)
        )
    )


def _color_centroid(canvas: np.ndarray, bgr: tuple[int, int, int], tol: int = 40) -> tuple[float, float]:
    b, g, r = bgr
    mask = (
        (np.abs(canvas[:, :, 0].astype(int) - b) < tol)
        & (np.abs(canvas[:, :, 1].astype(int) - g) < tol)
        & (np.abs(canvas[:, :, 2].astype(int) - r) < tol)
    )
    ys, xs = np.nonzero(mask)
    assert len(xs) > 0, f"expected colour {bgr} on the canvas"
    return float(xs.mean()), float(ys.mean())


def _head_slot(path: Path, drawing: str, bgr: tuple[int, int, int], z: int) -> Slot:
    return Slot(
        images={drawing: path},
        offset_x=0.0,
        offset_y=0.0,
        keyframes=[SlotKeyframe(frame=0, drawing=drawing)],
        canvas_w=20,
        canvas_h=20,
        pivot_x=2.0,
        pivot_y=10.0,
        z=z,
    )


def test_head_group_rotates_rigidly_about_neck_pivot(tmp_path: Path):
    """Far marks on base/eyes/mouth stay together; the neck pixel stays put."""

    body = _write_solid(tmp_path / "body.png", 4, 4, (0, 0, 0), alpha=0)
    # Marks sit on one radial line from the neck so they cannot cover each other.
    base = _write_marked(tmp_path / "base.png", 20, 20, (2, 10), (16, 10), (0, 0, 255))  # red
    eyes = _write_marked(tmp_path / "eyes.png", 20, 20, (2, 10), (12, 10), (255, 0, 0))  # blue
    mouth = _write_marked(tmp_path / "mouth.png", 20, 20, (2, 10), (8, 10), (255, 255, 0))  # cyan

    def layer_at(rot: float, flip: bool = False) -> Layer:
        return Layer(
            id="char",
            asset=body,
            z=0,
            transform=Transform(x=40, y=40, anchor="center", flip_x=flip),
            groups={"head": ["head_base", "eyes", "mouth"]},
            group_rotations={"head": rot},
            slots={
                "head_base": _head_slot(base, "neutral", (0, 0, 255), 0),
                "eyes": _head_slot(eyes, "open", (255, 0, 0), 1),
                "mouth": _head_slot(mouth, "X", (255, 255, 0), 2),
            },
        )

    rest = np.zeros((80, 80, 3), dtype=np.uint8)
    turned = np.zeros((80, 80, 3), dtype=np.uint8)
    _draw_layer(rest, layer_at(0), AssetCache(), 0, fps=24)
    _draw_layer(turned, layer_at(90), AssetCache(), 0, fps=24)

    # Neck (green) stays at the owner attachment.
    nx0, ny0 = _color_centroid(rest, (0, 255, 0))
    nx1, ny1 = _color_centroid(turned, (0, 255, 0))
    assert abs(nx0 - 40) <= 1.5 and abs(ny0 - 40) <= 1.5
    assert abs(nx1 - nx0) <= 1.5 and abs(ny1 - ny0) <= 1.5

    # Far mark was to the right of the neck; 90° clockwise in Y-down is down.
    rx0, ry0 = _color_centroid(rest, (0, 0, 255))
    rx1, ry1 = _color_centroid(turned, (0, 0, 255))
    assert rx0 > nx0 + 8
    assert abs(ry0 - ny0) <= 2
    assert abs(rx1 - nx1) <= 2
    assert ry1 > ny1 + 8

    # Eyes and mouth stay on the same radial line (same X after 90°), distances preserved.
    ex, ey = _color_centroid(turned, (255, 0, 0))
    mx, my = _color_centroid(turned, (255, 255, 0))
    assert abs(ex - nx1) <= 2 and abs(mx - nx1) <= 2
    assert ey > ny1 + 5 and my > ny1 + 2
    assert ey < ry1 - 2
    rest_base = ((rx0 - nx0) ** 2 + (ry0 - ny0) ** 2) ** 0.5
    turned_base = ((rx1 - nx1) ** 2 + (ry1 - ny1) ** 2) ** 0.5
    assert abs(rest_base - turned_base) <= 1.5


def test_group_rotation_mirrors_when_flipped(tmp_path: Path):
    """Flip mirrors X at rest and negates group rotation, same as child Swing.

    90° keeps the far mark on-axis so interpolation cannot hide it. Without
    the negate, a flipped +90 would send the (now-left) mark *up*.
    """

    body = _write_solid(tmp_path / "body.png", 4, 4, (0, 0, 0), alpha=0)
    base = _write_marked(tmp_path / "base.png", 20, 20, (2, 10), (16, 10), (0, 0, 255))

    def layer_at(rot: float, flip: bool) -> Layer:
        return Layer(
            id="char",
            asset=body,
            z=0,
            transform=Transform(x=40, y=40, anchor="center", flip_x=flip),
            groups={"head": ["head_base"]},
            group_rotations={"head": rot},
            slots={"head_base": _head_slot(base, "neutral", (0, 0, 255), 0)},
        )

    def draw(rot: float, flip: bool) -> np.ndarray:
        canvas = np.zeros((80, 80, 3), dtype=np.uint8)
        _draw_layer(canvas, layer_at(rot, flip), AssetCache(), 0, fps=24)
        return canvas

    rest = draw(0, False)
    rest_f = draw(0, True)
    turned = draw(90, False)
    turned_f = draw(90, True)

    nx, ny = _color_centroid(rest, (0, 255, 0))
    rx0, ry0 = _color_centroid(rest, (0, 0, 255))
    rx0f, ry0f = _color_centroid(rest_f, (0, 0, 255))
    assert rx0 > nx + 8
    assert abs(ry0 - ny) <= 2.5
    assert rx0f < nx - 8
    assert abs(ry0f - ny) <= 2.5
    assert abs((rx0 - nx) + (rx0f - nx)) <= 2.5
    assert abs(ry0 - ry0f) <= 2.5

    rx1, ry1 = _color_centroid(turned, (0, 0, 255))
    rx1f, ry1f = _color_centroid(turned_f, (0, 0, 255))
    assert abs(rx1 - nx) <= 2.5
    assert ry1 > ny + 8
    # Negated angle: the mirrored mark also goes down, not up.
    assert abs(rx1f - nx) <= 2.5
    assert ry1f > ny + 8
    assert abs(ry1 - ry1f) <= 2.5


def test_group_pose_combines_with_head_bob(tmp_path: Path):
    body = _write_solid(tmp_path / "body.png", 4, 4, (0, 0, 0), alpha=0)
    base = _write_marked(tmp_path / "base.png", 20, 20, (2, 10), (16, 10), (0, 0, 255))
    slot = _head_slot(base, "neutral", (0, 0, 255), 0)
    slot = Slot(
        images=slot.images,
        offset_x=slot.offset_x,
        offset_y=slot.offset_y,
        keyframes=slot.keyframes,
        canvas_w=slot.canvas_w,
        canvas_h=slot.canvas_h,
        pivot_x=slot.pivot_x,
        pivot_y=slot.pivot_y,
        z=slot.z,
        head_bob_starts=[0],
        head_bob_amp=10.0,
        head_bob_rotation=0.0,
    )
    posed = Layer(
        id="char",
        asset=body,
        z=0,
        transform=Transform(x=40, y=40, anchor="center"),
        groups={"head": ["head_base"]},
        group_rotations={"head": 0},
        slots={"head_base": slot},
    )
    canvas = np.zeros((80, 80, 3), dtype=np.uint8)
    _draw_layer(canvas, posed, AssetCache(), 2, fps=24)  # bob peak
    _nx, ny = _color_centroid(canvas, (0, 255, 0))
    assert ny > 44  # bob pushed the neck down from 40


def test_do_timeline_restores_view_slot_group_and_bob(tmp_path: Path):
    _write_solid(tmp_path / "bg.png", 40, 40, (10, 10, 10))
    _write_solid(tmp_path / "body.png", 8, 8, (0, 0, 0), alpha=0)
    stand = _write_solid(tmp_path / "stand.png", 8, 8, (0, 0, 255))  # red
    rig = _write_solid(tmp_path / "rig.png", 8, 8, (0, 255, 0))  # green
    front = _write_solid(tmp_path / "head_front.png", 8, 8, (255, 0, 0))  # blue
    side = _write_solid(tmp_path / "head_side.png", 8, 8, (255, 255, 0))  # cyan

    doc = {
        "series": "Test",
        "episode": "do-restore",
        "fps": 24,
        "canvas": {"width": 40, "height": 40},
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 12},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "rodney",
                        "asset": "body.png",
                        "z": 1,
                        "transform": {"x": 12, "y": 20, "anchor": "center", "scale": 1},
                        "transform_keyframes": [
                            {"frame": 0, "y": 20},
                            {"frame": 2, "y": 24},
                            {"frame": 8, "y": 20},
                        ],
                        "view_keyframes": [
                            {"frame": 0, "view": "right_34"},
                            {"frame": 8, "view": "front"},
                        ],
                        "groups": {"head": ["head_base"]},
                        "group_rotation_keyframes": {
                            "head": [
                                {"frame": 0, "rotation": 0},
                                {"frame": 2, "rotation": 8},
                                {"frame": 8, "rotation": 0},
                            ]
                        },
                        "slots": {
                            "torso": {
                                "offset": {"x": -10, "y": 0},
                                "images": {"stand": "stand.png", "rig": "rig.png"},
                                "keyframes": [
                                    {"frame": 0, "drawing": "rig"},
                                    {"frame": 8, "drawing": "stand"},
                                ],
                            },
                            "head_base": {
                                "offset": {"x": 10, "y": 0},
                                "images": {"neutral": "head_front.png"},
                                "images_by_view": {
                                    "front": {"neutral": "head_front.png"},
                                    "right_34": {"neutral": "head_side.png"},
                                },
                                "keyframes": [{"frame": 0, "drawing": "neutral"}],
                            },
                        },
                    }
                ],
            }
        ],
    }
    (tmp_path / "timeline.json").write_text(json.dumps(doc))
    timeline = load_timeline(tmp_path / "timeline.json")
    during = compose_scene_frame(timeline.scenes[0], 2, 40, 40, 24, AssetCache())
    after = compose_scene_frame(timeline.scenes[0], 8, 40, 40, 24, AssetCache())
    assert _has_color(during, (0, 255, 0)), "torso should be rig during Do"
    assert _has_color(during, (255, 255, 0)), "head should use right_34 during Do"
    assert not _has_color(during, (0, 0, 255))
    assert _has_color(after, (0, 0, 255)), "torso should restore stand"
    assert _has_color(after, (255, 0, 0)), "head should restore front"
    assert not _has_color(after, (0, 255, 0))
    assert not _has_color(after, (255, 255, 0))


def test_bob_moves_while_standing(tmp_path: Path):
    body = _write_solid(tmp_path / "body.png", 8, 8, (0, 0, 255))
    layer = Layer(
        id="char",
        asset=body,
        z=0,
        transform=Transform(x=20, y=20, anchor="center"),
        transform_keyframes=[
            TransformKeyframe(frame=0, x=20, y=20),
            TransformKeyframe(frame=2, x=20, y=28),
            TransformKeyframe(frame=4, x=20, y=20),
        ],
    )
    t0 = transform_at(layer, 0)
    t2 = transform_at(layer, 2)
    assert t0.x == t2.x
    assert t2.y == 28
    assert t0.y == 20
    a = np.zeros((40, 40, 3), dtype=np.uint8)
    b = np.zeros((40, 40, 3), dtype=np.uint8)
    _draw_layer(a, layer, AssetCache(), 0, fps=24)
    _draw_layer(b, layer, AssetCache(), 2, fps=24)
    _, y0 = _color_centroid(a, (0, 0, 255))
    _, y2 = _color_centroid(b, (0, 0, 255))
    assert y2 > y0 + 4


def test_silent_view_switches_head_drawings(tmp_path: Path):
    _write_solid(tmp_path / "bg.png", 40, 40, (10, 10, 10))
    _write_solid(tmp_path / "body.png", 8, 8, (0, 0, 0), alpha=0)
    front = _write_solid(tmp_path / "head_front.png", 8, 8, (0, 0, 255))  # red
    three_four = _write_solid(tmp_path / "head_34.png", 8, 8, (0, 255, 0))  # green

    doc = {
        "series": "Test",
        "episode": "silent-view",
        "fps": 24,
        "canvas": {"width": 40, "height": 40},
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 12},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "rodney",
                        "asset": "body.png",
                        "z": 1,
                        "transform": {"x": 12, "y": 12, "anchor": "top-left", "scale": 1},
                        "view_keyframes": [{"frame": 0, "view": "right_34"}],
                        "slots": {
                            "head_base": {
                                "offset": {"x": 0, "y": 0},
                                "images": {"neutral": "head_front.png"},
                                "images_by_view": {
                                    "front": {"neutral": "head_front.png"},
                                    "right_34": {"neutral": "head_34.png"},
                                },
                                "keyframes": [{"frame": 0, "drawing": "neutral"}],
                            }
                        },
                    }
                ],
            }
        ],
    }
    (tmp_path / "timeline.json").write_text(json.dumps(doc))
    timeline = load_timeline(tmp_path / "timeline.json")
    frame = compose_scene_frame(timeline.scenes[0], 4, 40, 40, 24, AssetCache())
    assert _has_color(frame, (0, 255, 0)), "silent View should pick right_34"
    assert not _has_color(frame, (0, 0, 255))
