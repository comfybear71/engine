"""Generates projects/_global_assets: the shared character/background library.

Everything here is drawn programmatically with OpenCV/NumPy, the same way
projects/sample's assets are, so the whole library can be regenerated from
scratch with no binary art dependencies.

Run from the repo root:

    worker/python/venv/bin/python worker/python/scripts/generate_global_assets.py
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
GLOBAL_DIR = REPO_ROOT / "projects" / "_global_assets"

MOUTH_SHAPE_PARAMS = {
    # (open_amount, wide) -- same rough approximation of Rhubarb shapes used
    # by the original sample.
    "A": (0.05, 0.9),
    "B": (0.25, 0.8),
    "C": (0.5, 0.9),
    "D": (0.85, 1.0),
    "E": (0.4, 1.1),
    "F": (0.3, 0.6),
    "G": (0.2, 0.7),
    "H": (0.6, 0.85),
    "X": (0.02, 0.8),
}


def _mkdirs(*paths: Path) -> None:
    for p in paths:
        p.mkdir(parents=True, exist_ok=True)


def _mouth_image(width: int, height: int, open_amount: float, wide: float, color_bgr) -> np.ndarray:
    img = np.zeros((height, width, 4), dtype=np.uint8)
    cx, cy = width // 2, height // 2
    ax = int(width * 0.42 * wide)
    ay = max(2, int(height * 0.45 * open_amount))
    cv2.ellipse(img, (cx, cy), (ax, ay), 0, 0, 360, color_bgr + (255,), -1)
    if open_amount > 0.1:
        cv2.rectangle(img, (cx - ax // 2, cy - ay // 2), (cx + ax // 2, cy - ay // 4), (230, 230, 230, 255), -1)
    return img


def _write_mouth_set(mouth_dir: Path, color_bgr=(30, 20, 90)) -> None:
    _mkdirs(mouth_dir)
    for shape, (open_amount, wide) in MOUTH_SHAPE_PARAMS.items():
        img = _mouth_image(140, 100, open_amount, wide, color_bgr)
        cv2.imwrite(str(mouth_dir / f"{shape}.png"), img)


def _write_eyes_set(eyes_dir: Path, extra: dict[str, tuple] = None) -> None:
    """Writes open.png / closed.png, plus any extra named expressions, each
    a tuple of (eye_color_bgr, angry_brows: bool)."""

    _mkdirs(eyes_dir)
    w, h = 160, 60

    def _eyes(color, angry=False):
        img = np.zeros((h, w, 4), dtype=np.uint8)
        cv2.circle(img, (w // 2 - 36, h // 2), 10, color + (255,), -1)
        cv2.circle(img, (w // 2 + 36, h // 2), 10, color + (255,), -1)
        if angry:
            cv2.line(img, (w // 2 - 50, h // 2 - 18), (w // 2 - 20, h // 2 - 8), (20, 20, 20, 255), 5)
            cv2.line(img, (w // 2 + 50, h // 2 - 18), (w // 2 + 20, h // 2 - 8), (20, 20, 20, 255), 5)
        return img

    def _closed(color):
        img = np.zeros((h, w, 4), dtype=np.uint8)
        cv2.line(img, (w // 2 - 46, h // 2), (w // 2 - 26, h // 2), color + (255,), 4)
        cv2.line(img, (w // 2 + 26, h // 2), (w // 2 + 46, h // 2), color + (255,), 4)
        return img

    cv2.imwrite(str(eyes_dir / "open.png"), _eyes((30, 30, 30)))
    cv2.imwrite(str(eyes_dir / "closed.png"), _closed((30, 30, 30)))
    for name, (color, angry) in (extra or {}).items():
        cv2.imwrite(str(eyes_dir / f"{name}.png"), _eyes(color, angry=angry))


def _rounded_body(width: int, height: int, jacket_bgr) -> np.ndarray:
    img = np.zeros((height, width, 4), dtype=np.uint8)
    cx = width // 2
    torso_top = int(height * 0.32)
    cv2.rectangle(img, (int(width * 0.2), torso_top), (int(width * 0.8), height), jacket_bgr + (255,), -1)
    cv2.ellipse(img, (cx, torso_top), (int(width * 0.3), int(height * 0.08)), 0, 0, 360, jacket_bgr + (255,), -1)
    head_r = int(width * 0.28)
    head_cy = int(height * 0.2)
    cv2.circle(img, (cx, head_cy), head_r, (220, 200, 180, 255), -1)
    return img


def _write_hand_set(hand_dir: Path, skin_bgr=(220, 200, 180)) -> None:
    _mkdirs(hand_dir)
    w, h = 90, 90

    fist = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.circle(fist, (w // 2, h // 2), 34, skin_bgr + (255,), -1)
    cv2.imwrite(str(hand_dir / "fist.png"), fist)

    flat = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.rectangle(flat, (w // 2 - 20, 10), (w // 2 + 20, h - 10), skin_bgr + (255,), -1)
    cv2.circle(flat, (w // 2, h - 10), 20, skin_bgr + (255,), -1)
    cv2.imwrite(str(hand_dir / "flat.png"), flat)

    point = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.circle(point, (w // 2, h - 20), 26, skin_bgr + (255,), -1)
    cv2.rectangle(point, (w // 2 - 8, 0), (w // 2 + 8, h - 20), skin_bgr + (255,), -1)
    cv2.imwrite(str(hand_dir / "point.png"), point)


def _write_arm(parts_dir: Path, jacket_bgr) -> None:
    _mkdirs(parts_dir)
    w, h = 100, 260
    arm = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.rectangle(arm, (int(w * 0.3), 0), (int(w * 0.7), int(h * 0.75)), jacket_bgr + (255,), -1)
    cv2.imwrite(str(parts_dir / "arm.png"), arm)


def build_hicks() -> None:
    char_dir = GLOBAL_DIR / "characters" / "hicks"
    _mkdirs(char_dir)

    cv2.imwrite(str(char_dir / "body.png"), _rounded_body(360, 760, (90, 70, 200)))  # warm red jacket
    _write_mouth_set(char_dir / "mouth")
    _write_eyes_set(char_dir / "eyes", extra={"furious": ((20, 20, 190), True)})  # angry red-tinted eyes
    _write_arm(char_dir / "parts", (90, 70, 200))
    _write_hand_set(char_dir / "right_hand")

    character_json = {
        "id": "hicks",
        "display_name": "Hicks",
        "aliases": ["Hicks"],
        "asset": "body.png",
        "z": 10,
        "default_scale": 1.0,
        "default_flip_x": False,
        "voice_id": None,
        "slots": {
            "mouth": {"offset": {"x": 0, "y": -558}, "drawings_dir": "mouth"},
            "eyes": {"offset": {"x": 0, "y": -624}, "drawings_dir": "eyes", "default_drawing": "open"},
        },
        "children": [
            {
                "id": "right_arm",
                "asset": "parts/arm.png",
                "z": 1,
                "offset": {"x": -170, "y": -480},
                "pivot": "top-center",
                "slots": {
                    "right_hand": {
                        "offset": {"x": 0, "y": 230},
                        "drawings_dir": "right_hand",
                        "default_drawing": "flat",
                    }
                },
            }
        ],
    }
    (char_dir / "character.json").write_text(json.dumps(character_json, indent=2) + "\n")


def build_dana() -> None:
    char_dir = GLOBAL_DIR / "characters" / "dana"
    _mkdirs(char_dir)

    cv2.imwrite(str(char_dir / "body.png"), _rounded_body(360, 760, (200, 140, 60)))  # blue jacket
    _write_mouth_set(char_dir / "mouth", color_bgr=(20, 15, 70))
    _write_eyes_set(char_dir / "eyes")

    character_json = {
        "id": "dana",
        "display_name": "Dana",
        "aliases": ["Dana"],
        "asset": "body.png",
        "z": 10,
        "default_scale": 1.0,
        "default_flip_x": False,
        "voice_id": None,
        "slots": {
            "mouth": {"offset": {"x": 0, "y": -558}, "drawings_dir": "mouth"},
            "eyes": {"offset": {"x": 0, "y": -624}, "drawings_dir": "eyes", "default_drawing": "open"},
        },
        "children": [],
    }
    (char_dir / "character.json").write_text(json.dumps(character_json, indent=2) + "\n")


def _background_image(w: int, h: int, sky_bgr, ground_bgr, decoration) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    horizon = int(h * 0.62)
    img[:horizon] = sky_bgr
    img[horizon:] = ground_bgr
    cv2.line(img, (0, horizon), (w, horizon), tuple(max(0, c - 30) for c in ground_bgr), 4)
    decoration(img, w, h, horizon)
    return img


def build_bedroom() -> None:
    """Small room: marks close together, slightly larger scale (intimate framing)."""

    loc_dir = GLOBAL_DIR / "backgrounds" / "bedroom"
    _mkdirs(loc_dir)

    def decorate(img, w, h, horizon):
        # A window and a bed frame hint, to make "small room" legible.
        cv2.rectangle(img, (int(w * 0.08), int(h * 0.15)), (int(w * 0.28), int(h * 0.45)), (235, 220, 200), -1)
        cv2.rectangle(img, (int(w * 0.08), int(h * 0.15)), (int(w * 0.28), int(h * 0.45)), (120, 100, 90), 6)
        cv2.rectangle(img, (int(w * 0.6), horizon - 10), (int(w * 0.95), horizon + 40), (90, 110, 150), -1)

    bg = _background_image(1280, 720, (210, 190, 170), (150, 170, 190), decorate)
    cv2.imwrite(str(loc_dir / "bg.png"), bg)

    staging = {
        "marks": {
            "centre": {"x": 960, "y": 1080, "scale": 1.15},
            "left": {"x": 800, "y": 1080, "scale": 1.15},
            "right": {"x": 1120, "y": 1080, "scale": 1.15, "flip_x": True},
            "far_left": {"x": 680, "y": 1080, "scale": 1.05},
            "far_right": {"x": 1240, "y": 1080, "scale": 1.05, "flip_x": True},
        },
        "auto_order": ["left", "right", "far_left", "far_right"],
    }
    (loc_dir / "staging.json").write_text(json.dumps(staging, indent=2) + "\n")


def build_corridor() -> None:
    """Big corridor: marks wide apart, smaller scale (characters read as farther away)."""

    loc_dir = GLOBAL_DIR / "backgrounds" / "corridor"
    _mkdirs(loc_dir)

    def decorate(img, w, h, horizon):
        # Receding doorways down the hall, to make "big corridor" legible.
        for i, x_frac in enumerate((0.15, 0.35, 0.65, 0.85)):
            x0 = int(w * x_frac)
            cv2.rectangle(img, (x0, int(horizon - 180)), (x0 + 40, horizon), (100, 90, 80), -1)
        cv2.rectangle(img, (0, horizon - 4), (w, horizon + 4), (80, 70, 60), -1)

    bg = _background_image(1280, 720, (190, 175, 160), (120, 115, 110), decorate)
    cv2.imwrite(str(loc_dir / "bg.png"), bg)

    staging = {
        "marks": {
            "centre": {"x": 960, "y": 1080, "scale": 0.85},
            "left": {"x": 350, "y": 1080, "scale": 0.85},
            "right": {"x": 1570, "y": 1080, "scale": 0.85, "flip_x": True},
            "far_left": {"x": 150, "y": 1080, "scale": 0.75},
            "far_right": {"x": 1770, "y": 1080, "scale": 0.75, "flip_x": True},
        },
        "auto_order": ["left", "right", "far_left", "far_right"],
    }
    (loc_dir / "staging.json").write_text(json.dumps(staging, indent=2) + "\n")


def build_staging_defaults() -> None:
    defaults = {
        "marks": {
            "centre": {"x": 960, "y": 1080, "scale": 1.0},
            "left": {"x": 640, "y": 1080, "scale": 1.0},
            "right": {"x": 1280, "y": 1080, "scale": 1.0, "flip_x": True},
            "off_left": {"x": -200, "y": 1080, "scale": 1.0},
            "off_right": {"x": 2120, "y": 1080, "scale": 1.0, "flip_x": True},
        },
        "auto_order": ["left", "right", "far_left", "far_right"],
    }
    (GLOBAL_DIR / "staging_defaults.json").write_text(json.dumps(defaults, indent=2) + "\n")


def main() -> None:
    _mkdirs(GLOBAL_DIR)
    build_staging_defaults()
    build_bedroom()
    build_corridor()
    build_hicks()
    build_dana()
    print(f"Global asset library written under {GLOBAL_DIR}")


if __name__ == "__main__":
    main()
