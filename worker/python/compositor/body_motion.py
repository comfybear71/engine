"""How a body clip moves up and down, so a head riding on it can follow.

Used by the Head Rig preview (through the worker) and by the timeline bake, so
both place the head from the same numbers.

For each frame of a body clip's `cut/` folder, find the highest visible row in
a narrow strip of columns around the neck (the head's anchor x) and turn it
into a vertical offset: a fraction of the body frame's height, relative to the
middle (median) of the whole clip, lightly smoothed. Positive = the body is
lower than usual on that frame.

Usage:
    python -m compositor.body_motion --cut-dir <shot>/cut --center-x 0.5

Prints JSON on the last stdout line: { "offsets": [...], "frameCount": n }
where offsets[i] belongs to source frame f_(i+1).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import cv2
import numpy as np

BAND_HALF_WIDTH = 0.12
# A row counts as "the top of the body" once this share of the strip is visible there,
# so a stray flapping edge of cape does not set the height.
ROW_COVERAGE = 0.3
ALPHA_THRESHOLD = 10
MAX_OFFSET = 0.12

_FRAME_RE = re.compile(r"^f_(\d+)\.png$")
_memo: dict[tuple[str, int], list[float]] = {}


def _frame_files(cut_dir: Path) -> dict[int, Path]:
    found: dict[int, Path] = {}
    if not cut_dir.is_dir():
        return found
    for path in cut_dir.iterdir():
        match = _FRAME_RE.match(path.name)
        if match:
            found[int(match.group(1))] = path
    return found


def _top_fraction(path: Path, center_x: float) -> float | None:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    height, width = img.shape[:2]
    if img.ndim < 3 or img.shape[2] < 4:
        alpha = np.full((height, width), 255, dtype=np.uint8)
    else:
        alpha = img[:, :, 3]
    x0 = max(0, int(math.floor((center_x - BAND_HALF_WIDTH) * width)))
    x1 = min(width, int(math.ceil((center_x + BAND_HALF_WIDTH) * width)))
    if x1 <= x0:
        return None
    coverage = (alpha[:, x0:x1] > ALPHA_THRESHOLD).mean(axis=1)
    rows = np.nonzero(coverage >= ROW_COVERAGE)[0]
    if rows.size == 0:
        return None
    return float(rows[0]) / float(height)


def _fill_gaps(values: list[float | None]) -> list[float]:
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        return [0.0] * len(values)
    out: list[float] = []
    for i, value in enumerate(values):
        if value is not None:
            out.append(value)
            continue
        nearest = min(known, key=lambda k: abs(k - i))
        out.append(float(values[nearest]))  # type: ignore[arg-type]
    return out


def _smooth(values: list[float]) -> list[float]:
    """Median of 3 (drops a one-frame misread) then mean of 3 (keeps the walking beat)."""
    n = len(values)
    if n < 3:
        return list(values)
    padded = [values[0]] + list(values) + [values[-1]]
    med = [sorted(padded[i:i + 3])[1] for i in range(n)]
    padded = [med[0]] + med + [med[-1]]
    return [sum(padded[i:i + 3]) / 3.0 for i in range(n)]


def offsets_from_tops(tops: list[float | None]) -> list[float]:
    """Smoothed vertical offsets (fractions of the frame height) around the clip's median."""
    filled = _fill_gaps(tops)
    if not filled:
        return []
    smooth = _smooth(filled)
    ordered = sorted(smooth)
    half = len(ordered) // 2
    middle = ordered[half] if len(ordered) % 2 else (ordered[half - 1] + ordered[half]) / 2
    return [round(max(-MAX_OFFSET, min(MAX_OFFSET, v - middle)), 5) for v in smooth]


def compute_offsets(cut_dir: Path, center_x: float) -> list[float]:
    files = _frame_files(cut_dir)
    if not files:
        return []
    last = max(files)
    tops: list[float | None] = [None] * last
    for number, path in files.items():
        tops[number - 1] = _top_fraction(path, center_x)
    return offsets_from_tops(tops)


def _cache_stamp(files: dict[int, Path]) -> list[float]:
    newest = 0.0
    for path in files.values():
        try:
            newest = max(newest, path.stat().st_mtime)
        except OSError:
            pass
    return [float(len(files)), newest]


def neck_percent(center_x: float) -> int:
    """The neck position the measurement is made at, in whole percent and in steps of 5, so nudging
    the head sideways does not re-measure the clip every time."""
    return int(math.floor(min(1.0, max(0.0, center_x)) * 20 + 0.5)) * 5


def offsets_for(cut_dir: str | Path, center_x: float) -> list[float]:
    """Cached offsets for a body clip. The cache lives next to the clip and is rebuilt when its frames change."""
    cut = Path(cut_dir)
    key = (str(cut), neck_percent(center_x))
    hit = _memo.get(key)
    if hit is not None:
        return hit
    files = _frame_files(cut)
    stamp = _cache_stamp(files)
    cache_path = cut.parent / "body_motion.json"
    track_key = f"{key[1] / 100:.2f}"
    cache: dict = {}
    try:
        cache = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    fresh = cache.get("stamp") == stamp
    cached = cache.get("tracks", {}).get(track_key) if fresh else None
    if isinstance(cached, list):
        offsets = [float(v) for v in cached]
    else:
        offsets = compute_offsets(cut, key[1] / 100)
        tracks = dict(cache.get("tracks", {})) if fresh else {}
        tracks[track_key] = offsets
        try:
            cache_path.write_text(json.dumps({"stamp": stamp, "tracks": tracks}))
        except OSError:
            pass
    _memo[key] = offsets
    return offsets


def offset_at(offsets: list[float], source_frame: int) -> float:
    """The offset for a 1-based source frame number; 0 outside the clip."""
    index = int(source_frame) - 1
    if 0 <= index < len(offsets):
        return float(offsets[index])
    return 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description="Vertical motion of a body clip")
    parser.add_argument("--cut-dir", required=True)
    parser.add_argument("--center-x", type=float, default=0.5)
    args = parser.parse_args()
    try:
        offsets = offsets_for(args.cut_dir, min(1.0, max(0.0, args.center_x)))
        print(json.dumps({"offsets": offsets, "frameCount": len(offsets)}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
