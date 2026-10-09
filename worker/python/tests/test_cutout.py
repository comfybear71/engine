"""Key + split on a tiny synthetic #00FF00 sheet (no sample art)."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor.cutout import is_empty, process_image


def _green_sheet() -> np.ndarray:
    # 10x20 BGR: pure #00FF00, a red square in the left cell, blue in the right.
    img = np.zeros((10, 20, 3), dtype=np.uint8)
    img[:] = (0, 255, 0)
    img[1:9, 1:9] = (0, 0, 255)  # red
    img[1:9, 11:19] = (255, 0, 0)  # blue
    return img


def test_key_and_split_tiny_green_sheet(tmp_path: Path):
    cells = process_image(_green_sheet(), key=True, grid=(2, 1), split="grid", trim=True)
    assert len(cells) == 2

    left, right = cells
    assert left.shape[2] == 4
    assert right.shape[2] == 4
    assert not is_empty(left)
    assert not is_empty(right)

    left_opaque = left[left[:, :, 3] > 128]
    right_opaque = right[right[:, :, 3] > 128]
    assert len(left_opaque) >= 16
    assert len(right_opaque) >= 16

    # Foreground stays red / blue; leftover screen green is gone (keyed + despilled).
    assert left_opaque[:, 2].mean() > 200  # R
    assert left_opaque[:, 1].mean() < 80  # G
    assert right_opaque[:, 0].mean() > 200  # B
    assert right_opaque[:, 1].mean() < 80  # G

    # Fully green pixels in each cell should be transparent.
    left_green = np.all(left[:, :, :3] == (0, 255, 0), axis=2)
    if left_green.any():
        assert left[left_green][:, 3].max() < 40

    out = tmp_path / "left.png"
    assert cv2.imwrite(str(out), left)
    assert out.stat().st_size > 0
