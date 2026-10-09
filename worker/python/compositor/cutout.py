"""Green-screen cut-out for Studio asset ingest.

Estimates the screen colour per sheet, keys pixels that are greener than
red/blue (relative to that screen), despills edge fringe, drops tiny specks
and an optional Grok-style corner watermark, then splits. Each grid cell
keeps the main figure (plus nearby detached parts) and is trimmed. Invoked
by the Node worker as ``python -m compositor.cutout``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# OpenCV BGR for HTML #00FF00. Used when the sheet border is not a green screen.
KEY_BGR = np.array([0.0, 255.0, 0.0], dtype=np.float32)

# Soft matte: t = (g - max(r, b)) / screen_excess. t >= T_HI is screen;
# t <= T_LO is solid foreground. ALPHA_FLOOR snaps leftover haze to clear.
T_LO = 0.15
T_HI = 0.50
ALPHA_FLOOR = 16
TRIM_MARGIN = 2
MIN_SPECK_AREA = 32
MIN_SCREEN_EXCESS = 24.0
# Keep detached sunglasses/hat parts whose bbox sits this close to the main figure.
MAIN_FIGURE_GAP = 8


def bgr_to_bgra(bgr: np.ndarray) -> np.ndarray:
    if bgr.ndim == 3 and bgr.shape[2] == 4:
        return bgr.copy()
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)


def _planes(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rgb = bgr[:, :, :3].astype(np.float32)
    return rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]


def _excess(b: np.ndarray, g: np.ndarray, r: np.ndarray) -> np.ndarray:
    return g - np.maximum(r, b)


def estimate_screen_bgr(bgr: np.ndarray, border: int = 4) -> np.ndarray:
    """Median BGR of green-looking border / background pixels, else #00FF00."""
    h, w = bgr.shape[:2]
    if h < 2 or w < 2:
        return KEY_BGR.copy()

    blue, green, red = _planes(bgr)
    excess = _excess(blue, green, red)

    pad = max(1, min(border, h // 4, w // 4))
    border_mask = np.zeros((h, w), dtype=bool)
    border_mask[:pad, :] = True
    border_mask[-pad:, :] = True
    border_mask[:, :pad] = True
    border_mask[:, -pad:] = True

    greenish_border = border_mask & (excess >= MIN_SCREEN_EXCESS)
    sample_mask = greenish_border if np.any(greenish_border) else border_mask
    sample = bgr[:, :, :3][sample_mask]
    if sample.size == 0:
        return KEY_BGR.copy()

    median = np.median(sample.astype(np.float32), axis=0)
    screen_excess = float(median[1] - max(median[0], median[2]))
    if screen_excess < MIN_SCREEN_EXCESS:
        return KEY_BGR.copy()

    # Refine from all pixels about as green as that border estimate.
    similar = excess >= (screen_excess * 0.55)
    if np.count_nonzero(similar) >= 16:
        refined = np.median(bgr[:, :, :3][similar].astype(np.float32), axis=0)
        if float(refined[1] - max(refined[0], refined[2])) >= MIN_SCREEN_EXCESS:
            median = refined

    return median.astype(np.float32)


def key_green(
    bgr: np.ndarray,
    *,
    screen_bgr: np.ndarray | None = None,
    t_lo: float = T_LO,
    t_hi: float = T_HI,
    floor: int = ALPHA_FLOOR,
    threshold: float | None = None,
    slope: float | None = None,
) -> np.ndarray:
    """Return BGRA keyed by how much greener each pixel is than red/blue.

    Alpha is a soft ramp on ``(g - max(r, b)) / screen_excess``. Anything
    below ``floor`` opacity is snapped to fully transparent. ``threshold``
    and ``slope`` are accepted for call-site compatibility and ignored.
    """
    del threshold, slope
    rgb = bgr[:, :, :3]
    blue, green, red = _planes(rgb)
    if screen_bgr is None:
        screen_bgr = estimate_screen_bgr(bgr)
    sb, sg, sr = (float(x) for x in np.asarray(screen_bgr, dtype=np.float32).reshape(-1)[:3])
    screen_excess = max(sg - max(sb, sr), 1.0)
    t = _excess(blue, green, red) / screen_excess
    span = max(float(t_hi) - float(t_lo), 1e-6)
    alpha_f = np.clip((float(t_hi) - t) / span, 0.0, 1.0)
    alpha = (alpha_f * 255.0).astype(np.float32)
    alpha[alpha < float(floor)] = 0.0
    alpha_u8 = np.clip(alpha, 0, 255).astype(np.uint8)

    out = bgr_to_bgra(rgb)
    if bgr.ndim == 3 and bgr.shape[2] == 4:
        out[:, :, 3] = np.minimum(bgr[:, :, 3], alpha_u8)
    else:
        out[:, :, 3] = alpha_u8
    return out


def despill(bgra: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Clamp leftover green to max(r, b) on semi-transparent edge pixels."""
    out = bgra.copy()
    blue = out[:, :, 0].astype(np.float32)
    green = out[:, :, 1].astype(np.float32)
    red = out[:, :, 2].astype(np.float32)
    alpha = out[:, :, 3]
    limit = np.maximum(red, blue)
    edge = (alpha > 0) & (alpha < 255)
    if not np.any(edge):
        return out
    strength = float(np.clip(strength, 0.0, 1.0))
    clamped = np.minimum(green, limit)
    green_new = green.copy()
    green_new[edge] = green[edge] * (1.0 - strength) + clamped[edge] * strength
    out[:, :, 1] = np.clip(green_new, 0, 255).astype(np.uint8)
    return out


def trim_alpha(bgra: np.ndarray, padding: int = TRIM_MARGIN) -> np.ndarray:
    alpha = bgra[:, :, 3]
    ys, xs = np.where(alpha > 0)
    if len(xs) == 0:
        return bgra
    x0 = max(int(xs.min()) - padding, 0)
    y0 = max(int(ys.min()) - padding, 0)
    x1 = min(int(xs.max()) + 1 + padding, bgra.shape[1])
    y1 = min(int(ys.max()) + 1 + padding, bgra.shape[0])
    return bgra[y0:y1, x0:x1].copy()


def _label_alpha(bgra: np.ndarray, min_alpha: int = 8) -> tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    binary = (bgra[:, :, 3] > min_alpha).astype(np.uint8)
    return cv2.connectedComponentsWithStats(binary, connectivity=8)


def remove_specks(bgra: np.ndarray, min_area: int = MIN_SPECK_AREA) -> np.ndarray:
    """Clear connected components smaller than ``min_area``."""
    out = bgra.copy()
    num, labels, stats, _centroids = _label_alpha(out)
    for i in range(1, num):
        if int(stats[i, cv2.CC_STAT_AREA]) < min_area:
            out[labels == i, 3] = 0
    return out


def _mean_saturation(pixels: np.ndarray) -> float:
    if pixels.size == 0:
        return 0.0
    b = pixels[:, 0].astype(np.float32)
    g = pixels[:, 1].astype(np.float32)
    r = pixels[:, 2].astype(np.float32)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 1e-6, (mx - mn) / mx * 255.0, 0.0)
    return float(sat.mean())


def remove_watermark(
    bgra: np.ndarray,
    *,
    max_area_frac: float = 0.08,
    max_saturation: float = 50.0,
    corner_frac: float = 0.70,
) -> np.ndarray:
    """Drop a small, low-saturation blob in the bottom-right (Grok logo)."""
    out = bgra.copy()
    h, w = out.shape[:2]
    img_area = max(h * w, 1)
    num, labels, stats, centroids = _label_alpha(out)
    for i in range(1, num):
        x = int(stats[i, cv2.CC_STAT_LEFT])
        y = int(stats[i, cv2.CC_STAT_TOP])
        area = int(stats[i, cv2.CC_STAT_AREA])
        cx, cy = float(centroids[i][0]), float(centroids[i][1])
        if cx < w * corner_frac or cy < h * corner_frac:
            continue
        # Whole-character blobs that merely reach the corner start much earlier.
        if x < w * 0.55 or y < h * 0.55:
            continue
        if area > img_area * max_area_frac or area < 12:
            continue
        if _mean_saturation(out[labels == i]) > max_saturation:
            continue
        out[labels == i, 3] = 0
    return out


def keep_main_figure(bgra: np.ndarray, gap: int = MAIN_FIGURE_GAP) -> np.ndarray:
    """Keep the largest alpha blob and nearby parts; drop other cell-edge junk.

    After a grid split, the top of a hat from the row below can sit on the
    cell edge as its own component. Sunglasses or a hat brim that belong to
    *this* figure are usually a small gap away: keep a component if it
    overlaps the largest blob's bbox expanded by ``gap``, or if its bbox
    centre lies inside that expanded box. Everything else is cleared.
    """
    num, labels, stats, centroids = _label_alpha(bgra)
    if num <= 2:
        return bgra

    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x = int(stats[largest, cv2.CC_STAT_LEFT])
    y = int(stats[largest, cv2.CC_STAT_TOP])
    width = int(stats[largest, cv2.CC_STAT_WIDTH])
    height = int(stats[largest, cv2.CC_STAT_HEIGHT])
    x0 = x - gap
    y0 = y - gap
    x1 = x + width + gap
    y1 = y + height + gap

    keep = np.zeros(num, dtype=bool)
    keep[largest] = True
    for i in range(1, num):
        if i == largest:
            continue
        ix = int(stats[i, cv2.CC_STAT_LEFT])
        iy = int(stats[i, cv2.CC_STAT_TOP])
        iw = int(stats[i, cv2.CC_STAT_WIDTH])
        ih = int(stats[i, cv2.CC_STAT_HEIGHT])
        cx, cy = float(centroids[i][0]), float(centroids[i][1])
        overlaps = not (ix + iw <= x0 or ix >= x1 or iy + ih <= y0 or iy >= y1)
        centre_inside = x0 <= cx < x1 and y0 <= cy < y1
        if overlaps or centre_inside:
            keep[i] = True

    if bool(keep[1:].all()):
        return bgra

    out = bgra.copy()
    out[~keep[labels], 3] = 0
    return out


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
    """Key, despill, split, keep the main figure per grid cell, and trim.

    ``grid`` is ``(cols, rows)``.
    """
    img = bgr
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if key:
        keyed = key_green(img)
        keyed = despill(keyed)
        keyed = remove_specks(keyed)
        keyed = remove_watermark(keyed)
    else:
        keyed = bgr_to_bgra(img)

    if split == "components" or grid is None:
        cells = split_components(keyed)
        if not cells:
            cells = [keyed]
    else:
        cols, rows = grid
        cells = split_grid(keyed, cols, rows)
        if key:
            cells = [remove_watermark(cell) for cell in cells]
        cells = [keep_main_figure(cell) for cell in cells]

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
