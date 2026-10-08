"""Generates the tiny sample assets used by projects/sample.

Everything here is drawn programmatically with OpenCV/NumPy (simple
shapes, flat colors) so the sample project can be committed without any
binary art assets beyond a handful of very small PNGs/WAV, and so anyone
can regenerate them from scratch.

Run from the repo root:

    worker/python/venv/bin/python worker/python/scripts/generate_sample_assets.py
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
PROJECT_DIR = REPO_ROOT / "projects" / "sample"
ASSETS_DIR = PROJECT_DIR / "assets"

FPS = 24


def _ensure_dirs() -> None:
    for sub in (
        "backgrounds", "characters", "mouths/stuart", "mouths/dana",
        "eyes/stuart", "parts", "audio", "cues",
    ):
        (ASSETS_DIR / sub).mkdir(parents=True, exist_ok=True)


def make_background() -> None:
    """A small (1280x720) two-tone sky/ground background.

    Deliberately NOT the same resolution as the 1920x1080 canvas, to
    exercise the "fit background to canvas" behavior in the compositor.
    """

    w, h = 1280, 720
    img = np.zeros((h, w, 3), dtype=np.uint8)
    horizon = int(h * 0.62)
    img[:horizon] = (235, 180, 120)  # sky (BGR)
    img[horizon:] = (90, 150, 80)    # ground (BGR)
    # A simple sun, and a horizon line, so "fit" cropping is visually obvious.
    cv2.circle(img, (int(w * 0.78), int(h * 0.22)), 70, (140, 220, 250), -1)
    cv2.line(img, (0, horizon), (w, horizon), (60, 110, 60), 4)
    cv2.imwrite(str(ASSETS_DIR / "backgrounds" / "bg.png"), img)


def _rounded_body(width: int, height: int, color_bgr: tuple[int, int, int]) -> np.ndarray:
    """A simple rounded-rectangle "body" shape with a circular head, BGRA."""

    img = np.zeros((height, width, 4), dtype=np.uint8)
    cx = width // 2

    # Torso.
    torso_top = int(height * 0.32)
    cv2.rectangle(img, (int(width * 0.2), torso_top), (int(width * 0.8), height), color_bgr + (255,), -1)
    # Rounded shoulders.
    cv2.ellipse(img, (cx, torso_top), (int(width * 0.3), int(height * 0.08)), 0, 0, 360, color_bgr + (255,), -1)
    # Head.
    head_r = int(width * 0.28)
    head_cy = int(height * 0.2)
    cv2.circle(img, (cx, head_cy), head_r, (220, 200, 180, 255), -1)
    # Simple eyes, for character/orientation (so flip_x is visually checkable).
    eye_y = head_cy - head_r // 6
    cv2.circle(img, (cx - head_r // 2, eye_y), max(2, head_r // 8), (30, 30, 30, 255), -1)
    cv2.circle(img, (cx + head_r // 6, eye_y), max(2, head_r // 8), (30, 30, 30, 255), -1)
    return img


def make_characters() -> None:
    stuart = _rounded_body(360, 760, (90, 70, 200))   # warm red jacket
    dana = _rounded_body(360, 760, (200, 140, 60))    # blue jacket
    cv2.imwrite(str(ASSETS_DIR / "characters" / "stuart_body.png"), stuart)
    cv2.imwrite(str(ASSETS_DIR / "characters" / "dana_body.png"), dana)


def _mouth_image(width: int, height: int, open_amount: float, wide: float) -> np.ndarray:
    """A small transparent-background mouth ellipse. open_amount in [0, 1]."""

    img = np.zeros((height, width, 4), dtype=np.uint8)
    cx, cy = width // 2, height // 2
    ax = int(width * 0.42 * wide)
    ay = max(2, int(height * 0.45 * open_amount))
    cv2.ellipse(img, (cx, cy), (ax, ay), 0, 0, 360, (30, 20, 90, 255), -1)
    if open_amount > 0.1:
        # Teeth hint when open.
        cv2.rectangle(img, (cx - ax // 2, cy - ay // 2), (cx + ax // 2, cy - ay // 4), (230, 230, 230, 255), -1)
    return img


MOUTH_SHAPE_PARAMS = {
    # Rough approximation of Rhubarb's mouth shapes: (open_amount, wide)
    "A": (0.05, 0.9),   # closed
    "B": (0.25, 0.8),
    "C": (0.5, 0.9),
    "D": (0.85, 1.0),
    "E": (0.4, 1.1),
    "F": (0.3, 0.6),
    "G": (0.2, 0.7),
    "H": (0.6, 0.85),
    "X": (0.02, 0.8),   # idle/closed
}


def make_mouths(character: str) -> None:
    for shape, (open_amount, wide) in MOUTH_SHAPE_PARAMS.items():
        img = _mouth_image(140, 100, open_amount, wide)
        cv2.imwrite(str(ASSETS_DIR / "mouths" / character / f"{shape}.png"), img)


def make_eyes(character: str) -> None:
    """A small two-drawing "eyes" slot: open / closed, for a simple blink
    driven by held-until-changed keyframes (not lipsync)."""

    w, h = 160, 60
    open_img = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.circle(open_img, (w // 2 - 36, h // 2), 10, (30, 30, 30, 255), -1)
    cv2.circle(open_img, (w // 2 + 36, h // 2), 10, (30, 30, 30, 255), -1)

    closed_img = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.line(closed_img, (w // 2 - 46, h // 2), (w // 2 - 26, h // 2), (30, 30, 30, 255), 4)
    cv2.line(closed_img, (w // 2 + 26, h // 2), (w // 2 + 46, h // 2), (30, 30, 30, 255), 4)

    cv2.imwrite(str(ASSETS_DIR / "eyes" / character / "open.png"), open_img)
    cv2.imwrite(str(ASSETS_DIR / "eyes" / character / "closed.png"), closed_img)


def make_arm_part() -> None:
    """A simple rig child part (an arm) with two hand-pose drawings baked
    into separate images, demonstrating cut-out rig nesting: the arm is a
    `child` of stuart's layer, and its hand is a `slot` on that child."""

    w, h = 100, 260
    arm = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.rectangle(arm, (int(w * 0.3), 0), (int(w * 0.7), int(h * 0.75)), (90, 70, 200, 255), -1)
    cv2.imwrite(str(ASSETS_DIR / "parts" / "stuart_arm.png"), arm)

    hand_w, hand_h = 90, 90

    fist = np.zeros((hand_h, hand_w, 4), dtype=np.uint8)
    cv2.circle(fist, (hand_w // 2, hand_h // 2), 34, (220, 200, 180, 255), -1)
    cv2.imwrite(str(ASSETS_DIR / "parts" / "stuart_hand_fist.png"), fist)

    open_hand = np.zeros((hand_h, hand_w, 4), dtype=np.uint8)
    cv2.circle(open_hand, (hand_w // 2, hand_h // 2), 30, (220, 200, 180, 255), -1)
    for i in range(4):
        fx = hand_w // 2 - 24 + i * 16
        cv2.rectangle(open_hand, (fx, 2), (fx + 10, 34), (220, 200, 180, 255), -1)
    cv2.imwrite(str(ASSETS_DIR / "parts" / "stuart_hand_open.png"), open_hand)


def make_audio(filename: str, duration_s: float, freq_hz: float = 220.0) -> None:
    """A short, clearly audible tone (not silence) so ffprobe/manual QC can confirm an audio stream exists."""

    sample_rate = 44100
    n_samples = int(duration_s * sample_rate)
    amplitude = 0.3 * 32767
    samples = []
    for i in range(n_samples):
        t = i / sample_rate
        # Gentle fade in/out to avoid clicks, slight vibrato so it doesn't sound like a pure test tone.
        envelope = min(1.0, t / 0.05, (duration_s - t) / 0.05)
        envelope = max(0.0, envelope)
        value = amplitude * envelope * math.sin(2 * math.pi * freq_hz * t + 0.3 * math.sin(2 * math.pi * 4 * t))
        samples.append(int(value))

    path = ASSETS_DIR / "audio" / filename
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(struct.pack("<h", s) for s in samples))


def make_cues(filename: str, duration_s: float) -> None:
    """A hand-authored Rhubarb-style cues JSON spanning duration_s seconds."""

    shapes = ["X", "B", "C", "D", "C", "B", "E", "A", "F", "H", "C", "X"]
    n = len(shapes)
    step = duration_s / n
    cues = []
    for i, shape in enumerate(shapes):
        cues.append({"start": round(i * step, 3), "end": round((i + 1) * step, 3), "value": shape})
    data = {
        "metadata": {"soundFile": "../audio/line1.wav", "duration": duration_s},
        "mouthCues": cues,
    }
    with open(ASSETS_DIR / "cues" / filename, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def main() -> None:
    _ensure_dirs()
    make_background()
    make_characters()
    make_mouths("stuart")
    make_mouths("dana")
    make_eyes("stuart")
    make_arm_part()
    duration_s = 2.5
    make_audio("line1.wav", duration_s=duration_s, freq_hz=220.0)
    make_cues("line1_cues.json", duration_s=duration_s)
    print(f"Sample assets written under {ASSETS_DIR}")


if __name__ == "__main__":
    main()
