from pathlib import Path

import cv2
import numpy as np

from compositor.align import (
    already_aligned,
    align_to_reference,
    apply_shared_transform,
    crop_to_head,
    detect_collar_y,
    fit_set_to_head_canvas,
    landmarks,
    shared_overlay_transform,
)


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


def test_crop_to_head_drops_collar_and_shoulders():
    ref = _head(200, 220, 70, 20, 130, 180)
    src = np.zeros((200, 120, 4), dtype=np.uint8)
    src[10:90, 40:80] = (30, 40, 200, 255)
    src[90:180, 10:110] = (10, 80, 40, 255)
    collar = detect_collar_y(src)
    assert collar is not None
    assert 70 <= collar <= 110
    cropped = crop_to_head(src, ref)
    box = landmarks(cropped)["bbox"]
    assert box[3] <= collar + 1
    aligned = align_to_reference(src, ref, crop=True)
    sl = landmarks(aligned)
    rl = landmarks(ref)
    assert abs((sl["chin"][1] - sl["hat"][1]) - (rl["chin"][1] - rl["hat"][1])) <= 6


def test_head_only_source_is_not_cropped_by_reference_aspect():
    ref = _head(200, 220, 70, 20, 130, 180)
    src = _head(80, 90, 20, 10, 60, 70)
    cropped = crop_to_head(src, ref)
    assert (cropped[:, :, 3] > 16).sum() == (src[:, :, 3] > 16).sum()


def test_shared_transform_is_one_matrix_for_the_set(tmp_path: Path):
    base = np.zeros((1024, 1024, 4), dtype=np.uint8)
    base[200:800, 300:700] = (30, 40, 200, 255)
    default = np.zeros((80, 60, 4), dtype=np.uint8)
    default[10:30, 10:50] = (0, 0, 255, 255)
    sibling = np.zeros((80, 60, 4), dtype=np.uint8)
    sibling[40:60, 10:50] = (0, 255, 0, 255)

    scale, tx, ty = shared_overlay_transform(base, default, pivot=(512.0, 800.0))
    fitted_default = apply_shared_transform(default, scale, tx, ty)
    fitted_sibling = apply_shared_transform(sibling, scale, tx, ty)
    assert fitted_default.shape[1] == 1024
    assert fitted_default.shape[0] == 1024
    assert fitted_sibling.shape == fitted_default.shape

    dbox = landmarks(fitted_default)["bbox"]
    sbox = landmarks(fitted_sibling)["bbox"]
    # Same scale + translation: sibling stays the same offset below default.
    assert abs((sbox[1] - dbox[1]) - (40 - 10) * scale) <= 3
    assert abs((sbox[0] - dbox[0])) <= 3

    src_dir = tmp_path / "eyes"
    src_dir.mkdir()
    cv2.imwrite(str(src_dir / "open.png"), default)
    cv2.imwrite(str(src_dir / "closed.png"), sibling)
    cv2.imwrite(str(tmp_path / "base.png"), base)
    out_dir = tmp_path / "out"
    written = fit_set_to_head_canvas(
        src_dir,
        tmp_path / "base.png",
        out_dir,
        default_name="open",
        pivot=(512.0, 800.0),
    )
    assert len(written) == 2
    assert {item["width"] for item in written} == {1024}
    assert {item["height"] for item in written} == {1024}
    assert {round(item["scale"], 6) for item in written} == {round(scale, 6)}


def test_align_is_idempotent_when_already_matched():
    ref = _head(200, 220, 70, 20, 130, 180)
    src = _head(80, 90, 20, 10, 60, 70)
    once = align_to_reference(src, ref)
    assert already_aligned(once, ref)
    twice = align_to_reference(once, ref)
    assert twice.shape == once.shape
    assert abs(int((twice[:, :, 3] > 16).sum()) - int((once[:, :, 3] > 16).sum())) <= 4
    sl = landmarks(twice)
    rl = landmarks(ref)
    assert abs((sl["chin"][1] - sl["hat"][1]) - (rl["chin"][1] - rl["hat"][1])) <= 2
