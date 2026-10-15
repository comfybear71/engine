"""Keep a talking head the same size across frames and across chained clips.

LTX often lets the head shrink (or grow) a little while it talks, and the next
clip starts from that smaller last frame, so the error compounds. Head size is
the square root of the keyed head's area (so it does not care about aspect
ratio); the head is scaled about its own centre so it stays where it is.

CLI:
    python -m compositor.head_size measure --in frame.png
    python -m compositor.head_size normalize --in last.png --out start.png --target 321.5
"""

from __future__ import annotations

import argparse
import json
import sys

import cv2
import numpy as np

MIN_FACTOR = 0.7
MAX_FACTOR = 1.4
DEAD_BAND = 0.015
MEASURE_WIDTH = 640
LIT_THRESH = 28


def measure_head(bgr: np.ndarray) -> tuple[float, float, float] | None:
    """(size, cx, cy) of the visible head in full-frame pixels, or None.

    The head is the largest lit blob on the black backdrop; its convex hull area
    is used so open lips or a tilted hat brim do not change the size.
    """
    h, w = bgr.shape[:2]
    shrink = min(1.0, MEASURE_WIDTH / float(w))
    small = cv2.resize(bgr, (int(round(w * shrink)), int(round(h * shrink))), interpolation=cv2.INTER_AREA) if shrink < 1.0 else bgr
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (0, 0), 1.2)
    lit = (gray > LIT_THRESH).astype(np.uint8)
    k = max(3, int(round(small.shape[0] * 0.02)) | 1)
    lit = cv2.morphologyEx(lit, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(lit, connectivity=8)
    if count < 2:
        return None
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[best, cv2.CC_STAT_AREA] < 0.003 * small.shape[0] * small.shape[1]:
        return None
    contours, _ = cv2.findContours((labels == best).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = cv2.convexHull(np.concatenate(contours))
    area = float(cv2.contourArea(hull)) / (shrink * shrink)
    moments = cv2.moments(hull)
    if area <= 0 or moments["m00"] <= 0:
        return None
    return float(np.sqrt(area)), float(moments["m10"] / moments["m00"] / shrink), float(moments["m01"] / moments["m00"] / shrink)


def scale_about(bgr: np.ndarray, factor: float, cx: float, cy: float) -> np.ndarray:
    """Scale the whole frame by factor around (cx, cy); the black backdrop stays black."""
    if abs(factor - 1.0) < 1e-3:
        return bgr
    h, w = bgr.shape[:2]
    matrix = np.array([[factor, 0.0, cx * (1.0 - factor)], [0.0, factor, cy * (1.0 - factor)]], dtype=np.float32)
    return cv2.warpAffine(bgr, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))


def clamp_factor(factor: float) -> float:
    factor = max(MIN_FACTOR, min(MAX_FACTOR, factor))
    return 1.0 if abs(factor - 1.0) < DEAD_BAND else factor


def normalize_frame(bgr: np.ndarray, target: float) -> np.ndarray:
    """One frame scaled so its head matches target; unchanged when no head is found."""
    found = measure_head(bgr)
    if not found or target <= 0:
        return bgr
    size, cx, cy = found
    return scale_about(bgr, clamp_factor(target / size), cx, cy)


def smooth(values: np.ndarray, window: int) -> np.ndarray:
    """Moving average with edge padding, so a head that shrinks steadily is
    followed but a quick nod or mouth movement is left alone."""
    window = max(1, int(window))
    if window == 1 or len(values) < 2:
        return values.astype(np.float64)
    window = min(window, len(values))
    pad_left = window // 2
    pad_right = window - 1 - pad_left
    padded = np.concatenate([np.full(pad_left, values[0]), values, np.full(pad_right, values[-1])])
    return np.convolve(padded, np.ones(window) / window, mode="valid")


def plan_clip(metrics: list[tuple[float, float, float] | None], fps: float, target: float = 0.0) -> tuple[float, list[tuple[float, float, float]]]:
    """Per-frame (factor, cx, cy) that keeps head size at target.

    With target 0 the clip's own opening size (median of its first frames) is used
    and returned, so the first clip of a chain defines the size for the rest.
    """
    sizes = np.array([m[0] if m else np.nan for m in metrics], dtype=np.float64)
    valid = ~np.isnan(sizes)
    if not valid.any():
        return float(target), [(1.0, 0.0, 0.0)] * len(metrics)
    idx = np.arange(len(sizes))
    sizes = np.interp(idx, idx[valid], sizes[valid])
    cxs = np.interp(idx, idx[valid], np.array([m[1] if m else np.nan for m in metrics])[valid])
    cys = np.interp(idx, idx[valid], np.array([m[2] if m else np.nan for m in metrics])[valid])
    if target <= 0:
        target = float(np.median(sizes[: max(1, min(len(sizes), 5))]))
    smoothed = smooth(sizes, int(round(max(fps, 1.0))))
    return float(target), [(clamp_factor(target / s), float(cxs[i]), float(cys[i])) for i, s in enumerate(smoothed)]


def _main() -> None:
    parser = argparse.ArgumentParser(description="Head size tools for talking heads")
    sub = parser.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("measure")
    m.add_argument("--in", dest="src", required=True)
    n = sub.add_parser("normalize")
    n.add_argument("--in", dest="src", required=True)
    n.add_argument("--out", required=True)
    n.add_argument("--target", type=float, required=True)
    args = parser.parse_args()
    try:
        img = cv2.imread(args.src, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"Cannot read {args.src}")
        if args.cmd == "measure":
            found = measure_head(img)
            print(json.dumps({"size": found[0], "cx": found[1], "cy": found[2]} if found else {"size": 0}))
        else:
            out = normalize_frame(img, args.target)
            cv2.imwrite(args.out, out)
            print(json.dumps({"ok": True}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _main()
