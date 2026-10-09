"""Green-screen cut-out for Studio asset ingest.

Keys #00FF00, despills green edges, trims transparent borders, and splits
a sheet into cells (regular grid, or connected components). Invoked by the
Node worker as ``python -m compositor.cutout``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# OpenCV BGR for HTML #00FF00.
KEY_BGR = np.array([0.0, 255.0, 0.0], dtype=np.float32)


def bgr_to_bgra(bgr: np.ndarray) -> np.ndarray:
    if bgr.ndim == 3 and bgr.shape[2] == 4:
        return bgr.copy()
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)


def key_green(
    bgr: np.ndarray,
    *,
    threshold: float = 40.0,
    slope: float = 30.0,
) -> np.ndarray:
    """Return BGRA with alpha 0 on #00FF00 and 255 on foreground.

    ``threshold`` is the chroma distance (in BGR) treated as pure screen;
    ``slope`` is the feather width.
    """
    rgb = bgr[:, :, :3].astype(np.float32)
    dist = np.linalg.norm(rgb - KEY_BGR, axis=2)
    alpha = np.clip((dist - threshold) / max(slope, 1e-6) * 255.0, 0, 255).astype(np.uint8)
    out = bgr_to_bgra(bgr[:, :, :3])
    if bgr.ndim == 3 and bgr.shape[2] == 4:
        out[:, :, 3] = np.minimum(bgr[:, :, 3], alpha)
    else:
        out[:, :, 3] = alpha
    return out


def despill(bgra: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Pull leftover green toward red/blue on pixels that still look like spill."""
    out = bgra.copy()
    blue = out[:, :, 0].astype(np.float32)
    green = out[:, :, 1].astype(np.float32)
    red = out[:, :, 2].astype(np.float32)
    alpha = out[:, :, 3].astype(np.float32) / 255.0
    limit = np.maximum(red, blue)
    spill = np.maximum(green - limit, 0.0) * strength * alpha
    out[:, :, 1] = np.clip(green - spill, 0, 255).astype(np.uint8)
    return out


def trim_alpha(bgra: np.ndarray, padding: int = 0) -> np.ndarray:
    alpha = bgra[:, :, 3]
    ys, xs = np.where(alpha > 0)
    if len(xs) == 0:
        return bgra
    x0 = max(int(xs.min()) - padding, 0)
    y0 = max(int(ys.min()) - padding, 0)
    x1 = min(int(xs.max()) + 1 + padding, bgra.shape[1])
    y1 = min(int(ys.max()) + 1 + padding, bgra.shape[0])
    return bgra[y0:y1, x0:x1].copy()


def split_grid(bgra: np.ndarray, cols: int, rows: int) -> list[np.ndarray]:
    if cols < 1 or rows < 1:
        raise ValueError("grid cols and rows must be >= 1")
    height, width = bgra.shape[:2]
    cells: list[np.ndarray] = []
    for row in range(rows):
        for col in range(cols):
            x0 = int(round(col * width / cols))
            x1 = int(round((col + 1) * width / cols))
            y0 = int(round(row * height / rows))
            y1 = int(round((row + 1) * height / rows))
            cells.append(bgra[y0:y1, x0:x1].copy())
    return cells


def split_components(bgra: np.ndarray, min_area: int = 16) -> list[np.ndarray]:
    alpha = bgra[:, :, 3]
    binary = (alpha > 8).astype(np.uint8) * 255
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    boxes = []
    sheet_h = max(bgra.shape[0], 1)
    row_bucket = max(sheet_h // 10, 1)
    for i in range(1, num):
        x, y, width, height, area = stats[i]
        if int(area) < min_area:
            continue
        boxes.append((int(x), int(y), int(width), int(height)))
    boxes.sort(key=lambda box: (box[1] // row_bucket, box[0]))
    return [trim_alpha(bgra[y : y + h, x : x + w].copy()) for x, y, w, h in boxes]


def is_empty(bgra: np.ndarray, min_pixels: int = 4) -> bool:
    return int(np.count_nonzero(bgra[:, :, 3] > 8)) < min_pixels


def process_image(
    bgr: np.ndarray,
    *,
    key: bool = True,
    grid: tuple[int, int] | None = None,
    split: str = "grid",
    trim: bool = True,
) -> list[np.ndarray]:
    """Key, despill, split, and trim. ``grid`` is ``(cols, rows)``."""
    img = bgr
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if key:
        keyed = key_green(img)
        keyed = despill(keyed)
    else:
        keyed = bgr_to_bgra(img)

    if split == "components" or grid is None:
        cells = split_components(keyed)
        if not cells:
            cells = [keyed]
    else:
        cols, rows = grid
        cells = split_grid(keyed, cols, rows)

    if trim:
        cells = [trim_alpha(cell) for cell in cells]
    return cells


def load_image(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"could not read image: {path}")
    return img


def write_png(path: Path, bgra: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), bgra):
        raise OSError(f"failed to write PNG: {path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Key #00FF00, trim, and split a sheet into cells.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--grid", default=None, help="COLSxROWS, e.g. 3x3")
    parser.add_argument("--components", action="store_true", help="Split by connected components instead of a grid")
    parser.add_argument("--no-key", action="store_true", help="Skip chroma key (background plates)")
    parser.add_argument("--no-trim", action="store_true")
    args = parser.parse_args(argv)

    image = load_image(args.input)
    grid = None
    split = "components" if args.components else "grid"
    if args.grid:
        parts = args.grid.lower().split("x")
        if len(parts) != 2:
            print("error: --grid must look like 3x3", file=sys.stderr)
            return 2
        try:
            grid = (int(parts[0]), int(parts[1]))
        except ValueError:
            print("error: --grid must look like 3x3", file=sys.stderr)
            return 2
        split = "grid"

    try:
        cells = process_image(
            image,
            key=not args.no_key,
            grid=grid,
            split=split,
            trim=not args.no_trim,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = []
    for index, cell in enumerate(cells):
        cell_path = out_dir / f"cell_{index:02d}.png"
        write_png(cell_path, cell)
        payload.append(
            {
                "index": index,
                "path": str(cell_path),
                "width": int(cell.shape[1]),
                "height": int(cell.shape[0]),
                "empty": is_empty(cell),
            }
        )

    print(json.dumps({"ok": True, "cells": payload}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
