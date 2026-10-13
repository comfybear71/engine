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
# Drop disconnected crumbs smaller than this fraction of the main body.
ISLAND_AREA_FRAC = 0.04
ISLAND_MIN_AREA = 24
ISLAND_KEEP_FRAC = 0.08
ISLAND_DILATE = 4
# A gap-split cell this much larger than an equal-area cell is a merged pose.
MERGED_CELL_AREA = 1.55


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


def remove_stray_islands(
    bgra: np.ndarray,
    *,
    min_frac: float = ISLAND_AREA_FRAC,
    keep_frac: float = ISLAND_KEEP_FRAC,
    gap: int = MAIN_FIGURE_GAP,
    dilate: int = ISLAND_DILATE,
) -> np.ndarray:
    """Keep the main body plus attached / large nearby parts; drop small islands.

    Cut-out sheets often leave a detached boot/toe from the neighbouring cell
    or a cape sliver on the cell edge. Those are small and not touching the
    figure. A hat brim or sunglasses sitting a few pixels off the head stay.
    """
    num, labels, stats, centroids = _label_alpha(bgra)
    if num <= 2:
        return bgra

    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    main_area = max(int(stats[largest, cv2.CC_STAT_AREA]), 1)
    threshold = max(ISLAND_MIN_AREA, int(main_area * min_frac))
    keep_large = max(threshold * 2, int(main_area * keep_frac))

    main_mask = (labels == largest).astype(np.uint8)
    k = max(1, int(dilate) * 2 + 1)
    dilated = cv2.dilate(main_mask, np.ones((k, k), np.uint8), iterations=1)

    mx = int(stats[largest, cv2.CC_STAT_LEFT])
    my = int(stats[largest, cv2.CC_STAT_TOP])
    mw = int(stats[largest, cv2.CC_STAT_WIDTH])
    mh = int(stats[largest, cv2.CC_STAT_HEIGHT])
    x0, y0, x1, y1 = mx - gap, my - gap, mx + mw + gap, my + mh + gap

    keep = np.zeros(num, dtype=bool)
    keep[largest] = True
    for i in range(1, num):
        if i == largest:
            continue
        area = int(stats[i, cv2.CC_STAT_AREA])
        attached = bool(np.any(dilated[labels == i]))
        if attached:
            keep[i] = True
            continue
        ix = int(stats[i, cv2.CC_STAT_LEFT])
        iy = int(stats[i, cv2.CC_STAT_TOP])
        iw = int(stats[i, cv2.CC_STAT_WIDTH])
        ih = int(stats[i, cv2.CC_STAT_HEIGHT])
        cx, cy = float(centroids[i][0]), float(centroids[i][1])
        nearby = not (ix + iw <= x0 or ix >= x1 or iy + ih <= y0 or iy >= y1)
        centre_inside = x0 <= cx < x1 and y0 <= cy < y1
        if area >= keep_large and (nearby or centre_inside):
            keep[i] = True
            continue
        if area < threshold:
            continue
        # Mid-size but not attached and not a real extra part — drop.

    if bool(keep[1:].all()):
        return bgra
    out = bgra.copy()
    out[~keep[labels], 3] = 0
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


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive-start, exclusive-end runs where ``mask`` is true."""
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for i, value in enumerate(mask.tolist()):
        if value and start is None:
            start = i
        elif not value and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, int(mask.size)))
    return runs


def _equal_bands(length: int, count: int, offset: int = 0) -> list[tuple[int, int]]:
    length = max(int(length), 0)
    count = max(int(count), 1)
    return [
        (offset + int(round(i * length / count)), offset + int(round((i + 1) * length / count)))
        for i in range(count)
    ]


def _occupy_gap_midpoints(bands: list[tuple[int, int]], axis_len: int) -> list[tuple[int, int]]:
    """Grow each content band to the midpoints of its neighbouring gutters."""
    if not bands:
        return [(0, max(axis_len, 1))]
    out: list[tuple[int, int]] = []
    last = len(bands) - 1
    for i, (start, end) in enumerate(bands):
        left = 0 if i == 0 else (bands[i - 1][1] + start) // 2
        right = axis_len if i == last else (end + bands[i + 1][0]) // 2
        out.append((left, max(right, left + 1)))
    return out


def _axis_bands(occupancy: np.ndarray, expected: int, *, min_run: int = 2) -> list[tuple[int, int]]:
    """Split one axis into ``expected`` content bands using low-occupancy gutters.

    Green / transparent gutters show up as valleys in the occupancy profile.
    Extra speck bands are merged across the smallest gaps; missing gutters
    (touching heads) split the widest remaining band equally.
    """
    n = int(occupancy.size)
    expected = max(int(expected), 1)
    if n <= 0:
        return [(0, 1)]
    if expected == 1:
        return [(0, n)]

    peak = float(np.percentile(occupancy, 90)) if n else 1.0
    peak = max(peak, 1.0)
    is_content = occupancy >= (peak * 0.12)
    content = [(a, b) for a, b in _runs(is_content) if (b - a) >= min_run]
    if not content:
        return _equal_bands(n, expected)

    # Too many bands: merge across the smallest gap (specks / JPEG crumbs).
    while len(content) > expected:
        gap_i = 0
        gap_w = n
        for i in range(len(content) - 1):
            width = content[i + 1][0] - content[i][1]
            if width < gap_w:
                gap_w = width
                gap_i = i
        start = content[gap_i][0]
        end = content[gap_i + 1][1]
        content = content[:gap_i] + [(start, end)] + content[gap_i + 2 :]

    # Too few bands: heads touched. Split the widest band until we have enough.
    while len(content) < expected:
        widths = [b - a for a, b in content]
        i = int(np.argmax(np.asarray(widths)))
        start, end = content[i]
        if end - start < 2:
            span0, span1 = content[0][0], content[-1][1]
            return _occupy_gap_midpoints(_equal_bands(span1 - span0, expected, offset=span0), n)
        mid = (start + end) // 2
        content = content[:i] + [(start, mid), (mid, end)] + content[i + 1 :]

    return _occupy_gap_midpoints(content[:expected], n)


def detect_grid_boxes(bgra: np.ndarray, cols: int, rows: int) -> list[tuple[int, int, int, int]]:
    """Return ``(x, y, w, h)`` boxes for a ``cols`` × ``rows`` sheet from green gaps."""
    if cols < 1 or rows < 1:
        raise ValueError("grid cols and rows must be >= 1")
    alpha = bgra[:, :, 3]
    col_occ = np.count_nonzero(alpha > 8, axis=0).astype(np.float32)
    row_occ = np.count_nonzero(alpha > 8, axis=1).astype(np.float32)
    x_bands = _axis_bands(col_occ, cols)
    y_bands = _axis_bands(row_occ, rows)
    boxes: list[tuple[int, int, int, int]] = []
    for y0, y1 in y_bands:
        for x0, x1 in x_bands:
            boxes.append((int(x0), int(y0), int(max(x1 - x0, 1)), int(max(y1 - y0, 1))))
    return boxes


def split_grid_from_gaps(bgra: np.ndarray, cols: int, rows: int) -> list[np.ndarray]:
    cells: list[np.ndarray] = []
    for x, y, width, height in detect_grid_boxes(bgra, cols, rows):
        cells.append(bgra[y : y + height, x : x + width].copy())
    return cells


def _alpha_area(bgra: np.ndarray) -> int:
    return int(np.count_nonzero(bgra[:, :, 3] > 8))


def cell_looks_merged(cell: np.ndarray, expected_w: float, expected_h: float) -> bool:
    """True when a cell is several poses stuck together (whole sheet / two cells)."""
    if cell.size == 0:
        return False
    h, w = cell.shape[:2]
    if w > expected_w * MERGED_CELL_AREA or h > expected_h * MERGED_CELL_AREA:
        if _alpha_area(cell) > 32:
            return True
    num, _labels, stats, _centroids = _label_alpha(cell)
    if num <= 2:
        return False
    areas = sorted((int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, num)), reverse=True)
    if len(areas) < 2:
        return False
    # Two large, similar-sized bodies in one cell — several walk poses.
    return areas[1] >= max(40, int(areas[0] * 0.45)) and areas[0] + areas[1] > 80


def split_grid_robust(bgra: np.ndarray, cols: int, rows: int) -> list[np.ndarray]:
    """Gap-split a sheet, falling back to equal-area when gutters fail.

    Grok walk sheets are 4×2 / 4×4 cells with green gutters. Weak JPEG
    gutters can merge two poses into one cell (or the whole sheet into one
    'leg'). Prefer occupancy gutters, then equal slices if those cells look
    like several figures.
    """
    equal = split_grid(bgra, cols, rows)
    if cols * rows <= 1:
        return equal
    gap = split_grid_from_gaps(bgra, cols, rows)
    height, width = bgra.shape[:2]
    expected_w = width / max(cols, 1)
    expected_h = height / max(rows, 1)
    merged = sum(1 for cell in gap if cell_looks_merged(cell, expected_w, expected_h))
    if merged >= max(1, (cols * rows) // 4):
        return equal
    return gap


def analyze_cells(
    cells: list[np.ndarray],
    *,
    small_frac: float = 0.4,
    large_frac: float = 2.5,
) -> tuple[list[str | None], list[str]]:
    """Flag empty cells and bbox sizes far from the median of filled cells."""
    flags: list[str | None] = []
    warnings: list[str] = []
    areas = [int(cell.shape[0] * cell.shape[1]) for cell in cells]
    filled_areas = [area for area, cell in zip(areas, cells) if not is_empty(cell)]
    median = float(np.median(np.asarray(filled_areas, dtype=np.float32))) if filled_areas else 0.0
    for index, cell in enumerate(cells):
        if is_empty(cell):
            flags.append("empty")
            warnings.append(f"Cell {index} is empty")
            continue
        if median > 0 and areas[index] < median * small_frac:
            flags.append("small")
            warnings.append(f"Cell {index} is much smaller than the others")
        elif median > 0 and areas[index] > median * large_frac:
            flags.append("large")
            warnings.append(f"Cell {index} is much larger than the others")
        else:
            flags.append(None)
    return flags, warnings


def normalize_cells(cells: list[np.ndarray]) -> list[np.ndarray]:
    """Scale and pad every cell onto the median filled-head canvas."""
    filled = [cell for cell in cells if not is_empty(cell)]
    if len(filled) < 1:
        return cells
    target_w = max(int(np.median(np.asarray([cell.shape[1] for cell in filled], dtype=np.float32))), 8)
    target_h = max(int(np.median(np.asarray([cell.shape[0] for cell in filled], dtype=np.float32))), 8)
    out: list[np.ndarray] = []
    for cell in cells:
        if is_empty(cell):
            out.append(np.zeros((target_h, target_w, 4), dtype=np.uint8))
            continue
        height, width = cell.shape[:2]
        scale = min(target_w / max(width, 1), target_h / max(height, 1))
        new_w = max(1, int(round(width * scale)))
        new_h = max(1, int(round(height * scale)))
        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
        resized = cv2.resize(cell, (new_w, new_h), interpolation=interp)
        canvas = np.zeros((target_h, target_w, 4), dtype=np.uint8)
        y0 = (target_h - new_h) // 2
        x0 = (target_w - new_w) // 2
        canvas[y0 : y0 + new_h, x0 : x0 + new_w] = resized
        out.append(canvas)
    return out


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
    detect_gaps: bool = False,
    normalize: bool = False,
) -> list[np.ndarray]:
    """Key, despill, split, keep the main figure per grid cell, and trim.

    ``grid`` is ``(cols, rows)``. ``detect_gaps`` splits on green/transparent
    gutters instead of equal-area slices. ``normalize`` pads/scales cells to
    the median filled-head size.
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
        cells = split_grid_robust(keyed, cols, rows) if detect_gaps else split_grid(keyed, cols, rows)
        if key:
            cells = [remove_watermark(cell) for cell in cells]
        cells = [keep_main_figure(cell) for cell in cells]
        cells = [remove_stray_islands(cell) for cell in cells]

    if trim:
        cells = [trim_alpha(cell) for cell in cells]
    if normalize:
        cells = normalize_cells(cells)
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


def has_alpha_channel(img: np.ndarray) -> bool:
    return img.ndim == 3 and img.shape[2] == 4 and int(np.count_nonzero(img[:, :, 3] < 250)) > 8


def clean_islands_image(img: np.ndarray) -> np.ndarray:
    """Drop stray disconnected islands on an already-cut drawing (or a keyed cell)."""
    if has_alpha_channel(img):
        bgra = bgr_to_bgra(img)
    else:
        bgra = key_green(img)
        bgra = despill(bgra)
        bgra = remove_specks(bgra)
        bgra = remove_watermark(bgra)
    bgra = keep_main_figure(bgra)
    return remove_stray_islands(bgra)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Key #00FF00, trim, and split a sheet into cells.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=False)
    parser.add_argument("--grid", default=None, help="COLSxROWS, e.g. 3x3")
    parser.add_argument("--components", action="store_true", help="Split by connected components instead of a grid")
    parser.add_argument(
        "--detect-gaps",
        action="store_true",
        help="Split a grid on green/transparent gutters instead of equal-area slices",
    )
    parser.add_argument(
        "--normalize",
        action="store_true",
        help="Pad/scale each cell to the median filled-head size",
    )
    parser.add_argument("--no-key", action="store_true", help="Skip chroma key (background plates)")
    parser.add_argument("--no-trim", action="store_true")
    parser.add_argument(
        "--clean-islands",
        action="store_true",
        help="Keep the main body and drop small disconnected islands (boot/cape crumbs)",
    )
    parser.add_argument("--out", type=Path, dest="out_file", help="Single output PNG (with --clean-islands)")
    args = parser.parse_args(argv)

    image = load_image(args.input)

    if args.clean_islands and not args.grid:
        jobs: list[tuple[Path, Path]] = []
        if args.input.is_dir():
            out_dir = (args.out_dir or args.out_file or args.input).resolve()
            out_dir.mkdir(parents=True, exist_ok=True)
            for src in sorted(args.input.glob("*.png")):
                jobs.append((src, out_dir / src.name))
        else:
            dest = args.out_file or (args.out_dir / args.input.name if args.out_dir else None)
            if dest is None:
                print("error: --clean-islands needs --out or --out-dir", file=sys.stderr)
                return 2
            jobs.append((args.input, dest))
        written = []
        for src, dest in jobs:
            cleaned = clean_islands_image(load_image(src) if src != args.input else image)
            write_png(dest, cleaned)
            written.append(
                {
                    "src": str(src),
                    "out": str(dest),
                    "width": int(cleaned.shape[1]),
                    "height": int(cleaned.shape[0]),
                    "empty": is_empty(cleaned),
                }
            )
        print(json.dumps({"ok": True, "cleaned": written, "warnings": []}))
        return 0
    if args.out_dir is None:
        print("error: --out-dir is required", file=sys.stderr)
        return 2
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
            detect_gaps=bool(args.detect_gaps and grid),
            normalize=False,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    flags, warnings = analyze_cells(cells)
    if args.normalize:
        cells = normalize_cells(cells)

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
                "warning": flags[index] if index < len(flags) else None,
            }
        )

    report = {"ok": True, "cells": payload, "warnings": warnings}
    if grid:
        report["grid"] = {"cols": grid[0], "rows": grid[1]}
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
