"""Per-drawing align (Studio Save) is applied on top of slot offset/scale."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.asset_cache import AssetCache
from compositor.compositor import _draw_layer
from compositor.slots import DrawingAlign
from compositor.timeline_loader import load_timeline


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


def _compose(tmp_path: Path, align: dict | None) -> np.ndarray:
    _write_bgra(tmp_path / "body.png", _solid(40, 40, (0, 0, 0), 0))
    _write_bgra(tmp_path / "head.png", _solid(10, 10, (0, 0, 255)))
    _write_bgra(tmp_path / "bg.png", _solid(40, 40, (0, 0, 0)))
    slot = {
        "offset": {"x": 20, "y": 20},
        "images": {"X": "head.png"},
        "keyframes": [{"frame": 0, "drawing": "X"}],
    }
    if align is not None:
        slot["align"] = align
    doc = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 1},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "c",
                        "asset": "body.png",
                        "z": 1,
                        "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                        "slots": {"mouth": slot},
                    }
                ],
            }
        ],
    }
    path = tmp_path / "timeline.json"
    path.write_text(json.dumps(doc))
    timeline = load_timeline(path)
    canvas = np.zeros((40, 40, 3), dtype=np.uint8)
    _draw_layer(canvas, timeline.scenes[0].layers[0], AssetCache(), 0, fps=24)
    return canvas, timeline.scenes[0].layers[0].slots["mouth"]


def test_align_scale_keeps_center_and_enlarges_drawing(tmp_path: Path):
    small, slot = _compose(tmp_path, {"X": {"x": 0, "y": 0, "scale": 1.0}})
    large, loaded = _compose(tmp_path, {"X": {"x": 0, "y": 0, "scale": 2.0}})

    assert loaded.align["X"] == DrawingAlign(x=0.0, y=0.0, scale=2.0)
    assert slot.align["X"].scale == pytest.approx(1.0)

    # Attachment point (20, 20) stays red at both scales (centre-anchored).
    assert tuple(small[20, 20]) == (0, 0, 255)
    assert tuple(large[20, 20]) == (0, 0, 255)
    # 10x10 head at scale 1 covers [15, 25); scale 2 covers [10, 30).
    assert tuple(small[11, 11]) == (0, 0, 0)
    assert tuple(large[11, 11]) == (0, 0, 255)


def test_align_nudge_shifts_drawing(tmp_path: Path):
    base, _ = _compose(tmp_path, None)
    nudged, slot = _compose(tmp_path, {"X": {"x": 5, "y": -4, "scale": 1.0}})

    assert slot.align["X"] == DrawingAlign(x=5.0, y=-4.0, scale=1.0)
    # Canvas index is [y, x]. Un-nudged 10x10 at (20, 20) covers x/y [15, 25).
    # After +5/-4 the center is (25, 16) and the rect is x [20, 30), y [11, 21).
    assert tuple(base[20, 16]) == (0, 0, 255)
    assert tuple(nudged[20, 16]) == (0, 0, 0)
    assert tuple(base[12, 26]) == (0, 0, 0)
    assert tuple(nudged[12, 26]) == (0, 0, 255)
    assert tuple(nudged[16, 25]) == (0, 0, 255)


def test_no_align_is_unchanged(tmp_path: Path):
    missing, slot = _compose(tmp_path, None)
    identity, ident = _compose(tmp_path, {"X": {"x": 0, "y": 0, "scale": 1}})
    other, other_slot = _compose(tmp_path, {"A": {"x": 8, "y": -6, "scale": 2.0}})

    assert slot.align == {}
    assert ident.align["X"] == DrawingAlign(x=0.0, y=0.0, scale=1.0)
    assert "X" not in other_slot.align
    assert np.array_equal(missing, identity)
    assert np.array_equal(missing, other)
