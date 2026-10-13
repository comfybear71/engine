from __future__ import annotations

import numpy as np

from compositor.factory_fit import (
    count_boots,
    extract_legs,
    facing_direction,
    fit_piece_no_squash,
    looks_like_full_figure,
    looks_like_full_head,
    validate_piece,
    validate_walk_frame,
)


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


def _full_figure_facing_right() -> np.ndarray:
    img = np.zeros((120, 80, 4), dtype=np.uint8)
    img[8:22, 42:62] = (96, 140, 196, 255)  # head on the right
    img[22:52, 34:58] = (28, 28, 150, 255)  # torso
    img[52:88, 30:40] = (40, 70, 140, 255)  # back leg
    img[52:88, 48:58] = (40, 70, 140, 255)  # front leg
    img[88:102, 28:42] = (24, 40, 70, 255)  # back boot
    img[88:102, 50:64] = (24, 40, 70, 255)  # front boot
    return img


def test_extract_legs_drops_the_head_and_keeps_two_boots():
    src = _full_figure_facing_right()
    assert looks_like_full_figure(src) is True
    assert facing_direction(src) == "right"
    assert count_boots(src) == 2
    legs = extract_legs(src)
    assert looks_like_full_figure(legs) is False
    assert count_boots(legs) == 2
    ys, xs = np.where(legs[:, :, 3] > 16)
    assert int(ys.min()) >= 40
    assert validate_walk_frame(src, expect_face="right") == []


def test_validate_walk_rejects_stacked_boots_and_wrong_facing():
    stacked = _full_figure_facing_right()
    stacked[88:102, 8:20] = (24, 40, 70, 255)
    stacked[88:102, 66:78] = (24, 40, 70, 255)
    problems = validate_walk_frame(stacked, expect_face="right")
    assert any("boots" in item for item in problems)

    left = np.fliplr(_full_figure_facing_right())
    facing = validate_walk_frame(left, expect_face="right")
    assert any("facing" in item for item in facing)
