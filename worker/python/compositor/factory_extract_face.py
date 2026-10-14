"""Cut mouth/eye overlays from talking-head frames and fit Library frames to slots.

No API calls. Mouths classify into Rhubarb visemes A–H plus rest X. Eyes
classify into open / half (squint) / closed (blink) / look L/R / surprised.
Overlays are placed on the blank head-base canvas for that view — never a
full head. Torso/body uses the Import MP4 plant; arms and heads uniform-fit.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .align import alpha_bbox
from .asset_cache import _to_bgra
from .factory_fit import (
    _blit,
    _resize_uniform,
    fit_piece_no_squash,
    keep_on_canvas,
    looks_like_full_head,
)
from .factory_import_mp4 import estimate_yaw, fit_import_body, yaw_to_view

VISEMES = ("X", "A", "B", "C", "D", "E", "F", "G", "H")
EYE_SHAPES = ("closed", "half", "open", "look_left", "look_right", "surprised")
HEAD_OVERLAY_VIEWS = ("front", "left_34", "right_34", "left_side", "right_side")


def _load(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"could not read {path}")
    return img


def _write(path: Path, bgra: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), bgra):
        raise OSError(f"failed to write {path}")


def _head_box(frame: np.ndarray) -> tuple[int, int, int, int]:
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        h, w = src.shape[:2]
        return (0, 0, w, h)
    return box


def _region(frame: np.ndarray, kind: str) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    src = _to_bgra(frame)
    x0, y0, x1, y1 = _head_box(src)
    h = max(1, y1 - y0)
    w = max(1, x1 - x0)
    if kind == "eyes":
        rx0 = x0 + int(w * 0.10)
        rx1 = x0 + int(w * 0.90)
        ry0 = y0 + int(h * 0.18)
        ry1 = y0 + int(h * 0.50)
    else:
        rx0 = x0 + int(w * 0.20)
        rx1 = x0 + int(w * 0.80)
        ry0 = y0 + int(h * 0.50)
        ry1 = y0 + int(h * 0.88)
    rx0, ry0 = max(0, rx0), max(0, ry0)
    rx1, ry1 = min(src.shape[1], max(rx0 + 2, rx1)), min(src.shape[0], max(ry0 + 2, ry1))
    return src[ry0:ry1, rx0:rx1].copy(), (rx0, ry0, rx1, ry1)


def _luma(bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)


def mouth_features(frame: np.ndarray) -> dict:
    roi, box = _region(frame, "mouth")
    bgr = roi[:, :, :3]
    alpha = roi[:, :, 3] if roi.shape[2] == 4 else np.full(roi.shape[:2], 255, dtype=np.uint8)
    opaque = alpha > 16
    gray = _luma(roi)
    b = bgr[:, :, 0].astype(np.float32)
    g = bgr[:, :, 1].astype(np.float32)
    r = bgr[:, :, 2].astype(np.float32)
    ih, iw = gray.shape[:2]
    inner = np.zeros_like(opaque)
    inner[int(ih * 0.18) : max(int(ih * 0.18) + 2, int(ih * 0.86)), int(iw * 0.16) : max(int(iw * 0.16) + 2, int(iw * 0.84))] = True
    cavity = opaque & inner & (gray < 58)
    teeth = opaque & inner & (gray > 175) & (np.abs(r - g) < 28) & (np.abs(g - b) < 28)
    # Pink/magenta blob in the mouth well — not warm skin.
    tongue = (
        opaque
        & inner
        & (r > g + 40)
        & (r > b + 40)
        & (g < 110)
        & (gray < 145)
        & (gray > 35)
    )
    roi_n = max(1, int(np.count_nonzero(opaque)))
    cavity_n = int(np.count_nonzero(cavity))
    ys, xs = np.where(cavity)
    if xs.size:
        cw = int(xs.max() - xs.min() + 1)
        ch = int(ys.max() - ys.min() + 1)
        area = int(xs.size)
    else:
        cw = ch = area = 0
    lip = opaque & (gray < 110) & (gray >= 58)
    lip_ys, _ = np.where(lip)
    lip_h = int(lip_ys.max() - lip_ys.min() + 1) if lip_ys.size else 0
    aspect = (cw / max(1, ch)) if ch else 0.0
    roundness = (min(cw, ch) / max(1, max(cw, ch))) if cw and ch else 0.0
    return {
        "box": box,
        "roi_w": int(roi.shape[1]),
        "roi_h": int(roi.shape[0]),
        "openness": cavity_n / roi_n,
        "cavity_w": cw,
        "cavity_h": ch,
        "cavity_area": area,
        "aspect": float(aspect),
        "roundness": float(roundness),
        "teeth": float(np.count_nonzero(teeth) / roi_n),
        "tongue": float(np.count_nonzero(tongue) / roi_n),
        "lip_h": lip_h,
        "opaque": roi_n,
    }


def classify_viseme(features: dict | None = None, frame: np.ndarray | None = None) -> tuple[str, float, dict]:
    feats = features if features is not None else mouth_features(frame)
    scores = {name: 0.0 for name in VISEMES}
    op = float(feats["openness"])
    ch = int(feats["cavity_h"])
    cw = int(feats["cavity_w"])
    rh = max(1, int(feats["roi_h"]))
    rw = max(1, int(feats["roi_w"]))
    teeth = float(feats["teeth"])
    tongue = float(feats["tongue"])
    roundness = float(feats["roundness"])
    aspect = float(feats["aspect"]) if feats.get("aspect") is not None else (cw / max(1, ch))

    # A shadow field across the lower face is not a mouth.
    spurious = (cw >= rw * 0.60 and ch >= rh * 0.32) or (op >= 0.22 and roundness < 0.62 and aspect > 1.35)
    localized_tongue = 0.015 <= tongue <= 0.40
    if localized_tongue and not spurious:
        scores["H"] = 0.90 + min(0.08, tongue)
    if teeth >= 0.02 and op < 0.35 and not spurious:
        scores["G"] = 0.88 + min(0.08, teeth)

    if spurious:
        scores["X"] = 0.72
    elif ch >= rh * 0.42 or op >= 0.16:
        scores["D"] = 0.86 + min(0.1, op)
    elif roundness >= 0.82 and cw <= rw * 0.28:
        scores["F"] = 0.88
    elif roundness >= 0.78 and cw <= rw * 0.48:
        scores["E"] = 0.86
    elif op < 0.03 and ch <= 4:
        scores["X"] = 0.90
    elif ch <= 14 and aspect >= 1.6:
        if aspect >= 3.0 or (ch <= 10 and op < 0.06):
            scores["A"] = 0.88
        else:
            scores["B"] = 0.88
    elif op < 0.12:
        scores["C"] = 0.82
    else:
        scores["C"] = 0.80

    best = max(scores, key=scores.get)
    return best, float(scores[best]), scores


def classify_eyes(frame: np.ndarray) -> tuple[str, float, dict]:
    roi, box = _region(frame, "eyes")
    bgr = roi[:, :, :3]
    alpha = roi[:, :, 3] if roi.shape[2] == 4 else np.full(roi.shape[:2], 255, dtype=np.uint8)
    opaque = alpha > 16
    gray = _luma(roi)
    white = opaque & (gray > 165)
    dark = opaque & (gray < 70)
    h, w = roi.shape[:2]
    k = np.ones((3, 3), np.uint8)
    near_white = cv2.dilate(white.astype(np.uint8), k, iterations=2) > 0
    iris = dark & near_white
    eye_like = white | dark
    eye_n = max(1, int(np.count_nonzero(eye_like)))
    white_n = int(np.count_nonzero(white))
    white_frac = white_n / eye_n
    dark_frac = float(np.count_nonzero(dark) / max(1, int(np.count_nonzero(opaque))))
    iris_ys, iris_xs = np.where(iris if np.count_nonzero(iris) else dark)
    cx = float(iris_xs.mean()) / max(1, w - 1) if iris_xs.size else 0.5
    eye_ys, _ = np.where(eye_like)
    eye_h = int(eye_ys.max() - eye_ys.min() + 1) if eye_ys.size else 0
    mid = w // 2
    left_white = int(np.count_nonzero(white[:, :mid]))
    right_white = int(np.count_nonzero(white[:, mid:]))

    def _gaze_offset(x0: int, x1: int) -> float:
        _, w_xs = np.where(white[:, x0:x1])
        _, i_xs = np.where(iris[:, x0:x1])
        if w_xs.size == 0 or i_xs.size == 0:
            return 0.0
        return float(i_xs.mean() - w_xs.mean())

    gaze = (_gaze_offset(0, mid) + _gaze_offset(mid, w)) / 2.0
    scores = {name: 0.0 for name in EYE_SHAPES}
    if white_n < 12 and eye_h <= max(5, int(h * 0.18)):
        scores["closed"] = 0.90
    elif white_frac < 0.42 or (white_n >= 12 and eye_h <= h * 0.22):
        scores["half"] = 0.86
    elif white_frac >= 0.62 and eye_h >= h * 0.40:
        scores["surprised"] = 0.88
    elif gaze <= -2.2:
        scores["look_left"] = 0.90
    elif gaze >= 2.2:
        scores["look_right"] = 0.90
    else:
        scores["open"] = 0.84
    # Blink / squint aliases already map to closed / half.
    best = max(scores, key=scores.get)
    extras = {
        "box": box,
        "white_frac": white_frac,
        "dark_frac": dark_frac,
        "cx": cx,
        "eye_h": eye_h,
        "left_white": left_white,
        "right_white": right_white,
    }
    return best, float(scores[best]), {**scores, **extras}


def cut_face_overlay(frame: np.ndarray, kind: str) -> np.ndarray:
    """Keep only the mouth or eyes island on a transparent copy of the frame."""

    src = _to_bgra(frame)
    roi, (x0, y0, x1, y1) = _region(src, kind)
    out = np.zeros_like(src)
    gray = _luma(roi)
    alpha = roi[:, :, 3]
    if kind == "mouth":
        keep = (alpha > 16) & (gray < 200)
        # Drop surrounding skin: keep lips/cavity/teeth/tongue.
        b = roi[:, :, 0].astype(np.float32)
        g = roi[:, :, 1].astype(np.float32)
        r = roi[:, :, 2].astype(np.float32)
        cavity = gray < 58
        teeth = (gray > 175) & (np.abs(r - g) < 28)
        tongue = (r > g + 18) & (r > b + 12)
        lips = (gray < 130) & (r > 70)
        keep = (alpha > 16) & (cavity | teeth | tongue | lips)
    else:
        keep = alpha > 16
        # Drop large skin field; keep whites, lids, irises.
        keep = keep & ((gray > 150) | (gray < 90) | (alpha > 200) & (gray < 160))
    k = np.ones((3, 3), np.uint8)
    keep_u8 = keep.astype(np.uint8)
    keep_u8 = cv2.morphologyEx(keep_u8, cv2.MORPH_CLOSE, k, iterations=1)
    piece = roi.copy()
    piece[keep_u8 == 0, 3] = 0
    out[y0:y1, x0:x1] = piece
    box = alpha_bbox(out)
    if box is None:
        return out
    # Guard: if we accidentally kept most of the head, crop back to the ROI.
    head = _head_box(src)
    head_h = max(1, head[3] - head[1])
    piece_h = box[3] - box[1]
    if piece_h >= head_h * 0.72:
        trimmed = np.zeros_like(out)
        trimmed[y0:y1, x0:x1] = piece
        return trimmed
    return out


def place_on_head_canvas(
    overlay: np.ndarray,
    head_ref: np.ndarray | None,
    canvas_w: int,
    canvas_h: int,
    kind: str = "mouth",
) -> np.ndarray:
    ov = _to_bgra(overlay)
    box = alpha_bbox(ov)
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    if box is None:
        return out
    piece = ov[box[1] : box[3], box[0] : box[2]]
    if head_ref is None:
        return keep_on_canvas(ov, canvas_w, canvas_h)
    href = keep_on_canvas(_to_bgra(head_ref), canvas_w, canvas_h)
    hbox = alpha_bbox(href)
    if hbox is None:
        hbox = (0, 0, canvas_w, canvas_h)
    hx0, hy0, hx1, hy1 = hbox
    hh = max(1, hy1 - hy0)
    hw = max(1, hx1 - hx0)
    if kind == "eyes":
        tx0 = hx0 + int(hw * 0.12)
        tx1 = hx0 + int(hw * 0.88)
        ty0 = hy0 + int(hh * 0.20)
        ty1 = hy0 + int(hh * 0.50)
    else:
        tx0 = hx0 + int(hw * 0.22)
        tx1 = hx0 + int(hw * 0.78)
        ty0 = hy0 + int(hh * 0.52)
        ty1 = hy0 + int(hh * 0.86)
    tw = max(8, tx1 - tx0)
    th = max(8, ty1 - ty0)
    scale = min(tw / max(1, piece.shape[1]), th / max(1, piece.shape[0]), 1.0)
    resized = _resize_uniform(piece, float(scale))
    x = tx0 + (tw - resized.shape[1]) // 2
    y = ty0 + (th - resized.shape[0]) // 2
    _blit(out, resized, x, y)
    return out


def _view_of(frame: np.ndarray, tagged: dict | None) -> str:
    if tagged and tagged.get("view"):
        view = str(tagged["view"])
        if view in HEAD_OVERLAY_VIEWS or view == "back":
            return view if view != "back" else "front"
    yaw = float(tagged["yaw"]) if tagged and tagged.get("yaw") is not None else estimate_yaw(frame, "head")
    view = yaw_to_view(yaw)
    return view if view in HEAD_OVERLAY_VIEWS else "front"


def extract_face_set(
    frames: list[tuple[int, np.ndarray, dict]],
    kind: str,
    head_ref: np.ndarray | None,
    canvas_w: int,
    canvas_h: int,
    out_dir: Path | None = None,
) -> dict:
    """Pick the best frame per viseme/eye shape per view and fit to head_base."""

    kind = "eyes" if kind == "eyes" else "mouth"
    shapes = EYE_SHAPES if kind == "eyes" else VISEMES
    best: dict[tuple[str, str], dict] = {}
    scanned = 0
    for index, img, tagged in frames:
        src = _to_bgra(img)
        if alpha_bbox(src) is None:
            continue
        scanned += 1
        view = _view_of(src, tagged)
        if kind == "eyes":
            shape, score, extra = classify_eyes(src)
        else:
            shape, score, extra = classify_viseme(frame=src)
        key = (view, shape)
        row = best.get(key)
        if row is None or score > row["score"]:
            overlay = cut_face_overlay(src, kind)
            fitted = place_on_head_canvas(overlay, head_ref, canvas_w, canvas_h, kind=kind)
            if looks_like_full_head(fitted, head_ref):
                continue
            best[key] = {
                "view": view,
                "name": shape,
                "score": round(float(score), 3),
                "index": int(index),
                "fitted": fitted,
                "extra": {k: extra[k] for k in extra if k in {"openness", "white_frac", "cx", "tongue", "teeth"}},
            }

    drawings = []
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
    for (view, name), row in sorted(best.items(), key=lambda item: (item[0][0], item[0][1])):
        rel = f"{view}/{name}.png"
        if out_dir is not None:
            _write(out_dir / view / f"{name}.png", row["fitted"])
        drawings.append(
            {
                "view": view,
                "name": name,
                "score": row["score"],
                "index": row["index"],
                "rel": rel,
                "fullHead": False,
            }
        )
    found = {(item["view"], item["name"]) for item in drawings}
    missing = []
    views = sorted({view for view, _name in best} or {"front"})
    for view in views:
        for shape in shapes:
            if (view, shape) not in found:
                missing.append({"view": view, "name": shape})
    info = {
        "ok": True,
        "kind": kind,
        "scanned": scanned,
        "drawings": drawings,
        "missing": missing,
        "shapes": list(shapes),
    }
    if out_dir is not None:
        (out_dir / "extract.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf8")
    return info


def fit_library_slot(
    src: np.ndarray,
    slot: str,
    canvas_w: int,
    canvas_h: int,
    *,
    head_ref: np.ndarray | None = None,
    torso_ref: np.ndarray | None = None,
    legs_ref: np.ndarray | None = None,
    ref: np.ndarray | None = None,
    neck_y: int | None = None,
) -> dict:
    src = _to_bgra(src)
    name = str(slot or "").lower()
    problems: list[str] = []
    warnings: list[str] = []
    overlay = name in {"eyes", "mouth"}
    if overlay:
        working = src
        extracted = looks_like_full_head(src, head_ref)
        if extracted:
            working = cut_face_overlay(src, "eyes" if name == "eyes" else "mouth")
        if looks_like_full_head(working, head_ref):
            warnings.append("looks like a full head (eyes/mouth must be overlays)")
            return {
                "ok": False,
                "error": "Eyes and mouths must be overlays, never full heads.",
                "warnings": warnings,
                "problems": problems,
                "fullHead": True,
                "fitted": None,
            }
        if extracted and head_ref is not None:
            fitted = place_on_head_canvas(working, head_ref, canvas_w, canvas_h, kind=name)
        else:
            fitted = keep_on_canvas(working, canvas_w, canvas_h)
        if looks_like_full_head(fitted, head_ref):
            warnings.append("looks like a full head (eyes/mouth must be overlays)")
            return {
                "ok": False,
                "error": "Eyes and mouths must be overlays, never full heads.",
                "warnings": warnings,
                "problems": problems,
                "fullHead": True,
                "fitted": None,
            }
    elif name in {"torso", "body"}:
        fitted, problems = fit_import_body(
            src,
            canvas_w,
            canvas_h,
            torso_ref=torso_ref,
            legs_ref=legs_ref,
            neck_y=neck_y,
        )
    else:
        fitted = fit_piece_no_squash(src, canvas_w, canvas_h, ref=ref if ref is not None else head_ref)
    return {
        "ok": True,
        "warnings": warnings,
        "problems": problems,
        "fullHead": False,
        "fitted": fitted,
        "width": int(fitted.shape[1]),
        "height": int(fitted.shape[0]),
    }


def _load_frames(frames_dir: Path, index_json: Path | None) -> list[tuple[int, np.ndarray, dict]]:
    tagged_by_index: dict[int, dict] = {}
    if index_json and index_json.exists():
        data = json.loads(index_json.read_text(encoding="utf8"))
        for item in data.get("frames") or []:
            tagged_by_index[int(item.get("index", 0))] = item
    rows = []
    for path in sorted(p for p in frames_dir.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg"}):
        stem = path.stem
        digits = "".join(ch for ch in stem if ch.isdigit())
        index = int(digits) if digits else len(rows)
        rows.append((index, _load(path), tagged_by_index.get(index) or {}))
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract mouth/eye overlays or fit a Library frame to a slot.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract-face")
    ex.add_argument("--frames-dir", type=Path, required=True)
    ex.add_argument("--out-dir", type=Path, required=True)
    ex.add_argument("--kind", choices=("mouth", "eyes"), default="mouth")
    ex.add_argument("--head-ref", type=Path, dest="head_ref")
    ex.add_argument("--canvas-w", type=int, default=1024)
    ex.add_argument("--canvas-h", type=int, default=1024)
    ex.add_argument("--index-json", type=Path, dest="index_json")
    fit = sub.add_parser("fit-slot")
    fit.add_argument("--src", type=Path, required=True)
    fit.add_argument("--out", type=Path, required=True)
    fit.add_argument("--slot", required=True)
    fit.add_argument("--canvas-w", type=int, default=1024)
    fit.add_argument("--canvas-h", type=int, default=1024)
    fit.add_argument("--head-ref", type=Path, dest="head_ref")
    fit.add_argument("--torso-ref", type=Path, dest="torso_ref")
    fit.add_argument("--legs-ref", type=Path, dest="legs_ref")
    fit.add_argument("--ref", type=Path)
    fit.add_argument("--neck-y", type=int)
    fit.add_argument("--check-head", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "extract-face":
            head = _load(args.head_ref) if args.head_ref else None
            frames = _load_frames(args.frames_dir, args.index_json)
            info = extract_face_set(
                frames,
                args.kind,
                head,
                args.canvas_w,
                args.canvas_h,
                out_dir=args.out_dir,
            )
            print(json.dumps({k: v for k, v in info.items() if k != "fitted"}))
            return 0 if info.get("ok") else 1
        src = _load(args.src)
        head = _load(args.head_ref) if args.head_ref else None
        torso = _load(args.torso_ref) if args.torso_ref else None
        legs = _load(args.legs_ref) if args.legs_ref else None
        ref = _load(args.ref) if args.ref else None
        result = fit_library_slot(
            src,
            args.slot,
            args.canvas_w,
            args.canvas_h,
            head_ref=head,
            torso_ref=torso,
            legs_ref=legs,
            ref=ref,
            neck_y=args.neck_y,
        )
        fitted = result.pop("fitted", None)
        if not result.get("ok") or fitted is None:
            print(json.dumps(result))
            return 1
        _write(args.out, fitted)
        result["out"] = str(args.out)
        print(json.dumps(result))
        return 0
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(err)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
