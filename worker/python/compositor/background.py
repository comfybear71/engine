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
