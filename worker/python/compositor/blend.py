"""Vectorised alpha blending of a (clipped) BGRA image onto a BGR canvas."""

from __future__ import annotations

import numpy as np

from .transform import PlacementRect, compute_placement


def draw_image(
    canvas: np.ndarray,
    img_bgra: np.ndarray,
    x: float,
    y: float,
    anchor: str,
    opacity: float = 1.0,
) -> PlacementRect | None:
    """Alpha-blend ``img_bgra`` onto ``canvas`` (in place), clipped to bounds.

    ``canvas`` is a BGR uint8 array (no alpha channel: it is always fully
    opaque, which is true for every frame we composite since the background
    always covers it). Returns the ``PlacementRect`` used, or ``None`` if
    the image was entirely off-canvas and nothing was drawn.

    Straight (non-premultiplied) alpha is assumed for ``img_bgra``, which is
    what PNG stores. Compositing onto an opaque destination with the
    standard Porter-Duff "over" operator reduces to a single vectorised
    lerp, so no premultiply/unpremultiply round-trip is needed here (that
    round-trip *is* done in AssetCache when resizing, where it matters for
    avoiding edge fringing).
    """

    if opacity <= 0.0:
        return None

    canvas_h, canvas_w = canvas.shape[:2]
    img_h, img_w = img_bgra.shape[:2]

    placement = compute_placement(canvas_w, canvas_h, img_w, img_h, x, y, anchor)
    if placement is None:
        return None

    dx0, dy0, dx1, dy1 = placement.dst
    sx0, sy0, sx1, sy1 = placement.src

    dest_region = canvas[dy0:dy1, dx0:dx1].astype(np.float32)
    src_region = img_bgra[sy0:sy1, sx0:sx1]

    fg_rgb = src_region[:, :, :3].astype(np.float32)
    alpha = (src_region[:, :, 3:4].astype(np.float32) / 255.0) * float(opacity)

    blended = fg_rgb * alpha + dest_region * (1.0 - alpha)
    canvas[dy0:dy1, dx0:dx1] = np.clip(blended, 0, 255).astype(np.uint8)

    return placement
