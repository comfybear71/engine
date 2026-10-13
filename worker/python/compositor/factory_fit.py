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
LEGS_TOP_FRAC = 0.42
BOOT_BAND_FRAC = 0.72
BOOT_MIN_FRAC = 0.01


def _resize_uniform(piece: np.ndarray, scale: float) -> np.ndarray:
    h, w = piece.shape[:2]
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(piece, (new_w, new_h), interpolation=interp)


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
    return height > width * 1.15 and top_px > 8 and bot_px > 8


def extract_legs(piece: np.ndarray, top_frac: float = LEGS_TOP_FRAC) -> np.ndarray:
    """Clear the head/torso so only the lower body remains on the same canvas."""

    src = _to_bgra(piece)
    if not looks_like_full_figure(src):
        return src
    box = alpha_bbox(src)
    if box is None:
        return src
    x0, y0, x1, y1 = box
    cut = y0 + int(round((y1 - y0) * float(top_frac)))
    out = src.copy()
    out[: max(cut, 0), :, 3] = 0
    return out


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
    y_head1 = y0 + max(1, int(height * 0.32))
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
) -> list[str]:
    """Reject a walk cell with extra boots or a torso facing the wrong way."""

    problems: list[str] = []
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
    parser.add_argument("--head-ref", type=Path, dest="head_ref")
    parser.add_argument(
        "--extract-legs",
        action="store_true",
        help="Crop a full-figure cell down to the lower body before fitting",
    )
    parser.add_argument(
        "--validate-walk",
        action="store_true",
        help="Flag frames with more than two boots or a mismatched facing",
    )
    parser.add_argument("--expect-face", default="right", help="Expected walk facing (right|left)")
    args = parser.parse_args(argv)

    ref = _load(args.ref) if args.ref else None
    head_ref = _load(args.head_ref) if args.head_ref else None
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
    for src_path, out_path in jobs:
        src = _load(src_path)
        walk_problems: list[str] = []
        if args.validate_walk:
            walk_problems.extend(validate_walk_frame(src, expect_face=args.expect_face))
        if args.extract_legs:
            src = extract_legs(src)
        fitted = fit_piece_no_squash(src, args.canvas_w, args.canvas_h, ref=ref)
        if args.check_head and looks_like_full_head(src, head_ref):
            warnings.append(f"{src_path.name}: looks like a full head (eyes/mouth must be overlays)")
        problems = validate_piece(fitted, args.canvas_w, args.canvas_h)
        problems.extend(walk_problems)
        if walk_problems:
            warnings.append(f"{src_path.name}: {'; '.join(walk_problems)}")
        _write(out_path, fitted)
        written.append(
            {
                "src": str(src_path),
                "out": str(out_path),
                "width": int(fitted.shape[1]),
                "height": int(fitted.shape[0]),
                "problems": problems,
            }
        )

    print(json.dumps({"ok": True, "written": written, "warnings": warnings}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
