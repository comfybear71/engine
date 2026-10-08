"""Minimal virtual camera: linear keyframe pan/zoom plus additive shake.

Deliberately simple (see schema/timeline.schema.json `camera`): a list of
(frame, x, y, zoom) keyframes, linearly interpolated, plus an optional
sine-based shake. It is applied as a post-process on the fully composited
canvas-sized frame: crop the visible window, then resize back up to the
canvas size. That means zooming in re-samples already-rendered pixels
(a documented limitation, not a bug -- see docs/timeline-schema.md).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass(frozen=True)
class CameraKeyframe:
    frame: int
    x: float | None = None
    y: float | None = None
    zoom: float = 1.0


@dataclass(frozen=True)
class Shake:
    amplitude_px: float = 0.0
    frequency_hz: float = 8.0
    start_frame: int = 0
    end_frame: int | None = None


@dataclass(frozen=True)
class Camera:
    keyframes: list[CameraKeyframe] = field(default_factory=list)
    shake: Shake | None = None


def _interpolate(keyframes: list[CameraKeyframe], frame: int, canvas_w: int, canvas_h: int):
    if not keyframes:
        return canvas_w / 2.0, canvas_h / 2.0, 1.0

    kfs = sorted(keyframes, key=lambda k: k.frame)
    resolved = [
        (k.frame, k.x if k.x is not None else canvas_w / 2.0, k.y if k.y is not None else canvas_h / 2.0, k.zoom)
        for k in kfs
    ]

    if frame <= resolved[0][0]:
        _, x, y, z = resolved[0]
        return x, y, z
    if frame >= resolved[-1][0]:
        _, x, y, z = resolved[-1]
        return x, y, z

    for (f0, x0, y0, z0), (f1, x1, y1, z1) in zip(resolved, resolved[1:]):
        if f0 <= frame <= f1:
            t = 0.0 if f1 == f0 else (frame - f0) / (f1 - f0)
            return (
                x0 + (x1 - x0) * t,
                y0 + (y1 - y0) * t,
                z0 + (z1 - z0) * t,
            )

    _, x, y, z = resolved[-1]
    return x, y, z


def _shake_offset(shake: Shake | None, frame: int, fps: int) -> tuple[float, float]:
    if shake is None or shake.amplitude_px <= 0:
        return 0.0, 0.0
    if frame < shake.start_frame:
        return 0.0, 0.0
    if shake.end_frame is not None and frame >= shake.end_frame:
        return 0.0, 0.0

    t = frame / float(fps)
    angle = 2.0 * math.pi * shake.frequency_hz * t
    dx = shake.amplitude_px * math.sin(angle)
    dy = shake.amplitude_px * math.cos(angle * 1.3)
    return dx, dy


def apply_camera(
    frame_bgr: np.ndarray,
    camera: Camera | None,
    frame_idx: int,
    fps: int,
) -> np.ndarray:
    """Apply pan/zoom/shake to a composited frame. No-op if camera is None/default."""

    if camera is None:
        return frame_bgr

    canvas_h, canvas_w = frame_bgr.shape[:2]
    cx, cy, zoom = _interpolate(camera.keyframes, frame_idx, canvas_w, canvas_h)
    shake_dx, shake_dy = _shake_offset(camera.shake, frame_idx, fps)
    cx += shake_dx
    cy += shake_dy

    if abs(zoom - 1.0) < 1e-9 and abs(shake_dx) < 1e-9 and abs(shake_dy) < 1e-9:
        return frame_bgr

    zoom = max(zoom, 1e-3)
    crop_w = canvas_w / zoom
    crop_h = canvas_h / zoom

    x0 = cx - crop_w / 2.0
    y0 = cy - crop_h / 2.0
    # Keep the crop window fully inside the canvas.
    x0 = min(max(x0, 0.0), canvas_w - crop_w) if crop_w <= canvas_w else -(canvas_w - crop_w) / 2.0
    y0 = min(max(y0, 0.0), canvas_h - crop_h) if crop_h <= canvas_h else -(canvas_h - crop_h) / 2.0

    x0i, y0i = int(round(x0)), int(round(y0))
    x1i = int(round(x0i + crop_w))
    y1i = int(round(y0i + crop_h))

    # Pad if the shake pushed the window outside canvas bounds.
    pad_left = max(0, -x0i)
    pad_top = max(0, -y0i)
    pad_right = max(0, x1i - canvas_w)
    pad_bottom = max(0, y1i - canvas_h)

    if pad_left or pad_top or pad_right or pad_bottom:
        frame_bgr = cv2.copyMakeBorder(
            frame_bgr, pad_top, pad_bottom, pad_left, pad_right, cv2.BORDER_REPLICATE
        )
        x0i += pad_left
        y0i += pad_top
        x1i += pad_left
        y1i += pad_top

    crop = frame_bgr[y0i:y1i, x0i:x1i]
    if crop.shape[0] < 1 or crop.shape[1] < 1:
        return frame_bgr
    return cv2.resize(crop, (canvas_w, canvas_h), interpolation=cv2.INTER_LINEAR)
