"""Studio preview: compose a single global frame without rendering video."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.compositor import compose_frame, scene_at_frame
from compositor.timeline_loader import Background, Canvas, Scene, Timeline


def _solid_bg(path: Path, bgr: tuple[int, int, int]) -> Path:
    cv2.imwrite(str(path), np.full((20, 20, 3), bgr, dtype=np.uint8))
    return path


def _two_scene_timeline(tmp_path: Path) -> Timeline:
    red = _solid_bg(tmp_path / "red.png", (0, 0, 255))
    blue = _solid_bg(tmp_path / "blue.png", (255, 0, 0))
    return Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=20, height=20),
        scenes=[
            Scene(id="s1", total_frames=5, background=Background(asset=red), layers=[]),
            Scene(id="s2", total_frames=5, background=Background(asset=blue), layers=[]),
        ],
        project_dir=tmp_path,
    )


def test_compose_frame_selects_the_correct_scene(tmp_path):
    timeline = _two_scene_timeline(tmp_path)

    first = compose_frame(timeline, 0)
    assert first.shape == (20, 20, 3)
    assert tuple(int(v) for v in first[0, 0]) == (0, 0, 255)

    second = compose_frame(timeline, 5)
    assert tuple(int(v) for v in second[0, 0]) == (255, 0, 0)

    scene, local = scene_at_frame(timeline, 7)
    assert scene.id == "s2"
    assert local == 2


def test_compose_frame_rejects_out_of_range(tmp_path):
    timeline = _two_scene_timeline(tmp_path)
    with pytest.raises(ValueError, match="past the end"):
        compose_frame(timeline, 10)
    with pytest.raises(ValueError, match="must be >= 0"):
        compose_frame(timeline, -1)
