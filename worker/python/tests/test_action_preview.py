from __future__ import annotations

import numpy as np

from compositor.action_preview import (
    contain_crop_box,
    content_bbox,
    crop_rect,
    crop_square,
    sample_frame_indices,
    square_crop_box,
    union_bbox,
)


def test_content_bbox_ignores_black_and_square_crop_zooms_the_figure():
    frame = np.zeros((480, 854, 3), dtype=np.uint8)
    frame[200:320, 380:470] = (40, 80, 200)
    box = content_bbox(frame)
    assert box == (380, 200, 469, 319)
    merged = union_bbox(box, (390, 210, 480, 330))
    assert merged == (380, 200, 480, 330)
    crop = square_crop_box(box, 854, 480, pad_ratio=0.1)
    assert crop[2] == crop[3]
    tile = crop_square(frame, crop, 256)
    assert tile.shape == (256, 256, 3)
    assert tile.max() > 0


def test_contain_crop_is_16x9_and_keeps_the_whole_figure():
    frame = np.zeros((480, 854, 3), dtype=np.uint8)
    frame[80:400, 380:490] = (40, 80, 200)
    box = content_bbox(frame)
    crop = contain_crop_box(box, 854, 480, aspect=(16, 9), pad_ratio=0.2)
    x, y, w, h = crop
    assert w > h
    assert abs((w / h) - (16 / 9)) < 0.08
    assert x <= box[0] and y <= box[1]
    assert x + w > box[2] and y + h > box[3]
    tile = crop_rect(frame, crop, 854, 480)
    assert tile.shape == (480, 854, 3)
    assert tile.max() > 0


def test_sample_indices_are_one_cycle_without_wrap_or_holds():
    # 2s loop at 24fps of an 8-frame 12fps walk used to dump 0,2,… then wrap
    # so frames 8/10/12/14 copied 0/2/4/6.
    wrapped = sample_frame_indices(48, 24, sample_fps=12, cycle_frames=8)
    assert wrapped == [0, 2, 4, 6, 8, 10, 12, 14]
    assert len(set(wrapped)) == 8
    one_cycle = sample_frame_indices(16, 24, sample_fps=12, cycle_frames=8)
    assert one_cycle == [0, 2, 4, 6, 8, 10, 12, 14]
