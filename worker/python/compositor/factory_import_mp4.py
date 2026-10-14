"""Import an outside walk MP4 into Factory: key, pick a gait cycle, fit the rig.

No API calls. Frames are extracted by the Node worker; this module analyses
them, keys black or green, drops stray islands, and plants a headless body
on the rig canvas so the character's one head can sit on the collar.
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
from .cutout import despill, key_green, remove_stray_islands
from .factory_fit import (
    _blit,
    _boot_xs,
    _resize_uniform,
    count_boots,
    count_figures,
    facing_direction,
    rig_ground_and_height,
)
from .factory_walk_rig import plant_to_ground, travel_distance

HARD_BG = 10
LUMA_BG = 22
EDGE_PROTECT = 2
THUMB_H = 72
MIN_CYCLE = 8


def _load(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"could not read {path}")
    return img


def detect_background(frames: list[np.ndarray]) -> str:
    """'green' if the border is chroma green, else 'black'."""

    sample = frames[min(len(frames) // 2, len(frames) - 1)] if frames else None
    if sample is None:
        return "black"
    bgr = sample[:, :, :3]
    h, w = bgr.shape[:2]
    pad = max(2, min(8, h // 20, w // 20))
    border = np.concatenate(
        [bgr[:pad].reshape(-1, 3), bgr[-pad:].reshape(-1, 3), bgr[:, :pad].reshape(-1, 3), bgr[:, -pad:].reshape(-1, 3)]
    )
    med = np.median(border.astype(np.float32), axis=0)
    b, g, r = (float(x) for x in med)
    if g > 80 and g > r + 25 and g > b + 25:
        return "green"
    return "black"


def key_black(bgr: np.ndarray, luma_max: int = LUMA_BG, protect: int = EDGE_PROTECT) -> np.ndarray:
    """Luma-key a black field. Keep dark outlines and boots on the figure."""

    src = _to_bgra(bgr)
    gray = cv2.cvtColor(src[:, :, :3], cv2.COLOR_BGR2GRAY)
    hard = (gray <= HARD_BG).astype(np.uint8)
    num, labels = cv2.connectedComponents(hard, connectivity=8)
    border = set()
    border.update(labels[0].tolist())
    border.update(labels[-1].tolist())
    border.update(labels[:, 0].tolist())
    border.update(labels[:, -1].tolist())
    border.discard(0)
    bg = np.isin(labels, list(border)).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    soft = (gray <= int(luma_max)).astype(np.uint8)
    # Grow only into near-black fringe, not into mid-grey clothes/boots.
    grown = bg.copy()
    for _ in range(2):
        grown = cv2.dilate(grown, k, iterations=1) & soft
    bg = grown
    # Edge-safe: pixels next to the real figure stay, so dark outlines remain.
    fg = (gray > int(luma_max)).astype(np.uint8)
    if int(protect) > 0:
        near_fg = cv2.dilate(fg, k, iterations=int(protect))
        bg = bg & (1 - near_fg)
    out = src.copy()
    out[bg > 0, 3] = 0
    return out


def key_frame(bgr: np.ndarray, background: str | None = None) -> np.ndarray:
    kind = background or detect_background([bgr])
    if kind == "green":
        keyed = despill(key_green(bgr))
    else:
        keyed = key_black(bgr)
    return remove_stray_islands(_to_bgra(keyed))


def _row_width(alpha: np.ndarray, frac: float) -> int:
    h = alpha.shape[0]
    y = int(np.clip(round(frac * (h - 1)), 0, h - 1))
    xs = np.where(alpha[y] > 16)[0]
    if xs.size < 2:
        return int(xs.size)
    return int(xs.max() - xs.min() + 1)


def looks_like_has_head(frame: np.ndarray) -> bool:
    """True when the top of the silhouette is a distinct, narrower head blob."""

    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return False
    x0, y0, x1, y1 = box
    crop = src[y0:y1, x0:x1, 3]
    h = max(1, y1 - y0)
    if h < 40:
        return False
    top_w = _row_width(crop, 0.08)
    chest_w = _row_width(crop, 0.38)
    if top_w < 6 or chest_w < 8:
        return False
    # Head is clearly narrower than the chest/cape.
    return chest_w > top_w * 1.45 and top_w < crop.shape[1] * 0.55


def _foot_span(frame: np.ndarray) -> float:
    xs = _boot_xs(frame)
    if len(xs) >= 2:
        return float(max(xs) - min(xs))
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return 0.0
    return float(max(8, (box[2] - box[0]) * 0.35))


def frame_features(frame: np.ndarray, keyed: np.ndarray | None = None) -> dict:
    src = keyed if keyed is not None else key_frame(frame)
    box = alpha_bbox(src)
    if box is None:
        return {
            "empty": True,
            "h": 0,
            "w": 0,
            "cx": 0.0,
            "foot_span": 0.0,
            "blobs": 0,
            "boots": 0,
            "has_head": False,
            "area": 0,
        }
    x0, y0, x1, y1 = box
    return {
        "empty": False,
        "h": int(y1 - y0),
        "w": int(x1 - x0),
        "cx": (x0 + x1) / 2.0,
        "foot_span": _foot_span(src),
        "blobs": int(count_figures(src)),
        "boots": int(count_boots(src)),
        "has_head": bool(looks_like_has_head(src)),
        "area": int(np.count_nonzero(src[:, :, 3] > 16)),
    }


def _autocorr_period(values: list[float]) -> int:
    arr = np.asarray(values, dtype=np.float32)
    if arr.size < MIN_CYCLE * 2:
        return max(MIN_CYCLE, arr.size // 2 or MIN_CYCLE)
    arr = arr - float(arr.mean())
    if float(np.std(arr)) < 1e-3:
        return max(MIN_CYCLE, arr.size // 3)
    spec = np.fft.rfft(arr)
    mag = np.abs(spec)
    mag[0] = 0
    peak = int(np.argmax(mag))
    if peak <= 0:
        return max(MIN_CYCLE, arr.size // 3)
    period = int(round(arr.size / peak))
    return int(np.clip(period, MIN_CYCLE, max(MIN_CYCLE, arr.size // 2)))


def detect_steady_section(features: list[dict]) -> tuple[int, int]:
    """Skip intro stand/turn; return [start, end) of the usable walk."""

    n = len(features)
    if n < MIN_CYCLE:
        return 0, n
    heights = np.array([max(1, f["h"]) for f in features], dtype=np.float32)
    spans = np.array([f["foot_span"] for f in features], dtype=np.float32)
    areas = np.array([max(1, f["area"]) for f in features], dtype=np.float32)
    motion = np.zeros(n, dtype=np.float32)
    motion[1:] = np.abs(np.diff(spans)) + np.abs(np.diff(heights)) * 0.25
    # Standing / turning: little stride variation or unstable height.
    med_h = float(np.median(heights))
    stable = (np.abs(heights - med_h) / max(1.0, med_h) < 0.18) & (areas > np.median(areas) * 0.35)
    best = (0, n)
    best_score = -1.0
    window = max(MIN_CYCLE * 2, min(n, 48))
    step = max(1, window // 6)
    for start in range(0, max(1, n - window + 1), step):
        end = min(n, start + max(window, n // 3))
        if end - start < MIN_CYCLE:
            continue
        sl = slice(start, end)
        if float(np.mean(stable[sl])) < 0.55:
            continue
        span_std = float(np.std(spans[sl]))
        mot = float(np.mean(motion[sl]))
        # Prefer later windows (skip the intro) with real stride variation.
        score = span_std * 1.4 + mot * 0.6 + start * 0.02
        if span_std < 1.5 and mot < 1.0:
            score *= 0.2
        if score > best_score:
            best_score = score
            best = (start, end)
    start, end = best
    # Trim a short standing run at the front of the window.
    while start < end - MIN_CYCLE and motion[start] < 0.6 and spans[start] < max(8.0, float(np.median(spans[start:end])) * 0.72):
        start += 1
    return start, end


def score_key(features: list[dict], index: int) -> float:
    f = features[index]
    if f["empty"]:
        return -100.0
    score = 0.0
    if f["blobs"] == 1:
        score += 6.0
    else:
        score -= 4.0 * max(0, f["blobs"] - 1)
    if f["boots"] == 2:
        score += 3.0
    elif f["boots"] > 2:
        score -= 3.0 * (f["boots"] - 2)
    if f["has_head"]:
        score -= 2.5
    # Prefer silhouettes close to the section median (stable scale).
    hs = [item["h"] for item in features if not item["empty"]]
    if hs:
        score -= abs(f["h"] - float(np.median(hs))) / max(8.0, float(np.median(hs))) * 4.0
    return score


def suggest_keys(features: list[dict], start: int, end: int, counts: tuple[int, ...] = (8, 12, 16)) -> dict[str, list[int]]:
    section = features[start:end]
    spans = [f["foot_span"] for f in section]
    period = _autocorr_period(spans)
    # One gait cycle inside the steady section; prefer the second cycle if present.
    cycle_start = start
    if end - start >= period * 2:
        cycle_start = start + period
    cycle_end = min(end, cycle_start + period)
    if cycle_end - cycle_start < MIN_CYCLE:
        cycle_start, cycle_end = start, min(end, start + max(MIN_CYCLE, period))
    out: dict[str, list[int]] = {}
    length = max(1, cycle_end - cycle_start)
    for count in counts:
        picks: list[int] = []
        for i in range(count):
            center = cycle_start + int(round((i / count) * length))
            center = min(cycle_end - 1, max(cycle_start, center))
            window = range(max(cycle_start, center - 2), min(cycle_end, center + 3))
            best = max(window, key=lambda idx: score_key(features, idx) - abs(idx - center) * 0.15)
            if best not in picks:
                picks.append(best)
            else:
                # Nudge to a neighbour so we keep `count` unique frames when possible.
                for alt in list(window) + list(range(cycle_start, cycle_end)):
                    if alt not in picks:
                        picks.append(alt)
                        break
        picks.sort()
        out[str(count)] = picks[:count]
    out["cycle"] = [cycle_start, cycle_end]
    out["period"] = period
    return out


def loop_closure(features: list[dict], indices: list[int]) -> float:
    if len(indices) < 2:
        return 0.0
    a = features[indices[0]]
    b = features[indices[-1]]
    if a["empty"] or b["empty"]:
        return 0.0
    dh = abs(a["h"] - b["h"]) / max(1.0, (a["h"] + b["h"]) / 2.0)
    ds = abs(a["foot_span"] - b["foot_span"]) / max(8.0, (a["foot_span"] + b["foot_span"]) / 2.0)
    return float(max(0.0, 1.0 - dh - ds * 0.5))


def fit_import_body(
    src: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    *,
    torso_ref: np.ndarray | None = None,
    legs_ref: np.ndarray | None = None,
    neck_y: int | None = None,
) -> tuple[np.ndarray, list[str]]:
    """Scale a (usually headless) body to the rig, plant feet, put collar at neck."""

    src = _to_bgra(src)
    problems: list[str] = []
    box = alpha_bbox(src)
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    if box is None:
        return out, ["blank drawing"]
    if count_figures(src) > 1:
        problems.append("extra figures")
    if looks_like_has_head(src):
        problems.append("video has a head — rig already adds one")
    x0, y0, x1, y1 = box
    piece = src[y0:y1, x0:x1]
    ph, pw = piece.shape[:2]
    ground, fig_h = rig_ground_and_height(torso_ref, legs_ref, canvas_h)
    neck = int(neck_y) if neck_y is not None else int(ground - fig_h * 0.38)
    target_h = max(24, int(ground - neck + 12))
    inner_w = max(1, canvas_w - 16)
    inner_h = max(1, canvas_h - 16)
    scale = min(target_h / max(1, ph), inner_w / max(1, pw), inner_h / max(1, ph))
    resized = _resize_uniform(piece, float(scale))
    rh, rw = resized.shape[:2]
    x = int(round(canvas_w / 2.0 - rw / 2.0))
    y = int(round(ground - rh))
    x = max(0, min(x, canvas_w - rw))
    y = max(0, min(y, canvas_h - rh))
    _blit(out, resized, x, y)
    out = plant_to_ground(out, ground)
    # After planting, shift so the collar (top) sits on the neck when possible.
    fitted = alpha_bbox(out)
    if fitted is not None:
        top = fitted[1]
        dy = int(neck) - int(top)
        if abs(dy) > 2 and abs(dy) < canvas_h * 0.25:
            # Keep feet on the ground: only ease toward the neck, don't lift feet.
            if dy > 0:
                out = plant_to_ground(out, ground)
            else:
                shifted = np.zeros_like(out)
                h = out.shape[0]
                y0s = max(0, dy)
                y1s = min(h, h + dy)
                s0 = max(0, -dy)
                s1 = s0 + (y1s - y0s)
                if y1s > y0s:
                    shifted[y0s:y1s] = out[s0:s1]
                out = plant_to_ground(shifted, ground)
    return out, problems


def write_thumb(src: np.ndarray, dest: Path) -> None:
    box = alpha_bbox(_to_bgra(src))
    if box is None:
        tiny = np.zeros((THUMB_H, max(8, THUMB_H // 2), 4), dtype=np.uint8)
        cv2.imwrite(str(dest), tiny)
        return
    crop = _to_bgra(src)[box[1] : box[3], box[0] : box[2]]
    h, w = crop.shape[:2]
    scale = THUMB_H / max(1, h)
    thumb = _resize_uniform(crop, scale)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dest), thumb)


def analyze_frames(frame_paths: list[Path], out_dir: Path) -> dict:
    raw = [_load(p) for p in frame_paths]
    background = detect_background(raw)
    keyed = [key_frame(img, background) for img in raw]
    features = [frame_features(raw[i], keyed[i]) for i in range(len(raw))]
    start, end = detect_steady_section(features)
    suggestions = suggest_keys(features, start, end)
    strip_dir = out_dir / "strip"
    strip_dir.mkdir(parents=True, exist_ok=True)
    thumbs = []
    for i, src in enumerate(keyed):
        name = f"frame_{i:04d}.png"
        write_thumb(src, strip_dir / name)
        thumbs.append({"index": i, "rel": f"strip/{name}", **{k: features[i][k] for k in ("h", "w", "foot_span", "blobs", "boots", "has_head")}})
    cycle = suggestions.get("cycle") or [start, end]
    has_head = any(features[i]["has_head"] for i in range(start, end) if not features[i]["empty"])
    warnings = []
    if has_head:
        warnings.append("This video looks like it already has a head. The rig will add Rodney's head — prefer a headless body.")
    info = {
        "ok": True,
        "background": background,
        "frameCount": len(frame_paths),
        "steady": {"start": start, "end": end},
        "cycle": {"start": int(cycle[0]), "end": int(cycle[1]), "period": suggestions.get("period")},
        "suggested": {k: v for k, v in suggestions.items() if k not in {"cycle", "period"}},
        "loopClosure": {k: round(loop_closure(features, v), 3) for k, v in suggestions.items() if k.isdigit()},
        "hasHead": has_head,
        "warnings": warnings,
        "thumbs": thumbs,
    }
    keyed_dir = out_dir / "keyed"
    keyed_dir.mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(keyed):
        cv2.imwrite(str(keyed_dir / f"frame_{i:04d}.png"), src)
    (out_dir / "analysis.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf8")
    return info


def build_from_indices(
    keyed_dir: Path,
    indices: list[int],
    out_dir: Path,
    canvas_w: int,
    canvas_h: int,
    *,
    torso_ref: np.ndarray | None = None,
    legs_ref: np.ndarray | None = None,
    neck_y: int | None = None,
) -> dict:
    frames: list[np.ndarray] = []
    problems: list[str] = []
    written = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, index in enumerate(indices):
        src_path = keyed_dir / f"frame_{int(index):04d}.png"
        src = _load(src_path)
        fitted, probs = fit_import_body(
            src,
            canvas_w,
            canvas_h,
            torso_ref=torso_ref,
            legs_ref=legs_ref,
            neck_y=neck_y,
        )
        problems.extend(probs)
        name = f"cell_{i:02d}.png"
        dest = out_dir / name
        cv2.imwrite(str(dest), fitted)
        written.append({"src": str(dest), "name": name, "index": int(index), "problems": probs})
        frames.append(fitted)
    info = {
        "ok": True,
        "frames": len(frames),
        "distance_per_cycle": travel_distance(frames) if len(frames) >= 2 else 96,
        "problems": list(dict.fromkeys(problems)),
        "written": written,
        "hasHead": any("head" in p for p in problems),
    }
    return info


VIEW_YAW = {
    "front": 0.0,
    "right_34": 45.0,
    "right_side": 90.0,
    "back": 180.0,
    "left_side": -90.0,
    "left_34": -45.0,
}

WALK_PHASES = ("contact_R", "down_R", "passing_R", "up_R", "contact_L", "down_L", "passing_L", "up_L")


def infer_clip_meta(filename: str, prompt: str = "") -> dict:
    text = f"{filename} {prompt}".lower().replace("_", " ")
    if any(word in text for word in ("walk", "stride", "step", "gait")):
        return {"kind": "body", "action": "walk", "category": "walks"}
    if "mic" in text:
        return {"kind": "body", "action": "mic", "category": "mic"}
    if any(word in text for word in ("head", "face", "look", "turn")):
        cat = "turns_looks" if any(word in text for word in ("look", "turn", "glance")) else "head_moves"
        return {"kind": "head", "action": "turn", "category": cat}
    if any(word in text for word in ("arm", "gesture", "wave", "point")):
        return {"kind": "body", "action": "gesture", "category": "arms_gestures"}
    if any(word in text for word in ("idle", "stand", "neutral")):
        return {"kind": "body", "action": "stand", "category": "idle_stand"}
    if any(word in text for word in ("eye", "mouth", "smile", "expression")):
        return {"kind": "head", "action": "expression", "category": "expressions"}
    return {"kind": "body", "action": "action", "category": "other"}


def yaw_to_view(yaw: float) -> str:
    best = "front"
    best_d = 999.0
    for name, value in VIEW_YAW.items():
        d = abs(((yaw - value + 180) % 360) - 180)
        if d < best_d:
            best_d = d
            best = name
    return best


def estimate_yaw(frame: np.ndarray, kind: str = "body") -> float:
    facing = facing_direction(frame)
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return 0.0
    width = max(1, box[2] - box[0])
    height = max(1, box[3] - box[1])
    aspect = width / float(height)
    profile = 0.48 if kind == "head" else 0.42
    three_q = 0.36 if kind == "head" else 0.32
    if facing == "right":
        if aspect >= profile:
            return 90.0
        if aspect >= three_q:
            return 45.0
        return 20.0
    if facing == "left":
        if aspect >= profile:
            return -90.0
        if aspect >= three_q:
            return -45.0
        return -20.0
    if aspect >= profile * 1.05:
        return 180.0
    return 0.0


def classify_phase(action: str, index: int, features: dict, cycle_len: int) -> str:
    if action == "walk" and cycle_len > 0:
        return WALK_PHASES[int(index) % len(WALK_PHASES)]
    if action == "mic":
        span = float(features.get("w") or 0)
        height = float(features.get("h") or 1)
        return "raise" if span > height * 0.55 else "hold"
    if action == "turn":
        return "turn"
    if action == "stand":
        return "stand"
    return action or "hold"


def detect_frame_issues(frame: np.ndarray, kind: str, view: str) -> list[str]:
    issues: list[str] = []
    src = _to_bgra(frame)
    box = alpha_bbox(src)
    if box is None:
        return ["empty"]
    x0, y0, x1, y1 = box
    crop = src[y0:y1, x0:x1]
    h = max(1, y1 - y0)
    top = crop[: max(1, h // 3), :, 3]
    bot = crop[(h * 2) // 3 :, :, 3]
    top_mass = int(np.count_nonzero(top > 16))
    bot_mass = int(np.count_nonzero(bot > 16))
    if kind == "body":
        boots_top = count_boots(crop[: max(8, h // 3)])
        if top_mass > bot_mass * 1.35 and boots_top >= 1:
            issues.append("upside_down")
    else:
        top_w = _row_width(crop[:, :, 3], 0.08)
        bot_w = _row_width(crop[:, :, 3], 0.92)
        if top_w > 4 and bot_w > 4 and top_w < bot_w * 0.62:
            issues.append("upside_down")
    facing = facing_direction(src)
    if view in {"right_side", "right_34"} and facing == "left":
        issues.append("mirrored")
    if view in {"left_side", "left_34"} and facing == "right":
        issues.append("mirrored")
    if kind == "body":
        mid = crop[h // 4 : (h * 3) // 4, :, 3] > 16
        ys, xs = np.where(mid)
        if xs.size > 8:
            cx = float(xs.mean())
            # Raised mass on the far side of a profile view is often the wrong arm.
            if view in {"right_side", "right_34"} and cx < crop.shape[1] * 0.28:
                issues.append("arm_side")
            if view in {"left_side", "left_34"} and cx > crop.shape[1] * 0.72:
                issues.append("arm_side")
    return issues


def _alpha_over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    out = dst.copy()
    src = _to_bgra(src)
    if src.shape[:2] != out.shape[:2]:
        canvas = np.zeros_like(out)
        h = min(src.shape[0], canvas.shape[0])
        w = min(src.shape[1], canvas.shape[1])
        canvas[:h, :w] = src[:h, :w]
        src = canvas
    a = src[:, :, 3:4].astype(np.float32) / 255.0
    out[:, :, :3] = (src[:, :, :3].astype(np.float32) * a + out[:, :, :3].astype(np.float32) * (1.0 - a)).astype(np.uint8)
    out[:, :, 3] = np.clip(out[:, :, 3].astype(np.float32) * (1.0 - a[:, :, 0]) + src[:, :, 3].astype(np.float32) * a[:, :, 0], 0, 255).astype(np.uint8)
    return out


def place_head_at_neck(head: np.ndarray, canvas_w: int, canvas_h: int, neck_y: int, neck_x: int | None = None) -> np.ndarray:
    src = _to_bgra(head)
    box = alpha_bbox(src)
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    if box is None:
        return out
    piece = src[box[1] : box[3], box[0] : box[2]]
    ph, pw = piece.shape[:2]
    target_h = max(24, int(neck_y * 0.42))
    scale = min(target_h / max(1, ph), (canvas_w - 16) / max(1, pw))
    resized = _resize_uniform(piece, float(scale))
    rh, rw = resized.shape[:2]
    x = int(round((neck_x if neck_x is not None else canvas_w / 2.0) - rw / 2.0))
    y = int(round(neck_y - rh))
    x = max(0, min(x, canvas_w - rw))
    y = max(0, min(y, canvas_h - rh))
    _blit(out, resized, x, y)
    return out


def compose_body_head(
    body: np.ndarray,
    head: np.ndarray | None,
    canvas_w: int,
    canvas_h: int,
    *,
    torso_ref: np.ndarray | None = None,
    legs_ref: np.ndarray | None = None,
    neck_y: int | None = None,
) -> tuple[np.ndarray, list[str]]:
    """Head first (neck at collar), body over so collar/mic/hand cover the chin."""

    body_fit, problems = fit_import_body(
        body,
        canvas_w,
        canvas_h,
        torso_ref=torso_ref,
        legs_ref=legs_ref,
        neck_y=neck_y,
    )
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    neck = int(neck_y) if neck_y is not None else 457
    bbox = alpha_bbox(body_fit)
    neck_x = int((bbox[0] + bbox[2]) / 2) if bbox is not None else canvas_w // 2
    if head is not None and alpha_bbox(_to_bgra(head)) is not None:
        placed = place_head_at_neck(head, canvas_w, canvas_h, neck, neck_x)
        out = _alpha_over(out, placed)
    out = _alpha_over(out, body_fit)
    return out, problems


def nearest_head_index(body_yaw: float, heads: list[dict]) -> int | None:
    if not heads:
        return None
    best_i = 0
    best_d = 999.0
    for i, item in enumerate(heads):
        yaw = float(item.get("yaw") or 0)
        d = abs(((body_yaw - yaw + 180) % 360) - 180)
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def catalog_frames(frame_paths: list[Path], out_dir: Path, *, filename: str = "", prompt: str = "") -> dict:
    """Key every frame, tag kind/view/phase/quality, write library layout."""

    meta = infer_clip_meta(filename, prompt)
    raw = [_load(p) for p in frame_paths]
    background = detect_background(raw)
    keyed = [key_frame(img, background) for img in raw]
    features = [frame_features(raw[i], keyed[i]) for i in range(len(raw))]
    head_votes = sum(1 for f in features if f.get("has_head") and f.get("boots", 0) < 2 and f.get("h", 0) < 160)
    if meta["kind"] != "head" and head_votes >= max(3, len(features) * 0.55) and not any(f.get("boots", 0) >= 2 for f in features):
        meta = {**meta, "kind": "head", "action": "turn", "category": "head_moves"}
    frames_dir = out_dir / "frames"
    strip_dir = out_dir / "strip"
    frames_dir.mkdir(parents=True, exist_ok=True)
    strip_dir.mkdir(parents=True, exist_ok=True)
    tagged = []
    warnings: list[str] = []
    for i, src in enumerate(keyed):
        name = f"frame_{i:04d}.png"
        cv2.imwrite(str(frames_dir / name), src)
        write_thumb(src, strip_dir / name)
        yaw = estimate_yaw(src, meta["kind"])
        view = yaw_to_view(yaw)
        issues = detect_frame_issues(src, meta["kind"], view)
        quality = max(0.0, min(1.0, (score_key(features, i) + 8.0) / 16.0))
        if issues:
            quality = max(0.0, quality - 0.25 * len(issues))
            warnings.extend(issues)
        tagged.append(
            {
                "index": i,
                "file": f"frames/{name}",
                "rel": f"strip/{name}",
                "kind": meta["kind"],
                "view": view,
                "yaw": round(yaw, 1),
                "action": meta["action"],
                "phase": classify_phase(meta["action"], i, features[i], max(8, len(features) // 3)),
                "quality": round(quality, 3),
                "issues": issues,
                **{k: features[i][k] for k in ("h", "w", "foot_span", "blobs", "boots", "has_head")},
            }
        )
    unique_warn = list(dict.fromkeys(warnings))
    info = {
        "ok": True,
        "kind": meta["kind"],
        "action": meta["action"],
        "category": meta["category"],
        "background": background,
        "frameCount": len(tagged),
        "hasHead": any(item.get("has_head") for item in tagged),
        "warnings": [
            f"{w.replace('_', ' ')} on {sum(1 for item in tagged if w in item['issues'])} frame(s)"
            for w in unique_warn
        ],
        "frames": tagged,
    }
    (out_dir / "index.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf8")
    return info


def compose_from_library(
    body_dir: Path,
    body_indices: list[int],
    out_dir: Path,
    canvas_w: int,
    canvas_h: int,
    *,
    heads: list[tuple[int, np.ndarray, float]] | None = None,
    torso_ref: np.ndarray | None = None,
    legs_ref: np.ndarray | None = None,
    neck_y: int | None = None,
) -> dict:
    head_rows = [{"yaw": yaw, "index": i} for i, _img, yaw in (heads or [])]
    written = []
    problems: list[str] = []
    frames: list[np.ndarray] = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, index in enumerate(body_indices):
        src = _load(body_dir / f"frame_{int(index):04d}.png")
        head_img = None
        if heads:
            yaw = estimate_yaw(src, "body")
            pick = nearest_head_index(yaw, head_rows)
            if pick is not None:
                head_img = heads[pick][1]
        fitted, probs = compose_body_head(
            src,
            head_img,
            canvas_w,
            canvas_h,
            torso_ref=torso_ref,
            legs_ref=legs_ref,
            neck_y=neck_y,
        )
        problems.extend(probs)
        name = f"cell_{i:02d}.png"
        dest = out_dir / name
        cv2.imwrite(str(dest), fitted)
        written.append({"src": str(dest), "name": name, "index": int(index), "problems": probs})
        frames.append(fitted)
    return {
        "ok": True,
        "frames": len(frames),
        "distance_per_cycle": travel_distance(frames) if len(frames) >= 2 else 96,
        "problems": list(dict.fromkeys(problems)),
        "written": written,
        "pairedHead": bool(heads),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyse, catalogue, or fit an imported walk MP4.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze")
    an.add_argument("--frames-dir", type=Path, required=True)
    an.add_argument("--out-dir", type=Path, required=True)
    an.add_argument("--filename", default="")
    cat = sub.add_parser("catalog")
    cat.add_argument("--frames-dir", type=Path, required=True)
    cat.add_argument("--out-dir", type=Path, required=True)
    cat.add_argument("--filename", default="")
    cat.add_argument("--prompt", default="")
    bd = sub.add_parser("build")
    bd.add_argument("--keyed-dir", type=Path, required=True)
    bd.add_argument("--out-dir", type=Path, required=True)
    bd.add_argument("--indices", required=True, help="comma-separated frame indices")
    bd.add_argument("--canvas-w", type=int, default=1024)
    bd.add_argument("--canvas-h", type=int, default=1024)
    bd.add_argument("--torso-ref", type=Path)
    bd.add_argument("--legs-ref", type=Path)
    bd.add_argument("--neck-y", type=int)
    bd.add_argument("--head-dir", type=Path)
    bd.add_argument("--head-indices", default="")
    bd.add_argument("--head-yaws", default="")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "analyze":
            paths = sorted(p for p in args.frames_dir.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg"})
            info = analyze_frames(paths, args.out_dir)
            print(json.dumps(info))
            return 0
        if args.cmd == "catalog":
            paths = sorted(p for p in args.frames_dir.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg"})
            info = catalog_frames(paths, args.out_dir, filename=args.filename, prompt=args.prompt)
            print(json.dumps(info))
            return 0
        indices = [int(x) for x in str(args.indices).split(",") if str(x).strip() != ""]
        torso = _load(args.torso_ref) if args.torso_ref else None
        legs = _load(args.legs_ref) if args.legs_ref else None
        heads = None
        if args.head_dir and str(args.head_indices).strip():
            h_idx = [int(x) for x in str(args.head_indices).split(",") if str(x).strip() != ""]
            yaws = [float(x) for x in str(args.head_yaws).split(",") if str(x).strip() != ""]
            heads = []
            for i, index in enumerate(h_idx):
                path = args.head_dir / f"frame_{int(index):04d}.png"
                yaw = yaws[i] if i < len(yaws) else 0.0
                heads.append((index, _load(path), yaw))
        if heads:
            info = compose_from_library(
                args.keyed_dir,
                indices,
                args.out_dir,
                args.canvas_w,
                args.canvas_h,
                heads=heads,
                torso_ref=torso,
                legs_ref=legs,
                neck_y=args.neck_y,
            )
        else:
            info = build_from_indices(
                args.keyed_dir,
                indices,
                args.out_dir,
                args.canvas_w,
                args.canvas_h,
                torso_ref=torso,
                legs_ref=legs,
                neck_y=args.neck_y,
            )
        print(json.dumps(info))
        return 0 if info.get("ok") else 1
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(err)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
