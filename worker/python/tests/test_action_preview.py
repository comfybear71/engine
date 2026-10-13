from __future__ import annotations

import numpy as np

from compositor.action_preview import content_bbox, crop_square, square_crop_box, union_bbox


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
