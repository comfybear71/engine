"""Natural lip-sync post-process: hold, smoothing, loud mouths, blinks, bob.

Applied when a timeline is loaded so CLI render and the Stage preview share
one path. Missing loud drawings, words, or a closed-eye drawing all no-op
instead of requiring new art.
"""

from __future__ import annotations

import json
import random
import wave
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

from . import lipsync
from .interpolate import apply_ease
from .slots import Slot, SlotKeyframe

LOUD_SHAPES = ("B", "C", "D", "E")
MIN_HOLD_FRAMES = 2
DEFAULT_LOUD_PERCENTILE = 0.75
DEFAULT_SMOOTHING = "light"
DEFAULT_HEAD_BOB = "subtle"
HEAD_SLOT_NAMES = frozenset({"mouth", "face", "eyes"})
HEAD_BOB_SPAN = 6
HEAD_BOB_PEAK = 2
HEAD_BOB_PRESETS = {
    "off": (0.0, 0.0),
    "subtle": (4.0, 1.0),
    "strong": (10.0, 1.5),
}
DEFAULT_BLINK_EVERY = (3.0, 6.0)
DEFAULT_BLINK_FRAMES = 5
SMOOTHING_MODES = ("off", "light", "medium")
HEAD_BOB_MODES = ("off", "subtle", "strong")


@dataclass(frozen=True)
class LipSyncSettings:
    smoothing: str = DEFAULT_SMOOTHING
    head_bob: str = DEFAULT_HEAD_BOB
    blinks: bool = True
    loud_threshold: float = DEFAULT_LOUD_PERCENTILE
    blink_every: tuple[float, float] = DEFAULT_BLINK_EVERY
    blink_frames: int = DEFAULT_BLINK_FRAMES

    @property
    def head_bob_amp(self) -> float:
        return HEAD_BOB_PRESETS.get(self.head_bob, HEAD_BOB_PRESETS["subtle"])[0]

    @property
    def head_bob_rotation(self) -> float:
        return HEAD_BOB_PRESETS.get(self.head_bob, HEAD_BOB_PRESETS["subtle"])[1]


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else float(value)


def _as_percentile(value: object, default: float = DEFAULT_LOUD_PERCENTILE) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if number > 1.0:
        number = number / 100.0
    return _clamp01(number)


def _as_mode(value: object, allowed: Sequence[str], default: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in allowed else default


def load_json_object(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_studio_lipsync(project_dir: Path) -> dict:
    data = load_json_object(project_dir / "studio.json")
    raw = data.get("lipsync")
    return raw if isinstance(raw, dict) else {}


def _show_assets_dir(project_dir: Path) -> Path | None:
    """Episode at shows/<id>/episodes/<ep> shares the show folder; else None."""

    episodes_dir = project_dir.parent
    show_dir = episodes_dir.parent
    if episodes_dir.name != "episodes":
        return None
    if not (show_dir / "show.json").is_file():
        return None
    return show_dir


def _global_assets_dir(project_dir: Path) -> Path:
    sibling = project_dir.parent / "_global_assets"
    if sibling.is_dir():
        return sibling
    current = project_dir.resolve()
    for _ in range(8):
        parent = current.parent
        next_to_parent = parent / "_global_assets"
        if next_to_parent.is_dir():
            return next_to_parent
        under_projects = parent / "projects" / "_global_assets"
        if under_projects.is_dir():
            return under_projects
        if parent == current:
            break
        current = parent
    return sibling


def load_character_config(project_dir: Path, character_id: str | None) -> dict:
    """episode → show → global, same order as the parser asset library."""

    if not character_id:
        return {}
    rel = Path("characters") / character_id / "character.json"
    candidates = [project_dir / rel]
    show_dir = _show_assets_dir(project_dir)
    if show_dir is not None:
        candidates.append(show_dir / rel)
    candidates.append(_global_assets_dir(project_dir) / rel)
    for path in candidates:
        data = load_json_object(path)
        if data:
            return data
    return {}


def merge_lipsync_settings(studio_raw: dict | None, character_raw: dict | None) -> LipSyncSettings:
    """Defaults < character.json < project studio.json."""

    character = character_raw if isinstance(character_raw, dict) else {}
    char_lipsync = character.get("lipsync") if isinstance(character.get("lipsync"), dict) else {}
    studio = studio_raw if isinstance(studio_raw, dict) else {}

    smoothing = DEFAULT_SMOOTHING
    head_bob = DEFAULT_HEAD_BOB
    loud_threshold = DEFAULT_LOUD_PERCENTILE
    blinks = True
    blink_every = DEFAULT_BLINK_EVERY
    blink_frames = DEFAULT_BLINK_FRAMES

    char_blinks = character.get("blinks")
    if char_blinks is False:
        blinks = False
    elif isinstance(char_blinks, dict):
        every = char_blinks.get("every")
        if isinstance(every, (list, tuple)) and len(every) >= 2:
            lo = float(every[0])
            hi = float(every[1])
            if hi < lo:
                lo, hi = hi, lo
            blink_every = (max(0.1, lo), max(0.1, hi))
        if char_blinks.get("frames") is not None:
            try:
                blink_frames = max(1, int(char_blinks["frames"]))
            except (TypeError, ValueError):
                pass

    for src in (char_lipsync, studio):
        if "smoothing" in src:
            smoothing = _as_mode(src.get("smoothing"), SMOOTHING_MODES, smoothing)
        if "head_bob" in src:
            head_bob = _as_mode(src.get("head_bob"), HEAD_BOB_MODES, head_bob)
        if "loud_threshold" in src:
            loud_threshold = _as_percentile(src.get("loud_threshold"), loud_threshold)
        if src.get("blinks") is False or src.get("blinks") == "off":
            blinks = False
        elif src.get("blinks") is True or src.get("blinks") == "on":
            blinks = True

    return LipSyncSettings(
        smoothing=smoothing,
        head_bob=head_bob,
        blinks=blinks,
        loud_threshold=loud_threshold,
        blink_every=blink_every,
        blink_frames=blink_frames,
    )


def project_seed(project_dir: Path, extra: str = "") -> int:
    key = f"{project_dir.resolve().name}:{extra}"
    return zlib.crc32(key.encode("utf-8")) & 0xFFFFFFFF


def cue_frame_count(cue: lipsync.MouthCue, fps: int) -> float:
    return max(0.0, (cue.end - cue.start) * float(fps))


def cues_to_frames(cues: Sequence[lipsync.MouthCue], duration_frames: int, fps: int) -> list[str]:
    frames = [lipsync.DEFAULT_SHAPE] * max(0, int(duration_frames))
    if not frames:
        return frames
    for cue in cues:
        start = max(0, int(round(cue.start * float(fps))))
        end = min(len(frames), int(round(cue.end * float(fps))))
        if end <= start:
            end = min(len(frames), start + 1)
        for idx in range(start, end):
            frames[idx] = cue.shape
    return frames


def frames_to_cues(frames: Sequence[str], fps: int) -> list[lipsync.MouthCue]:
    if not frames:
        return []
    out: list[lipsync.MouthCue] = []
    start = 0
    current = frames[0]
    for idx in range(1, len(frames) + 1):
        if idx < len(frames) and frames[idx] == current:
            continue
        out.append(
            lipsync.MouthCue(
                start=start / float(fps),
                end=idx / float(fps),
                shape=current,
            )
        )
        if idx < len(frames):
            start = idx
            current = frames[idx]
    return out


def apply_min_hold(frames: list[str], min_frames: int = MIN_HOLD_FRAMES) -> list[str]:
    """Merge runs shorter than ``min_frames`` into a neighbour.

    A closed-mouth ``A`` that already lasts ``min_frames`` or more is kept
    (a real M/B/P between words). A 1-frame ``A`` is not.
    """

    if not frames or min_frames <= 1:
        return list(frames)

    out = list(frames)
    changed = True
    while changed:
        changed = False
        runs = _runs(out)
        for start, end, shape in runs:
            length = end - start
            if length >= min_frames:
                continue
            replacement = _merge_neighbour(out, start, end, runs)
            if replacement is None:
                continue
            out[start:end] = [replacement] * length
            changed = True
            break
    return out


def _runs(frames: Sequence[str]) -> list[tuple[int, int, str]]:
    runs: list[tuple[int, int, str]] = []
    if not frames:
        return runs
    start = 0
    current = frames[0]
    for idx, shape in enumerate(frames[1:], start=1):
        if shape == current:
            continue
        runs.append((start, idx, current))
        start = idx
        current = shape
    runs.append((start, len(frames), current))
    return runs


def _merge_neighbour(
    frames: Sequence[str], start: int, end: int, runs: Sequence[tuple[int, int, str]]
) -> str | None:
    prev_shape = frames[start - 1] if start > 0 else None
    next_shape = frames[end] if end < len(frames) else None
    if prev_shape is not None and prev_shape == next_shape:
        return prev_shape

    prev_len = 0
    next_len = 0
    for run_start, run_end, _shape in runs:
        if run_end == start:
            prev_len = run_end - run_start
        if run_start == end:
            next_len = run_end - run_start

    if prev_shape is not None and next_shape is not None:
        return prev_shape if prev_len >= next_len else next_shape
    if prev_shape is not None:
        return prev_shape
    if next_shape is not None:
        return next_shape
    return None


def apply_smoothing(frames: list[str], mode: str = DEFAULT_SMOOTHING) -> list[str]:
    """Collapse rapid flicker. ``light`` is a 3-frame C-B-C; ``medium`` is 5."""

    mode = _as_mode(mode, SMOOTHING_MODES, DEFAULT_SMOOTHING)
    if mode == "off" or len(frames) < 3:
        return list(frames)

    max_island = 1 if mode == "light" else 2
    out = list(frames)
    changed = True
    while changed:
        changed = False
        runs = _runs(out)
        for i, (start, end, _shape) in enumerate(runs):
            length = end - start
            if length > max_island or i == 0 or i == len(runs) - 1:
                continue
            prev_shape = runs[i - 1][2]
            next_shape = runs[i + 1][2]
            if prev_shape != next_shape:
                continue
            out[start:end] = [prev_shape] * length
            changed = True
            break
    return out


def process_mouth_cues(
    cues: Sequence[lipsync.MouthCue],
    *,
    duration_frames: int,
    fps: int,
    smoothing: str = DEFAULT_SMOOTHING,
) -> list[lipsync.MouthCue]:
    if not cues or duration_frames <= 0 or fps <= 0:
        return list(cues)
    frames = cues_to_frames(cues, duration_frames, fps)
    frames = apply_min_hold(frames)
    frames = apply_smoothing(frames, smoothing)
    return frames_to_cues(frames, fps)


def percentile_threshold(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float64), _clamp01(q) * 100.0))


def drawing_names(slot: Slot | None, view: str | None = None) -> set[str]:
    if slot is None:
        return set()
    names = set(slot.images)
    if view and view in slot.images_by_view:
        names.update(slot.images_by_view[view])
    if "front" in slot.images_by_view:
        names.update(slot.images_by_view["front"])
    return names


def select_loud_variants(
    cues: Sequence[lipsync.MouthCue],
    rms_values: Sequence[float],
    *,
    threshold_percentile: float = DEFAULT_LOUD_PERCENTILE,
    available: Iterable[str] | None = None,
) -> list[lipsync.MouthCue]:
    """Promote B/C/D/E to ``*_loud`` when RMS is above the clip percentile.

    Missing loud files stay on the normal shape.
    """

    available_names = set(available or [])
    values = list(rms_values)
    if len(values) < len(cues):
        values.extend([0.0] * (len(cues) - len(values)))
    threshold = percentile_threshold(values, threshold_percentile)
    out: list[lipsync.MouthCue] = []
    for cue, rms in zip(cues, values):
        shape = cue.shape
        base = shape[:-5] if shape.endswith("_loud") else shape
        if base in LOUD_SHAPES and rms > threshold:
            loud_name = f"{base}_loud"
            if not available_names or loud_name in available_names:
                shape = loud_name
            else:
                shape = base
        out.append(lipsync.MouthCue(start=cue.start, end=cue.end, shape=shape))
    return out


def read_wav_mono(path: Path) -> tuple[np.ndarray, int] | None:
    try:
        with wave.open(str(path), "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.getnframes()
            raw = wf.readframes(frames)
    except (OSError, wave.Error):
        return None
    if rate <= 0 or not raw:
        return None
    if width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        return None
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, int(rate)


def window_rms(data: np.ndarray, rate: int, start: float, end: float) -> float:
    if data.size == 0 or rate <= 0:
        return 0.0
    i0 = max(0, int(start * rate))
    i1 = min(data.size, max(i0 + 1, int(math_ceil(end * rate))))
    sl = data[i0:i1]
    if sl.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(sl))))


def math_ceil(value: float) -> int:
    integer = int(value)
    return integer if integer == value or value < 0 else integer + 1


def cue_rms_values(
    audio_path: Path,
    cues: Sequence[lipsync.MouthCue],
    *,
    trim_in: float = 0.0,
) -> list[float]:
    loaded = read_wav_mono(audio_path)
    if loaded is None:
        return [0.0] * len(cues)
    data, rate = loaded
    return [window_rms(data, rate, trim_in + cue.start, trim_in + cue.end) for cue in cues]


def apply_loud_to_cues(
    cues: Sequence[lipsync.MouthCue],
    audio_path: Path,
    *,
    trim_in: float = 0.0,
    threshold_percentile: float = DEFAULT_LOUD_PERCENTILE,
    available: Iterable[str] | None = None,
) -> list[lipsync.MouthCue]:
    if not cues:
        return []
    rms_values = cue_rms_values(audio_path, cues, trim_in=trim_in)
    if not any(rms_values):
        return list(cues)
    return select_loud_variants(
        cues,
        rms_values,
        threshold_percentile=threshold_percentile,
        available=available,
    )


def stressed_midpoints(
    words: Sequence[object],
    audio_path: Path,
    *,
    threshold_percentile: float = DEFAULT_LOUD_PERCENTILE,
) -> list[float]:
    """Return source-audio times (seconds) of stressed words."""

    if not words:
        return []
    loaded = read_wav_mono(audio_path)
    if loaded is None:
        return []
    data, rate = loaded
    windows: list[tuple[float, float]] = []
    for word in words:
        start = float(getattr(word, "start", 0.0))
        end = float(getattr(word, "end", start))
        if end > start:
            windows.append((start, end))
    if not windows:
        return []
    values = [window_rms(data, rate, start, end) for start, end in windows]
    threshold = percentile_threshold(values, threshold_percentile)
    out: list[float] = []
    for (start, end), rms in zip(windows, values):
        if rms > threshold:
            out.append((start + end) / 2.0)
    return out


def loudness_peak_times(
    audio_path: Path,
    *,
    start: float,
    end: float,
    threshold_percentile: float = DEFAULT_LOUD_PERCENTILE,
    hop: float = 1.0 / 24.0,
) -> list[float]:
    loaded = read_wav_mono(audio_path)
    if loaded is None or end <= start:
        return []
    data, rate = loaded
    times: list[float] = []
    values: list[float] = []
    t = start
    while t < end:
        t1 = min(end, t + hop)
        values.append(window_rms(data, rate, t, t1))
        times.append((t + t1) / 2.0)
        t = t1
    if len(values) < 3:
        return []
    threshold = percentile_threshold(values, threshold_percentile)
    peaks: list[float] = []
    for i in range(1, len(values) - 1):
        if values[i] > threshold and values[i] >= values[i - 1] and values[i] > values[i + 1]:
            peaks.append(times[i])
    return peaks


def clip_stress_times(
    words: Sequence[object],
    audio_path: Path,
    *,
    trim_in: float,
    play_seconds: float,
    threshold_percentile: float = DEFAULT_LOUD_PERCENTILE,
) -> list[float]:
    """Source-audio times that should trigger a head bob."""

    times = stressed_midpoints(words, audio_path, threshold_percentile=threshold_percentile)
    if times:
        return times
    return loudness_peak_times(
        audio_path,
        start=trim_in,
        end=trim_in + max(0.0, play_seconds),
        threshold_percentile=threshold_percentile,
    )


def head_bob_starts(
    source_times: Sequence[float],
    *,
    trim_in: float,
    clip_start_frame: int,
    fps: int,
    span: int = HEAD_BOB_SPAN,
    duration_frames: int | None = None,
) -> list[int]:
    """Layer-local start frames for non-overlapping bob pulses."""

    starts: list[int] = []
    last_end = -1
    for source_t in source_times:
        local_seconds = source_t - trim_in
        if local_seconds < 0:
            continue
        frame = clip_start_frame + int(round(local_seconds * float(fps)))
        if frame < 0:
            continue
        if duration_frames is not None and frame + span > duration_frames:
            continue
        if frame < last_end:
            continue
        starts.append(frame)
        last_end = frame + span
    return starts


def head_bob_at(
    starts: Sequence[int],
    frame: int,
    *,
    amp: float,
    rotation: float,
    span: int = HEAD_BOB_SPAN,
    peak: int = HEAD_BOB_PEAK,
) -> tuple[float, float]:
    """Canvas-pixel down offset and degrees for ``frame``."""

    if amp == 0.0 and rotation == 0.0:
        return 0.0, 0.0
    dy = 0.0
    rot = 0.0
    peak = max(1, min(peak, span - 1)) if span > 1 else 1
    for i, start in enumerate(starts):
        t = frame - start
        if t < 0 or t > span:
            continue
        if t <= peak:
            u = t / float(peak)
        else:
            u = 1.0 - (t - peak) / float(max(1, span - peak))
        u = apply_ease(u, "inout")
        dy = max(dy, amp * u)
        sign = 1.0 if i % 2 == 0 else -1.0
        rot += sign * rotation * u
    return dy, rot


def slot_head_bob(slot: Slot, frame: int) -> tuple[float, float]:
    return head_bob_at(
        slot.head_bob_starts,
        frame,
        amp=slot.head_bob_amp,
        rotation=slot.head_bob_rotation,
    )


def schedule_blinks(
    *,
    duration_frames: int,
    fps: int,
    seed: int,
    every: tuple[float, float] = DEFAULT_BLINK_EVERY,
    blink_frames: int = DEFAULT_BLINK_FRAMES,
    pinned: Sequence[tuple[int, int]] = (),
) -> list[tuple[int, int]]:
    """Deterministic blink windows. ``seed`` must stay stable for a project."""

    if duration_frames <= 0 or fps <= 0 or blink_frames <= 0:
        return []
    lo, hi = every
    if hi < lo:
        lo, hi = hi, lo
    lo = max(0.1, float(lo))
    hi = max(lo, float(hi))
    rng = random.Random(int(seed))
    out: list[tuple[int, int]] = []
    t = rng.uniform(lo, hi)
    while True:
        start = int(round(t * float(fps)))
        end = start + int(blink_frames)
        if end >= duration_frames:
            break
        if start >= 0 and not _overlaps_any(start, end, pinned) and not _overlaps_any(start, end, out):
            out.append((start, end))
        t += rng.uniform(lo, hi)
    return out


def _overlaps_any(start: int, end: int, ranges: Sequence[tuple[int, int]]) -> bool:
    for other_start, other_end in ranges:
        if start < other_end and end > other_start:
            return True
    return False


def rest_eye_drawing(images: dict, keyframes: Sequence[SlotKeyframe] | None) -> str | None:
    if "open" in images:
        return "open"
    if keyframes:
        first = keyframes[0].drawing
        if first and first != "closed":
            return first
    for name in images:
        if name != "closed":
            return name
    return None


def pin_ranges(
    keyframes: Sequence[SlotKeyframe],
    *,
    rest: str | None,
    duration_frames: int,
) -> list[tuple[int, int]]:
    """Held ``eyes=`` pins that are not the rest/open drawing."""

    ranges: list[tuple[int, int]] = []
    if not keyframes:
        return ranges
    for i, kf in enumerate(keyframes):
        if kf.cycle:
            ranges.append((kf.frame, duration_frames if i == len(keyframes) - 1 else keyframes[i + 1].frame))
            continue
        if kf.drawing is None or kf.drawing == rest:
            continue
        end = duration_frames if i == len(keyframes) - 1 else keyframes[i + 1].frame
        ranges.append((kf.frame, end))
    return ranges


def insert_auto_blinks(
    keyframes: list[SlotKeyframe] | None,
    images: dict,
    *,
    duration_frames: int,
    fps: int,
    seed: int,
    every: tuple[float, float] = DEFAULT_BLINK_EVERY,
    blink_frames: int = DEFAULT_BLINK_FRAMES,
) -> list[SlotKeyframe] | None:
    if "closed" not in images or duration_frames <= 0:
        return keyframes
    kfs = list(keyframes or [])
    if any(kf.cycle for kf in kfs):
        return keyframes
    rest = rest_eye_drawing(images, kfs)
    if rest is None or rest == "closed":
        return keyframes
    if not kfs:
        kfs = [SlotKeyframe(frame=0, drawing=rest)]

    pins = pin_ranges(kfs, rest=rest, duration_frames=duration_frames)
    blinks = schedule_blinks(
        duration_frames=duration_frames,
        fps=fps,
        seed=seed,
        every=every,
        blink_frames=blink_frames,
        pinned=pins,
    )
    if not blinks:
        return kfs

    extras = []
    for start, end in blinks:
        extras.append(SlotKeyframe(frame=start, drawing="closed"))
        extras.append(SlotKeyframe(frame=end, drawing=rest))
    merged = sorted(kfs + extras, key=lambda kf: (kf.frame, 0 if kf.drawing != "closed" else 1))
    return merged
