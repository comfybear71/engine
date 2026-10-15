"""Capture every frame from a Grok video, key the background, write cut/thumb/preview.

Usage:
    python -m compositor.shot_capture --video source.mp4 --out-dir <shotDir>

Outputs JSON on the last stdout line:
    { fps, frameCount, poster, preview }

Steps:
1. ffmpeg extracts every frame to raw/f_NNNN.png
2. Per frame: detect background from 12px border median (green or black),
   key it out, remove the Grok watermark (bottom-right 110x50).
3. Write cut/ (RGBA png), thumb/ (jpg on black, 160px tall),
   preview.mp4 (on black, 360px tall, H.264, faststart, no audio),
   poster.jpg (frame 1 on black).
4. Write shot.json with frame metadata.
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


# ── Background detection ─────────────────────────────────────────────

def detect_bg_from_border(bgr: np.ndarray, border_px: int = 12) -> str:
    """Detect background colour from the median of a border ring: 'green' or 'black'."""
    h, w = bgr.shape[:2]
    pad = min(border_px, h // 4, w // 4)
    if pad < 2:
        return "black"
    top = bgr[:pad].reshape(-1, 3)
    bot = bgr[-pad:].reshape(-1, 3)
    left = bgr[pad:-pad, :pad].reshape(-1, 3)
    right = bgr[pad:-pad, -pad:].reshape(-1, 3)
    border = np.concatenate([top, bot, left, right]).astype(np.float32)
    med = np.median(border, axis=0)
    b, g, r = float(med[0]), float(med[1]), float(med[2])
    if g > 80 and g > r + 25 and g > b + 25:
        return "green"
    return "black"


# ── Green keying ─────────────────────────────────────────────────────

def key_green(bgr: np.ndarray) -> np.ndarray:
    """HSV chroma-key green pixels → BGRA with alpha."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    # Green hue range ~35-85, sat > 40, val > 30
    mask = ((h >= 35) & (h <= 85) & (s >= 40) & (v >= 30)).astype(np.float32)
    # Soft edge: expand into partial green
    rgb = bgr[:, :, :3].astype(np.float32)
    b_ch, g_ch, r_ch = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    excess = g_ch - np.maximum(r_ch, b_ch)
    soft = np.clip(excess / 80.0, 0, 1)
    alpha = 1.0 - np.maximum(mask, soft)
    alpha = np.clip(alpha, 0, 1)
    out = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    out[:, :, 3] = (alpha * 255).astype(np.uint8)
    return out


def despill_green(bgra: np.ndarray) -> np.ndarray:
    """Remove green fringe on edge pixels: g = min(g, max(r,b)) on partial alpha."""
    out = bgra.copy()
    alpha = out[:, :, 3].astype(np.float32) / 255.0
    edge = (alpha > 0.02) & (alpha < 0.98)
    b, g, r = out[:, :, 0].astype(np.float32), out[:, :, 1].astype(np.float32), out[:, :, 2].astype(np.float32)
    cap = np.maximum(r, b)
    spilled = edge & (g > cap)
    out[:, :, 1] = np.where(spilled, cap.astype(np.uint8), out[:, :, 1])
    return out


# ── Black keying ─────────────────────────────────────────────────────

def key_black(bgr: np.ndarray, v_thresh: int = 28, feather_px: float = 1.5) -> np.ndarray:
    """Flood-fill from border through dark pixels only.

    Dark hair and beard inside the outline stay because the flood only
    reaches dark pixels connected to the border.
    """
    src = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Hard-dark pixels that are candidates for background
    dark = (gray <= v_thresh).astype(np.uint8)

    # Connected components on the dark mask
    num_labels, labels = cv2.connectedComponents(dark, connectivity=8)

    # Find which labels touch the border
    border_labels = set()
    border_labels.update(labels[0].tolist())
    border_labels.update(labels[-1].tolist())
    border_labels.update(labels[:, 0].tolist())
    border_labels.update(labels[:, -1].tolist())
    border_labels.discard(0)

    # Background = dark pixels connected to border
    bg = np.isin(labels, list(border_labels)).astype(np.uint8)

    # Grow into slightly-less-dark fringe (V < 40) but only into dark regions
    soft_dark = (gray <= 40).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    grown = bg.copy()
    for _ in range(3):
        grown = cv2.dilate(grown, k, iterations=1) & soft_dark
    bg = np.maximum(bg, grown)

    # Keep large dark blobs that are NOT connected to the border (e.g. between legs)
    # They are interior holes — fill them in the foreground.
    # (Already handled: they're not in border_labels)

    # Fill holes inside the foreground outline
    fg_mask = (1 - bg).astype(np.uint8)
    contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(fg_mask)
    cv2.drawContours(filled, contours, -1, 1, cv2.FILLED)
    # Where the filled contour says foreground but our mask says background,
    # keep those as foreground (they're interior dark gaps)
    bg = bg & (1 - filled)

    # Feather the edge slightly
    if feather_px > 0:
        alpha_f = (1 - bg).astype(np.float32)
        ksize = int(feather_px * 2 + 1) | 1
        alpha_f = cv2.GaussianBlur(alpha_f, (ksize, ksize), feather_px)
        src[:, :, 3] = (alpha_f * 255).astype(np.uint8)
    else:
        src[:, :, 3] = ((1 - bg) * 255).astype(np.uint8)

    return src


# ── Watermark removal ────────────────────────────────────────────────

def remove_watermark(bgra: np.ndarray) -> np.ndarray:
    """Zero alpha on any blob lying fully inside the bottom-right 110x50 box."""
    h, w = bgra.shape[:2]
    bw, bh = min(110, w), min(50, h)
    roi = bgra[h - bh:h, w - bw:w, 3]
    # Find blobs in the ROI that have nonzero alpha
    binary = (roi > 10).astype(np.uint8)
    num_labels, labels = cv2.connectedComponents(binary, connectivity=8)
    # Remove all blobs that are fully inside the ROI (don't touch any edge of the ROI
    # that is also an edge of the full image — but since the ROI IS the corner,
    # just nuke everything in the ROI that looks like the logo)
    for lbl in range(1, num_labels):
        mask = labels == lbl
        area = int(mask.sum())
        if area < 5:
            continue
        # Check if this blob touches the top or left edge of the ROI
        # (those are interior edges, so blobs touching them might extend outside)
        touches_top = np.any(mask[0, :])
        touches_left = np.any(mask[:, 0])
        if touches_top or touches_left:
            continue
        roi[mask] = 0
    bgra[h - bh:h, w - bw:w, 3] = roi
    return bgra


# ── Frame processing ─────────────────────────────────────────────────

def process_frame(bgr: np.ndarray, bg_hint: str = "") -> np.ndarray:
    """Key the background and remove watermark from a single frame.

    bg_hint: if "green", always use green keying (we told Grok to use
    a green screen, so trust that over border-pixel auto-detection).
    """
    if bg_hint == "green":
        bg_type = "green"
    else:
        bg_type = detect_bg_from_border(bgr)
    if bg_type == "green":
        keyed = despill_green(key_green(bgr))
    else:
        keyed = key_black(bgr)
    keyed = remove_watermark(keyed)
    return keyed


def rgba_on_black(bgra: np.ndarray) -> np.ndarray:
    """Composite BGRA onto black background → BGR."""
    alpha = bgra[:, :, 3:4].astype(np.float32) / 255.0
    rgb = bgra[:, :, :3].astype(np.float32) * alpha
    return rgb.astype(np.uint8)


# ── Main pipeline ────────────────────────────────────────────────────

def run(video_path: str, out_dir: str, name: str = "", prompt: str = "",
        ref_image: str = "", background: str = "", category: str = "") -> dict:
    video = Path(video_path)
    out = Path(out_dir)

    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")

    # Create directories
    raw_dir = out / "raw"
    cut_dir = out / "cut"
    thumb_dir = out / "thumb"
    for d in [raw_dir, cut_dir, thumb_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # 1. Extract every frame with ffmpeg
    pattern = str(raw_dir / "f_%04d.png")
    cmd = ["ffmpeg", "-y", "-i", str(video), "-fps_mode", "passthrough", pattern]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip().split(chr(10))[-1]}")

    # Probe fps
    probe_cmd = [
        "ffprobe", "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "csv=p=0", str(video)
    ]
    probe = subprocess.run(probe_cmd, capture_output=True, text=True)
    fps_str = probe.stdout.strip()
    if "/" in fps_str:
        num, den = fps_str.split("/")
        fps = round(float(num) / float(den), 2)
    else:
        fps = float(fps_str) if fps_str else 24.0

    # Collect raw frames sorted
    raw_frames = sorted(raw_dir.glob("f_*.png"))
    if not raw_frames:
        raise RuntimeError("No frames extracted from video")

    frame_count = len(raw_frames)

    # 2. Process each frame
    THUMB_H = 160
    for i, raw_path in enumerate(raw_frames):
        idx = i + 1
        bgr = cv2.imread(str(raw_path), cv2.IMREAD_COLOR)
        if bgr is None:
            continue

        # Key the frame — pass the background hint so we always green-key
        # when we told Grok to use a green screen
        keyed = process_frame(bgr, bg_hint=background)

        # Write cut (RGBA png)
        cut_path = cut_dir / f"f_{idx:04d}.png"
        cv2.imwrite(str(cut_path), keyed)

        # Write thumb (on black, 160px tall, jpg)
        on_black = rgba_on_black(keyed)
        h, w = on_black.shape[:2]
        scale = THUMB_H / h
        thumb = cv2.resize(on_black, (int(w * scale), THUMB_H), interpolation=cv2.INTER_AREA)
        thumb_path = thumb_dir / f"f_{idx:04d}.jpg"
        cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # 3. Write poster.jpg (frame 1 on black)
    first_cut = cut_dir / "f_0001.png"
    if first_cut.exists():
        first = cv2.imread(str(first_cut), cv2.IMREAD_UNCHANGED)
        poster = rgba_on_black(first)
        cv2.imwrite(str(out / "poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])

    # 4. Write preview.mp4 (on black, 360px tall, H.264, faststart, no audio)
    # First render all cut frames onto black at 360px height
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
        # Ensure even dimensions for H.264
        new_w = new_w + (new_w % 2)
        resized = cv2.resize(on_black, (new_w, PREVIEW_H), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(preview_dir / f"f_{i:04d}.png"), resized)

    preview_pattern = str(preview_dir / "f_%04d.png")
    preview_out = str(out / "preview.mp4")
    preview_cmd = [
        "ffmpeg", "-y", "-framerate", str(fps),
        "-i", preview_pattern,
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an",
        preview_out
    ]
    subprocess.run(preview_cmd, capture_output=True, text=True)

    # Clean up preview temp
    import shutil
    shutil.rmtree(str(preview_dir), ignore_errors=True)

    # 5. Write shot.json
    shot_id = out.name
    shot_info = {
        "id": shot_id,
        "name": name or shot_id,
        "filename": video.name,
        "prompt": prompt,
        "refImage": ref_image,
        "background": background or "auto",
        "fps": fps,
        "frameCount": frame_count,
        "in": 1,
        "out": frame_count,
        "category": category or "other",
        "createdAt": __import__("datetime").datetime.now().isoformat(),
        "status": "ready",
    }
    shot_json_path = out / "shot.json"
    with open(shot_json_path, "w") as f:
        json.dump(shot_info, f, indent=2)

    return {
        "fps": fps,
        "frameCount": frame_count,
        "poster": "poster.jpg",
        "preview": "preview.mp4",
    }


# ── CLI ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Capture frames from a Grok video")
    parser.add_argument("--video", required=True, help="Path to source.mp4")
    parser.add_argument("--out-dir", required=True, help="Output directory for this shot")
    parser.add_argument("--name", default="", help="Shot name")
    parser.add_argument("--prompt", default="", help="Original prompt")
    parser.add_argument("--ref-image", default="", help="Reference image used")
    parser.add_argument("--background", default="", help="Background type hint (green/black)")
    parser.add_argument("--category", default="", help="Category hint")
    args = parser.parse_args()

    try:
        result = run(
            video_path=args.video,
            out_dir=args.out_dir,
            name=args.name,
            prompt=args.prompt,
            ref_image=args.ref_image,
            background=args.background,
            category=args.category,
        )
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
