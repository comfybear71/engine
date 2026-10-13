from __future__ import annotations

import numpy as np

from compositor.factory_fit import fit_piece_no_squash, looks_like_full_head, validate_piece


def _rect(w: int, h: int, color=(40, 80, 180, 255)) -> np.ndarray:
    img = np.zeros((h + 20, w + 20, 4), dtype=np.uint8)
    img[10 : 10 + h, 10 : 10 + w] = color
    return img


def test_fit_never_squashes_a_tall_piece():
    src = _rect(40, 80)
    out = fit_piece_no_squash(src, 200, 200, margin=8)
    assert out.shape == (200, 200, 4)
    ys, xs = np.where(out[:, :, 3] > 16)
    bw = int(xs.max() - xs.min() + 1)
    bh = int(ys.max() - ys.min() + 1)
    ratio = bh / max(1, bw)
    assert 1.8 < ratio < 2.2
    assert validate_piece(out, 200, 200) == []


def test_eyes_overlay_is_not_a_full_head():
    head = _rect(80, 100)
    eyes = _rect(50, 18)
    assert looks_like_full_head(head, head) is True
    assert looks_like_full_head(eyes, head) is False
