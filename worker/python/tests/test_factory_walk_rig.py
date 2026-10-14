from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.align import alpha_bbox
from compositor.factory_fit import BOOT_BAND_FRAC, _boot_xs, count_boots, count_figures, validate_walk_frame
from compositor.factory_walk_rig import (
    BOB_PX,
    _foot_xs,
    build_long_stride_cycle,
    long_stride_warp,
    plant_to_ground,
    stride_amount,
    travel_distance,
)

REAL_WALK_02 = Path("/workspace/projects/rodney_demo/characters/rodney/torso/walk_side_02.png")
REAL_WALK_07 = Path("/workspace/projects/rodney_demo/characters/rodney/torso/walk_side_07.png")
REAL_LONG_8_01 = Path("/workspace/projects/rodney_demo/characters/rodney/torso/walk_side_long_stride_8_01.png")


def _full_figure(offset: int = 0) -> np.ndarray:
    img = np.zeros((120, 90, 4), dtype=np.uint8)
    img[8:22, 48:70] = (96, 140, 196, 255)
    img[22:52, 38:62] = (28, 28, 150, 255)
    img[52:88, 32 + offset : 42 + offset] = (40, 70, 140, 255)
    img[52:88, 50 - offset : 60 - offset] = (40, 70, 140, 255)
    img[88:102, 28 + offset : 44 + offset] = (24, 40, 70, 255)
    img[88:102, 50 - offset : 66 - offset] = (24, 40, 70, 255)
    return img


def _cape_knee_figure() -> np.ndarray:
    """Clean 2-boot cell with cape hem / knee plates in the old 72% band."""

    img = np.zeros((200, 80, 4), dtype=np.uint8)
    img[8:28, 42:66] = (96, 140, 196, 255)  # head
    img[28:90, 30:62] = (28, 28, 150, 255)  # torso
    img[90:150, 28:40] = (40, 70, 140, 255)
    img[90:150, 48:60] = (40, 70, 140, 255)
    # Cape hem / knee plates around 72–80% of the bbox — not boots.
    img[140:158, 22:36] = (20, 20, 180, 255)
    img[140:158, 50:64] = (20, 20, 180, 255)
    img[168:190, 24:40] = (24, 40, 70, 255)
    img[168:190, 48:64] = (24, 40, 70, 255)
    return img


def test_boot_band_ignores_cape_hem_and_knee_plates():
    assert BOOT_BAND_FRAC >= 0.84
    src = _cape_knee_figure()
    assert count_boots(src) == 2
    assert not any("boots" in item for item in validate_walk_frame(src, expect_face=None))


def test_stacked_boots_at_the_foot_line_still_fail():
    src = _cape_knee_figure()
    src[168:190, 4:16] = (24, 40, 70, 255)
    src[168:190, 66:78] = (24, 40, 70, 255)
    problems = validate_walk_frame(src, expect_face=None)
    assert any("boots" in item for item in problems)


@pytest.mark.skipif(not REAL_LONG_8_01.exists(), reason="no live long-stride cell on disk")
def test_real_clean_long_stride_cell_is_two_boots():
    src = cv2.imread(str(REAL_LONG_8_01), cv2.IMREAD_UNCHANGED)
    assert src is not None
    assert count_boots(src) == 2


def _rig_refs() -> tuple[np.ndarray, np.ndarray]:
    torso = np.zeros((1024, 1024, 4), dtype=np.uint8)
    torso[470:690, 430:640] = (150, 28, 28, 255)
    legs = np.zeros((1024, 1024, 4), dtype=np.uint8)
    legs[700:790, 450:480] = (40, 20, 10, 255)
    legs[700:790, 520:550] = (40, 20, 10, 255)
    return torso, legs


@pytest.mark.skipif(not (REAL_WALK_02.exists() and REAL_WALK_07.exists()), reason="no live walk_side frames")
@pytest.mark.parametrize("frames", [8, 12, 16])
def test_real_walk_side_builds_long_stride_cycle(frames: int):
    a = cv2.imread(str(REAL_WALK_02), cv2.IMREAD_UNCHANGED)
    b = cv2.imread(str(REAL_WALK_07), cv2.IMREAD_UNCHANGED)
    assert a is not None and b is not None
    torso, legs = _rig_refs()
    cycle, info = build_long_stride_cycle(
        [a, b], frames, 1024, 1024, ref=legs, torso_ref=torso
    )
    assert len(cycle) == frames
    assert info["ok"] is True
    assert info["distance_per_cycle"] >= 96
    grounds = [alpha_bbox(frame)[3] for frame in cycle]
    heights = [alpha_bbox(frame)[3] - alpha_bbox(frame)[1] for frame in cycle]
    widths = [alpha_bbox(frame)[2] - alpha_bbox(frame)[0] for frame in cycle]
    assert max(grounds) - min(grounds) <= 2
    assert max(heights) / max(1, min(heights)) < 1.12
    for frame, height, width in zip(cycle, heights, widths):
        assert count_figures(frame) == 1
        assert count_boots(frame) <= 2
        assert abs(height - 320) / 320 < 0.15
        assert width < height * 1.15
        assert 250 < height < 500
        assert 740 <= alpha_bbox(frame)[3] <= 830


@pytest.mark.skipif(not (REAL_WALK_02.exists() and REAL_WALK_07.exists()), reason="no live walk_side frames")
def test_eight_real_keys_alternate_readable_strides():
    """Full 8-key set (Stuart's body/walk_side_01..08 layout) must not
    collapse to the old 02+07 near-identical / tiny-figure sheet."""

    a = cv2.imread(str(REAL_WALK_02), cv2.IMREAD_UNCHANGED)
    b = cv2.imread(str(REAL_WALK_07), cv2.IMREAD_UNCHANGED)
    assert a is not None and b is not None
    sources = [a, b, a, b, a, b, a, b]
    torso, legs = _rig_refs()
    cycle, info = build_long_stride_cycle(sources, 8, 1024, 1024, ref=legs, torso_ref=torso)
    assert len(cycle) == 8
    assert info["sources"] == 8
    leads: list[float] = []
    for frame in cycle:
        box = alpha_bbox(frame)
        assert box is not None
        assert (box[3] - box[1]) >= 240
        assert count_figures(frame) == 1
        assert count_boots(frame) <= 2
        xs = _boot_xs(frame) or _foot_xs(frame)
        assert xs, "each 8-key frame must expose a lead foot"
        leads.append(max(xs))
    even = float(np.mean([leads[i] for i in range(0, 8, 2)]))
    odd = float(np.mean([leads[i] for i in range(1, 8, 2)]))
    assert abs(even - odd) >= 8, f"alternating strides collapsed ({even:.1f} vs {odd:.1f})"
    for i in range(1, 8):
        diff = float(np.mean(np.abs(cycle[i].astype(np.float32) - cycle[i - 1].astype(np.float32))))
        assert diff > 1.5, f"frames {i} and {i + 1} look frozen ({diff:.3f})"


def test_painted_sources_build_8_12_16_without_squash_or_a_second_head():
    sources = [_full_figure(-6), _full_figure(6)]
    for frames in (8, 12, 16):
        cycle, info = build_long_stride_cycle(sources, frames, 1024, 1024)
        assert len(cycle) == frames
        assert info["distance_per_cycle"] >= 96
        grounds = [alpha_bbox(frame)[3] for frame in cycle]
        assert max(grounds) - min(grounds) <= 2
        for frame in cycle:
            assert count_figures(frame) == 1
            box = alpha_bbox(frame)
            assert box is not None
            assert (box[3] - box[1]) > (box[2] - box[0])


def test_plant_to_ground_does_not_scale():
    src = _full_figure()
    box = alpha_bbox(src)
    planted = plant_to_ground(src, box[3] + 12)
    new = alpha_bbox(planted)
    assert new[3] - new[1] == box[3] - box[1]
    assert new[2] - new[0] == box[2] - box[0]
    assert new[3] == box[3] + 12


def test_long_stride_warp_widens_legs_and_keeps_one_body():
    src = np.zeros((200, 200, 4), dtype=np.uint8)
    src[20:90, 80:120] = (28, 28, 150, 255)
    src[90:180, 60:84] = (40, 70, 140, 255)
    src[90:180, 116:140] = (40, 70, 140, 255)
    warped = long_stride_warp(src, 0.35, BOB_PX)
    before = alpha_bbox(src)
    after = alpha_bbox(warped)
    assert after[2] - after[0] > before[2] - before[0]
    assert abs((after[3] - after[1]) - (before[3] - before[1])) <= 4
    assert count_figures(warped) == 1
    assert stride_amount(0.0) > stride_amount(0.25)


def test_travel_uses_foot_span_when_boots_are_thin():
    a = _full_figure(-8)
    b = _full_figure(8)
    canvas_a = np.zeros((200, 200, 4), dtype=np.uint8)
    canvas_b = np.zeros((200, 200, 4), dtype=np.uint8)
    canvas_a[20:140, 40:130] = a
    canvas_b[20:140, 40:130] = b
    assert travel_distance([canvas_a, canvas_b]) >= 96
