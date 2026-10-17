"""Hand-erasing parts of a shot's frames: undoable, survives a re-key, never touches colour."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor import shot_erase
from compositor.shot_capture import _process_and_write_frame, reprocess

W, H = 80, 60


def _solid_frame(path: Path) -> None:
    bgra = np.zeros((H, W, 4), np.uint8)
    bgra[:, :, :3] = (30, 60, 200)
    bgra[:, :, 3] = 255
    cv2.imwrite(str(path), bgra)


def _shot(tmp_path: Path, frames: int = 3) -> Path:
    out = tmp_path / "shot"
    (out / "cut").mkdir(parents=True)
    (out / "thumb").mkdir()
    (out / "erase").mkdir()
    for i in range(1, frames + 1):
        _solid_frame(out / "cut" / f"f_{i:04d}.png")
    return out


def _mask(path: Path, x0: int, x1: int) -> None:
    mask = np.zeros((H, W), np.uint8)
    mask[:, x0:x1] = 255
    cv2.imwrite(str(path), mask)


def _alpha(out: Path, idx: int) -> np.ndarray:
    return cv2.imread(str(out / "cut" / f"f_{idx:04d}.png"), cv2.IMREAD_UNCHANGED)[:, :, 3]


def test_erase_makes_the_masked_area_transparent_and_keeps_colour(tmp_path: Path) -> None:
    out = _shot(tmp_path)
    before = cv2.imread(str(out / "cut" / "f_0002.png"), cv2.IMREAD_UNCHANGED)
    _mask(out / "erase" / "f_0002.png", 10, 30)
    assert shot_erase.apply_frame(out, 2) == "erased"
    alpha = _alpha(out, 2)
    assert alpha[:, 10:30].max() == 0
    assert alpha[:, :10].min() == 255 and alpha[:, 30:].min() == 255
    after = cv2.imread(str(out / "cut" / "f_0002.png"), cv2.IMREAD_UNCHANGED)
    assert (after[:, :, :3] == before[:, :, :3]).all()
    assert (_alpha(out, 1) == 255).all() and (_alpha(out, 3) == 255).all()
    assert (out / "thumb" / "f_0002.jpg").exists()
    assert shot_erase.erased_frames(out) == [2]


def test_a_second_erase_replaces_the_first_instead_of_stacking_on_it(tmp_path: Path) -> None:
    out = _shot(tmp_path)
    _mask(out / "erase" / "f_0001.png", 0, 40)
    shot_erase.apply_frame(out, 1)
    _mask(out / "erase" / "f_0001.png", 60, 80)
    shot_erase.apply_frame(out, 1)
    alpha = _alpha(out, 1)
    assert alpha[:, :40].min() == 255
    assert alpha[:, 60:].max() == 0


def test_restore_and_an_empty_mask_both_put_the_frame_back(tmp_path: Path) -> None:
    out = _shot(tmp_path)
    for idx in (1, 2):
        _mask(out / "erase" / f"f_{idx:04d}.png", 0, 80)
        shot_erase.apply_frame(out, idx)
    assert _alpha(out, 1).max() == 0

    assert shot_erase.restore_frame(out, 1) is True
    assert (_alpha(out, 1) == 255).all()
    assert shot_erase.erased_frames(out) == [2]

    cv2.imwrite(str(out / "erase" / "f_0002.png"), np.zeros((H, W), np.uint8))
    assert shot_erase.apply_frame(out, 2) == "restored"
    assert (_alpha(out, 2) == 255).all()
    assert shot_erase.erased_frames(out) == []
    assert not any((out / "cut_orig").glob("*.png"))


def test_a_mask_of_another_size_is_scaled_to_the_frame(tmp_path: Path) -> None:
    out = _shot(tmp_path)
    mask = np.zeros((H * 2, W * 2), np.uint8)
    mask[:, W:] = 255
    cv2.imwrite(str(out / "erase" / "f_0001.png"), mask)
    shot_erase.apply_frame(out, 1)
    alpha = _alpha(out, 1)
    assert alpha[:, : W // 2 - 1].min() == 255
    assert alpha[:, W // 2 + 1 :].max() == 0


def test_an_erase_survives_re_keying_the_shot_and_can_still_be_undone(tmp_path: Path) -> None:
    out = tmp_path / "shot"
    for name in ("raw", "cut", "thumb", "erase"):
        (out / name).mkdir(parents=True)
    raw = np.zeros((H, W, 3), np.uint8)
    cv2.rectangle(raw, (20, 10), (60, 50), (40, 90, 220), -1)
    cv2.imwrite(str(out / "raw" / "f_0001.png"), raw)
    (out / "shot.json").write_text('{"fps": 24, "keyMode": "head-black"}')
    _mask(out / "erase" / "f_0001.png", 0, 40)

    reprocess(str(out))
    alpha = _alpha(out, 1)
    assert alpha[30, 30] == 0
    assert alpha[30, 50] == 255

    shot_erase.restore_frame(out, 1)
    assert _alpha(out, 1)[30, 30] == 255


def test_process_and_write_frame_leaves_frames_without_an_erase_alone(tmp_path: Path) -> None:
    out = tmp_path / "shot"
    (out / "cut").mkdir(parents=True)
    (out / "thumb").mkdir()
    raw = np.zeros((H, W, 3), np.uint8)
    cv2.rectangle(raw, (20, 10), (60, 50), (40, 90, 220), -1)
    _process_and_write_frame(raw, 1, out / "cut", out / "thumb", key_mode="head-black")
    assert _alpha(out, 1)[30, 30] == 255
    assert not (out / "cut_orig").exists()
