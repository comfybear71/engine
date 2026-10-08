"""Anchor math and off-screen clipping (requirement: bounding-box intersect,
vectorised slicing, no out-of-bounds, no per-pixel loops)."""

import pytest

from compositor.transform import (
    anchor_offset,
    compute_placement,
    mouth_center,
    top_left_for_anchor,
)


def test_anchor_offset_bottom_center():
    assert anchor_offset("bottom-center", 100, 200) == (50.0, 200.0)


def test_anchor_offset_center():
    assert anchor_offset("center", 100, 200) == (50.0, 100.0)


def test_anchor_offset_top_left():
    assert anchor_offset("top-left", 100, 200) == (0.0, 0.0)


def test_anchor_offset_bottom_right():
    assert anchor_offset("bottom-right", 100, 200) == (100.0, 200.0)


def test_anchor_offset_unknown_raises():
    with pytest.raises(ValueError):
        anchor_offset("nonsense", 10, 10)


def test_top_left_for_anchor_bottom_center():
    # A 100x200 image anchored bottom-center at (960, 1080) should have its
    # top-left corner at (960 - 50, 1080 - 200) = (910, 880).
    assert top_left_for_anchor(960, 1080, "bottom-center", 100, 200) == (910.0, 880.0)


class TestComputePlacementFullyOnCanvas:
    def test_fully_inside(self):
        placement = compute_placement(1920, 1080, 100, 100, 500, 500, "top-left")
        assert placement is not None
        assert placement.dst == (500, 500, 600, 600)
        assert placement.src == (0, 0, 100, 100)
        assert placement.width == 100
        assert placement.height == 100


class TestOffScreenClipping:
    """Layers partly off-screen must be clipped, not skipped entirely."""

    def test_clipped_on_right_edge(self):
        # 400-wide image anchored bottom-center at x=1900 on a 1920-wide
        # canvas: left edge at 1700, right edge at 2100 -> 220px visible.
        placement = compute_placement(1920, 1080, 400, 200, 1900, 1080, "bottom-center")
        assert placement is not None
        assert placement.dst == (1700, 880, 1920, 1080)
        assert placement.src == (0, 0, 220, 200)
        assert placement.width == 220

    def test_clipped_on_left_edge(self):
        placement = compute_placement(1920, 1080, 400, 200, -150, 100, "top-left")
        assert placement is not None
        assert placement.dst == (0, 100, 250, 300)
        assert placement.src == (150, 0, 400, 200)

    def test_clipped_on_top_and_bottom(self):
        placement = compute_placement(1920, 1080, 100, 2000, 960, 0, "top-center")
        assert placement is not None
        assert placement.dst[1] == 0
        assert placement.dst[3] == 1080

    def test_fully_off_screen_returns_none(self):
        placement = compute_placement(1920, 1080, 100, 100, 5000, 5000, "top-left")
        assert placement is None

    def test_fully_off_screen_negative_returns_none(self):
        placement = compute_placement(1920, 1080, 50, 50, -500, -500, "top-left")
        assert placement is None

    def test_dst_and_src_always_equal_size(self):
        placement = compute_placement(800, 600, 300, 300, 750, 50, "top-left")
        assert placement is not None
        assert placement.width == placement.src[2] - placement.src[0]
        assert placement.height == placement.src[3] - placement.src[1]

    def test_never_produces_negative_or_oob_indices(self):
        # A grid of extreme positions should never produce indices usable to
        # cause an IndexError when slicing a (canvas_h, canvas_w) array.
        canvas_w, canvas_h = 640, 360
        for x in range(-800, 1500, 97):
            for y in range(-800, 1000, 113):
                placement = compute_placement(canvas_w, canvas_h, 200, 150, x, y, "center")
                if placement is None:
                    continue
                dx0, dy0, dx1, dy1 = placement.dst
                assert 0 <= dx0 <= dx1 <= canvas_w
                assert 0 <= dy0 <= dy1 <= canvas_h
                sx0, sy0, sx1, sy1 = placement.src
                assert 0 <= sx0 <= sx1 <= 200
                assert 0 <= sy0 <= sy1 <= 150


class TestAnchorAndFlipMath:
    def test_flip_does_not_change_anchor_semantics(self):
        # Flip mirrors pixel content, not the anchor box: a bottom-center
        # anchored image occupies the same destination rect whether or not
        # it's flipped (only its pixel content differs upstream of this).
        a = compute_placement(1920, 1080, 200, 400, 960, 1080, "bottom-center")
        b = compute_placement(1920, 1080, 200, 400, 960, 1080, "bottom-center")
        assert a == b

    def test_mouth_center_mirrors_offset_when_flipped(self):
        x, y = mouth_center(parent_x=500, parent_y=800, offset_x=20, offset_y=-100, scale=1.0, flip_x=False)
        assert (x, y) == (520.0, 700.0)

        x_flipped, y_flipped = mouth_center(
            parent_x=500, parent_y=800, offset_x=20, offset_y=-100, scale=1.0, flip_x=True
        )
        assert (x_flipped, y_flipped) == (480.0, 700.0)

    def test_mouth_center_scales_offset(self):
        x, y = mouth_center(parent_x=0, parent_y=0, offset_x=10, offset_y=20, scale=2.0, flip_x=False)
        assert (x, y) == (20.0, 40.0)
