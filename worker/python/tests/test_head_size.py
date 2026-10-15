from __future__ import annotations

import cv2
import numpy as np

from compositor.head_size import measure_head, normalize_frame, plan_clip, scale_about, smooth


def _head(radius: int, cx: int = 640, cy: int = 360, size=(704, 1280)) -> np.ndarray:
    img = np.zeros((size[0], size[1], 3), dtype=np.uint8)
    cv2.ellipse(img, (cx, cy), (radius, int(radius * 1.15)), 0, 0, 360, (60, 110, 190), -1)
    return img


def test_measure_scales_with_the_head() -> None:
    small = measure_head(_head(100))
    big = measure_head(_head(150))
    assert small is not None and big is not None
    assert abs(big[0] / small[0] - 1.5) < 0.04
    assert abs(small[1] - 640) < 3 and abs(small[2] - 360) < 3


def test_measure_returns_none_on_black() -> None:
    assert measure_head(np.zeros((704, 1280, 3), dtype=np.uint8)) is None


def test_normalize_frame_restores_the_target_size_in_place() -> None:
    target = measure_head(_head(150))[0]
    fixed = normalize_frame(_head(135, cx=700, cy=300), target)
    size, cx, cy = measure_head(fixed)
    assert abs(size / target - 1.0) < 0.03
    assert abs(cx - 700) < 4 and abs(cy - 300) < 4


def test_normalize_frame_leaves_a_head_at_target_alone() -> None:
    img = _head(150)
    target = measure_head(img)[0]
    assert np.array_equal(normalize_frame(img, target), img)


def test_scale_about_keeps_backdrop_black() -> None:
    out = scale_about(_head(100), 1.2, 640, 360)
    assert out[0, 0].tolist() == [0, 0, 0]


def test_plan_clip_follows_a_steady_shrink_and_ignores_a_blink() -> None:
    sizes = list(np.linspace(300, 270, 48))
    metrics = [(s, 640.0, 360.0) for s in sizes]
    target, plan = plan_clip(metrics, 24.0)
    assert abs(target - 300) < 3
    assert plan[0][0] < 1.03
    assert plan[-1][0] > 1.07

    flat = [(300.0, 640.0, 360.0)] * 48
    flat[20] = (285.0, 640.0, 360.0)
    _, flat_plan = plan_clip(flat, 24.0, 300.0)
    assert flat_plan[20][0] < 1.04


def test_plan_clip_uses_a_given_target_and_clamps() -> None:
    metrics = [(100.0, 640.0, 360.0)] * 10
    target, plan = plan_clip(metrics, 24.0, 300.0)
    assert target == 300.0
    assert plan[0][0] == 1.4


def test_smooth_keeps_length() -> None:
    values = np.arange(10, dtype=float)
    assert len(smooth(values, 5)) == 10
