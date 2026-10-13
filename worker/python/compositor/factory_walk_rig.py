"""Build long-stride walk cycles from ticked walk_side frames. No API calls.

Takes Rodney's painted ``walk_side_01..08`` (or however many exist), plants
them on the rig canvas, inserts in-betweens by optical-flow morph, then
spreads only the leg region for a longer stride. The head is never
duplicated. Scale stays uniform — no squash.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

from .align import alpha_bbox
from .asset_cache import _to_bgra
from .factory_fit import (
    _boot_xs,
    fit_walk_piece,
    normalize_walk_batch,
)

STRIDE_GAIN = 0.16
BOB_PX = 3.0
HIP_FRAC = 0.62
MORPH_MIN_SOURCES = 4


def _load(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"could not read {path}")
    return strip_canvas_frame(_to_bgra(img))


def strip_canvas_frame(src: np.ndarray) -> np.ndarray:
    """Drop a 1px opaque border that makes alpha_bbox the whole canvas."""

    src = _to_bgra(src)
    h, w = src.shape[:2]
    alpha = (src[:, :, 3] > 16).astype(np.uint8)
    num, labels, stats, _centroids = cv2.connectedComponentsWithStats(alpha, connectivity=8)
    out = src.copy()
    for i in range(1, num):
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        area = int(stats[i, cv2.CC_STAT_AREA])
        if bw >= w - 2 and bh >= h - 2 and area < w * h * 0.08:
            out[labels == i] = 0
    return out


def _write(path: Path, bgra: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), bgra):
        raise OSError(f"failed to write {path}")


def _ground(frame: np.ndarray) -> int | None:
    box = alpha_bbox(frame)
    return None if box is None else int(box[3])


def plant_to_ground(frame: np.ndarray, ground_y: int) -> np.ndarray:
    """Translate so the lowest opaque row sits on ``ground_y``. No scale."""

    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return src
    dy = int(ground_y) - int(box[3])
    if dy == 0:
        return src
    out = np.zeros_like(src)
    h, w = src.shape[:2]
    y0 = max(0, dy)
    y1 = min(h, h + dy)
    s0 = max(0, -dy)
    s1 = s0 + (y1 - y0)
    if y1 > y0 and s1 > s0:
        out[y0:y1] = src[s0:s1]
    return out


def morph_frames(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """Optical-flow in-between. ``t=0`` is ``a``, ``t=1`` is ``b``."""

    a = _to_bgra(a)
    b = _to_bgra(b)
    if t <= 0.001:
        return a.copy()
    if t >= 0.999:
        return b.copy()
    a_gray = cv2.cvtColor(a[:, :, :3], cv2.COLOR_BGR2GRAY)
    b_gray = cv2.cvtColor(b[:, :, :3], cv2.COLOR_BGR2GRAY)
    flow_ab = cv2.calcOpticalFlowFarneback(a_gray, b_gray, None, 0.5, 3, 21, 3, 5, 1.1, 0)
    flow_ba = cv2.calcOpticalFlowFarneback(b_gray, a_gray, None, 0.5, 3, 21, 3, 5, 1.1, 0)
    h, w = a.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_a = np.dstack((grid_x + flow_ab[:, :, 0] * t, grid_y + flow_ab[:, :, 1] * t))
    map_b = np.dstack((grid_x + flow_ba[:, :, 0] * (1.0 - t), grid_y + flow_ba[:, :, 1] * (1.0 - t)))
    wa = cv2.remap(a, map_a, None, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    wb = cv2.remap(b, map_b, None, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    out = cv2.addWeighted(wa, 1.0 - t, wb, t, 0)
    return _to_bgra(out)


def long_stride_warp(frame: np.ndarray, amount: float, bob: float) -> np.ndarray:
    """Spread only the legs; bob the torso. Head stays put. Feet re-planted."""

    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return src
    x0, y0, x1, y1 = box
    hip_y = y0 + int((y1 - y0) * HIP_FRAC)
    band = src[y0 : min(y1, hip_y + 1), x0:x1, 3] > 16
    ys, xs = np.where(band)
    hip_x = float(xs.mean() + x0) if xs.size else (x0 + x1) / 2.0
    h, w = src.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    below = np.clip((grid_y - hip_y) / max(1.0, float(y1 - hip_y)), 0.0, 1.0)
    below = below * below
    # Destination-to-source: divide so pixels move *away* from the hip.
    spread = 1.0 + float(amount) * below
    map_x = hip_x + (grid_x - hip_x) / np.maximum(spread, 1e-3)
    above = np.clip((hip_y - grid_y) / max(1.0, float(hip_y - y0)), 0.0, 1.0)
    map_y = grid_y + float(bob) * above
    warped = cv2.remap(
        src,
        map_x.astype(np.float32),
        map_y.astype(np.float32),
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )
    return plant_to_ground(_to_bgra(warped), y1)


def _sample_pair(sources: list[np.ndarray], index: int, count: int) -> tuple[np.ndarray, np.ndarray, float, float]:
    n = len(sources)
    pos = (index / max(1, count)) * n
    a = int(math.floor(pos)) % n
    b = (a + 1) % n
    frac = float(pos - math.floor(pos))
    phase = index / max(1, count)
    return sources[a], sources[b], frac, phase


def _inbetween(a: np.ndarray, b: np.ndarray, frac: float, n_sources: int) -> np.ndarray:
    """Morph adjacent keys when we have a real cycle. Never cross-dissolve two
    opposite contact poses — that ghosts a second body."""

    if n_sources >= MORPH_MIN_SOURCES and 0.08 < frac < 0.92:
        return morph_frames(a, b, frac)
    return a.copy() if frac < 0.5 else b.copy()


def stride_amount(phase: float) -> float:
    # Contact (legs apart) at 0 / 0.5; passing (together) at 0.25 / 0.75.
    return STRIDE_GAIN * abs(math.cos(phase * math.pi * 2.0))


def bob_amount(phase: float) -> float:
    return BOB_PX * (1.0 - math.cos(phase * math.pi * 4.0)) * 0.5


def _foot_xs(frame: np.ndarray) -> list[float]:
    xs = _boot_xs(frame)
    if len(xs) >= 2:
        return xs
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return xs
    x0, y0, x1, y1 = box
    height = max(1, y1 - y0)
    width = max(1, x1 - x0)
    band_y0 = y0 + int(height * 0.88)
    band = np.zeros(src.shape[:2], dtype=np.uint8)
    band[band_y0:y1, x0:x1] = np.where(src[band_y0:y1, x0:x1, 3] > 16, 255, 0)
    num, _labels, stats, centroids = cv2.connectedComponentsWithStats(band, connectivity=8)
    min_area = max(12, int(width * height * 0.004))
    blobs: list[tuple[int, float]] = []
    for i in range(1, num):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        if area < min_area or bw <= 3:
            continue
        blobs.append((area, float(centroids[i][0])))
    blobs.sort(reverse=True)
    if len(blobs) >= 2:
        return [blobs[0][1], blobs[1][1]]
    if blobs:
        return [blobs[0][1]]
    ys, cols = np.where(src[band_y0:y1, x0:x1, 3] > 16)
    if cols.size < 4:
        return xs
    return [float(cols.min() + x0), float(cols.max() + x0)]


def travel_distance(frames: list[np.ndarray]) -> int:
    spreads: list[float] = []
    leads: list[float] = []
    for frame in frames:
        xs = _foot_xs(frame)
        if len(xs) >= 2:
            spreads.append(max(xs) - min(xs))
        if xs:
            leads.append(max(xs))
    spread = float(np.median(spreads)) if spreads else 64.0
    lead_span = float(max(leads) - min(leads)) if len(leads) >= 2 else 0.0
    return max(96, int(round(max(spread * 1.45, lead_span * 2.2))))


def build_long_stride_cycle(
    sources: list[np.ndarray],
    frames: int,
    canvas_w: int,
    canvas_h: int,
    *,
    ref: np.ndarray | None = None,
    torso_ref: np.ndarray | None = None,
) -> tuple[list[np.ndarray], dict]:
    if len(sources) < 2:
        raise ValueError("need at least two walk_side frames")
    count = max(2, int(frames))
    fitted: list[np.ndarray] = []
    problems: list[str] = []
    for src in sources:
        src = strip_canvas_frame(src)
        out, probs = fit_walk_piece(
            src,
            canvas_w,
            canvas_h,
            ref=ref,
            torso_ref=torso_ref,
            extract=False,
            expect_face=None,
            strict=False,
        )
        problems.extend(probs)
        if alpha_bbox(out) is not None:
            fitted.append(out)
    if len(fitted) < 2:
        raise ValueError("; ".join(problems) or "could not fit walk_side sources")
    fitted = normalize_walk_batch(fitted)
    cycle: list[np.ndarray] = []
    for i in range(count):
        a, b, frac, phase = _sample_pair(fitted, i, count)
        blended = _inbetween(a, b, frac, len(fitted))
        warped = long_stride_warp(blended, stride_amount(phase), bob_amount(phase))
        cycle.append(warped)
    cycle = normalize_walk_batch(cycle)
    grounds = [_ground(frame) for frame in cycle]
    grounds_ok = [g for g in grounds if g is not None]
    target = int(round(float(np.median(np.asarray(grounds_ok, dtype=np.float32))))) if grounds_ok else canvas_h - 16
    cycle = [plant_to_ground(frame, target) for frame in cycle]
    info = {
        "ok": True,
        "frames": count,
        "sources": len(fitted),
        "distance_per_cycle": travel_distance(cycle),
        "ground_y": target,
        "problems": list(dict.fromkeys(problems)),
    }
    return cycle, info


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a long-stride walk from walk_side frames.")
    parser.add_argument("--src", type=Path, action="append", dest="sources", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--canvas-w", type=int, default=1024)
    parser.add_argument("--canvas-h", type=int, default=1024)
    parser.add_argument("--ref", type=Path)
    parser.add_argument("--torso-ref", type=Path, dest="torso_ref")
    args = parser.parse_args(argv)
    try:
        sources = [_load(p) for p in args.sources]
        ref = _load(args.ref) if args.ref else None
        torso_ref = _load(args.torso_ref) if args.torso_ref else None
        cycle, info = build_long_stride_cycle(
            sources,
            args.frames,
            args.canvas_w,
            args.canvas_h,
            ref=ref,
            torso_ref=torso_ref,
        )
    except Exception as err:  # noqa: BLE001 — CLI reports any build failure
        print(json.dumps({"ok": False, "error": str(err)}))
        return 1
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for i, frame in enumerate(cycle):
        name = f"cell_{i:02d}.png"
        dest = out_dir / name
        _write(dest, frame)
        written.append({"src": str(dest), "name": name})
    info["written"] = written
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
