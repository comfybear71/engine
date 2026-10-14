"""Mouth/eye viseme classification and overlay fit from talking-head frames."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor.factory_extract_face import (
    VISEMES,
    classify_eyes,
    classify_viseme,
    cut_face_overlay,
    extract_face_set,
    fit_library_slot,
    mouth_features,
    place_on_head_canvas,
)
from compositor.factory_fit import looks_like_full_head


def _head(w: int = 160, h: int = 200) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    cv2.ellipse(img, (w // 2, h // 2 + 4), (w // 2 - 8, h // 2 - 10), 0, 0, 360, (90, 140, 196, 255), -1)
    return img


def _viseme(name: str) -> np.ndarray:
    img = _head()
    cx, cy = 80, 132
    if name == "X":
        cv2.line(img, (cx - 14, cy), (cx + 14, cy), (20, 20, 40, 255), 2)
    elif name == "A":
        cv2.rectangle(img, (cx - 18, cy - 4), (cx + 18, cy + 4), (30, 20, 50, 255), -1)
    elif name == "B":
        cv2.ellipse(img, (cx, cy), (13, 6), 0, 0, 360, (18, 16, 22, 255), -1)
    elif name == "C":
        cv2.ellipse(img, (cx, cy), (16, 11), 0, 0, 360, (18, 16, 22, 255), -1)
    elif name == "D":
        cv2.ellipse(img, (cx, cy), (17, 24), 0, 0, 360, (18, 16, 22, 255), -1)
    elif name == "E":
        cv2.circle(img, (cx, cy), 12, (18, 16, 22, 255), -1)
    elif name == "F":
        cv2.circle(img, (cx, cy), 5, (18, 16, 22, 255), -1)
    elif name == "G":
        cv2.ellipse(img, (cx, cy), (16, 8), 0, 0, 360, (30, 20, 50, 255), -1)
        cv2.rectangle(img, (cx - 13, cy - 4), (cx + 13, cy + 4), (230, 230, 235, 255), -1)
    elif name == "H":
        cv2.ellipse(img, (cx, cy), (14, 12), 0, 0, 360, (18, 16, 22, 255), -1)
        cv2.ellipse(img, (cx, cy + 3), (7, 8), 0, 0, 360, (60, 55, 210, 255), -1)
    return img


def _eyes(name: str) -> np.ndarray:
    img = _head()
    ly, ry, y = 52, 108, 70
    if name == "closed":
        cv2.line(img, (ly - 12, y), (ly + 12, y), (20, 20, 30, 255), 2)
        cv2.line(img, (ry - 12, y), (ry + 12, y), (20, 20, 30, 255), 2)
    elif name == "half":
        for x in (ly, ry):
            cv2.ellipse(img, (x, y), (12, 6), 0, 0, 180, (230, 230, 235, 255), -1)
            cv2.ellipse(img, (x, y), (12, 6), 0, 0, 180, (20, 20, 30, 255), 1)
            cv2.circle(img, (x, y - 1), 3, (20, 20, 30, 255), -1)
    elif name == "open":
        for x in (ly, ry):
            cv2.ellipse(img, (x, y), (13, 9), 0, 0, 360, (235, 235, 240, 255), -1)
            cv2.circle(img, (x, y), 4, (20, 20, 30, 255), -1)
    elif name == "look_left":
        for x in (ly, ry):
            cv2.ellipse(img, (x, y), (13, 9), 0, 0, 360, (235, 235, 240, 255), -1)
            cv2.circle(img, (x - 7, y), 4, (20, 20, 30, 255), -1)
    elif name == "look_right":
        for x in (ly, ry):
            cv2.ellipse(img, (x, y), (13, 9), 0, 0, 360, (235, 235, 240, 255), -1)
            cv2.circle(img, (x + 7, y), 4, (20, 20, 30, 255), -1)
    elif name == "surprised":
        for x in (ly, ry):
            cv2.circle(img, (x, y), 14, (240, 240, 245, 255), -1)
            cv2.circle(img, (x, y), 4, (20, 20, 30, 255), -1)
    return img


def test_classify_visemes_a_through_x():
    found = {}
    for name in VISEMES:
        shape, score, _ = classify_viseme(frame=_viseme(name))
        found[name] = (shape, score)
        assert shape == name, f"{name} classified as {shape} (score {score})"
        assert score > 0.5


def test_classify_eyes_blink_squint_look():
    mapping = {
        "closed": "closed",
        "half": "half",
        "open": "open",
        "look_left": "look_left",
        "look_right": "look_right",
        "surprised": "surprised",
    }
    for src, want in mapping.items():
        shape, score, extra = classify_eyes(_eyes(src))
        assert shape == want, f"{src} classified as {shape} extras={extra}"
        assert score > 0.5


def test_cut_mouth_is_not_a_full_head():
    head = _viseme("D")
    overlay = cut_face_overlay(head, "mouth")
    assert looks_like_full_head(head, head) is True
    assert looks_like_full_head(overlay, head) is False
    box_h = overlay.shape[0]
    # Opaque overlay must sit well below a full-head height.
    ys, xs = np.where(overlay[:, :, 3] > 16)
    assert ys.size > 8
    assert int(ys.max() - ys.min() + 1) < box_h * 0.55


def test_place_on_head_canvas_matches_blank_base():
    head = _head(1024, 1024)
    cv2.ellipse(head, (512, 500), (220, 260), 0, 0, 360, (90, 140, 196, 255), -1)
    mouth = cut_face_overlay(_viseme("C"), "mouth")
    placed = place_on_head_canvas(mouth, head, 1024, 1024, kind="mouth")
    assert placed.shape == (1024, 1024, 4)
    assert looks_like_full_head(placed, head) is False
    ys, xs = np.where(placed[:, :, 3] > 16)
    assert ys.size > 8
    assert ys.mean() > 500


def test_extract_face_set_picks_best_per_viseme(tmp_path: Path):
    frames = []
    for i, name in enumerate(("X", "A", "C", "D", "X", "C")):
        frames.append((i, _viseme(name), {"view": "front", "yaw": 0}))
    info = extract_face_set(frames, "mouth", _head(1024, 1024), 256, 256, out_dir=tmp_path)
    names = {item["name"] for item in info["drawings"]}
    assert {"X", "A", "C", "D"} <= names
    assert (tmp_path / "front" / "C.png").exists()
    # Duplicate C: higher-index equal score may replace, but one C only.
    assert sum(1 for item in info["drawings"] if item["name"] == "C") == 1


def test_fit_talking_head_to_mouth_extracts_overlay():
    src = _viseme("D")
    head = _head(256, 256)
    cv2.ellipse(head, (128, 128), (80, 100), 0, 0, 360, (90, 140, 196, 255), -1)
    result = fit_library_slot(src, "mouth", 256, 256, head_ref=head)
    assert result["ok"] is True
    assert looks_like_full_head(result["fitted"], head) is False


def test_fit_overlay_rejects_uncut_full_head_when_cut_fails_closed():
    # A blank skin oval with no mouth still looks like a head after a weak cut.
    src = _head(200, 240)
    result = fit_library_slot(src, "mouth", 256, 256, head_ref=src)
    # Either extracted to a tiny overlay (ok) or rejected as full head.
    if not result["ok"]:
        assert result["fullHead"] is True
    else:
        assert looks_like_full_head(result["fitted"], src) is False


def test_fit_torso_and_arm_and_existing_overlay():
    torso = np.zeros((180, 100, 4), dtype=np.uint8)
    torso[20:150, 30:70] = (40, 36, 170, 255)
    torso[148:170, 32:48] = (32, 36, 42, 255)
    torso[148:170, 52:68] = (32, 36, 42, 255)
    fitted = fit_library_slot(torso, "torso", 256, 256)
    assert fitted["ok"] is True
    assert fitted["fitted"].shape == (256, 256, 4)

    arm = np.zeros((80, 40, 4), dtype=np.uint8)
    arm[4:76, 12:28] = (176, 92, 48, 255)
    arm_fit = fit_library_slot(arm, "arm", 128, 128)
    assert arm_fit["ok"] is True

    overlay = np.zeros((128, 128, 4), dtype=np.uint8)
    overlay[80:92, 48:80] = (20, 16, 30, 255)
    mouth = fit_library_slot(overlay, "mouth", 128, 128, head_ref=_head(128, 128))
    assert mouth["ok"] is True
    assert mouth["fullHead"] is False


def test_mouth_features_openness_grows():
    closed = mouth_features(_viseme("X"))
    open_c = mouth_features(_viseme("C"))
    wide = mouth_features(_viseme("D"))
    assert closed["openness"] < open_c["openness"] <= wide["openness"] or closed["cavity_h"] < wide["cavity_h"]
