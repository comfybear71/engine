from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from compositor.align import alpha_bbox
from compositor.factory_fit import (
    count_boots,
    count_figures,
    extract_legs,
    facing_direction,
    fit_piece_no_squash,
    fit_walk_piece,
    looks_like_full_figure,
    looks_like_full_head,
    looks_like_walk_body,
    normalize_walk_batch,
    validate_piece,
    validate_walk_composite,
    validate_walk_frame,
    walk_pose_problems,
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


def _zoomed_boots() -> np.ndarray:
    """Real Grok failure mode: a close-up of two boots filling the cell."""

    img = np.zeros((220, 220, 4), dtype=np.uint8)
    img[40:200, 20:95] = (24, 40, 70, 255)
    img[40:200, 125:200] = (24, 40, 70, 255)
    return img


def _two_rodneys() -> np.ndarray:
    left = _full_figure_facing_right()
    right = np.fliplr(_full_figure_facing_right())
    img = np.zeros((130, 180, 4), dtype=np.uint8)
    img[5:125, 4:84] = left
    img[5:125, 96:176] = right
    return img


def _rig_refs() -> tuple[np.ndarray, np.ndarray]:
    torso = np.zeros((1024, 1024, 4), dtype=np.uint8)
    torso[470:690, 430:640] = (150, 28, 28, 255)
    legs = np.zeros((1024, 1024, 4), dtype=np.uint8)
    legs[700:790, 450:480] = (40, 20, 10, 255)
    legs[700:790, 520:550] = (40, 20, 10, 255)
    return torso, legs


def test_count_figures_one_body_not_cape_or_two_people():
    assert count_figures(_full_figure_facing_right()) == 1
    assert count_figures(_two_rodneys()) == 2


def _headless_walk_body() -> np.ndarray:
    """Landscape Grok walk cell: cape + torso + legs, no separate head blob."""

    img = np.zeros((90, 110, 4), dtype=np.uint8)
    img[8:48, 6:22] = (20, 20, 180, 255)  # cape
    img[12:48, 28:70] = (28, 28, 150, 255)  # torso
    img[48:72, 32:42] = (40, 70, 140, 255)
    img[48:72, 52:62] = (40, 70, 140, 255)
    img[72:86, 28:46] = (24, 40, 70, 255)
    img[72:86, 50:68] = (24, 40, 70, 255)
    return img


def test_headless_walk_body_is_accepted_and_not_scaled_to_canvas():
    src = _headless_walk_body()
    assert looks_like_walk_body(src) is True
    problems = validate_walk_frame(src, expect_face=None, require_full_figure=True)
    assert not any("zoomed crop" in item or "extra figures" in item for item in problems)
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        src, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face=None
    )
    assert problems == []
    box = alpha_bbox(fitted)
    assert box is not None
    assert 250 < box[3] - box[1] < 420
    assert box[3] > 680


REAL_WALK = Path("/workspace/projects/rodney_demo/characters/rodney/torso/walk_side_02.png")


@pytest.mark.skipif(not REAL_WALK.exists(), reason="no live Rodney Grok walk drawing on disk")
def test_real_whole_body_sheet_fits_at_rig_scale_without_extracting_legs():
    """Regression: live Grok cells are hat-to-boots. Fit the whole cell, never chop at the waist."""

    import cv2

    src = cv2.imread(str(REAL_WALK), cv2.IMREAD_UNCHANGED)
    assert src is not None
    torso, legs = _rig_refs()
    frames = []
    for i in range(8):
        shift = (i % 4) * 8 - 12
        cell = np.zeros_like(src)
        if shift >= 0:
            cell[:, shift:] = src[:, : src.shape[1] - shift]
        else:
            cell[:, : src.shape[1] + shift] = src[:, -shift:]
        fitted, problems = fit_walk_piece(
            cell, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face=None
        )
        assert problems == []
        box = alpha_bbox(fitted)
        assert box is not None
        assert 250 < box[3] - box[1] < 450
        assert 760 <= box[3] <= 810
        frames.append(fitted)
    assert walk_pose_problems(frames) == []
    for frame in frames:
        assert validate_walk_composite(frame, [torso, legs]) == []


@pytest.mark.skipif(not REAL_WALK.exists(), reason="no live Rodney Grok walk drawing on disk")
def test_real_grok_walk_drawing_is_not_scaled_to_fill_the_canvas():
    import cv2

    src = cv2.imread(str(REAL_WALK), cv2.IMREAD_UNCHANGED)
    assert src is not None
    old = fit_piece_no_squash(src, 1024, 1024, margin=8)
    old_box = alpha_bbox(old)
    assert old_box is not None
    assert old_box[3] - old_box[1] > 800
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        src, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face=None
    )
    assert problems == []
    box = alpha_bbox(fitted)
    assert box is not None
    assert 250 < box[3] - box[1] < 450
    assert 760 <= box[3] <= 810
    assert looks_like_walk_body(fitted) is True


def test_validate_walk_rejects_extra_figures_and_zoomed_boots():
    extras = validate_walk_frame(_two_rodneys(), expect_face=None, require_full_figure=True)
    assert any("extra figures" in item for item in extras)
    zoomed = validate_walk_frame(_zoomed_boots(), expect_face=None, require_full_figure=True)
    assert any("extra figures" in item or "zoomed crop" in item for item in zoomed)


def test_old_extract_then_canvas_fit_enlarges_legs_the_live_bug():
    src = _full_figure_facing_right()
    chopped = extract_legs(src)
    giant = fit_piece_no_squash(chopped, 1024, 1024, margin=8)
    box = alpha_bbox(giant)
    assert box is not None
    assert box[3] - box[1] > 800


def test_fit_walk_matches_rig_scale_and_plants_feet():
    src = _full_figure_facing_right()
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        src, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face="right"
    )
    assert problems == []
    box = alpha_bbox(fitted)
    assert box is not None
    height = box[3] - box[1]
    assert 250 <= height <= 420
    assert 760 <= box[3] <= 810
    assert height < 1024 * 0.5
    assert looks_like_walk_body(fitted) is True


def test_fit_walk_rejects_extra_figures_instead_of_compositing_them():
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        _two_rodneys(), 1024, 1024, ref=legs, torso_ref=torso, extract=True, expect_face=None
    )
    assert any("extra figures" in item for item in problems)
    assert int(np.count_nonzero(fitted[:, :, 3] > 16)) == 0


def test_fit_walk_rejects_zoomed_boots_instead_of_scaling_them():
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        _zoomed_boots(), 1024, 1024, ref=legs, torso_ref=torso, extract=True, expect_face=None
    )
    assert any("zoomed crop" in item or "extra figures" in item for item in problems)
    assert int(np.count_nonzero(fitted[:, :, 3] > 16)) == 0


def test_normalize_walk_batch_shares_a_ground_line():
    torso, legs = _rig_refs()
    small = _full_figure_facing_right()
    big = np.zeros((180, 120, 4), dtype=np.uint8)
    big[10:170, 20:100] = _resize_like(small, 160, 80)
    a, _p = fit_walk_piece(small, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face="right")
    b, _q = fit_walk_piece(big, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face="right")
    out = normalize_walk_batch([a, b])
    grounds = [alpha_bbox(frame)[3] for frame in out]
    heights = [alpha_bbox(frame)[3] - alpha_bbox(frame)[1] for frame in out]
    assert max(grounds) - min(grounds) <= 2
    assert abs(heights[0] - heights[1]) <= 4


def _resize_like(src: np.ndarray, h: int, w: int) -> np.ndarray:
    import cv2

    return cv2.resize(src, (w, h), interpolation=cv2.INTER_NEAREST)


def _stride_figure(offset: int) -> np.ndarray:
    img = _full_figure_facing_right()
    shifted = np.zeros_like(img)
    if offset >= 0:
        shifted[:, offset:] = img[:, : img.shape[1] - offset]
    else:
        shifted[:, : img.shape[1] + offset] = img[:, -offset:]
    return shifted


def test_walk_pose_rejects_identical_cells_and_accepts_a_cycle():
    same = [_full_figure_facing_right() for _ in range(8)]
    assert any("near-identical" in item for item in walk_pose_problems(same))
    cycle = [_stride_figure((i % 4) * 4 - 4) for i in range(8)]
    assert walk_pose_problems(cycle) == []


def test_extract_then_standing_torso_is_duplicated_boots():
    src = _full_figure_facing_right()
    torso, legs = _rig_refs()
    chopped, _problems = fit_walk_piece(
        src, 1024, 1024, ref=legs, torso_ref=torso, extract=True, expect_face="right"
    )
    problems = validate_walk_composite(chopped, [torso, legs])
    assert any("duplicated" in item or "rig base" in item for item in problems)


def test_whole_body_walk_covers_standing_rig():
    src = _full_figure_facing_right()
    torso, legs = _rig_refs()
    fitted, problems = fit_walk_piece(
        src, 1024, 1024, ref=legs, torso_ref=torso, extract=False, expect_face="right"
    )
    assert problems == []
    extra = validate_walk_composite(fitted, [torso, legs])
    assert extra == []
