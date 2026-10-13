"""Crop a short action timeline to the character and encode a 256px loop.

Used by Studio Action Shot tiles. Frames come from the same ``compose_frame``
path as CLI render; the subject is zoomed by cropping away the empty canvas
so the character is not a speck in a black square.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

from .compositor import compose_frame
from .ffmpeg_writer import write_preview_segment
from .timeline_loader import Timeline, load_timeline

DEFAULT_SIZE = 256
PROXY_WIDTH = 854
PROXY_HEIGHT = 480
CONTENT_THRESHOLD = 14
PAD_RATIO = 0.14


def content_bbox(frame: np.ndarray, threshold: int = CONTENT_THRESHOLD) -> tuple[int, int, int, int] | None:
    """Inclusive (x0, y0, x1, y1) of pixels brighter than ``threshold``."""

    if frame.ndim == 3:
        luma = frame.max(axis=2)
    else:
        luma = frame
    ys, xs = np.where(luma > threshold)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def union_bbox(
    a: tuple[int, int, int, int] | None, b: tuple[int, int, int, int] | None
) -> tuple[int, int, int, int] | None:
    if a is None:
        return b
    if b is None:
        return a
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def square_crop_box(
    box: tuple[int, int, int, int],
    frame_w: int,
    frame_h: int,
    pad_ratio: float = PAD_RATIO,
) -> tuple[int, int, int, int]:
    """Expand ``box`` to a padded square that stays on the frame."""

    x0, y0, x1, y1 = box
    w = max(1, x1 - x0 + 1)
    h = max(1, y1 - y0 + 1)
    pad = max(4, int(round(max(w, h) * pad_ratio)))
    side = max(w, h) + pad * 2
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    side = min(side, frame_w, frame_h)
    x = int(round(cx - side / 2.0))
    y = int(round(cy - side / 2.0))
    x = max(0, min(x, frame_w - side))
    y = max(0, min(y, frame_h - side))
    return x, y, side, side


def crop_square(frame: np.ndarray, box: tuple[int, int, int, int], size: int) -> np.ndarray:
    x, y, w, h = box
    tile = frame[y : y + h, x : x + w]
    out = max(2, int(size) - int(size) % 2)
    interp = cv2.INTER_AREA if out < min(w, h) else cv2.INTER_LINEAR
    return cv2.resize(tile, (out, out), interpolation=interp)


def render_action_preview(
    timeline: Timeline,
    output_path: Path,
    size: int = DEFAULT_SIZE,
) -> Path:
    """Compose every frame, crop to the character, write a silent looping MP4."""

    size = max(2, int(size) - int(size) % 2)
    cache_frames: list[np.ndarray] = []
    bbox = None
    total = max(1, int(timeline.total_frames))
    for index in range(total):
        frame = compose_frame(timeline, index, width=PROXY_WIDTH, height=PROXY_HEIGHT)
        cache_frames.append(frame)
        bbox = union_bbox(bbox, content_bbox(frame))
    if bbox is None:
        bbox = (0, 0, PROXY_WIDTH - 1, PROXY_HEIGHT - 1)
    crop = square_crop_box(bbox, PROXY_WIDTH, PROXY_HEIGHT)
    tiles = (crop_square(frame, crop, size) for frame in cache_frames)
    write_preview_segment(tiles, Path(output_path), size, size, timeline.fps)
    return Path(output_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a cropped action-preview MP4.")
    parser.add_argument("--timeline", type=Path, required=True)
    parser.add_argument("--project-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE)
    args = parser.parse_args(argv)
    timeline = load_timeline(args.timeline.resolve(), project_dir=args.project_dir.resolve())
    render_action_preview(timeline, args.output.resolve(), size=args.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
