"""Combine a body shot and head shot into a new composite shot.

Usage:
    python -m compositor.shot_combine \
        --body-dir <bodyShot>/cut \
        --head-dir <headShot>/cut \
        --out-dir <newShot> \
        --anchor-x 0.5 --anchor-y 0.15 \
        --head-scale 1.0 \
        --body-in 1 --body-out 100 \
        --head-in 1 --head-out 50

Outputs JSON on the last stdout line:
    { fps, frameCount, poster, preview }

The head frames are composited on top of the body frames at the given
anchor point.  If the head shot has fewer frames than the body range,
the head frames loop.  The anchor is in normalised body-frame coords
(0,0 = top-left, 1,1 = bottom-right).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def find_content_bbox(bgra: np.ndarray) -> tuple[int, int, int, int]:
    """Find the bounding box of non-transparent pixels: (x, y, w, h)."""
    alpha = bgra[:, :, 3]
    rows = np.any(alpha > 10, axis=1)
    cols = np.any(alpha > 10, axis=0)
    if not np.any(rows) or not np.any(cols):
        return (0, 0, bgra.shape[1], bgra.shape[0])
    y1, y2 = int(np.argmax(rows)), int(bgra.shape[0] - np.argmax(rows[::-1]))
    x1, x2 = int(np.argmax(cols)), int(bgra.shape[1] - np.argmax(cols[::-1]))
    return (x1, y1, x2 - x1, y2 - y1)


def composite_over(base: np.ndarray, overlay: np.ndarray,
                   cx: int, cy: int) -> np.ndarray:
    """Place overlay (BGRA) centred at (cx, cy) on base (BGRA), return BGRA."""
    out = base.copy()
    bh, bw = base.shape[:2]
    oh, ow = overlay.shape[:2]

    # Position: centre overlay at (cx, cy)
    ox = cx - ow // 2
    oy = cy - oh // 2

    # Clip to base bounds
    sx = max(0, -ox)
    sy = max(0, -oy)
    dx = max(0, ox)
    dy = max(0, oy)
    w = min(ow - sx, bw - dx)
    h = min(oh - sy, bh - dy)
    if w <= 0 or h <= 0:
        return out

    # Alpha composite
    overlay_roi = overlay[sy:sy + h, sx:sx + w].astype(np.float32)
    base_roi = out[dy:dy + h, dx:dx + w].astype(np.float32)

    oa = overlay_roi[:, :, 3:4] / 255.0
    ba = base_roi[:, :, 3:4] / 255.0

    out_a = oa + ba * (1.0 - oa)
    safe = out_a > 0.001

    out_rgb = np.where(safe, (overlay_roi[:, :, :3] * oa +
                              base_roi[:, :, :3] * ba * (1.0 - oa)) / np.where(safe, out_a, 1.0),
                       0.0)

    result = np.zeros_like(base_roi)
    result[:, :, :3] = np.clip(out_rgb, 0, 255)
    result[:, :, 3] = out_a[:, :, 0] * 255.0
    out[dy:dy + h, dx:dx + w] = result.astype(np.uint8)
    return out


def rgba_on_black(bgra: np.ndarray) -> np.ndarray:
    """Composite BGRA onto black background -> BGR."""
    alpha = bgra[:, :, 3:4].astype(np.float32) / 255.0
    rgb = bgra[:, :, :3].astype(np.float32) * alpha
    return rgb.astype(np.uint8)


def run(body_dir: str, head_dir: str, out_dir: str,
        anchor_x: float = 0.5, anchor_y: float = 0.15,
        head_scale: float = 1.0,
        body_in: int = 1, body_out: int = 0,
        head_in: int = 1, head_out: int = 0,
        fps: float = 24.0, name: str = "") -> dict:

    body_path = Path(body_dir)
    head_path = Path(head_dir)
    out = Path(out_dir)

    # Collect body frames
    body_frames = sorted(body_path.glob("f_*.png"))
    if not body_frames:
        raise RuntimeError("No body frames found")

    # Apply in/out range for body
    if body_out <= 0:
        body_out = len(body_frames)
    body_frames = [f for f in body_frames
                   if body_in <= int(f.stem.split("_")[1]) <= body_out]
    if not body_frames:
        raise RuntimeError("No body frames in selected range")

    # Collect head frames
    head_frames = sorted(head_path.glob("f_*.png"))
    if not head_frames:
        raise RuntimeError("No head frames found")

    if head_out <= 0:
        head_out = len(head_frames)
    head_frames = [f for f in head_frames
                   if head_in <= int(f.stem.split("_")[1]) <= head_out]
    if not head_frames:
        raise RuntimeError("No head frames in selected range")

    # Create output dirs
    cut_dir = out / "cut"
    thumb_dir = out / "thumb"
    for d in [cut_dir, thumb_dir]:
        d.mkdir(parents=True, exist_ok=True)

    frame_count = len(body_frames)
    head_count = len(head_frames)

    THUMB_H = 160
    for i, body_file in enumerate(body_frames):
        idx = i + 1
        # Load body frame
        body_bgra = cv2.imread(str(body_file), cv2.IMREAD_UNCHANGED)
        if body_bgra is None:
            continue
        if body_bgra.shape[2] == 3:
            body_bgra = cv2.cvtColor(body_bgra, cv2.COLOR_BGR2BGRA)
            body_bgra[:, :, 3] = 255

        bh, bw = body_bgra.shape[:2]

        # Load head frame (loop if needed)
        head_idx = i % head_count
        head_bgra = cv2.imread(str(head_frames[head_idx]), cv2.IMREAD_UNCHANGED)
        if head_bgra is None:
            # Just use body frame
            combined = body_bgra
        else:
            if head_bgra.shape[2] == 3:
                head_bgra = cv2.cvtColor(head_bgra, cv2.COLOR_BGR2BGRA)
                head_bgra[:, :, 3] = 255

            # Scale head if needed
            if abs(head_scale - 1.0) > 0.01:
                hh, hw = head_bgra.shape[:2]
                new_hw = int(hw * head_scale)
                new_hh = int(hh * head_scale)
                head_bgra = cv2.resize(head_bgra, (new_hw, new_hh),
                                       interpolation=cv2.INTER_AREA if head_scale < 1.0
                                       else cv2.INTER_LANCZOS4)

            # Crop head to its content bounding box
            hx, hy, hw, hh = find_content_bbox(head_bgra)
            head_cropped = head_bgra[hy:hy + hh, hx:hx + hw]

            # Compute anchor position in body frame coords
            cx = int(anchor_x * bw)
            cy = int(anchor_y * bh)

            combined = composite_over(body_bgra, head_cropped, cx, cy)

        # Write cut frame
        cut_path = cut_dir / f"f_{idx:04d}.png"
        cv2.imwrite(str(cut_path), combined)

        # Write thumb
        on_black = rgba_on_black(combined)
        h, w = on_black.shape[:2]
        scale = THUMB_H / h
        thumb = cv2.resize(on_black, (int(w * scale), THUMB_H),
                          interpolation=cv2.INTER_AREA)
        thumb_path = thumb_dir / f"f_{idx:04d}.jpg"
        cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Write poster.jpg
    first_cut = cut_dir / "f_0001.png"
    if first_cut.exists():
        first = cv2.imread(str(first_cut), cv2.IMREAD_UNCHANGED)
        poster = rgba_on_black(first)
        cv2.imwrite(str(out / "poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Write preview.mp4
    preview_dir = out / "_preview_tmp"
    preview_dir.mkdir(exist_ok=True)
    PREVIEW_H = 360
    for i in range(1, frame_count + 1):
        cp = cut_dir / f"f_{i:04d}.png"
        if not cp.exists():
            continue
        img = cv2.imread(str(cp), cv2.IMREAD_UNCHANGED)
        on_black = rgba_on_black(img)
        h, w = on_black.shape[:2]
        scale = PREVIEW_H / h
        new_w = int(w * scale)
        new_w = new_w + (new_w % 2)
        resized = cv2.resize(on_black, (new_w, PREVIEW_H),
                            interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(preview_dir / f"f_{i:04d}.png"), resized)

    preview_out = str(out / "preview.mp4")
    preview_cmd = [
        "ffmpeg", "-y", "-framerate", str(fps),
        "-i", str(preview_dir / "f_%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an",
        preview_out
    ]
    subprocess.run(preview_cmd, capture_output=True, text=True)

    import shutil
    shutil.rmtree(str(preview_dir), ignore_errors=True)

    # Write shot.json
    shot_id = out.name
    shot_info = {
        "id": shot_id,
        "name": name or shot_id,
        "filename": "",
        "prompt": "combined",
        "refImage": "",
        "background": "auto",
        "fps": fps,
        "frameCount": frame_count,
        "in": 1,
        "out": frame_count,
        "category": "other",
        "shotType": "combined",
        "createdAt": __import__("datetime").datetime.now().isoformat(),
        "status": "ready",
    }
    with open(out / "shot.json", "w") as f:
        json.dump(shot_info, f, indent=2)

    return {
        "fps": fps,
        "frameCount": frame_count,
        "poster": "poster.jpg",
        "preview": "preview.mp4",
    }


def main():
    parser = argparse.ArgumentParser(description="Combine head + body shots")
    parser.add_argument("--body-dir", required=True, help="Body shot cut/ directory")
    parser.add_argument("--head-dir", required=True, help="Head shot cut/ directory")
    parser.add_argument("--out-dir", required=True, help="Output shot directory")
    parser.add_argument("--anchor-x", type=float, default=0.5, help="Head X anchor (0-1)")
    parser.add_argument("--anchor-y", type=float, default=0.15, help="Head Y anchor (0-1)")
    parser.add_argument("--head-scale", type=float, default=1.0, help="Head scale factor")
    parser.add_argument("--body-in", type=int, default=1, help="Body in frame")
    parser.add_argument("--body-out", type=int, default=0, help="Body out frame (0=all)")
    parser.add_argument("--head-in", type=int, default=1, help="Head in frame")
    parser.add_argument("--head-out", type=int, default=0, help="Head out frame (0=all)")
    parser.add_argument("--fps", type=float, default=24.0, help="Output FPS")
    parser.add_argument("--name", default="", help="Combined shot name")
    args = parser.parse_args()

    try:
        result = run(
            body_dir=args.body_dir,
            head_dir=args.head_dir,
            out_dir=args.out_dir,
            anchor_x=args.anchor_x,
            anchor_y=args.anchor_y,
            head_scale=args.head_scale,
            body_in=args.body_in,
            body_out=args.body_out,
            head_in=args.head_in,
            head_out=args.head_out,
            fps=args.fps,
            name=args.name,
        )
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
