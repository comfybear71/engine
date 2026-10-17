"""Erase parts of a keyed shot's frames by hand (for example a hand LTX added).

A shot keeps its keyed frames in cut/ and its thumbnails in thumb/. An erase
for frame N is a mask in erase/f_NNNN.png (white = erased). The first time a
frame is erased its untouched keyed picture is copied to cut_orig/, so the
erase can be undone and widened later without losing anything. Re-keying a
shot goes through apply_to_fresh(), so an erase survives it.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

ERASE_DIR = "erase"
ORIG_DIR = "cut_orig"
THUMB_H = 160


def _name(idx: int, ext: str = "png") -> str:
    return f"f_{idx:04d}.{ext}"


def read_mask(path: Path, width: int, height: int) -> np.ndarray | None:
    """The erase mask as 0/255 at the frame's size, or None when there is none or it is empty."""
    if not path.exists():
        return None
    mask = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return None
    if mask.shape[:2] != (height, width):
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    return mask if int(mask.max()) > 0 else None


def apply_mask(bgra: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Make the masked area transparent. Colours are never changed, only alpha."""
    out = bgra.copy()
    keep = (255 - mask.astype(np.uint16))
    out[:, :, 3] = ((out[:, :, 3].astype(np.uint16) * keep) // 255).astype(np.uint8)
    return out


def _write_frame(out: Path, idx: int, bgra: np.ndarray) -> None:
    from compositor.shot_capture import rgba_on_black

    cv2.imwrite(str(out / "cut" / _name(idx)), bgra)
    on_black = rgba_on_black(bgra)
    h, w = on_black.shape[:2]
    thumb = cv2.resize(on_black, (max(1, int(w * THUMB_H / h)), THUMB_H), interpolation=cv2.INTER_AREA)
    thumb_dir = out / "thumb"
    thumb_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(thumb_dir / _name(idx, "jpg")), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])


def apply_to_fresh(keyed: np.ndarray, out: Path, idx: int) -> np.ndarray:
    """For a freshly keyed frame: keep the unerased picture aside and return it with any saved erase applied."""
    mask = read_mask(out / ERASE_DIR / _name(idx), keyed.shape[1], keyed.shape[0])
    if mask is None:
        return keyed
    orig = out / ORIG_DIR
    orig.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(orig / _name(idx)), keyed)
    return apply_mask(keyed, mask)


def restore_frame(out: Path, idx: int) -> bool:
    """Put the frame back as keyed. True when there was an erase to undo."""
    mask_path = out / ERASE_DIR / _name(idx)
    orig_path = out / ORIG_DIR / _name(idx)
    had = mask_path.exists() or orig_path.exists()
    if orig_path.exists():
        original = cv2.imread(str(orig_path), cv2.IMREAD_UNCHANGED)
        if original is not None:
            _write_frame(out, idx, original)
        orig_path.unlink()
    mask_path.unlink(missing_ok=True)
    return had


def apply_frame(out: Path, idx: int) -> str:
    """Apply the saved mask for one frame. Returns "erased" or "restored" (an empty mask puts the frame back)."""
    cut_path = out / "cut" / _name(idx)
    mask_path = out / ERASE_DIR / _name(idx)
    orig_path = out / ORIG_DIR / _name(idx)
    base_path = orig_path if orig_path.exists() else cut_path
    base = cv2.imread(str(base_path), cv2.IMREAD_UNCHANGED)
    if base is None:
        raise FileNotFoundError(f"No keyed frame {idx} in {out}")
    if base.ndim != 3 or base.shape[2] != 4:
        raise ValueError(f"Frame {idx} has no alpha channel")
    mask = read_mask(mask_path, base.shape[1], base.shape[0])
    if mask is None:
        restore_frame(out, idx)
        return "restored"
    if not orig_path.exists():
        (out / ORIG_DIR).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cut_path, orig_path)
    _write_frame(out, idx, apply_mask(base, mask))
    return "erased"


def erased_frames(out: Path) -> list[int]:
    folder = out / ERASE_DIR
    found: list[int] = []
    if folder.exists():
        for path in folder.glob("f_*.png"):
            try:
                found.append(int(path.stem.split("_")[-1]))
            except ValueError:
                continue
    return sorted(found)


def refresh_poster_and_preview(out: Path) -> None:
    from compositor.shot_capture import _write_poster_and_preview

    cut_dir = out / "cut"
    numbers = [int(p.stem.split("_")[-1]) for p in cut_dir.glob("f_*.png")]
    if not numbers:
        return
    fps = 24.0
    info = out / "shot.json"
    if info.exists():
        try:
            fps = float(json.loads(info.read_text()).get("fps") or 24.0)
        except Exception:
            pass
    _write_poster_and_preview(out, cut_dir, max(numbers), fps)


def _parse_frames(text: str) -> list[int]:
    return sorted({int(part) for part in text.split(",") if part.strip()})


def _main() -> None:
    parser = argparse.ArgumentParser(description="Erase parts of a shot's frames")
    parser.add_argument("command", choices=["apply", "restore", "list"])
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--frames", default="", help="Comma-separated frame numbers (restore: omit for all)")
    parser.add_argument("--no-preview", action="store_true")
    args = parser.parse_args()
    out = Path(args.out_dir)
    try:
        if args.command == "list":
            print(json.dumps({"frames": erased_frames(out)}))
            return
        if args.command == "apply":
            frames = _parse_frames(args.frames)
            results = {str(idx): apply_frame(out, idx) for idx in frames}
        else:
            frames = _parse_frames(args.frames) if args.frames else sorted(
                set(erased_frames(out)) | {int(p.stem.split("_")[-1]) for p in (out / ORIG_DIR).glob("f_*.png")}
            )
            results = {str(idx): ("restored" if restore_frame(out, idx) else "unchanged") for idx in frames}
        if not args.no_preview:
            refresh_poster_and_preview(out)
        print(json.dumps({"ok": True, "frames": results, "erased": erased_frames(out)}))
    except Exception as err:  # noqa: BLE001 - reported to the caller as JSON
        print(json.dumps({"error": str(err)}))
        sys.exit(1)


if __name__ == "__main__":
    _main()
