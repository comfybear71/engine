"""Loads and caches PNG assets plus their scaled/flipped variants.

Every asset is read from disk at most once per render, and every distinct
(scale, flip) combination is computed at most once, regardless of how many
frames reference it. This matters a lot: Gemini's draft re-read every PNG
from disk on every frame, which is both slow and needless.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .transform import anchor_offset


def _to_bgra(img: np.ndarray) -> np.ndarray:
    """Normalize any image OpenCV can load into 4-channel BGRA, uint8."""

    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    elif img.shape[2] == 4:
        pass
    else:
        raise ValueError(f"Unsupported channel count: {img.shape[2]}")
    if img.dtype != np.uint8:
        img = img.astype(np.uint8)
    return img


class AssetCache:
    """Caches raw decoded images and per-(scale, flip) resized variants."""

    def __init__(self) -> None:
        self._raw: dict[str, np.ndarray] = {}
        self._variants: dict[tuple[str, float, bool], np.ndarray] = {}

    def get_raw(self, path: Path) -> np.ndarray:
        key = str(path)
        cached = self._raw.get(key)
        if cached is not None:
            return cached
        img = cv2.imread(key, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError(f"Could not read image asset: {path}")
        img = _to_bgra(img)
        self._raw[key] = img
        return img

    def get_variant(
        self,
        path: Path,
        scale: float = 1.0,
        flip_x: bool = False,
        rotation: float = 0.0,
    ) -> np.ndarray:
        """Return a cached BGRA image, flipped, scaled and rotated as requested.

        Scaling is done on premultiplied color channels to avoid dark/light
        fringing from interpolating the color of fully-transparent pixels,
        then un-premultiplied back to straight alpha. Rotation (degrees,
        clockwise) expands the canvas so no pixels are clipped at this
        stage; off-canvas clipping happens later, against the output frame.
        """

        key = (str(path), round(float(scale), 6), bool(flip_x), round(float(rotation), 3))
        cached = self._variants.get(key)
        if cached is not None:
            return cached

        img = self.get_raw(path)
        if flip_x:
            img = cv2.flip(img, 1)

        if abs(scale - 1.0) > 1e-9:
            h, w = img.shape[:2]
            new_w = max(1, round(w * scale))
            new_h = max(1, round(h * scale))
            interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR

            rgb = img[:, :, :3].astype(np.float32)
            alpha = img[:, :, 3].astype(np.float32) / 255.0
            premultiplied = rgb * alpha[:, :, None]

            premultiplied_r = cv2.resize(premultiplied, (new_w, new_h), interpolation=interp)
            alpha_r = cv2.resize(alpha, (new_w, new_h), interpolation=interp)

            safe_alpha = np.clip(alpha_r, 1e-6, 1.0)
            rgb_r = premultiplied_r / safe_alpha[:, :, None]
            rgb_r = np.clip(rgb_r, 0, 255)

            out = np.empty((new_h, new_w, 4), dtype=np.uint8)
            out[:, :, :3] = rgb_r.astype(np.uint8)
            out[:, :, 3] = np.clip(alpha_r * 255.0, 0, 255).astype(np.uint8)
            img = out
        else:
            img = img.copy()

        if abs(rotation) > 1e-9:
            img = _rotate_bgra(img, rotation)

        self._variants[key] = img
        return img

    def pre_rotation_size(self, path: Path, scale: float) -> tuple[int, int]:
        """Width/height of the flipped+scaled image *before* rotation expand.

        Must match the rounding inside :meth:`get_variant` so pivot math and
        the cached pixels describe the same rectangle.
        """

        img = self.get_raw(path)
        h, w = img.shape[:2]
        if abs(scale - 1.0) > 1e-9:
            return max(1, round(w * scale)), max(1, round(h * scale))
        return w, h


def rotation_expand_matrix(
    width: float, height: float, degrees_clockwise: float
) -> tuple[np.ndarray, int, int]:
    """The affine matrix ``_rotate_bgra`` uses, plus the expanded canvas size.

    Rotation is about the image centre; the canvas grows so no source pixel
    is clipped. The named pivot/anchor is *not* the rotation centre -- call
    :func:`anchor_after_rotation` to find where that point lands.
    """

    center = (width / 2.0, height / 2.0)
    matrix = cv2.getRotationMatrix2D(center, -degrees_clockwise, 1.0)

    cos = abs(matrix[0, 0])
    sin = abs(matrix[0, 1])
    new_w = int(np.ceil(height * sin + width * cos))
    new_h = int(np.ceil(height * cos + width * sin))
    matrix[0, 2] += (new_w / 2.0) - center[0]
    matrix[1, 2] += (new_h / 2.0) - center[1]
    return matrix, new_w, new_h


def map_affine_point(x: float, y: float, matrix: np.ndarray) -> tuple[float, float]:
    return (
        float(matrix[0, 0] * x + matrix[0, 1] * y + matrix[0, 2]),
        float(matrix[1, 0] * x + matrix[1, 1] * y + matrix[1, 2]),
    )


def anchor_after_rotation(
    width: float, height: float, anchor: str, degrees_clockwise: float
) -> tuple[float, float]:
    """Where ``anchor`` on the unrotated ``width``×``height`` image lands
    after the centre-rotate + canvas-expand that ``_rotate_bgra`` does."""

    ax, ay = anchor_offset(anchor, width, height)
    if abs(degrees_clockwise) < 1e-9:
        return ax, ay
    matrix, _new_w, _new_h = rotation_expand_matrix(width, height, degrees_clockwise)
    return map_affine_point(ax, ay, matrix)


def _rotate_bgra(img: np.ndarray, degrees: float) -> np.ndarray:
    """Rotate a BGRA image clockwise by ``degrees``, expanding the canvas."""

    h, w = img.shape[:2]
    matrix, new_w, new_h = rotation_expand_matrix(w, h, degrees)
    return cv2.warpAffine(
        img, matrix, (new_w, new_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )
