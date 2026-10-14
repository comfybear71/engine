"""Import MP4: key, skip intro stand/turn, score a gait cycle, fit to the rig."""

from __future__ import annotations

import numpy as np

from compositor.align import alpha_bbox
from compositor.factory_import_mp4 import (
    detect_background,
    detect_steady_section,
    fit_import_body,
    frame_features,
    key_black,
    key_frame,
    looks_like_has_head,
    loop_closure,
    suggest_keys,
)


def _body(
    h: int = 200,
    w: int = 120,
    stride: int = 0,
    *,
    headed: bool = False,
    island: bool = False,
    bg: str = "black",
    outline: bool = True,
) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    if bg == "green":
        img[:] = (0, 255, 0)
    y0 = 36 if headed else 22
    if headed:
        img[8:28, 50:66] = (96, 140, 196)
    if outline:
        img[y0 : y0 + 24, 28:84] = (14, 16, 18)  # dark cape outline
    img[y0 + 2 : y0 + 22, 32:80] = (28, 24, 150)  # cape fill
    img[y0 + 18 : y0 + 58, 40:78] = (40, 36, 170)  # torso
    img[y0 + 56 : y0 + 118, 42 - stride : 52 - stride] = (50, 80, 150)
    img[y0 + 56 : y0 + 118, 66 + stride : 76 + stride] = (50, 80, 150)
    img[y0 + 116 : y0 + 130, 40 - stride : 54 - stride] = (32, 36, 42)
    img[y0 + 116 : y0 + 130, 64 + stride : 78 + stride] = (32, 36, 42)
    if island:
        img[6:14, 6:14] = (40, 40, 200)
    return img


def _walk_sequence(n: int = 150, walk_start: int = 76, walk_end: int = 145) -> list[np.ndarray]:
    frames = []
    for i in range(n):
        if i < walk_start:
            # Intro stand / turn: almost no stride, facing drifts.
            stride = 1 if i % 18 > 9 else 0
            frames.append(_body(stride=stride, island=(i == 3)))
        elif i < walk_end:
            phase = (i - walk_start) / 24.0 * np.pi * 2
            stride = int(round(8 * np.sin(phase)))
            frames.append(_body(stride=stride))
        else:
            frames.append(_body(stride=2))
    return frames


def test_detect_black_and_green_backgrounds():
    assert detect_background([_body(bg="black")]) == "black"
    assert detect_background([_body(bg="green")]) == "green"


def test_key_black_keeps_dark_outlines_and_drops_the_field():
    src = _body(stride=4, outline=True)
    keyed = key_black(src)
    assert keyed.shape[2] == 4
    assert int(keyed[2, 2, 3]) == 0
    box = alpha_bbox(keyed)
    assert box is not None
    # Dark cape rim next to the body stays opaque.
    ys, xs = np.where(keyed[:, :, 3] > 16)
    assert ys.min() <= 30
    # Boot pixels (mid-grey, not true black) stay.
    assert int(np.count_nonzero(keyed[:, :, 3] > 16)) > 400


def test_key_green_and_stray_island():
    src = _body(bg="green", island=True, stride=3)
    keyed = key_frame(src, "green")
    assert int(keyed[2, 2, 3]) == 0
    # Corner island is gone; one main figure remains.
    feats = frame_features(src, keyed)
    assert feats["blobs"] == 1
    assert feats["empty"] is False


def test_headless_vs_headed():
    headless = key_frame(_body(headed=False), "black")
    headed = key_frame(_body(headed=True), "black")
    assert looks_like_has_head(headless) is False
    assert looks_like_has_head(headed) is True


def test_steady_section_skips_intro_stand_turn():
    raw = _walk_sequence()
    keyed = [key_frame(img, "black") for img in raw]
    features = [frame_features(raw[i], keyed[i]) for i in range(len(raw))]
    start, end = detect_steady_section(features)
    assert start >= 60
    assert start < 100
    assert end >= 130


def test_suggest_keys_span_one_gait_cycle():
    raw = _walk_sequence()
    keyed = [key_frame(img, "black") for img in raw]
    features = [frame_features(raw[i], keyed[i]) for i in range(len(raw))]
    start, end = detect_steady_section(features)
    picks = suggest_keys(features, start, end)
    for count in ("8", "12", "16"):
        keys = picks[count]
        assert len(keys) == int(count)
        assert keys == sorted(keys)
        assert keys[0] >= 76
        assert keys[-1] <= 145
        assert len(set(keys)) == int(count)
        assert loop_closure(features, keys) >= 0.4


def test_fit_plants_feet_and_eases_collar_to_neck():
    src = key_frame(_body(stride=6), "black")
    canvas_h = 256
    canvas_w = 256
    neck_y = 90
    ground = 220
    torso = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    torso[70:160, 100:156] = (40, 40, 170, 255)
    legs = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    legs[160:ground, 96:120] = (50, 80, 150, 255)
    legs[160:ground, 136:160] = (50, 80, 150, 255)
    fitted, problems = fit_import_body(src, canvas_w, canvas_h, torso_ref=torso, legs_ref=legs, neck_y=neck_y)
    box = alpha_bbox(fitted)
    assert box is not None
    assert abs(int(box[3]) - ground) <= 3
    assert int(box[1]) <= neck_y + 8
    assert "blank drawing" not in problems
    headed = key_frame(_body(headed=True, stride=4), "black")
    _, head_problems = fit_import_body(headed, canvas_w, canvas_h, neck_y=neck_y)
    assert any("head" in item for item in head_problems)
