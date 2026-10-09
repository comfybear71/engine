"""Pure geometry helpers: anchor math, placement/clipping rects.

Kept free of any OpenCV/numpy image data so it is trivially unit-testable.
All coordinates are in canvas pixel space unless noted otherwise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

ANCHORS = (
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right",
)


def anchor_offset(anchor: str, width: float, height: float) -> tuple[float, float]:
    """Offset from an image's top-left corner to its anchor point.

    e.g. "bottom-center" -> (width / 2, height), meaning the anchor point
    sits horizontally centered, at the bottom edge of the image.
    """

    if anchor not in ANCHORS:
        raise ValueError(f"Unknown anchor {anchor!r}; expected one of {ANCHORS}")

    vertical, _, horizontal = anchor.partition("-")
    # anchors without a hyphen ("center") mean centered on both axes.
    if horizontal == "":
        horizontal = "center"

    ax = {"left": 0.0, "center": width / 2.0, "right": width}[horizontal]
    ay = {"top": 0.0, "center": height / 2.0, "bottom": height}[vertical]
    return ax, ay


def top_left_for_anchor(
    x: float, y: float, anchor: str, width: float, height: float
) -> tuple[float, float]:
    """Top-left corner (canvas space) of an image placed so its anchor sits at (x, y)."""

    ax, ay = anchor_offset(anchor, width, height)
    return x - ax, y - ay


@dataclass(frozen=True)
class PlacementRect:
    """Integer pixel rects for compositing a (possibly partly off-canvas) image.

    ``dst`` is the visible region in canvas coordinates; ``src`` is the
    matching region inside the source image. Both are (x0, y0, x1, y1),
    half-open intervals, and always have equal width/height.
    """

    dst: tuple[int, int, int, int]
    src: tuple[int, int, int, int]

    @property
    def width(self) -> int:
        return self.dst[2] - self.dst[0]

    @property
    def height(self) -> int:
        return self.dst[3] - self.dst[1]


def compute_placement(
    canvas_w: int,
    canvas_h: int,
    img_w: int,
    img_h: int,
    x: float,
    y: float,
    anchor: str,
) -> PlacementRect | None:
    """Compute clipped src/dst rects for drawing an image onto the canvas.

    Returns ``None`` if the image is fully outside the canvas (nothing to
    draw). Images that are only partly outside the canvas are clipped
    rather than skipped, so walk-ons and partly off-frame characters still
    render their visible portion.
    """

    top_left_x, top_left_y = top_left_for_anchor(x, y, anchor, img_w, img_h)

    dst_x0f = max(0.0, top_left_x)
    dst_y0f = max(0.0, top_left_y)
    dst_x1f = min(float(canvas_w), top_left_x + img_w)
    dst_y1f = min(float(canvas_h), top_left_y + img_h)

    if dst_x1f <= dst_x0f or dst_y1f <= dst_y0f:
        return None

    dst_x0, dst_y0 = int(round(dst_x0f)), int(round(dst_y0f))
    dst_x1, dst_y1 = int(round(dst_x1f)), int(round(dst_y1f))
    if dst_x1 <= dst_x0 or dst_y1 <= dst_y0:
        return None

    src_x0 = dst_x0 - round(top_left_x)
    src_y0 = dst_y0 - round(top_left_y)
    src_x1 = src_x0 + (dst_x1 - dst_x0)
    src_y1 = src_y0 + (dst_y1 - dst_y0)

    # Clamp defensively against rounding pushing a source index out of bounds.
    src_x0 = max(0, min(src_x0, img_w))
    src_y0 = max(0, min(src_y0, img_h))
    src_x1 = max(src_x0, min(src_x1, img_w))
    src_y1 = max(src_y0, min(src_y1, img_h))

    width = min(dst_x1 - dst_x0, src_x1 - src_x0)
    height = min(dst_y1 - dst_y0, src_y1 - src_y0)
    if width <= 0 or height <= 0:
        return None

    return PlacementRect(
        dst=(dst_x0, dst_y0, dst_x0 + width, dst_y0 + height),
        src=(src_x0, src_y0, src_x0 + width, src_y0 + height),
    )


def mouth_center(
    parent_x: float,
    parent_y: float,
    offset_x: float,
    offset_y: float,
    scale: float,
    flip_x: bool,
) -> tuple[float, float]:
    """Canvas-space center point for a mouth sub-layer.

    ``offset`` is expressed in the parent layer's local (pre-scale) pixel
    space, relative to the parent's anchor point. It is scaled with the
    parent and mirrored in X when the parent is flipped, so the mouth
    tracks the face correctly.
    """

    mirrored_offset_x = -offset_x if flip_x else offset_x
    return (
        parent_x + mirrored_offset_x * scale,
        parent_y + offset_y * scale,
    )


def rotate_offset_clockwise(x: float, y: float, degrees: float) -> tuple[float, float]:
    """Rotate a 2D offset clockwise by ``degrees`` in Y-down canvas space.

    ``(0, 100)`` (straight down) rotated 90° clockwise becomes ``(-100, 0)``
    (straight left). Used to swing a child/slot offset around its owner's
    pivot when that owner is rotated.
    """

    if abs(degrees) < 1e-9:
        return x, y
    theta = math.radians(degrees)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    return x * cos_t - y * sin_t, x * sin_t + y * cos_t
