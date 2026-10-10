from pathlib import Path

import numpy as np

from compositor.align import align_to_reference, landmarks


def _head(width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    img = np.zeros((height, width, 4), dtype=np.uint8)
    img[y0:y1, x0:x1] = (30, 40, 200, 255)
    return img


def test_align_matches_hat_chin_and_pads_to_reference_canvas(tmp_path: Path):
    ref = _head(200, 220, 70, 20, 130, 180)
    src = _head(80, 90, 20, 10, 60, 70)
    aligned = align_to_reference(src, ref)
    assert aligned.shape[1] == 200
    assert aligned.shape[0] == 220
    sl = landmarks(aligned)
    rl = landmarks(ref)
    assert abs(sl["hat"][1] - rl["hat"][1]) <= 2
    assert abs((sl["chin"][1] - sl["hat"][1]) - (rl["chin"][1] - rl["hat"][1])) <= 3
    assert abs(sl["neck"][0] - rl["neck"][0]) <= 3


def test_nudge_shifts_aligned_head():
    ref = _head(160, 160, 50, 20, 110, 140)
    src = _head(160, 160, 50, 20, 110, 140)
    moved = align_to_reference(src, ref, nudge_x=12, nudge_y=-8)
    base = landmarks(src)
    after = landmarks(moved)
    assert after["hat"][0] - base["hat"][0] == 12
    assert after["hat"][1] - base["hat"][1] == -8
