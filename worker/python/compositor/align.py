"""Align a cut-out head/mouth/face drawing to an existing default canvas.

Matches hat-top / chin-bottom (alpha bbox height) and neck centre (bottom
band of the bbox) so a newly ingested sheet lands on the same size and
anchor as the previous default drawing. Pads to the reference canvas.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .asset_cache import _to_bgra

ALPHA_MIN = 16
NECK_BAND = 0.15


def alpha_bbox(bgra: np.ndarray, threshold: int = ALPHA_MIN) -> tuple[int, int, int, int] | None:
    alpha = bgra[:, :, 3]
    ys, xs = np.where(alpha > threshold)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def landmarks(bgra: np.ndarray) -> dict:
    h, w = bgra.shape[:2]
    bbox = alpha_bbox(bgra)
    if bbox is None:
        return {
            "hat": (w / 2.0, 0.0),
            "chin": (w / 2.0, float(h)),
            "neck": (w / 2.0, float(h)),
            "bbox": (0, 0, w, h),
            "canvas": (w, h),
        }
    x0, y0, x1, y1 = bbox
    hat = ((x0 + x1) / 2.0, float(y0))
    chin = ((x0 + x1) / 2.0, float(y1))
    band_h = max(1, int(round((y1 - y0) * NECK_BAND)))
    band = bgra[max(y0, y1 - band_h) : y1, x0:x1, 3]
    ys, xs = np.where(band > ALPHA_MIN)
    if xs.size:
        neck = (x0 + float(xs.mean()), float(y1))
    else:
        neck = ((x0 + x1) / 2.0, float(y1))
    return {"hat": hat, "chin": chin, "neck": neck, "bbox": bbox, "canvas": (w, h)}


def align_to_reference(
    src: np.ndarray,
    ref: np.ndarray,
    nudge_x: float = 0.0,
    nudge_y: float = 0.0,
    nudge_scale: float = 1.0,
) -> np.ndarray:
    src = _to_bgra(src)
    ref = _to_bgra(ref)
    sl = landmarks(src)
    rl = landmarks(ref)
    src_h = max(1.0, sl["chin"][1] - sl["hat"][1])
    ref_h = max(1.0, rl["chin"][1] - rl["hat"][1])
    scale = (ref_h / src_h) * (float(nudge_scale) if nudge_scale else 1.0)
    tx = rl["hat"][0] - sl["hat"][0] * scale
    ty = rl["hat"][1] - sl["hat"][1] * scale
    src_neck_x = sl["neck"][0] * scale + tx
    tx += rl["neck"][0] - src_neck_x
    tx += float(nudge_x)
    ty += float(nudge_y)
    out_h, out_w = ref.shape[:2]
    matrix = np.array([[scale, 0.0, tx], [0.0, scale, ty]], dtype=np.float32)
    return cv2.warpAffine(
        src,
        matrix,
        (out_w, out_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )


def align_file(
    src_path: Path,
    ref_path: Path,
    out_path: Path,
    nudge_x: float = 0.0,
    nudge_y: float = 0.0,
    nudge_scale: float = 1.0,
) -> dict:
    src = cv2.imread(str(src_path), cv2.IMREAD_UNCHANGED)
    ref = cv2.imread(str(ref_path), cv2.IMREAD_UNCHANGED)
    if src is None:
        raise FileNotFoundError(f"Could not read source: {src_path}")
    if ref is None:
        raise FileNotFoundError(f"Could not read reference: {ref_path}")
    aligned = align_to_reference(src, ref, nudge_x=nudge_x, nudge_y=nudge_y, nudge_scale=nudge_scale)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(out_path), aligned)
    if not ok:
        raise RuntimeError(f"failed to write aligned PNG: {out_path}")
    return {
        "src": str(src_path),
        "ref": str(ref_path),
        "out": str(out_path),
        "width": int(aligned.shape[1]),
        "height": int(aligned.shape[0]),
        "srcLandmarks": {k: list(v) if isinstance(v, tuple) else v for k, v in landmarks(_to_bgra(src)).items()},
        "refLandmarks": {k: list(v) if isinstance(v, tuple) else v for k, v in landmarks(_to_bgra(ref)).items()},
    }


def align_dirs(
    src_dir: Path,
    ref_dir: Path,
    out_dir: Path,
    names: list[str] | None = None,
    nudge_x: float = 0.0,
    nudge_y: float = 0.0,
    nudge_scale: float = 1.0,
) -> list[dict]:
    results = []
    wanted = {n.lower() for n in names} if names else None
    for src_path in sorted(src_dir.iterdir()):
        if src_path.suffix.lower() != ".png":
            continue
        if wanted is not None and src_path.stem.lower() not in wanted:
            continue
        ref_path = ref_dir / src_path.name
        if not ref_path.exists():
            continue
        out_path = out_dir / src_path.name
        results.append(
            align_file(src_path, ref_path, out_path, nudge_x=nudge_x, nudge_y=nudge_y, nudge_scale=nudge_scale)
        )
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Align a head/mouth drawing to a reference canvas")
    parser.add_argument("--src", type=Path, help="Source PNG")
    parser.add_argument("--ref", type=Path, help="Reference PNG (previous default)")
    parser.add_argument("--out", type=Path, help="Output PNG")
    parser.add_argument("--src-dir", type=Path, dest="src_dir")
    parser.add_argument("--ref-dir", type=Path, dest="ref_dir")
    parser.add_argument("--out-dir", type=Path, dest="out_dir")
    parser.add_argument("--name", action="append", dest="names")
    parser.add_argument("--nudge-x", type=float, default=0.0)
    parser.add_argument("--nudge-y", type=float, default=0.0)
    parser.add_argument("--nudge-scale", type=float, default=1.0)
    args = parser.parse_args(argv)

    try:
        if args.src_dir and args.ref_dir and args.out_dir:
            written = align_dirs(
                args.src_dir,
                args.ref_dir,
                args.out_dir,
                names=args.names,
                nudge_x=args.nudge_x,
                nudge_y=args.nudge_y,
                nudge_scale=args.nudge_scale,
            )
            print(json.dumps({"ok": True, "written": written}))
            return 0
        if args.src and args.ref and args.out:
            result = align_file(
                args.src,
                args.ref,
                args.out,
                nudge_x=args.nudge_x,
                nudge_y=args.nudge_y,
                nudge_scale=args.nudge_scale,
            )
            print(json.dumps({"ok": True, "written": [result]}))
            return 0
        print(json.dumps({"ok": False, "error": "pass --src/--ref/--out or --src-dir/--ref-dir/--out-dir"}))
        return 2
    except Exception as exc:  # noqa: BLE001 — CLI must print JSON
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
