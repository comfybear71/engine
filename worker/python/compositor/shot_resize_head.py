"""Resize head portion of a shot's frames.

Usage:
    python -m compositor.shot_resize_head \
        --shot-dir <shotDir> \
        --neck-y 0.35 \
        --head-scale 0.7

Outputs JSON on the last stdout line:
    { fps, frameCount, poster, preview }

Splits each cut frame at the neck-y position (normalised 0-1 from top),
scales the head portion (above neck-y) by head-scale, and composites
the smaller head back centred on the original X.  Overwrites cut/ and
thumb/ frames in place (backs up originals to _pre_resize/).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def resize_head_frame(bgra: np.ndarray, neck_y: float, head_scale: float) -> np.ndarray:
    """Scale the portion of the frame above neck_y line."""
    h, w = bgra.shape[:2]
    split_row = int(neck_y * h)
    split_row = max(1, min(split_row, h - 1))

    head = bgra[:split_row, :, :]
    body = bgra[split_row:, :, :]

    hh, hw = head.shape[:2]
    new_hh = max(1, int(hh * head_scale))
    new_hw = max(1, int(hw * head_scale))

    interp = cv2.INTER_AREA if head_scale < 1.0 else cv2.INTER_LANCZOS4
    head_scaled = cv2.resize(head, (new_hw, new_hh), interpolation=interp)

    # Create new canvas same size as original
    out = np.zeros_like(bgra)

    # Place scaled head centred horizontally, sitting just above the split line
    x_off = (w - new_hw) // 2
    y_off = split_row - new_hh  # align bottom of head to neck line

    if y_off < 0:
        # Head got bigger and overflows top — crop top of head
        head_scaled = head_scaled[-y_off:, :, :]
        new_hh = head_scaled.shape[0]
        y_off = 0

    # Clip horizontally if needed
    src_x = 0
    dst_x = x_off
    if dst_x < 0:
        src_x = -dst_x
        dst_x = 0
    copy_w = min(new_hw - src_x, w - dst_x)
    copy_h = min(new_hh, h - y_off)

    if copy_w > 0 and copy_h > 0:
        out[y_off:y_off + copy_h, dst_x:dst_x + copy_w] = \
            head_scaled[:copy_h, src_x:src_x + copy_w]

    # Place body unchanged
    body_h = body.shape[0]
    out[split_row:split_row + body_h, :] = body

    return out


def rgba_on_black(bgra: np.ndarray) -> np.ndarray:
    """Composite BGRA onto black background -> BGR."""
    alpha = bgra[:, :, 3:4].astype(np.float32) / 255.0
    rgb = bgra[:, :, :3].astype(np.float32) * alpha
    return rgb.astype(np.uint8)


def run(shot_dir: str, neck_y: float = 0.35, head_scale: float = 0.7,
        fps: float = 24.0) -> dict:
    shot = Path(shot_dir)
    cut_dir = shot / "cut"
    thumb_dir = shot / "thumb"

    frames = sorted(cut_dir.glob("f_*.png"))
    if not frames:
        raise RuntimeError("No cut frames found")

    # Back up originals
    backup = shot / "_pre_resize"
    backup_cut = backup / "cut"
    backup_thumb = backup / "thumb"
    backup_cut.mkdir(parents=True, exist_ok=True)
    backup_thumb.mkdir(parents=True, exist_ok=True)

    for f in frames:
        dst = backup_cut / f.name
        if not dst.exists():
            shutil.copy2(str(f), str(dst))
    for f in thumb_dir.glob("f_*.jpg"):
        dst = backup_thumb / f.name
        if not dst.exists():
            shutil.copy2(str(f), str(dst))

    # Process each frame
    THUMB_H = 160
    frame_count = len(frames)

    for f in frames:
        bgra = cv2.imread(str(f), cv2.IMREAD_UNCHANGED)
        if bgra is None:
            continue
        if bgra.shape[2] == 3:
            bgra = cv2.cvtColor(bgra, cv2.COLOR_BGR2BGRA)
            bgra[:, :, 3] = 255

        result = resize_head_frame(bgra, neck_y, head_scale)
        cv2.imwrite(str(f), result)

        # Update thumb
        on_black = rgba_on_black(result)
        h, w = on_black.shape[:2]
        scale = THUMB_H / h
        thumb = cv2.resize(on_black, (int(w * scale), THUMB_H),
                          interpolation=cv2.INTER_AREA)
        thumb_path = thumb_dir / f.name.replace(".png", ".jpg")
        cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Update poster
    first_cut = cut_dir / "f_0001.png"
    if first_cut.exists():
        first = cv2.imread(str(first_cut), cv2.IMREAD_UNCHANGED)
        poster = rgba_on_black(first)
        cv2.imwrite(str(shot / "poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Rebuild preview.mp4
    preview_dir = shot / "_preview_tmp"
    preview_dir.mkdir(exist_ok=True)
    PREVIEW_H = 360
    for i, f in enumerate(frames, 1):
        cp = cut_dir / f.name
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

    preview_out = str(shot / "preview.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(fps),
        "-i", str(preview_dir / "f_%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an",
        preview_out
    ], capture_output=True, text=True)

    shutil.rmtree(str(preview_dir), ignore_errors=True)

    return {
        "fps": fps,
        "frameCount": frame_count,
        "poster": "poster.jpg",
        "preview": "preview.mp4",
    }


def main():
    parser = argparse.ArgumentParser(description="Resize head in shot frames")
    parser.add_argument("--shot-dir", required=True, help="Shot directory")
    parser.add_argument("--neck-y", type=float, default=0.35,
                        help="Neck position (0-1 from top)")
    parser.add_argument("--head-scale", type=float, default=0.7,
                        help="Head scale factor (< 1 = shrink)")
    parser.add_argument("--fps", type=float, default=24.0, help="Output FPS")
    args = parser.parse_args()

    try:
        result = run(
            shot_dir=args.shot_dir,
            neck_y=args.neck_y,
            head_scale=args.head_scale,
            fps=args.fps,
        )
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
