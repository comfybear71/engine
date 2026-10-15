"""Head-on-black keyer: dark hair and beard stay, the black backdrop goes."""

from __future__ import annotations

import cv2
import numpy as np

from compositor.shot_capture import HEAD_BLACK_KEY, key_head_on_black, process_frame


def _head_on_black() -> np.ndarray:
    rng = np.random.default_rng(1)
    img = np.zeros((720, 1280, 3), np.uint8)
    cv2.ellipse(img, (640, 360), (150, 200), 0, 0, 360, (120, 160, 210), -1)
    texture = rng.integers(10, 40, img.shape, dtype=np.uint8)
    hair = np.zeros(img.shape[:2], np.uint8)
    cv2.ellipse(hair, (640, 230), (165, 120), 0, 180, 360, 1, -1)
    beard = np.zeros(img.shape[:2], np.uint8)
    cv2.ellipse(beard, (640, 520), (120, 90), 0, 0, 180, 1, -1)
    for mask in (hair, beard):
        img[mask == 1] = texture[mask == 1]
    cv2.circle(img, (600, 180), 12, (2, 2, 2), -1)
    return img


def test_keeps_dark_hair_beard_and_inner_shadow() -> None:
    alpha = key_head_on_black(_head_on_black())[:, :, 3]
    assert alpha[150, 640] == 255
    assert alpha[580, 640] == 255
    assert alpha[180, 600] == 255
    assert alpha[360, 640] == 255


def test_removes_backdrop_and_letterbox_bars() -> None:
    img = _head_on_black()
    img[:40] = 0
    img[-40:] = 0
    alpha = key_head_on_black(img)[:, :, 3]
    assert alpha[20, 20] == 0
    assert alpha[360, 300] == 0
    assert alpha[10, 640] == 0
    assert alpha[710, 640] == 0


def test_does_not_change_pixel_colours() -> None:
    img = _head_on_black()
    out = key_head_on_black(img)
    assert np.array_equal(out[:, :, :3], img)


def test_process_frame_uses_the_head_black_mode() -> None:
    img = _head_on_black()
    default = process_frame(img, bg_hint="black")
    forced = process_frame(img, bg_hint="black", key_mode=HEAD_BLACK_KEY)
    assert forced[150, 640, 3] == 255
    assert default.shape == forced.shape


def test_dark_pocket_reached_only_through_a_narrow_gap_stays_solid() -> None:
    img = np.zeros((704, 1280, 3), dtype=np.uint8)
    cv2.ellipse(img, (640, 360), (230, 280), 0, 0, 360, (60, 110, 190), -1)
    cv2.rectangle(img, (540, 300), (740, 400), (0, 0, 0), -1)
    cv2.rectangle(img, (400, 340), (540, 356), (0, 0, 0), -1)
    alpha = key_head_on_black(img)[:, :, 3]
    assert alpha[350, 640] == 255
    assert alpha[348, 470] == 255
    assert alpha[20, 20] == 0
    assert alpha[360, 200] == 0
