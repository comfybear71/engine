"""Bake a multi-segment timeline (many body + head segments) into one shot.

Usage:
    python -m compositor.shot_timeline_bake --spec <specJson> --out-dir <shotDir>

Spec JSON (written by the worker, read from --spec):
    {
      "bodySegments": [
        { "cutDir": "<abs path to a shot's cut/ dir>", "inFrame": 1, "outFrame": 60, "start": 1 },
        ...
      ],
      "headSegments": [
        { "cutDir": "...", "inFrame": 1, "outFrame": 20, "start": 1,
          "anchorX": 0.5, "anchorY": 0.15, "headScale": 1.0 },
        ...
      ],
      "fps": 24
    }

Segments on each track are independent -- a body segment and a head segment
do not need to start, end, or last the same length. At every output frame,
whichever segment covers that frame on each track (if any) is drawn; a frame
with no covering segment on a track simply has nothing from that track.

Outputs JSON on the last stdout line:
    { fps, frameCount, poster, preview }
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


# ── Compositing helpers (mirrors shot_combine.py) ────────────────────

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


def composite_over(base: np.ndarray, overlay: np.ndarray, cx: int, cy: int) -> np.ndarray:
    """Place overlay (BGRA) centred at (cx, cy) on base (BGRA), return BGRA."""
    out = base.copy()
    bh, bw = base.shape[:2]
    oh, ow = overlay.shape[:2]

    ox = cx - ow // 2
    oy = cy - oh // 2

    sx = max(0, -ox)
    sy = max(0, -oy)
    dx = max(0, ox)
    dy = max(0, oy)
    w = min(ow - sx, bw - dx)
    h = min(oh - sy, bh - dy)
    if w <= 0 or h <= 0:
        return out

    overlay_roi = overlay[sy:sy + h, sx:sx + w].astype(np.float32)
    base_roi = out[dy:dy + h, dx:dx + w].astype(np.float32)

    oa = overlay_roi[:, :, 3:4] / 255.0
    ba = base_roi[:, :, 3:4] / 255.0

    out_a = oa + ba * (1.0 - oa)
    safe = out_a > 0.001

    out_rgb = np.where(
        safe,
        (overlay_roi[:, :, :3] * oa + base_roi[:, :, :3] * ba * (1.0 - oa)) / np.where(safe, out_a, 1.0),
        0.0,
    )

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


def load_bgra(path: Path) -> np.ndarray | None:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        img[:, :, 3] = 255
    return img


# ── Segment lookup ────────────────────────────────────────────────────

def segment_length(seg: dict) -> int:
    return max(1, int(seg["outFrame"]) - int(seg["inFrame"]) + 1)


def segment_end(seg: dict) -> int:
    return int(seg["start"]) + segment_length(seg) - 1


def active_segment(segments: list[dict], frame: int) -> dict | None:
    for seg in segments:
        if frame >= int(seg["start"]) and frame <= segment_end(seg):
            return seg
    return None


def source_frame_path(seg: dict, frame: int) -> Path:
    source_frame = int(seg["inFrame"]) + (frame - int(seg["start"]))
    pad = str(source_frame).zfill(4)
    return Path(seg["cutDir"]) / f"f_{pad}.png"


def first_available_frame(segments: list[dict]) -> np.ndarray | None:
    for seg in segments:
        p = source_frame_path(seg, int(seg["start"]))
        img = load_bgra(p)
        if img is not None:
            return img
    return None


def run(spec_path: str, out_dir: str, fps: float = 24.0) -> dict:
    spec = json.loads(Path(spec_path).read_text())
    body_segments = spec.get("bodySegments") or []
    head_segments = spec.get("headSegments") or []
    fps = float(spec.get("fps") or fps)

    if not body_segments and not head_segments:
        raise RuntimeError("No segments to bake")

    total_frames = 1
    for seg in body_segments + head_segments:
        total_frames = max(total_frames, segment_end(seg))

    out = Path(out_dir)
    cut_dir = out / "cut"
    thumb_dir = out / "thumb"
    cut_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    # Canvas size comes from whichever body segment is active first; fall
    # back to a head frame if there is no body track at all.
    reference = first_available_frame(body_segments) if body_segments else None
    if reference is None:
        reference = first_available_frame(head_segments)
    if reference is None:
        raise RuntimeError("Could not read any source frame for this timeline")
    canvas_h, canvas_w = reference.shape[:2]

    THUMB_H = 160
    written = 0

    for frame in range(1, total_frames + 1):
        canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)

        body_seg = active_segment(body_segments, frame)
        if body_seg is not None:
            body_img = load_bgra(source_frame_path(body_seg, frame))
            if body_img is not None:
                if body_img.shape[:2] != (canvas_h, canvas_w):
                    body_img = cv2.resize(body_img, (canvas_w, canvas_h), interpolation=cv2.INTER_AREA)
                canvas = body_img

        head_seg = active_segment(head_segments, frame)
        if head_seg is not None:
            head_img = load_bgra(source_frame_path(head_seg, frame))
            if head_img is not None:
                head_scale = float(head_seg.get("headScale", 1.0))
                if abs(head_scale - 1.0) > 0.01:
                    hh, hw = head_img.shape[:2]
                    new_hw = max(1, int(hw * head_scale))
                    new_hh = max(1, int(hh * head_scale))
                    interp = cv2.INTER_AREA if head_scale < 1.0 else cv2.INTER_LANCZOS4
                    head_img = cv2.resize(head_img, (new_hw, new_hh), interpolation=interp)
                hx, hy, hw, hh = find_content_bbox(head_img)
                head_cropped = head_img[hy:hy + hh, hx:hx + hw]
                cx = int(float(head_seg.get("anchorX", 0.5)) * canvas_w)
                cy = int(float(head_seg.get("anchorY", 0.15)) * canvas_h)
                canvas = composite_over(canvas, head_cropped, cx, cy)

        cut_path = cut_dir / f"f_{frame:04d}.png"
        cv2.imwrite(str(cut_path), canvas)

        on_black = rgba_on_black(canvas)
        h, w = on_black.shape[:2]
        scale = THUMB_H / h
        thumb = cv2.resize(on_black, (int(w * scale), THUMB_H), interpolation=cv2.INTER_AREA)
        thumb_path = thumb_dir / f"f_{frame:04d}.jpg"
        cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        written += 1

    # Poster
    first_cut = cut_dir / "f_0001.png"
    if first_cut.exists():
        first = load_bgra(first_cut)
        if first is not None:
            poster = rgba_on_black(first)
            cv2.imwrite(str(out / "poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Preview video
    preview_dir = out / "_preview_tmp"
    preview_dir.mkdir(exist_ok=True)
    PREVIEW_H = 360
    for i in range(1, written + 1):
        cp = cut_dir / f"f_{i:04d}.png"
        if not cp.exists():
            continue
        img = load_bgra(cp)
        if img is None:
            continue
        on_black = rgba_on_black(img)
        h, w = on_black.shape[:2]
        scale = PREVIEW_H / h
        new_w = int(w * scale)
        new_w = new_w + (new_w % 2)
        resized = cv2.resize(on_black, (new_w, PREVIEW_H), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(preview_dir / f"f_{i:04d}.png"), resized)

    preview_out = str(out / "preview.mp4")
    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(fps),
            "-i", str(preview_dir / "f_%04d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-an",
            preview_out,
        ],
        capture_output=True, text=True,
    )
    shutil.rmtree(str(preview_dir), ignore_errors=True)

    return {
        "fps": fps,
        "frameCount": written,
        "poster": "poster.jpg",
        "preview": "preview.mp4",
    }


def main():
    parser = argparse.ArgumentParser(description="Bake a multi-segment body/head timeline into one shot")
    parser.add_argument("--spec", required=True, help="Path to the timeline spec JSON")
    parser.add_argument("--out-dir", required=True, help="Output shot directory")
    parser.add_argument("--fps", type=float, default=24.0, help="Output FPS (overridden by spec.fps if present)")
    args = parser.parse_args()

    try:
        result = run(spec_path=args.spec, out_dir=args.out_dir, fps=args.fps)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
