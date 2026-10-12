"""Fits a background image (of any resolution) onto the fixed output canvas.

Layer positions are always in canvas space, independent of the
background's native pixel size, so the background itself must be resized
("fitted") to the canvas before anything else is drawn.
"""

from __future__ import annotations

import cv2
import numpy as np


def _to_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        # Flatten alpha onto black; backgrounds are expected to be opaque.
        rgb = img[:, :, :3].astype(np.float32)
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        return (rgb * alpha).astype(np.uint8)
    return img


def fit_to_canvas(img: np.ndarray, canvas_w: int, canvas_h: int, mode: str = "cover") -> np.ndarray:
    img = _to_bgr(img)
    h, w = img.shape[:2]

    if mode == "cover":
        scale = max(canvas_w / w, canvas_h / h)
    elif mode == "contain":
        scale = min(canvas_w / w, canvas_h / h)
    else:
        raise ValueError(f"Unknown background fit mode: {mode!r}")

    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    resized = cv2.resize(img, (new_w, new_h), interpolation=interp)

    if mode == "cover":
        x0 = max(0, (new_w - canvas_w) // 2)
        y0 = max(0, (new_h - canvas_h) // 2)
        return resized[y0:y0 + canvas_h, x0:x0 + canvas_w]

    # contain: letterbox onto a black canvas.
    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    x0 = (canvas_w - new_w) // 2
    y0 = (canvas_h - new_h) // 2
    canvas[y0:y0 + new_h, x0:x0 + new_w] = resized
    return canvas


def fit_to_canvas_camera(
    img: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    mode: str,
    cx: float,
    cy: float,
    zoom: float,
) -> np.ndarray:
    """Fit a background from its source with the camera transform folded in.

    Same cover/contain placement as :func:`fit_to_canvas`, then
    ``T = translate(W/2, H/2) * scale(zoom) * translate(-cx, -cy)``. One
    resample from the source image, not from an already-fitted canvas.
    """

    img = _to_bgr(img)
    h, w = img.shape[:2]
    if mode == "cover":
        fit_scale = max(canvas_w / w, canvas_h / h)
    elif mode == "contain":
        fit_scale = min(canvas_w / w, canvas_h / h)
    else:
        raise ValueError(f"Unknown background fit mode: {mode!r}")

    fitted_w = max(1, round(w * fit_scale))
    fitted_h = max(1, round(h * fit_scale))
    sx_scale = fitted_w / float(w)
    sy_scale = fitted_h / float(h)

    if mode == "cover":
        origin_x = -max(0, (fitted_w - canvas_w) // 2)
        origin_y = -max(0, (fitted_h - canvas_h) // 2)
        border = cv2.BORDER_REPLICATE
        border_value = (0, 0, 0)
    else:
        origin_x = (canvas_w - fitted_w) // 2
        origin_y = (canvas_h - fitted_h) // 2
        border = cv2.BORDER_CONSTANT
        border_value = (0, 0, 0)

    zoom = max(float(zoom), 1e-3)
    combined = zoom * sx_scale
    interp = cv2.INTER_AREA if combined < 1.0 else cv2.INTER_LINEAR
    matrix = np.array(
        [
            [zoom * sx_scale, 0.0, canvas_w / 2.0 + (origin_x - cx) * zoom],
            [0.0, zoom * sy_scale, canvas_h / 2.0 + (origin_y - cy) * zoom],
        ],
        dtype=np.float64,
    )
    return cv2.warpAffine(
        img,
        matrix,
        (canvas_w, canvas_h),
        flags=interp,
        borderMode=border,
        borderValue=border_value,
    )
