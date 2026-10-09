"""Targeted tests for the cut-out animation additions: pivot-fixed rotation,
transform/rotation keyframes, one-level child.parent nesting, slot cycles,
and visible_when."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.asset_cache import AssetCache
from compositor.compositor import _draw_layer, _resolve_layer_placements
from compositor.schema_validate import TimelineValidationError, validate_timeline
from compositor.slots import Slot, SlotKeyframe, active_drawing
from compositor.timeline_loader import (
    Child,
    Layer,
    Transform,
    TransformKeyframe,
    load_timeline,
    transform_at,
)

from .conftest import write_png_1x1


def _write_bgra(path: Path, img: np.ndarray) -> Path:
    cv2.imwrite(str(path), img)
    return path


def _solid(w: int, h: int, bgr: tuple[int, int, int], alpha: int = 255) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    return img


def _green_centroid(canvas: np.ndarray) -> tuple[float, float]:
    """Centroid of pixels that are clearly green (the pivot marker)."""

    b, g, r = canvas[:, :, 0], canvas[:, :, 1], canvas[:, :, 2]
    mask = (g > 180) & (r < 80) & (b < 80)
    ys, xs = np.nonzero(mask)
    assert len(xs) > 0, "expected a green pivot marker on the canvas"
    return float(xs.mean()), float(ys.mean())


def test_shoulder_pivot_stays_put_when_child_rotates_90(tmp_path):
    """A top-center (shoulder) pivot must stay at the same canvas pixel
    after a 90° rotation -- the old path placed the *expanded* box by its
    top-center edge and the arm detached."""

    arm = _solid(20, 60, (0, 0, 200))  # red body
    arm[0:6, 7:13] = (0, 220, 0, 255)  # green marker around top-center (10, 0)
    arm_path = _write_bgra(tmp_path / "arm.png", arm)
    torso_path = _write_bgra(tmp_path / "torso.png", _solid(4, 4, (255, 255, 255), 0))

    pivot = (200.0, 150.0)
    t = Transform(x=pivot[0], y=pivot[1], anchor="top-left")
    child_0 = Child(
        id="arm", asset=arm_path, z=1,
        offset_x=0, offset_y=0, pivot="top-center", rotation=0,
    )
    child_90 = Child(
        id="arm", asset=arm_path, z=1,
        offset_x=0, offset_y=0, pivot="top-center", rotation=90,
    )
    layer_0 = Layer(id="rig", asset=torso_path, z=0, transform=t, children=[child_0])
    layer_90 = Layer(id="rig", asset=torso_path, z=0, transform=t, children=[child_90])

    canvas_0 = np.zeros((300, 400, 3), dtype=np.uint8)
    canvas_90 = np.zeros((300, 400, 3), dtype=np.uint8)
    _draw_layer(canvas_0, layer_0, AssetCache(), 0, fps=24)
    _draw_layer(canvas_90, layer_90, AssetCache(), 0, fps=24)

    cx0, cy0 = _green_centroid(canvas_0)
    cx90, cy90 = _green_centroid(canvas_90)
    assert (cx0, cy0) == pytest.approx(pivot, abs=2.0)
    assert (cx90, cy90) == pytest.approx(pivot, abs=2.0)
    assert (cx90, cy90) == pytest.approx((cx0, cy0), abs=1.5)

    # Rotation actually happened: a pixel that was below the shoulder is now
    # to the left of it (clockwise, Y-down).
    assert tuple(canvas_90[150, 160]) != (0, 0, 0)


def test_transform_interpolation_at_mid_frame():
    layer = Layer(
        id="walk",
        asset=Path("body.png"),
        z=0,
        transform=Transform(x=0, y=200, scale=1.0, rotation=0),
        transform_keyframes=[
            TransformKeyframe(frame=0, x=0, ease="linear"),
            TransformKeyframe(frame=10, x=100, ease="linear"),
        ],
    )
    mid = transform_at(layer, 5)
    assert mid.x == pytest.approx(50.0)
    assert mid.y == pytest.approx(200.0)  # never keyframed: static value
    placed = _resolve_layer_placements(layer, 5)
    assert placed[0].x == pytest.approx(50.0)
    assert placed[0].y == pytest.approx(200.0)


def test_nested_child_swings_with_parent_rotation():
    t = Transform(x=100, y=200, scale=1.0, anchor="top-left")
    upper = Child(id="upper_arm", asset=Path("upper.png"), z=1, offset_x=0, offset_y=0, rotation=90)
    forearm = Child(
        id="forearm", asset=Path("forearm.png"), z=2,
        offset_x=0, offset_y=50, parent="upper_arm", rotation=10,
    )
    layer = Layer(id="rig", asset=Path("body.png"), z=0, transform=t, children=[upper, forearm])
    placements = _resolve_layer_placements(layer, 0)
    by_name = {p.asset.name: p for p in placements}

    # (0, 50) down from (100, 200), 90° clockwise, Y-down -> (-50, 0)
    assert (by_name["forearm.png"].x, by_name["forearm.png"].y) == pytest.approx((50.0, 200.0))
    assert by_name["forearm.png"].rotation == pytest.approx(100.0)  # 90 + 10
    assert by_name["upper.png"].rotation == pytest.approx(90.0)


def test_cycle_drawing_at_frame_n():
    slot = Slot(
        images={"a": Path("a.png"), "b": Path("b.png"), "c": Path("c.png")},
        keyframes=[SlotKeyframe(frame=0, cycle=["a", "b", "c"], fps=12)],
    )
    # document fps 24, cycle fps 12 -> a new drawing every 2 frames
    assert active_drawing(slot, 0, fps=24) == "a"
    assert active_drawing(slot, 1, fps=24) == "a"
    assert active_drawing(slot, 2, fps=24) == "b"
    assert active_drawing(slot, 4, fps=24) == "c"
    assert active_drawing(slot, 6, fps=24) == "a"

    held_then_cycle = Slot(
        images={"still": Path("s.png"), "a": Path("a.png"), "b": Path("b.png")},
        keyframes=[
            SlotKeyframe(frame=0, drawing="still"),
            SlotKeyframe(frame=10, cycle=["a", "b"], fps=24),
        ],
    )
    assert active_drawing(held_then_cycle, 9, fps=24) == "still"
    assert active_drawing(held_then_cycle, 10, fps=24) == "a"
    assert active_drawing(held_then_cycle, 11, fps=24) == "b"


def test_visible_when_hides_slot_unless_named_drawing_is_active(tmp_path):
    body_front = _write_bgra(tmp_path / "front.png", _solid(8, 8, (255, 0, 0)))  # blue
    body_back = _write_bgra(tmp_path / "back.png", _solid(8, 8, (0, 0, 255)))  # red
    mouth = _write_bgra(tmp_path / "mouth.png", _solid(8, 8, (0, 255, 0)))  # green
    root = _write_bgra(tmp_path / "root.png", _solid(2, 2, (0, 0, 0), 0))

    layer = Layer(
        id="char",
        asset=root,
        z=0,
        transform=Transform(x=40, y=40, anchor="center"),
        slots={
            "body": Slot(
                images={"front": body_front, "back": body_back},
                offset_x=-16, offset_y=0,
                keyframes=[
                    SlotKeyframe(frame=0, drawing="front"),
                    SlotKeyframe(frame=10, drawing="back"),
                ],
            ),
            "mouth": Slot(
                images={"open": mouth},
                offset_x=16, offset_y=0,
                keyframes=[SlotKeyframe(frame=0, drawing="open")],
                visible_when={"body": ["front"]},
            ),
        },
    )

    canvas_front = np.zeros((80, 80, 3), dtype=np.uint8)
    canvas_back = np.zeros((80, 80, 3), dtype=np.uint8)
    _draw_layer(canvas_front, layer, AssetCache(), 0, fps=24)
    _draw_layer(canvas_back, layer, AssetCache(), 10, fps=24)

    def has_green(canvas: np.ndarray) -> bool:
        return bool(np.any((canvas[:, :, 1] > 180) & (canvas[:, :, 0] < 80) & (canvas[:, :, 2] < 80)))

    assert has_green(canvas_front)  # mouth visible while body is front
    assert not has_green(canvas_back)  # mouth hidden while body is back


def _write_timeline(tmp_path: Path, layer: dict) -> Path:
    write_png_1x1(tmp_path / "bg.png")
    write_png_1x1(tmp_path / "body.png")
    write_png_1x1(tmp_path / "a.png")
    write_png_1x1(tmp_path / "b.png")
    doc = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 24},
                "background": {"asset": "bg.png"},
                "layers": [layer],
            }
        ],
    }
    path = tmp_path / "timeline.json"
    path.write_text(json.dumps(doc))
    return path


def test_parent_must_exist_and_nesting_is_one_level(tmp_path):
    missing = {
        "id": "rig",
        "asset": "body.png",
        "z": 1,
        "transform": {"x": 0, "y": 0},
        "children": [
            {
                "id": "forearm",
                "asset": "a.png",
                "z": 1,
                "offset": {"x": 0, "y": 10},
                "parent": "nope",
            }
        ],
    }
    with pytest.raises(ValueError, match="does not exist"):
        load_timeline(_write_timeline(tmp_path, missing))

    too_deep = {
        "id": "rig",
        "asset": "body.png",
        "z": 1,
        "transform": {"x": 0, "y": 0},
        "children": [
            {"id": "upper", "asset": "a.png", "z": 1, "offset": {"x": 0, "y": 0}},
            {"id": "forearm", "asset": "a.png", "z": 2, "offset": {"x": 0, "y": 10}, "parent": "upper"},
            {"id": "hand", "asset": "b.png", "z": 3, "offset": {"x": 0, "y": 10}, "parent": "forearm"},
        ],
    }
    with pytest.raises(ValueError, match="one level"):
        load_timeline(_write_timeline(tmp_path, too_deep))


def test_new_optional_fields_pass_schema():
    raw = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 10},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "rig",
                        "asset": "body.png",
                        "z": 1,
                        "transform": {"x": 0, "y": 0},
                        "transform_keyframes": [
                            {"frame": 0, "x": 0, "ease": "linear"},
                            {"frame": 8, "x": 40, "rotation": 15, "ease": "inout"},
                        ],
                        "slots": {
                            "walk": {
                                "images": {"a": "a.png", "b": "b.png"},
                                "keyframes": [
                                    {"frame": 0, "cycle": ["a", "b"], "fps": 8}
                                ],
                            },
                            "mouth": {
                                "images": {"X": "a.png"},
                                "keyframes": [{"frame": 0, "drawing": "X"}],
                                "visible_when": {"walk": ["a"]},
                            },
                        },
                        "children": [
                            {
                                "id": "upper",
                                "asset": "a.png",
                                "z": 1,
                                "offset": {"x": 0, "y": 0},
                                "rotation_keyframes": [
                                    {"frame": 0, "rotation": 0},
                                    {"frame": 8, "rotation": 20},
                                ],
                            },
                            {
                                "id": "forearm",
                                "asset": "b.png",
                                "z": 2,
                                "offset": {"x": 0, "y": 20},
                                "parent": "upper",
                            },
                        ],
                    }
                ],
            }
        ],
    }
    validate_timeline(raw)  # must not raise


def test_cycle_keyframe_rejects_drawing_and_cycle_together():
    raw = {
        "series": "Test",
        "episode": 1,
        "fps": 24,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 1},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "l",
                        "asset": "body.png",
                        "z": 0,
                        "transform": {"x": 0, "y": 0},
                        "slots": {
                            "s": {
                                "images": {"a": "a.png"},
                                "keyframes": [
                                    {"frame": 0, "drawing": "a", "cycle": ["a"], "fps": 8}
                                ],
                            }
                        },
                    }
                ],
            }
        ],
    }
    with pytest.raises(TimelineValidationError):
        validate_timeline(raw)
