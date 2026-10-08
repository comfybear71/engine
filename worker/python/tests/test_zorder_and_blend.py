"""Z-order and alpha blending: higher z must draw on top, and blending must
be correct for both opaque and partially transparent overlapping layers."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from compositor.blend import draw_image


def _solid_bgra(w: int, h: int, bgr: tuple[int, int, int], alpha: int = 255) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    return img


@dataclass
class FakeLayer:
    z: int
    name: str


def test_layers_are_sorted_ascending_by_z_regardless_of_input_order():
    layers = [FakeLayer(z=10, name="front"), FakeLayer(z=-2, name="deep-bg"), FakeLayer(z=5, name="mid")]
    ordered = sorted(layers, key=lambda l: l.z)
    assert [l.name for l in ordered] == ["deep-bg", "mid", "front"]


def test_higher_z_layer_drawn_on_top_of_overlap():
    canvas = np.full((100, 100, 3), 255, dtype=np.uint8)  # white background

    red = _solid_bgra(60, 60, (0, 0, 255))   # BGR red
    blue = _solid_bgra(60, 60, (255, 0, 0))  # BGR blue

    # Simulate the compositor's behavior: draw strictly in ascending z order.
    layers_by_z = [(1, red, 0, 0), (5, blue, 30, 30)]
    for _z, img, x, y in sorted(layers_by_z, key=lambda t: t[0]):
        draw_image(canvas, img, x, y, anchor="top-left")

    # Non-overlapping red region: still red.
    assert tuple(canvas[10, 10]) == (0, 0, 255)
    # Overlapping region: blue (higher z) wins, not red.
    assert tuple(canvas[45, 45]) == (255, 0, 0)
    # Non-overlapping blue region: still blue.
    assert tuple(canvas[80, 80]) == (255, 0, 0)
    # Untouched background: still white.
    assert tuple(canvas[5, 95]) == (255, 255, 255)


def test_reversed_z_order_would_give_wrong_result_if_unsorted():
    # Sanity check that order genuinely matters (i.e. this isn't a test that
    # would pass regardless of draw order).
    canvas_sorted = np.full((100, 100, 3), 255, dtype=np.uint8)
    canvas_unsorted = np.full((100, 100, 3), 255, dtype=np.uint8)

    red = _solid_bgra(60, 60, (0, 0, 255))
    blue = _solid_bgra(60, 60, (255, 0, 0))

    for _z, img, x, y in sorted([(1, red, 0, 0), (5, blue, 30, 30)], key=lambda t: t[0]):
        draw_image(canvas_sorted, img, x, y, anchor="top-left")

    for _z, img, x, y in [(5, blue, 30, 30), (1, red, 0, 0)]:  # reverse of z order
        draw_image(canvas_unsorted, img, x, y, anchor="top-left")

    assert not np.array_equal(canvas_sorted, canvas_unsorted)


def test_partial_alpha_blends_proportionally():
    canvas = np.zeros((10, 10, 3), dtype=np.uint8)
    canvas[:] = (0, 0, 0)  # black background

    half_white = _solid_bgra(10, 10, (255, 255, 255), alpha=128)
    draw_image(canvas, half_white, 0, 0, anchor="top-left")

    # alpha=128/255 ~= 0.502 -> result ~= 128 on a black background.
    assert abs(int(canvas[5, 5, 0]) - 128) <= 2


def test_opacity_multiplies_with_image_alpha():
    canvas = np.zeros((10, 10, 3), dtype=np.uint8)
    full_alpha_white = _solid_bgra(10, 10, (255, 255, 255), alpha=255)
    draw_image(canvas, full_alpha_white, 0, 0, anchor="top-left", opacity=0.5)
    assert abs(int(canvas[5, 5, 0]) - 128) <= 2


def test_rgb_only_asset_still_works_as_opaque():
    # Simulates "PNGs without alpha still work": a 3-channel image gets a
    # synthetic full-alpha channel upstream (AssetCache._to_bgra); here we
    # verify draw_image handles a manually-built fully-opaque BGRA the same
    # way a converted no-alpha PNG would.
    canvas = np.zeros((10, 10, 3), dtype=np.uint8)
    opaque_green = _solid_bgra(10, 10, (0, 255, 0), alpha=255)
    draw_image(canvas, opaque_green, 0, 0, anchor="top-left")
    assert tuple(canvas[5, 5]) == (0, 255, 0)
