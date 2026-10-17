"""Head placement in the baked shot matches the Head Rig preview (frame centred on the anchor)."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor import shot_timeline_bake as bake


def _write_shot(root: Path, name: str, frames: list[np.ndarray]) -> Path:
    cut = root / name / "cut"
    cut.mkdir(parents=True)
    for i, img in enumerate(frames, start=1):
        cv2.imwrite(str(cut / f"f_{i:04d}.png"), img)
    return cut


def _body(w=100, h=200) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = 200
    img[:, :, 3] = 255
    return img


def _head(content_x: int, content_w: int, w=60, h=60, content_y=10, content_h=30) -> np.ndarray:
    """Frame with an off-centre opaque block, like a head that is not centred in its clip."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[content_y:content_y + content_h, content_x:content_x + content_w] = (0, 0, 255, 255)
    return img


def _spec(tmp_path: Path, body_cut: Path, head_cut: Path, frames: int, anchor, scale=1.0) -> Path:
    spec = {
        "fps": 24,
        "bodySegments": [{"cutDir": str(body_cut), "inFrame": 1, "outFrame": frames, "start": 1}],
        "headSegments": [
            {
                "cutDir": str(head_cut),
                "inFrame": 1,
                "outFrame": frames,
                "start": 1,
                "anchorX": anchor[0],
                "anchorY": anchor[1],
                "headScale": scale,
            }
        ],
    }
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec))
    return path


def _red_box(path: Path) -> tuple[int, int, int, int]:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    mask = (img[:, :, 2] > 200) & (img[:, :, 0] < 50) & (img[:, :, 3] > 200)
    ys, xs = np.where(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def test_head_frame_is_centred_on_anchor_not_its_visible_box(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()] * 2)
    # Visible block hugs the right of the frame: x 40..58 of a 60 wide frame.
    head_cut = _write_shot(tmp_path, "head", [_head(40, 18)] * 2)
    out = tmp_path / "out"
    bake.run(str(_spec(tmp_path, body_cut, head_cut, 2, (0.5, 0.5))), str(out))

    x0, y0, x1, y1 = _red_box(out / "cut" / "f_0001.png")
    canvas = cv2.imread(str(out / "cut" / "f_0001.png"), cv2.IMREAD_UNCHANGED)
    assert canvas.shape[:2] == (200, 100)
    # Frame centre (30, 30) sits on (50, 100): the block's left edge is 10px right of centre.
    assert (x0, x1) == (50 + (40 - 30), 50 + (58 - 30))
    assert (y0, y1) == (100 + (10 - 30), 100 + (40 - 30))


def test_visible_pixels_never_clipped_when_head_overshoots_the_body(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()])
    head_cut = _write_shot(tmp_path, "head", [_head(0, 60, content_y=0, content_h=60)])
    out = tmp_path / "out"
    bake.run(str(_spec(tmp_path, body_cut, head_cut, 1, (0.1, 0.05), scale=1.0)), str(out))
    canvas = cv2.imread(str(out / "cut" / "f_0001.png"), cv2.IMREAD_UNCHANGED)
    pad_l, pad_t, pad_r, pad_b = bake.head_overshoot_padding(
        json.loads((tmp_path / "spec.json").read_text())["headSegments"], 100, 200
    )
    assert canvas.shape[1] == 100 + pad_l + pad_r
    assert canvas.shape[0] == 200 + pad_t + pad_b
    # 60x60 head centred on (10, 10): extends 20px past the left/top edges.
    assert pad_l >= 20 and pad_t >= 20
    x0, y0, x1, y1 = _red_box(out / "cut" / "f_0001.png")
    assert (x1 - x0, y1 - y0) == (60, 60)


def test_head_does_not_move_while_its_visible_box_changes(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()] * 2)
    narrow = _head(10, 10)
    wide = _head(10, 40)
    head_cut = _write_shot(tmp_path, "head", [narrow, wide])
    out = tmp_path / "out"
    bake.run(str(_spec(tmp_path, body_cut, head_cut, 2, (0.5, 0.5))), str(out))
    a = _red_box(out / "cut" / "f_0001.png")
    b = _red_box(out / "cut" / "f_0002.png")
    assert a[0] == b[0]


def _seg(start, in_frame, out_frame, **extra):
    return {"cutDir": "x", "start": start, "inFrame": in_frame, "outFrame": out_frame, **extra}


def test_speed_and_reverse_pick_the_same_source_frames_as_the_studio():
    fast = _seg(1, 1, 10, speed=2)
    assert bake.segment_length(fast) == 5
    assert [bake.source_frame_number(fast, f) for f in range(1, 6)] == [1, 3, 5, 7, 9]
    slow = _seg(11, 1, 4, speed=0.5)
    assert bake.segment_length(slow) == 8
    assert [bake.source_frame_number(slow, f) for f in (11, 12, 13, 14, 18)] == [1, 1, 2, 2, 4]
    rev = _seg(5, 11, 15, reverse=True)
    assert [bake.source_frame_number(rev, f) for f in range(5, 10)] == [15, 14, 13, 12, 11]
    both = _seg(1, 1, 10, reverse=True, speed=2)
    assert [bake.source_frame_number(both, f) for f in range(1, 6)] == [10, 8, 6, 4, 2]
    assert bake.segment_length(_seg(1, 1, 5, speed=2)) == 3
    assert bake.source_frame_number(_seg(1, 1, 10, speed=3), 99) == 10


def test_baked_frames_follow_a_reversed_fast_clip(tmp_path: Path):
    frames = []
    for i in range(1, 7):
        img = np.zeros((40, 40, 4), dtype=np.uint8)
        img[:, :, 3] = 255
        img[:, :, 2] = i * 30
        frames.append(img)
    cut = _write_shot(tmp_path, "body", frames)
    spec = {
        "fps": 24,
        "bodySegments": [{"cutDir": str(cut), "inFrame": 1, "outFrame": 6, "start": 1, "speed": 2, "reverse": True}],
        "headSegments": [],
    }
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))
    out = tmp_path / "out"
    result = bake.run(str(spec_path), str(out), 24)
    assert result["frameCount"] == 3
    reds = [int(cv2.imread(str(out / "cut" / f"f_{i:04d}.png"), cv2.IMREAD_UNCHANGED)[0, 0, 2]) for i in (1, 2, 3)]
    assert reds == [180, 120, 60]

def _body_spec(tmp_path, body_cut, head_cut, frames, anchor, body_scale):
    spec = json.loads(_spec(tmp_path, body_cut, head_cut, frames, anchor).read_text())
    spec["bodySegments"][0]["bodyScale"] = body_scale
    path = tmp_path / "spec_body.json"
    path.write_text(json.dumps(spec))
    return path


def _blue_box(path: Path) -> tuple[int, int, int, int]:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    mask = (img[:, :, 0] > 150) & (img[:, :, 2] < 50) & (img[:, :, 3] > 200)
    ys, xs = np.where(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def test_smaller_body_shrinks_about_its_feet_and_the_head_stays_attached_at_full_size(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()])
    head_cut = _write_shot(tmp_path, "head", [_head(0, 60, content_y=0, content_h=60)])
    out = tmp_path / "out"
    bake.run(str(_body_spec(tmp_path, body_cut, head_cut, 1, (0.5, 0.5), 0.5)), str(out))
    path = out / "cut" / "f_0001.png"
    canvas = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    assert canvas.shape[:2] == (200, 100)
    # Half-size body: 50x100, bottom-centred -> x 25..75, y 100..200.
    x0, y0, x1, y1 = _blue_box(path)
    assert (x0, y0, x1, y1) == (25, 100, 75, 200)
    # Head anchor (0.5, 0.5) of the *smaller* body is (50, 150); head keeps its 60x60 size.
    hx0, hy0, hx1, hy1 = _red_box(path)
    assert (hx1 - hx0, hy1 - hy0) == (60, 60)
    assert ((hx0 + hx1) // 2, (hy0 + hy1) // 2) == (50, 150)


def test_bigger_body_grows_the_canvas_instead_of_being_clipped(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()])
    head_cut = _write_shot(tmp_path, "head", [_head(20, 20, content_y=20, content_h=20)])
    out = tmp_path / "out"
    bake.run(str(_body_spec(tmp_path, body_cut, head_cut, 1, (0.5, 0.1), 1.5)), str(out))
    path = out / "cut" / "f_0001.png"
    canvas = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    x0, y0, x1, y1 = _blue_box(path)
    assert (x1 - x0, y1 - y0) == (150, 300)
    assert canvas.shape[1] >= 150 and canvas.shape[0] >= 300
    # Feet stay on the same ground line: the body's bottom is the canvas bottom.
    assert y1 == canvas.shape[0] - bake.head_overshoot_padding([], 100, 200, body_segments=[{"bodyScale": 1.5}])[3]


def test_body_pivot_keeps_that_point_of_the_body_fixed_so_the_head_does_not_move():
    pivot = (0.5, 0.1)
    for scale in (0.6, 1.0, 1.5):
        left, top, width, height = bake.body_rect(100, 200, scale, pivot)
        assert (left + pivot[0] * width, top + pivot[1] * height) == pytest.approx((50, 20))
    # No pivot saved: the middle of the feet stays put (the earlier behaviour).
    assert bake.body_pivot_of({"bodyScale": 1.5}) == (0.5, 1.0)
    assert bake.body_pivot_of({"bodyPivotX": 2, "bodyPivotY": -1}) == (1.0, 0.0)


def test_bigger_body_grown_from_the_neck_gets_padding_below_and_above(tmp_path):
    body_cut = _write_shot(tmp_path, "body", [_body()])
    head_cut = _write_shot(tmp_path, "head", [_head(20, 20, content_y=20, content_h=20)])
    spec = json.loads(_body_spec(tmp_path, body_cut, head_cut, 1, (0.5, 0.1), 1.5).read_text())
    spec["bodySegments"][0].update({"bodyPivotX": 0.5, "bodyPivotY": 0.1})
    spec_path = tmp_path / "spec_pivot.json"
    spec_path.write_text(json.dumps(spec))
    out = tmp_path / "out"
    bake.run(str(spec_path), str(out))
    path = out / "cut" / "f_0001.png"
    canvas = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    x0, y0, x1, y1 = _blue_box(path)
    assert (x1 - x0, y1 - y0) == (150, 300)
    assert canvas.shape[0] >= 300
    # The neck point (0.5, 0.1) of the body is where it was in the unscaled frame, shifted only by the padding.
    pad_l, pad_t, _, _ = bake.head_overshoot_padding([], 100, 200, body_segments=spec["bodySegments"])
    assert (x0 + 0.5 * (x1 - x0), y0 + 0.1 * (y1 - y0)) == pytest.approx((pad_l + 50, pad_t + 20), abs=1.5)
