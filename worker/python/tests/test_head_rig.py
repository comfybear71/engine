"""One-head rig: canvas pivot anchoring, and groups.head draws one angle."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor.asset_cache import AssetCache
from compositor.compositor import _Placed, _draw_layer, _draw_slot, _sorted_slots, _suppressed_head_slots
from compositor.slots import Slot, SlotKeyframe
from compositor.timeline_loader import DialogueClip, Layer, Transform


def _write_bgra(path: Path, w: int, h: int, bgr: tuple[int, int, int], alpha: int = 255) -> Path:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    cv2.imwrite(str(path), img)
    return path


def _has_color(canvas: np.ndarray, bgr: tuple[int, int, int]) -> bool:
    b, g, r = bgr
    return bool(
        np.any(
            (np.abs(canvas[:, :, 0].astype(int) - b) < 40)
            & (np.abs(canvas[:, :, 1].astype(int) - g) < 40)
            & (np.abs(canvas[:, :, 2].astype(int) - r) < 40)
        )
    )


def _owner(x: float = 50.0, y: float = 50.0) -> _Placed:
    return _Placed(
        z=0, x=x, y=y, scale=1.0, flip_x=False, rotation=0.0,
        opacity=1.0, anchor="center", asset=Path("unused.png"), slots={},
    )


def test_canvas_pivot_anchors_neck_not_centre(tmp_path: Path):
    red = _write_bgra(tmp_path / "head.png", 20, 10, (0, 0, 255))
    slot = Slot(
        images={"neutral": red},
        keyframes=[SlotKeyframe(frame=0, drawing="neutral")],
        canvas_w=20,
        canvas_h=10,
        pivot_x=0.0,
        pivot_y=5.0,
    )
    canvas = np.zeros((100, 100, 3), dtype=np.uint8)
    _draw_slot(canvas, AssetCache(), slot, _owner(50, 50), 0, 24, {"head_base": "neutral"})
    # Left-centre (pivot) sits at (50, 50); image covers x=50..70.
    assert tuple(canvas[50, 50]) == (0, 0, 255)
    assert tuple(canvas[50, 69]) == (0, 0, 255)
    assert tuple(canvas[50, 40]) == (0, 0, 0)


def test_no_canvas_still_centres_the_drawing(tmp_path: Path):
    red = _write_bgra(tmp_path / "head.png", 20, 10, (0, 0, 255))
    slot = Slot(
        images={"neutral": red},
        keyframes=[SlotKeyframe(frame=0, drawing="neutral")],
    )
    canvas = np.zeros((100, 100, 3), dtype=np.uint8)
    _draw_slot(canvas, AssetCache(), slot, _owner(50, 50), 0, 24, {"head_base": "neutral"})
    assert tuple(canvas[50, 50]) == (0, 0, 255)
    assert tuple(canvas[50, 41]) == (0, 0, 255)
    assert tuple(canvas[50, 69]) == (0, 0, 0)


def test_slots_sort_by_z_then_dict_order():
    a = Slot(images={"a": Path("a.png")}, z=2)
    b = Slot(images={"b": Path("b.png")})
    c = Slot(images={"c": Path("c.png")}, z=0)
    d = Slot(images={"d": Path("d.png")}, z=2)
    ordered = [name for name, _slot in _sorted_slots({"b": b, "a": a, "c": c, "d": d})]
    assert ordered == ["b", "c", "a", "d"]


def test_group_draws_one_head_per_view(tmp_path: Path):
    body = _write_bgra(tmp_path / "body.png", 8, 8, (0, 0, 0), alpha=0)
    front = _write_bgra(tmp_path / "base_front.png", 8, 8, (255, 0, 0))  # blue
    side = _write_bgra(tmp_path / "base_side.png", 8, 8, (0, 255, 0))  # green
    eyes = _write_bgra(tmp_path / "eyes.png", 8, 8, (0, 0, 255))  # red
    mouth = _write_bgra(tmp_path / "mouth.png", 8, 8, (255, 255, 0))  # cyan
    face = _write_bgra(tmp_path / "face.png", 8, 8, (0, 255, 255))  # yellow
    head = _write_bgra(tmp_path / "head.png", 8, 8, (255, 0, 255))  # magenta

    layer = Layer(
        id="char",
        asset=body,
        z=0,
        transform=Transform(x=20, y=20, anchor="center"),
        groups={"head": ["head_base", "eyes", "mouth"]},
        dialogue=[
            DialogueClip(
                audio=tmp_path / "missing.wav",
                start_frame=0,
                duration_frames=10,
                cues=[],
                estimated=True,
                view="left_34",
            )
        ],
        slots={
            "face": Slot(
                images={"grin": face},
                offset_x=16,
                keyframes=[SlotKeyframe(frame=0, drawing="grin")],
            ),
            "head": Slot(
                images={"full": head},
                offset_x=-16,
                keyframes=[SlotKeyframe(frame=0, drawing="full")],
            ),
            "head_base": Slot(
                images={"neutral": front},
                images_by_view={"front": {"neutral": front}, "left_34": {"neutral": side}},
                keyframes=[SlotKeyframe(frame=0, drawing="neutral")],
                z=0,
            ),
            "eyes": Slot(
                images={"open": eyes, "closed": eyes},
                offset_y=-12,
                keyframes=[SlotKeyframe(frame=0, drawing="open")],
                z=1,
            ),
            "mouth": Slot(
                images={"X": mouth},
                offset_y=12,
                keyframes=[SlotKeyframe(frame=0, drawing="X")],
                z=2,
            ),
        },
    )
    assert _suppressed_head_slots(layer) == {"face", "head"}
    canvas = np.zeros((40, 40, 3), dtype=np.uint8)
    _draw_layer(canvas, layer, AssetCache(), 0, fps=24)
    assert _has_color(canvas, (0, 255, 0))  # left_34 base (green)
    assert not _has_color(canvas, (255, 0, 0))  # front base must not draw
    assert not _has_color(canvas, (0, 255, 255))  # legacy face
    assert not _has_color(canvas, (255, 0, 255))  # legacy head
    assert _has_color(canvas, (0, 0, 255))  # eyes overlay
    assert _has_color(canvas, (255, 255, 0))  # mouth overlay


def test_without_groups_legacy_face_still_draws(tmp_path: Path):
    body = _write_bgra(tmp_path / "body.png", 8, 8, (0, 0, 0), alpha=0)
    face = _write_bgra(tmp_path / "face.png", 8, 8, (0, 255, 255))
    layer = Layer(
        id="char",
        asset=body,
        z=0,
        transform=Transform(x=20, y=20, anchor="center"),
        slots={
            "face": Slot(images={"grin": face}, keyframes=[SlotKeyframe(frame=0, drawing="grin")]),
        },
    )
    assert _suppressed_head_slots(layer) == set()
    canvas = np.zeros((40, 40, 3), dtype=np.uint8)
    _draw_layer(canvas, layer, AssetCache(), 0, fps=24)
    assert _has_color(canvas, (0, 255, 255))
