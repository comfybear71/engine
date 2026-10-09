"""Optional slot.scale is pivot-correct around the attachment point."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.asset_cache import AssetCache
from compositor.compositor import _draw_layer
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


def test_slot_scale_keeps_center_and_enlarges_drawing(tmp_path: Path):
    _write_bgra(tmp_path / "body.png", _solid(40, 40, (0, 0, 0), 0))
    _write_bgra(tmp_path / "head.png", _solid(10, 10, (0, 0, 255)))
    _write_bgra(tmp_path / "bg.png", _solid(40, 40, (0, 0, 0)))

    def compose(scale: float) -> np.ndarray:
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
                            "slots": {
                                "mouth": {
                                    "offset": {"x": 20, "y": 20},
                                    "scale": scale,
                                    "images": {"X": "head.png"},
                                    "keyframes": [{"frame": 0, "drawing": "X"}],
                                }
                            },
                        }
                    ],
                }
            ],
        }
        path = tmp_path / "timeline.json"
        path.write_text(json.dumps(doc))
        timeline = load_timeline(path)
        slot = timeline.scenes[0].layers[0].slots["mouth"]
        assert slot.scale == pytest.approx(scale)
        canvas = np.zeros((40, 40, 3), dtype=np.uint8)
        _draw_layer(canvas, timeline.scenes[0].layers[0], AssetCache(), 0, fps=24)
        return canvas

    small = compose(1.0)
    large = compose(2.0)

    # Attachment point (20, 20) stays red at both scales.
    assert tuple(small[20, 20]) == (0, 0, 255)
    assert tuple(large[20, 20]) == (0, 0, 255)
    # 10x10 head at scale 1 covers [15, 25); scale 2 covers [10, 30).
    assert tuple(small[11, 11]) == (0, 0, 0)
    assert tuple(large[11, 11]) == (0, 0, 255)
