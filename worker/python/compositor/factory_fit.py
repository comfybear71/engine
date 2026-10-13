"""Fit a cut-out piece onto a slot canvas without squashing.

Used by Factory after chroma-key. Scale is uniform (one number for x and y).
Pieces are padded onto the canvas and aligned to an existing drawing's
feet / pivot when a reference is present.

Also flags eyes/mouth overlays that are actually full heads.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .align import alpha_bbox
from .asset_cache import _to_bgra

MARGIN = 8
FULL_HEAD_HEIGHT_RATIO = 0.72
LEGS_TOP_FRAC = 0.50
BOOT_BAND_FRAC = 0.85
BOOT_MIN_FRAC = 0.012
GIANT_LEGS_CANVAS_FRAC = 0.82
GIANT_LEGS_REF_RATIO = 2.4
WALK_SCALE_TOLERANCE = 0.22
LEGS_OF_FIGURE_FRAC = 0.42
POSE_DIFF_MIN = 0.028
PREVIEW_POSE_DIFF_MIN = 0.012
WALK_BOOT_X_MIN_STD = 2.5


def _resize_uniform(piece: np.ndarray, scale: float) -> np.ndarray:
    h, w = piece.shape[:2]
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(piece, (new_w, new_h), interpolation=interp)


def keep_on_canvas(src: np.ndarray, canvas_w: int, canvas_h: int) -> np.ndarray:
    """Pad or crop onto the canvas without moving opaque pixels relative to (0, 0)."""

    src = _to_bgra(src)
    canvas_w = max(2, int(canvas_w))
    canvas_h = max(2, int(canvas_h))
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    h, w = src.shape[:2]
    copy_h = min(h, canvas_h)
    copy_w = min(w, canvas_w)
    out[:copy_h, :copy_w] = src[:copy_h, :copy_w]
    return out


def fit_piece_no_squash(
    src: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    *,
    ref: np.ndarray | None = None,
    margin: int = MARGIN,
) -> np.ndarray:
    """Pad/scale uniformly onto ``canvas_w`` × ``canvas_h``. Never stretch."""

    src = _to_bgra(src)
    canvas_w = max(2, int(canvas_w))
    canvas_h = max(2, int(canvas_h))
    box = alpha_bbox(src)
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    if box is None:
        return out
    x0, y0, x1, y1 = box
    piece = src[y0:y1, x0:x1]
    ph, pw = piece.shape[:2]
    inner_w = max(1, canvas_w - margin * 2)
    inner_h = max(1, canvas_h - margin * 2)

    ref_box = alpha_bbox(_to_bgra(ref)) if ref is not None else None
    if ref_box is not None:
        rw = max(1, ref_box[2] - ref_box[0])
        rh = max(1, ref_box[3] - ref_box[1])
        scale = min(rw / max(1, pw), rh / max(1, ph), inner_w / max(1, pw), inner_h / max(1, ph))
    else:
        scale = min(inner_w / max(1, pw), inner_h / max(1, ph))

    resized = _resize_uniform(piece, float(scale))
    new_h, new_w = resized.shape[:2]
    if ref_box is not None:
        ref_cx = (ref_box[0] + ref_box[2]) / 2.0
        ref_bottom = ref_box[3]
        x = int(round(ref_cx - new_w / 2.0))
        y = int(round(ref_bottom - new_h))
    else:
        x = (canvas_w - new_w) // 2
        y = canvas_h - margin - new_h
    x = max(0, min(x, canvas_w - new_w))
    y = max(0, min(y, canvas_h - new_h))
    out[y : y + new_h, x : x + new_w] = resized
    return out


def looks_like_full_figure(piece: np.ndarray) -> bool:
    """True when a cell is a whole character (head + torso + legs), not a legs island."""

    piece = _to_bgra(piece)
    box = alpha_bbox(piece)
    if box is None:
        return False
    x0, y0, x1, y1 = box
    width = x1 - x0
    height = y1 - y0
    if height < 24 or width < 8:
        return False
    crop = piece[y0:y1, x0:x1]
    top = crop[: max(1, height // 3)]
    bot = crop[(height * 2) // 3 :]
    top_px = int(np.count_nonzero(top[:, :, 3] > 16))
    bot_px = int(np.count_nonzero(bot[:, :, 3] > 16))
    if not (height > width * 1.15 and top_px > 8 and bot_px > 8):
        return False
    # A head is one blob in the top third. Two thighs after a legs crop is not a figure.
    # A cape sliver sitting beside the head is not a second head.
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        (top[:, :, 3] > 16).astype(np.uint8), connectivity=8
    )
    top_blobs = 0
    for i in range(1, num):
        if int(stats[i, cv2.CC_STAT_AREA]) < 8:
            continue
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if bw < width * 0.28 and bh > bw * 1.4:
            continue
        top_blobs += 1
    return top_blobs == 1


def looks_like_walk_body(piece: np.ndarray) -> bool:
    """True for a walking body (cape/torso/legs), including headless Grok cells.

    Live Imagine walk cells are often a side-on body without a separate head
    blob. Those must still scale to the rig — not be treated as a boot close-up
    and blown up to the canvas.
    """

    if looks_like_full_figure(piece):
        return True
    src = _to_bgra(piece)
    box = alpha_bbox(src)
    if box is None:
        return False
    x0, y0, x1, y1 = box
    width = x1 - x0
    height = y1 - y0
    if height < 24 or width < 16:
        return False
    crop = src[y0:y1, x0:x1]
    top = crop[: max(1, (height * 40) // 100)]
    mid = crop[(height * 30) // 100 : (height * 65) // 100]
    bot = crop[(height * 65) // 100 :]
    top_px = int(np.count_nonzero(top[:, :, 3] > 16))
    mid_px = int(np.count_nonzero(mid[:, :, 3] > 16))
    bot_px = int(np.count_nonzero(bot[:, :, 3] > 16))
    if top_px < 24 or bot_px < 16 or mid_px < 16:
        return False
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        (top[:, :, 3] > 16).astype(np.uint8), connectivity=8
    )
    wide = 0
    for i in range(1, num):
        if int(stats[i, cv2.CC_STAT_AREA]) < 12:
            continue
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        if bw >= width * 0.34:
            wide += 1
    return wide >= 1


def count_figures(piece: np.ndarray) -> int:
    """Count separate bodies in a keyed cell (joined hat/cape/boots count as one)."""

    src = _to_bgra(piece)
    box = alpha_bbox(src)
    if box is None:
        return 0
    x0, y0, x1, y1 = box
    crop = src[y0:y1, x0:x1]
    height, width = crop.shape[:2]
    alpha = (crop[:, :, 3] > 16).astype(np.uint8)
    kx = max(3, (width // 14) | 1)
    ky = max(3, (height // 16) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kx, ky))
    merged = cv2.dilate(alpha, kernel)
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(merged, connectivity=8)
    min_area = max(24, int(height * width * 0.05))
    min_w = max(8, int(width * 0.32))
    min_h = max(12, int(height * 0.45))
    figures = 0
    for i in range(1, num):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if area < min_area or bw < min_w or bh < min_h:
            continue
        figures += 1
    return figures


def extract_legs(
    piece: np.ndarray,
    top_frac: float = LEGS_TOP_FRAC,
    ref: np.ndarray | None = None,
) -> np.ndarray:
    """Clear the head/torso so only the lower body remains on the same canvas.

    When ``ref`` is a standing legs drawing, keep a band of that height up from
    the feet (plus a small overlap) instead of scaling the leftover mass.
    """

    src = _to_bgra(piece)
    if not looks_like_full_figure(src) and not looks_like_walk_body(src):
        return src
    box = alpha_bbox(src)
    if box is None:
        return src
    x0, y0, x1, y1 = box
    out = src.copy()
    ref_box = alpha_bbox(_to_bgra(ref)) if ref is not None else None
    if ref_box is not None:
        keep_h = max(8, int(ref_box[3] - ref_box[1]))
        overlap = int(round(keep_h * 0.14))
        cut = y1 - keep_h - overlap
        out[: max(cut, 0), :, 3] = 0
        return out
    cut = y0 + int(round((y1 - y0) * float(top_frac)))
    out[: max(cut, 0), :, 3] = 0
    return out


def rig_ground_and_height(
    torso_ref: np.ndarray | None,
    legs_ref: np.ndarray | None,
    canvas_h: int,
) -> tuple[int, int]:
    """Standing feet y and full-figure height on the slot canvas."""

    tbox = alpha_bbox(_to_bgra(torso_ref)) if torso_ref is not None else None
    lbox = alpha_bbox(_to_bgra(legs_ref)) if legs_ref is not None else None
    canvas_h = max(2, int(canvas_h))
    if tbox is not None and lbox is not None:
        top = min(tbox[1], lbox[1])
        ground = max(tbox[3], lbox[3])
        return int(ground), int(max(ground - top, 8))
    if lbox is not None:
        ground = int(lbox[3])
        legs_h = max(1, lbox[3] - lbox[1])
        height = int(round(legs_h / LEGS_OF_FIGURE_FRAC))
        return ground, max(height, legs_h)
    if tbox is not None:
        torso_h = max(1, tbox[3] - tbox[1])
        ground = int(tbox[3] + round(torso_h * 0.40))
        height = int(round(torso_h / 0.62))
        return min(ground, canvas_h - MARGIN), max(height, torso_h)
    return canvas_h - MARGIN, int(canvas_h * 0.62)


def _blit(dst: np.ndarray, src: np.ndarray, x: int, y: int) -> np.ndarray:
    out = dst
    sh, sw = src.shape[:2]
    dh, dw = out.shape[:2]
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(dw, x + sw)
    y1 = min(dh, y + sh)
    if x1 <= x0 or y1 <= y0:
        return out
    sx0 = x0 - x
    sy0 = y0 - y
    out[y0:y1, x0:x1] = src[sy0 : sy0 + (y1 - y0), sx0 : sx0 + (x1 - x0)]
    return out


def fit_walk_piece(
    src: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    *,
    ref: np.ndarray | None = None,
    torso_ref: np.ndarray | None = None,
    extract: bool = False,
    margin: int = MARGIN,
    expect_face: str | None = "right",
    strict: bool = True,
) -> tuple[np.ndarray, list[str]]:
    """Scale the whole figure to the rig and plant feet on the ground line.

    Walks use the whole cell as the frame (hat-to-boots). Never extract legs
    onto a standing torso — that cropped live Grok sheets at the waist and
    composited a second pair of boots.
    """

    src = _to_bgra(src)
    canvas_w = max(2, int(canvas_w))
    canvas_h = max(2, int(canvas_h))
    problems = validate_walk_frame(src, expect_face=expect_face, require_full_figure=True)
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    if problems and strict:
        return out, problems
    box = alpha_bbox(src)
    if box is None:
        return out, ["blank drawing"]
    x0, y0, x1, y1 = box
    piece = src[y0:y1, x0:x1]
    ph, pw = piece.shape[:2]
    ground, target_h = rig_ground_and_height(torso_ref, ref, canvas_h)
    inner_w = max(1, canvas_w - margin * 2)
    inner_h = max(1, canvas_h - margin * 2)
    scale = min(target_h / max(1, ph), inner_w / max(1, pw), inner_h / max(1, ph))
    resized = _resize_uniform(piece, float(scale))
    new_h, new_w = resized.shape[:2]
    ref_box = alpha_bbox(_to_bgra(ref)) if ref is not None else None
    torso_box = alpha_bbox(_to_bgra(torso_ref)) if torso_ref is not None else None
    if ref_box is not None:
        cx = (ref_box[0] + ref_box[2]) / 2.0
    elif torso_box is not None:
        cx = (torso_box[0] + torso_box[2]) / 2.0
    else:
        cx = canvas_w / 2.0
    x = int(round(cx - new_w / 2.0))
    y = int(round(ground - new_h))
    x = max(margin, min(x, canvas_w - margin - new_w)) if new_w + margin * 2 <= canvas_w else max(0, min(x, canvas_w - new_w))
    y = max(margin, min(y, canvas_h - margin - new_h)) if new_h + margin * 2 <= canvas_h else max(0, min(y, canvas_h - new_h))
    _blit(out, resized, x, y)
    if extract:
        out = extract_legs(out, ref=ref)
    fitted_box = alpha_bbox(out)
    if fitted_box is None:
        problems.append("blank drawing after walk fit")
        return out, problems
    fh = fitted_box[3] - fitted_box[1]
    if fh > canvas_h * GIANT_LEGS_CANVAS_FRAC:
        problems.append("giant legs (fill the canvas)")
    if not extract:
        if abs(fh - target_h) / max(1.0, float(target_h)) > WALK_SCALE_TOLERANCE:
            problems.append("scale mismatch vs rig")
        if not looks_like_walk_body(out):
            problems.append("zoomed crop (not a whole body)")
    elif ref_box is not None:
        rh = max(1, ref_box[3] - ref_box[1])
        if fh > rh * GIANT_LEGS_REF_RATIO:
            problems.append(f"giant legs ({fh}px vs ref {rh}px)")
    return out, problems


def normalize_walk_batch(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Re-scale and plant every frame so feet share one ground line."""

    boxes = [alpha_bbox(frame) for frame in frames]
    filled = [(i, box) for i, box in enumerate(boxes) if box is not None]
    if len(filled) < 2:
        return frames
    heights = [box[3] - box[1] for _i, box in filled]
    grounds = [box[3] for _i, box in filled]
    target_h = float(np.median(np.asarray(heights, dtype=np.float32)))
    target_ground = int(round(float(np.median(np.asarray(grounds, dtype=np.float32)))))
    out = list(frames)
    for i, box in filled:
        frame = frames[i]
        x0, y0, x1, y1 = box
        piece = frame[y0:y1, x0:x1]
        ph, pw = piece.shape[:2]
        scale = target_h / max(1, ph)
        if abs(scale - 1.0) > 0.04:
            piece = _resize_uniform(piece, float(scale))
            ph, pw = piece.shape[:2]
        canvas = np.zeros_like(frame)
        ch, cw = canvas.shape[:2]
        cx = (x0 + x1) / 2.0
        x = int(round(cx - pw / 2.0))
        y = int(round(target_ground - ph))
        x = max(0, min(x, cw - pw))
        y = max(0, min(y, ch - ph))
        _blit(canvas, piece, x, y)
        out[i] = canvas
    return out


def walk_batch_problems(
    frames: list[np.ndarray],
    ref: np.ndarray | None = None,
    torso_ref: np.ndarray | None = None,
) -> list[str]:
    """Cross-frame checks: scale drift, feet on the ground, scale vs the rig."""

    boxes = [alpha_bbox(frame) for frame in frames if alpha_bbox(frame) is not None]
    if len(boxes) < 2:
        return []
    heights = [box[3] - box[1] for box in boxes]
    grounds = [box[3] for box in boxes]
    median_h = float(np.median(np.asarray(heights, dtype=np.float32)))
    problems: list[str] = []
    if median_h > 0 and (max(heights) / median_h > 1.0 + WALK_SCALE_TOLERANCE or min(heights) / median_h < 1.0 - WALK_SCALE_TOLERANCE):
        problems.append("scale mismatch across walk frames")
    if max(grounds) - min(grounds) > 16:
        problems.append("feet missed the common ground line")
    canvas_h = int(frames[0].shape[0]) if frames else 1024
    _ground, target_h = rig_ground_and_height(torso_ref, ref, canvas_h)
    if target_h > 0 and (
        max(heights) / float(target_h) > 1.0 + WALK_SCALE_TOLERANCE
        or min(heights) / float(target_h) < 1.0 - WALK_SCALE_TOLERANCE
    ):
        problems.append("scale mismatch vs rig")
    return problems


def _alpha_over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    dst = _to_bgra(dst)
    src = _to_bgra(src)
    if src.shape[:2] != dst.shape[:2]:
        return dst
    out = dst.copy()
    a = src[:, :, 3:4].astype(np.float32) / 255.0
    out[:, :, :3] = (
        src[:, :, :3].astype(np.float32) * a + out[:, :, :3].astype(np.float32) * (1.0 - a)
    ).astype(np.uint8)
    out[:, :, 3] = np.maximum(out[:, :, 3], src[:, :, 3])
    return out


def validate_walk_composite(walk: np.ndarray, standing_layers: list[np.ndarray | None]) -> list[str]:
    """Fail when a waist-down walk would leave the standing torso/legs on screen.

    Live Grok sheets were whole-body, then chopped at the waist and composited
    under the rig's own standing body — two pairs of legs / four boots.
    """

    walk = _to_bgra(walk)
    problems: list[str] = []
    walk_box = alpha_bbox(walk)
    if walk_box is None:
        return ["blank drawing"]
    torso = standing_layers[0] if standing_layers else None
    legs = standing_layers[1] if len(standing_layers) > 1 else None
    torso_box = alpha_bbox(_to_bgra(torso)) if torso is not None else None
    waist_down = False
    if torso_box is not None:
        torso_mid = (torso_box[1] + torso_box[3]) / 2.0
        if walk_box[1] > torso_mid:
            waist_down = True
    if not waist_down and torso_box is not None:
        target_h = max(8, (torso_box[3] - torso_box[1]))
        if legs is not None:
            lbox = alpha_bbox(_to_bgra(legs))
            if lbox is not None:
                target_h = max(lbox[3], torso_box[3]) - min(lbox[1], torso_box[1])
        if (walk_box[3] - walk_box[1]) < target_h * 0.55:
            waist_down = True
    if waist_down:
        problems.append("rig base parts visible beneath walk frames")
        stacked = np.zeros_like(walk)
        for layer in standing_layers:
            if layer is None:
                continue
            layer = _to_bgra(layer)
            if layer.shape[:2] != walk.shape[:2]:
                continue
            stacked = _alpha_over(stacked, layer)
        combined = _alpha_over(stacked, walk)
        boots = count_boots(combined)
        if boots > 2:
            problems.append(f"duplicated legs/boots in composite ({boots} boots)")
        else:
            problems.append("duplicated legs/boots in composite")
    return problems


def _boot_xs(frame: np.ndarray) -> list[float]:
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return []
    x0, y0, x1, y1 = box
    height = max(1, y1 - y0)
    band_y0 = y0 + int(height * BOOT_BAND_FRAC)
    band = np.zeros(src.shape[:2], dtype=np.uint8)
    band[band_y0:y1, x0:x1] = np.where(src[band_y0:y1, x0:x1, 3] > 16, 255, 0)
    num, _labels, stats, centroids = cv2.connectedComponentsWithStats(band, connectivity=8)
    xs: list[float] = []
    min_area = max(8, int((x1 - x0) * height * BOOT_MIN_FRAC))
    for i in range(1, num):
        if int(stats[i, cv2.CC_STAT_AREA]) >= min_area:
            xs.append(float(centroids[i][0]))
    return xs


def walk_pose_problems(
    frames: list[np.ndarray],
    *,
    min_diff: float = POSE_DIFF_MIN,
) -> list[str]:
    """Reject a sheet of near-identical mid-stride copies with no gait change."""

    samples: list[np.ndarray] = []
    lead_xs: list[float] = []
    for frame in frames:
        src = _to_bgra(frame)
        box = alpha_bbox(src)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        crop = src[y0:y1, x0:x1, 3]
        small = cv2.resize(crop, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        samples.append(small)
        xs = _boot_xs(frame)
        if xs:
            lead_xs.append(max(xs))
    if len(samples) < 2:
        return []
    diffs = [float(np.mean(np.abs(samples[i] - samples[i - 1]))) for i in range(1, len(samples))]
    for i, diff in enumerate(diffs, start=1):
        boot_delta = 0.0
        if i < len(lead_xs):
            boot_delta = abs(lead_xs[i] - lead_xs[i - 1])
        if diff < min_diff and boot_delta < WALK_BOOT_X_MIN_STD:
            return [f"near-identical cells (frames {i} and {i + 1} do not change)"]
    return []


def count_boots(piece: np.ndarray) -> int:
    """Count separate opaque blobs in the bottom band of the figure (feet/boots)."""

    src = _to_bgra(piece)
    box = alpha_bbox(src)
    if box is None:
        return 0
    x0, y0, x1, y1 = box
    height = max(1, y1 - y0)
    width = max(1, x1 - x0)
    band_y0 = y0 + int(height * BOOT_BAND_FRAC)
    band = np.zeros(src.shape[:2], dtype=np.uint8)
    band[band_y0:y1, x0:x1] = np.where(src[band_y0:y1, x0:x1, 3] > 16, 255, 0)
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(band, connectivity=8)
    min_area = max(8, int(width * height * BOOT_MIN_FRAC))
    boots = 0
    for i in range(1, num):
        if int(stats[i, cv2.CC_STAT_AREA]) >= min_area:
            boots += 1
    return boots


def facing_direction(piece: np.ndarray) -> str:
    """Guess 'right', 'left', or 'front' from the head (or remaining) silhouette."""

    src = _to_bgra(piece)
    box = alpha_bbox(src)
    if box is None:
        return "front"
    x0, y0, x1, y1 = box
    width = max(1, x1 - x0)
    height = max(1, y1 - y0)
    y_head1 = y0 + max(1, int(height * 0.18))
    head = src[y0:y_head1, x0:x1, 3] > 16
    ys, xs = np.where(head)
    if xs.size < 4:
        # Legs-only: leading (rightmost) mass vs trailing.
        ys, xs = np.where(src[y0:y1, x0:x1, 3] > 16)
        if xs.size < 4:
            return "front"
        cx = float(xs.mean())
        if cx > width * 0.56:
            return "right"
        if cx < width * 0.44:
            return "left"
        return "front"
    head_cx = float(xs.mean())
    if head_cx > width * 0.56:
        return "right"
    if head_cx < width * 0.44:
        return "left"
    return "front"


def validate_walk_frame(
    piece: np.ndarray,
    *,
    expect_face: str | None = "right",
    max_boots: int = 2,
    require_full_figure: bool = False,
) -> list[str]:
    """Reject extra figures, zoomed crops, extra boots, or a mismatched facing."""

    problems: list[str] = []
    figures = count_figures(piece)
    if figures > 1:
        problems.append(f"extra figures ({figures} bodies in one cell)")
    elif figures == 0:
        problems.append("no figure")
    if require_full_figure and figures <= 1 and not looks_like_walk_body(piece):
        problems.append("zoomed crop (not a whole body)")
    boots = count_boots(piece)
    if boots > max_boots:
        problems.append(f"too many boots ({boots} > {max_boots})")
    if expect_face:
        facing = facing_direction(piece)
        want = str(expect_face).lower()
        if facing in {"left", "right"} and want in {"left", "right"} and facing != want:
            problems.append(f"facing {facing}, expected {want}")
    return problems


def looks_like_full_head(piece: np.ndarray, head_ref: np.ndarray | None = None) -> bool:
    """True when an overlay is tall enough to be a whole head, not eyes/mouth."""

    piece = _to_bgra(piece)
    box = alpha_bbox(piece)
    if box is None:
        return False
    piece_h = box[3] - box[1]
    if head_ref is not None:
        head_box = alpha_bbox(_to_bgra(head_ref))
        if head_box is None:
            return False
        head_h = max(1, head_box[3] - head_box[1])
        return piece_h >= head_h * FULL_HEAD_HEIGHT_RATIO
    canvas_h = piece.shape[0]
    return piece_h >= canvas_h * FULL_HEAD_HEIGHT_RATIO


def validate_piece(bgra: np.ndarray, canvas_w: int, canvas_h: int) -> list[str]:
    """Return problem strings. Empty means the piece is usable."""

    problems: list[str] = []
    if bgra.shape[1] != canvas_w or bgra.shape[0] != canvas_h:
        problems.append(f"canvas is {bgra.shape[1]}x{bgra.shape[0]}, expected {canvas_w}x{canvas_h}")
    box = alpha_bbox(bgra)
    if box is None:
        problems.append("blank drawing")
        return problems
    x0, y0, x1, y1 = box
    if x0 <= 0 or y0 <= 0 or x1 >= canvas_w or y1 >= canvas_h:
        problems.append("alpha bbox touches the canvas edge")
    return problems


def _chroma_green(bgr: np.ndarray) -> np.ndarray:
    b = bgr[:, :, 0].astype(np.int16)
    g = bgr[:, :, 1].astype(np.int16)
    r = bgr[:, :, 2].astype(np.int16)
    return (g > 180) & (r < 60) & (b < 60) & (g - r > 80) & (g - b > 80)


def _figure_mask(img: np.ndarray) -> np.ndarray:
    src = img
    if src.ndim == 3 and src.shape[2] == 4:
        opaque = src[:, :, 3] > 16
        return opaque & ~_chroma_green(src[:, :, :3])
    if src.ndim == 3:
        gray = cv2.cvtColor(src[:, :, :3], cv2.COLOR_BGR2GRAY)
        return (gray > 18) & ~_chroma_green(src[:, :, :3])
    return src > 18


def _mask_to_bgra(mask: np.ndarray) -> np.ndarray:
    out = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    out[mask, 3] = 255
    out[mask, :3] = 200
    return out


def validate_preview_motion(frames: list[np.ndarray]) -> list[str]:
    """Fail when consecutive preview frames are frozen (same pose)."""

    if len(frames) < 2:
        return []
    grays = []
    for frame in frames:
        if frame.ndim == 3:
            grays.append(cv2.cvtColor(frame[:, :, :3], cv2.COLOR_BGR2GRAY))
        else:
            grays.append(frame)
    for i in range(1, len(grays)):
        mask = _figure_mask(frames[i]) | _figure_mask(frames[i - 1])
        ys, xs = np.where(mask)
        if ys.size < 16:
            continue
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        a = grays[i - 1][y0:y1, x0:x1].astype(np.float32)
        b = grays[i][y0:y1, x0:x1].astype(np.float32)
        diff = float(np.mean(np.abs(a - b))) / 255.0
        if diff < PREVIEW_POSE_DIFF_MIN:
            return [f"near-identical cells (frames {i} and {i + 1} do not change)"]
    return []


def validate_composite_matches_cell(composite: np.ndarray, cell: np.ndarray) -> list[str]:
    """Fail when the preview composite contains a second head/hat/collar the cell does not."""

    c_mask = _figure_mask(composite)
    s_mask = _figure_mask(cell)
    ys, xs = np.where(c_mask)
    if ys.size < 16 or not np.any(s_mask):
        return []
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    crop = c_mask[y0:y1, x0:x1]
    ch, cw = crop.shape
    sys, sxs = np.where(s_mask)
    sy0, sy1 = int(sys.min()), int(sys.max()) + 1
    sx0, sx1 = int(sxs.min()), int(sxs.max()) + 1
    src = s_mask[sy0:sy1, sx0:sx1].astype(np.uint8) * 255
    resized = cv2.resize(src, (cw, ch), interpolation=cv2.INTER_NEAREST) > 127
    extra = crop & ~resized
    overlap = crop & resized
    union = crop | resized
    iou = float(np.count_nonzero(overlap)) / max(1, int(np.count_nonzero(union)))
    top = max(1, ch // 3)
    extra_top = int(np.count_nonzero(extra[:top]))
    top_n = int(np.count_nonzero(crop[:top]))
    if iou < 0.55 or extra_top > max(40, int(top_n * 0.28)):
        return ["more than one head/hat in composite"]
    extra_n = int(np.count_nonzero(extra))
    body_n = int(np.count_nonzero(crop))
    if extra_n > max(120, int(body_n * 0.28)):
        return ["rig layers visible in walk composite"]
    return []


def _load(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"could not read {path}")
    return img


def _write(path: Path, bgra: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), bgra):
        raise OSError(f"failed to write {path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fit a cut-out piece onto a canvas without squashing.")
    parser.add_argument("--src", type=Path)
    parser.add_argument("--src-dir", type=Path, dest="src_dir")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--out-dir", type=Path, dest="out_dir")
    parser.add_argument("--ref", type=Path)
    parser.add_argument("--canvas-w", type=int, default=1024)
    parser.add_argument("--canvas-h", type=int, default=1024)
    parser.add_argument("--check-head", action="store_true")
    parser.add_argument(
        "--keep-canvas",
        action="store_true",
        help="Keep pixel placement (pad/crop to canvas) instead of refitting to feet/pivot",
    )
    parser.add_argument("--head-ref", type=Path, dest="head_ref")
    parser.add_argument("--torso-ref", type=Path, dest="torso_ref")
    parser.add_argument(
        "--extract-legs",
        action="store_true",
        help="Legacy: chop the fitted figure to a legs island. Walks must NOT use this.",
    )
    parser.add_argument(
        "--validate-walk",
        action="store_true",
        help="Reject extra figures, zoomed crops, extra boots, or a mismatched facing",
    )
    parser.add_argument(
        "--fail-closed",
        action="store_true",
        help="Exit non-zero when any walk frame fails validation (do not keep broken output)",
    )
    parser.add_argument("--expect-face", default="right", help="Expected walk facing (right|left)")
    parser.add_argument("--validate-preview", action="store_true")
    parser.add_argument("--preview-frames", type=Path, dest="preview_frames")
    parser.add_argument("--cell-dir", type=Path, dest="cell_dir")
    args = parser.parse_args(argv)

    if args.validate_preview:
        preview_dir = args.preview_frames
        cell_dir = args.cell_dir
        if not preview_dir or not preview_dir.exists():
            print(json.dumps({"ok": False, "error": "preview frames missing"}))
            return 1
        previews = [_load(p) for p in sorted(preview_dir.glob("frame_*.png"))]
        problems = validate_preview_motion(previews)
        if cell_dir and cell_dir.exists() and previews:
            cells = [_load(p) for p in sorted(cell_dir.glob("*.png"))]
            n = min(len(previews), len(cells))
            for i in range(n):
                problems.extend(
                    f"frame {i + 1}: {item}" for item in validate_composite_matches_cell(previews[i], cells[i])
                )
        problems = list(dict.fromkeys(problems))
        if problems:
            print(json.dumps({"ok": False, "error": "; ".join(problems[:8]), "problems": problems}))
            return 1
        print(json.dumps({"ok": True, "frames": len(previews), "problems": []}))
        return 0

    ref = _load(args.ref) if args.ref else None
    head_ref = _load(args.head_ref) if args.head_ref else None
    torso_ref = _load(args.torso_ref) if args.torso_ref else None
    jobs: list[tuple[Path, Path]] = []
    if args.src and args.out:
        jobs.append((args.src, args.out))
    elif args.src_dir and args.out_dir:
        for src in sorted(args.src_dir.glob("*.png")):
            jobs.append((src, args.out_dir / src.name))
    else:
        print(json.dumps({"ok": False, "error": "pass --src/--out or --src-dir/--out-dir"}))
        return 2

    written = []
    warnings: list[str] = []
    fitted_frames: list[np.ndarray] = []
    walk_mode = bool(args.validate_walk or args.extract_legs)
    for src_path, out_path in jobs:
        src = _load(src_path)
        walk_problems: list[str] = []
        if walk_mode and not args.keep_canvas:
            fitted, walk_problems = fit_walk_piece(
                src,
                args.canvas_w,
                args.canvas_h,
                ref=ref,
                torso_ref=torso_ref,
                extract=bool(args.extract_legs),
                expect_face=args.expect_face if args.validate_walk else None,
            )
        else:
            if args.validate_walk:
                walk_problems.extend(
                    validate_walk_frame(
                        src, expect_face=args.expect_face, require_full_figure=True
                    )
                )
            if args.extract_legs:
                src = extract_legs(src, ref=ref)
            if args.keep_canvas:
                fitted = keep_on_canvas(src, args.canvas_w, args.canvas_h)
            else:
                fitted = fit_piece_no_squash(src, args.canvas_w, args.canvas_h, ref=ref)
        if args.check_head and looks_like_full_head(src, head_ref):
            warnings.append(f"{src_path.name}: looks like a full head (eyes/mouth must be overlays)")
        problems = list(walk_problems)
        if not walk_mode:
            problems.extend(validate_piece(fitted, args.canvas_w, args.canvas_h))
        if walk_problems:
            warnings.append(f"{src_path.name}: {'; '.join(walk_problems)}")
        fitted_frames.append(fitted)
        written.append(
            {
                "src": str(src_path),
                "out": str(out_path),
                "width": int(fitted.shape[1]),
                "height": int(fitted.shape[0]),
                "problems": problems,
            }
        )

    if walk_mode and not args.keep_canvas:
        good_idx = [i for i, row in enumerate(written) if not row["problems"]]
        if len(good_idx) >= 2:
            subset = [fitted_frames[i] for i in good_idx]
            normalized = normalize_walk_batch(subset)
            for i, frame in zip(good_idx, normalized):
                fitted_frames[i] = frame
            batch = walk_batch_problems(normalized, ref=ref, torso_ref=torso_ref)
            pose = walk_pose_problems(normalized)
            standing = [item for item in (torso_ref, ref) if item is not None]
            extra: list[str] = []
            for frame in normalized:
                extra.extend(validate_walk_composite(frame, standing))
            # Deduplicate composite messages (same standing rig on every cell).
            extra = list(dict.fromkeys(extra))
            batch = batch + pose + extra
            if batch:
                warnings.extend(batch)
                for i in good_idx:
                    written[i]["problems"] = list(written[i]["problems"]) + batch

    for (_src_path, out_path), fitted, row in zip(jobs, fitted_frames, written):
        if args.fail_closed and row["problems"]:
            continue
        _write(out_path, fitted)
        row["width"] = int(fitted.shape[1])
        row["height"] = int(fitted.shape[0])

    fatal = [row for row in written if row["problems"]]
    if args.fail_closed and fatal:
        detail = "; ".join(
            f"{Path(row['src']).name}: {'; '.join(row['problems'])}" for row in fatal[:6]
        )
        print(json.dumps({"ok": False, "error": detail, "written": written, "warnings": warnings}))
        return 1

    print(json.dumps({"ok": True, "written": written, "warnings": warnings}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
