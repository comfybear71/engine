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
CONTENT_THRESHOLD = 8
PAD_RATIO = 0.32
WIDE_PAD_RATIO = 0.40
WIDE_WIDTH = 854
WIDE_HEIGHT = 480


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


def contain_crop_box(
    box: tuple[int, int, int, int],
    frame_w: int,
    frame_h: int,
    aspect: tuple[int, int] = (16, 9),
    pad_ratio: float = WIDE_PAD_RATIO,
) -> tuple[int, int, int, int]:
    """Expand ``box`` to a padded rectangle of ``aspect`` that keeps the whole figure."""

    x0, y0, x1, y1 = box
    w = max(1, x1 - x0 + 1)
    h = max(1, y1 - y0 + 1)
    pad = max(4, int(round(max(w, h) * pad_ratio)))
    cw, ch = w + 2 * pad, h + 2 * pad
    aw, ah = (max(1, int(aspect[0])), max(1, int(aspect[1])))
    target = aw / ah
    if cw / max(ch, 1) < target:
        cw = int(round(ch * target))
    else:
        ch = int(round(cw / target))
    if cw > frame_w or ch > frame_h:
        scale = min(frame_w / max(cw, 1), frame_h / max(ch, 1))
        cw = max(2, int(round(cw * scale)))
        ch = max(2, int(round(ch * scale)))
    cw = max(2, cw - cw % 2)
    ch = max(2, ch - ch % 2)
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    x = int(round(cx - cw / 2.0))
    y = int(round(cy - ch / 2.0))
    x = max(0, min(x, frame_w - cw))
    y = max(0, min(y, frame_h - ch))
    return x, y, cw, ch


def crop_rect(frame: np.ndarray, box: tuple[int, int, int, int], out_w: int, out_h: int) -> np.ndarray:
    x, y, w, h = box
    tile = frame[y : y + h, x : x + w]
    out_w = max(2, int(out_w) - int(out_w) % 2)
    out_h = max(2, int(out_h) - int(out_h) % 2)
    interp = cv2.INTER_AREA if out_w < w or out_h < h else cv2.INTER_LINEAR
    return cv2.resize(tile, (out_w, out_h), interpolation=interp)


def parse_aspect(value: str | None) -> tuple[int, int] | None:
    text = str(value or "").strip().lower()
    if not text or text in {"square", "1:1"}:
        return None
    if "x" in text:
        parts = text.split("x")
    else:
        parts = text.split(":")
    if len(parts) != 2:
        return None
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if w < 1 or h < 1:
        return None
    return w, h


def render_action_preview(
    timeline: Timeline,
    output_path: Path,
    size: int = DEFAULT_SIZE,
    *,
    aspect: str | None = None,
    width: int | None = None,
    height: int | None = None,
) -> Path:
    """Compose every frame, crop to the character, write a silent looping MP4."""

    size = max(2, int(size) - int(size) % 2)
    ratio = parse_aspect(aspect)
    cache_frames: list[np.ndarray] = []
    bbox = None
    total = max(1, int(timeline.total_frames))
    for index in range(total):
        frame = compose_frame(timeline, index, width=PROXY_WIDTH, height=PROXY_HEIGHT)
        cache_frames.append(frame)
        bbox = union_bbox(bbox, content_bbox(frame))
    if bbox is None:
        bbox = (0, 0, PROXY_WIDTH - 1, PROXY_HEIGHT - 1)
    dest = Path(output_path)
    if ratio is not None:
        crop = contain_crop_box(bbox, PROXY_WIDTH, PROXY_HEIGHT, aspect=ratio)
        out_w = max(2, int(width or WIDE_WIDTH) - int(width or WIDE_WIDTH) % 2)
        out_h = max(2, int(height or WIDE_HEIGHT) - int(height or WIDE_HEIGHT) % 2)
        tiles = [crop_rect(frame, crop, out_w, out_h) for frame in cache_frames]
        write_preview_segment(iter(tiles), dest, out_w, out_h, timeline.fps)
    else:
        crop = square_crop_box(bbox, PROXY_WIDTH, PROXY_HEIGHT)
        tiles = [crop_square(frame, crop, size) for frame in cache_frames]
        write_preview_segment(iter(tiles), dest, size, size, timeline.fps)
    if tiles:
        poster = dest.with_suffix(".jpg")
        cv2.imwrite(str(poster), tiles[0], [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a cropped action-preview MP4.")
    parser.add_argument("--timeline", type=Path, required=True)
    parser.add_argument("--project-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE)
    parser.add_argument("--aspect", default="1:1", help="1:1 (Action Shot tiles) or 16:9 (Factory walk)")
    parser.add_argument("--width", type=int, default=0)
    parser.add_argument("--height", type=int, default=0)
    args = parser.parse_args(argv)
    timeline = load_timeline(args.timeline.resolve(), project_dir=args.project_dir.resolve())
    render_action_preview(
        timeline,
        args.output.resolve(),
        size=args.size,
        aspect=args.aspect,
        width=args.width or None,
        height=args.height or None,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
