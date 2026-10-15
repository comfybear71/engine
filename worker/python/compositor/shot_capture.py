"""Capture every frame from a Grok video, key the background, write cut/thumb/preview.

Usage:
    python -m compositor.shot_capture --video source.mp4 --out-dir <shotDir>
    python -m compositor.shot_capture --reprocess --out-dir <shotDir>

Outputs JSON on the last stdout line:
    { fps, frameCount, poster, preview }

Steps (normal capture):
    1. ffmpeg extracts every frame to raw/f_NNNN.png
    2. Per frame: detect background from 12px border median (green or flat
       colour), key it out, remove the Grok watermark (bottom-right 110x50).
    3. Write cut/ (RGBA png), thumb/ (jpg on black, 160px tall),
       preview.mp4 (on black, 360px tall, H.264, faststart, no audio),
       poster.jpg (frame 1 on black).
    4. Write shot.json with frame metadata.

With --reprocess, step 1 (ffmpeg extraction) and the Grok call are skipped
entirely: existing raw/ frames are re-keyed in place and cut/thumb/poster/
preview are rebuilt. Use this to repair shots that were captured with an
older, less robust background keyer -- without burning another Grok
generation.
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

def detect_bg_from_border(bgr: np.ndarray, border_px: int = 12) -> tuple[str, tuple[float, float, float]]:
    """Detect the background colour from the median of a border ring.

    Returns (kind, bgr_color) where kind is "green" (a clear chroma-key
    green) or "flat" (any other near-uniform backdrop colour). Grok very
    often ignores the green-screen instruction and returns a moody, dark
    "cinematic" backdrop that is NOT pure black -- callers must key against
    the *actual* detected colour, not an assumed pure black.
    """
    h, w = bgr.shape[:2]
    pad = min(border_px, h // 4, w // 4)
    if pad < 2:
        return "flat", (0.0, 0.0, 0.0)
    top = bgr[:pad].reshape(-1, 3)
    bot = bgr[-pad:].reshape(-1, 3)
    left = bgr[pad:-pad, :pad].reshape(-1, 3)
    right = bgr[pad:-pad, -pad:].reshape(-1, 3)
    border = np.concatenate([top, bot, left, right]).astype(np.float32)
    med = np.median(border, axis=0)
    b, g, r = float(med[0]), float(med[1]), float(med[2])
    if g > 80 and g > r + 25 and g > b + 25:
        return "green", (b, g, r)
    return "flat", (b, g, r)


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


# ── Flat-colour keying (black, dark grey, moody "cinematic" backdrops) ──

def key_flat(bgr: np.ndarray, bg_color: tuple[float, float, float],
             dist_thresh: float = 34.0, soft_mult: float = 1.7,
             abs_dark_thresh: int = 28, feather_px: float = 1.5) -> np.ndarray:
    """Flood-fill from the border through pixels close to the detected
    background colour -- OR plain dark pixels -- so this keys out any
    near-uniform backdrop (pure black AND Grok's dark "cinematic" grey or
    brown backgrounds), not just colours within `abs_dark_thresh` of pure
    black like the old black-only keyer required.

    Dark hair and beard inside the outline stay because the flood only
    reaches pixels connected to the border; isolated dark regions inside
    the silhouette are filled back in as foreground.
    """
    src = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    diff = bgr.astype(np.float32) - np.array(bg_color, dtype=np.float32)
    dist = np.sqrt((diff ** 2).sum(axis=2))

    # Candidate background: close in colour to the detected backdrop OR
    # just plain dark (keeps old near-pure-black behaviour working even if
    # the sampled median itself skewed lighter than the true corners).
    candidate = ((dist <= dist_thresh) | (gray <= abs_dark_thresh)).astype(np.uint8)

    num_labels, labels = cv2.connectedComponents(candidate, connectivity=8)

    border_labels = set()
    border_labels.update(labels[0].tolist())
    border_labels.update(labels[-1].tolist())
    border_labels.update(labels[:, 0].tolist())
    border_labels.update(labels[:, -1].tolist())
    border_labels.discard(0)

    bg = np.isin(labels, list(border_labels)).astype(np.uint8)

    # Grow into a softer tolerance band -- handles anti-aliased edges and
    # vignette falloff where the backdrop gets slightly lighter/darker away
    # from the sampled border.
    soft_candidate = ((dist <= dist_thresh * soft_mult) | (gray <= abs_dark_thresh + 12)).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    grown = bg.copy()
    for _ in range(4):
        grown = cv2.dilate(grown, k, iterations=1) & soft_candidate
    bg = np.maximum(bg, grown)

    # Fill holes inside the foreground outline: dark hair/beard/shadow that
    # does NOT touch the border stays part of the character (interior dark
    # gaps, e.g. between legs, are also kept as foreground by this step).
    fg_mask = (1 - bg).astype(np.uint8)
    contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(fg_mask)
    cv2.drawContours(filled, contours, -1, 1, cv2.FILLED)
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
        kind, bg_color = "green", None
    else:
        kind, bg_color = detect_bg_from_border(bgr)
    if kind == "green":
        keyed = despill_green(key_green(bgr))
    else:
        keyed = key_flat(bgr, bg_color)
    keyed = remove_watermark(keyed)
    return keyed


def rgba_on_black(bgra: np.ndarray) -> np.ndarray:
    """Composite BGRA onto black background → BGR."""
    alpha = bgra[:, :, 3:4].astype(np.float32) / 255.0
    rgb = bgra[:, :, :3].astype(np.float32) * alpha
    return rgb.astype(np.uint8)


def _process_and_write_frame(bgr: np.ndarray, idx: int, cut_dir: Path, thumb_dir: Path,
                              thumb_h: int = 160, bg_hint: str = "") -> None:
    """Key one raw frame and write its cut/ PNG + thumb/ JPG."""
    keyed = process_frame(bgr, bg_hint=bg_hint)

    cut_path = cut_dir / f"f_{idx:04d}.png"
    cv2.imwrite(str(cut_path), keyed)

    on_black = rgba_on_black(keyed)
    h, w = on_black.shape[:2]
    scale = thumb_h / h
    thumb = cv2.resize(on_black, (int(w * scale), thumb_h), interpolation=cv2.INTER_AREA)
    thumb_path = thumb_dir / f"f_{idx:04d}.jpg"
    cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])


def _write_poster_and_preview(out: Path, cut_dir: Path, frame_count: int, fps: float) -> None:
    """Rebuild poster.jpg (frame 1 on black) and preview.mp4 (all frames on
    black, 360px tall) from whatever is currently in cut_dir."""
    first_cut = cut_dir / "f_0001.png"
    if first_cut.exists():
        first = cv2.imread(str(first_cut), cv2.IMREAD_UNCHANGED)
        poster = rgba_on_black(first)
        cv2.imwrite(str(out / "poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])

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
        preview_out,
    ]
    subprocess.run(preview_cmd, capture_output=True, text=True)

    import shutil
    shutil.rmtree(str(preview_dir), ignore_errors=True)


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
    for i, raw_path in enumerate(raw_frames):
        idx = i + 1
        bgr = cv2.imread(str(raw_path), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        _process_and_write_frame(bgr, idx, cut_dir, thumb_dir, bg_hint=background)

    # 3 + 4. poster.jpg and preview.mp4
    _write_poster_and_preview(out, cut_dir, frame_count, fps)

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


def reprocess(out_dir: str) -> dict:
    """Re-key already-extracted raw/ frames without re-running ffmpeg
    extraction or calling Grok again. Use this to repair shots that were
    captured with an older, less robust background keyer -- the fix in
    key_flat() only helps frames keyed *after* it lands, so existing shots
    need to go through their raw/ frames again to pick it up.
    """
    out = Path(out_dir)
    raw_dir = out / "raw"
    cut_dir = out / "cut"
    thumb_dir = out / "thumb"
    if not raw_dir.exists():
        raise FileNotFoundError(f"No raw/ frames to reprocess in {out}")
    for d in [cut_dir, thumb_dir]:
        d.mkdir(parents=True, exist_ok=True)

    raw_frames = sorted(raw_dir.glob("f_*.png"))
    if not raw_frames:
        raise RuntimeError("No raw frames found to reprocess")

    # Pull fps and the saved background hint (e.g. "green") from shot.json
    shot_json_path = out / "shot.json"
    fps = 24.0
    bg_hint = ""
    if shot_json_path.exists():
        try:
            shot_info = json.loads(shot_json_path.read_text())
            fps = float(shot_info.get("fps") or 24.0)
            bg_hint = str(shot_info.get("background") or "")
        except Exception:
            pass

    frame_count = 0
    for raw_path in raw_frames:
        try:
            idx = int(raw_path.stem.split("_")[-1])
        except ValueError:
            continue
        frame_count = max(frame_count, idx)
        bgr = cv2.imread(str(raw_path), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        _process_and_write_frame(bgr, idx, cut_dir, thumb_dir, bg_hint=bg_hint)

    _write_poster_and_preview(out, cut_dir, frame_count, fps)

    return {
        "fps": fps,
        "frameCount": frame_count,
        "poster": "poster.jpg",
        "preview": "preview.mp4",
    }


# ── CLI ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Capture frames from a Grok video")
    parser.add_argument("--video", default="", help="Path to source.mp4 (not needed with --reprocess)")
    parser.add_argument("--out-dir", required=True, help="Output directory for this shot")
    parser.add_argument("--reprocess", action="store_true",
                         help="Re-key existing raw/ frames instead of extracting from --video")
    parser.add_argument("--name", default="", help="Shot name")
    parser.add_argument("--prompt", default="", help="Original prompt")
    parser.add_argument("--ref-image", default="", help="Reference image used")
    parser.add_argument("--background", default="", help="Background type hint (green/black)")
    parser.add_argument("--category", default="", help="Category hint")
    args = parser.parse_args()

    try:
        if args.reprocess:
            result = reprocess(out_dir=args.out_dir)
        else:
            if not args.video:
                raise ValueError("--video is required unless --reprocess is set")
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
