"""Rhubarb Lip Sync integration.

Rhubarb (https://github.com/DanielSWolf/rhubarb-lip-sync) analyzes a WAV
file and emits a JSON file of mouth-shape "cues": time ranges each tagged
with one of the shapes A-H / X. We either read a pre-computed cues JSON
directly, or, if a `rhubarb` binary is installed, run it on demand and
cache the result next to the source audio so repeat renders are instant.

If no cues file is given AND the `rhubarb` binary isn't installed, we
raise a clear, actionable error rather than silently rendering a static
mouth -- but a render that only references a pre-computed cues JSON (as
the sample project does) works with zero Rhubarb installation at all.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import warnings
from dataclasses import dataclass
from pathlib import Path

MOUTH_SHAPES = ("A", "B", "C", "D", "E", "F", "G", "H", "X")
DEFAULT_SHAPE = "X"
# Tongue-out H is often a drawn expression, not a spoken shape. Prefer an
# open mouth, then the previous cue, then a neighbour letter.
PREFERRED_FALLBACK = {
    "H": ("C", "D", "B", "G", "E", "F", "A", "X"),
}

RHUBARB_INSTALL_HINT = (
    "Rhubarb Lip Sync binary not found on PATH (expected `rhubarb` or "
    "`rhubarb.exe`). Install it and ensure it's on PATH, or commit a "
    "pre-computed cues JSON (mouth.lipsync.cues) so renders never need it. "
    "See docs/timeline-schema.md and README.md for install instructions "
    "(download a release from "
    "https://github.com/DanielSWolf/rhubarb-lip-sync/releases)."
)


@dataclass(frozen=True)
class MouthCue:
    start: float
    end: float
    shape: str


def find_rhubarb_binary() -> str | None:
    return shutil.which("rhubarb") or shutil.which("rhubarb.exe")


def load_cues_file(path: Path) -> list[MouthCue]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    cues_raw = data.get("mouthCues", data if isinstance(data, list) else [])
    cues = [
        MouthCue(start=float(c["start"]), end=float(c["end"]), shape=str(c["value"]))
        for c in cues_raw
    ]
    cues.sort(key=lambda c: c.start)
    return cues


def run_rhubarb(
    audio_path: Path,
    output_json_path: Path,
    dialogue_text: str | None = None,
    rhubarb_bin: str | None = None,
) -> Path:
    """Run Rhubarb on ``audio_path`` and write cues JSON to ``output_json_path``."""

    binary = rhubarb_bin or find_rhubarb_binary()
    if not binary:
        raise RuntimeError(RHUBARB_INSTALL_HINT)

    cmd = [binary, "-f", "json", "-o", str(output_json_path)]
    if dialogue_text:
        cmd += ["--dialogFile", "-"]
    cmd.append(str(audio_path))

    subprocess.run(
        cmd,
        input=dialogue_text.encode("utf-8") if dialogue_text else None,
        check=True,
        capture_output=True,
    )
    return output_json_path


def get_cues(
    lipsync_config: dict,
    project_dir: Path,
    rhubarb_bin: str | None = None,
) -> list[MouthCue]:
    """Resolve a mouth's ``lipsync`` config into a list of MouthCue.

    Resolution order (see schema/timeline.schema.json for the rationale):

    1. If the `cues` file (explicit, or defaulted to "<audio>.rhubarb.json"
       next to `audio`) already exists on disk, load it directly. This is
       the primary, deterministic path and Rhubarb is never invoked here.
    2. Else, if a `rhubarb` binary is available, run it on `audio` to
       generate that cues file, then load it.
    3. Else, this does NOT raise: it warns and returns an empty cue list,
       which makes the mouth render its idle/closed shape ("X") for the
       whole range. A missing Rhubarb install must never halt a render.
    """

    cues_rel = lipsync_config.get("cues")
    audio_rel = lipsync_config.get("audio")
    if not cues_rel and not audio_rel:
        raise ValueError("mouth.lipsync must specify 'cues' and/or 'audio'")

    audio_path = project_dir / audio_rel if audio_rel else None
    cues_path = (
        project_dir / cues_rel
        if cues_rel
        else audio_path.with_suffix(audio_path.suffix + ".rhubarb.json")
    )

    if cues_path.exists():
        return load_cues_file(cues_path)

    if audio_path is None:
        raise FileNotFoundError(
            f"mouth.lipsync.cues file does not exist and no 'audio' was "
            f"given to generate it: {cues_path}"
        )

    binary = rhubarb_bin or find_rhubarb_binary()
    if binary:
        run_rhubarb(
            audio_path,
            cues_path,
            dialogue_text=lipsync_config.get("dialogue_text"),
            rhubarb_bin=binary,
        )
        return load_cues_file(cues_path)

    warnings.warn(
        f"No cues file at {cues_path} and {RHUBARB_INSTALL_HINT} "
        "Falling back to the idle mouth shape for this mouth's whole "
        "duration; the render will still complete.",
        stacklevel=2,
    )
    return []


def _base_shape(shape: str) -> str:
    text = str(shape or DEFAULT_SHAPE)
    if text.endswith("_loud"):
        return text[: -len("_loud")]
    return text


def excluded_shape_set(names: object) -> set[str]:
    out: set[str] = set()
    if not names:
        return out
    for name in names:
        base = _base_shape(str(name)).upper()
        if base:
            out.add(base)
    return out


def remap_shape(
    shape: str,
    excluded: object = None,
    previous: str | None = None,
    available: object = None,
) -> str:
    """Map an excluded auto-lipsync shape to the nearest kept drawing.

    Keyframe / manual pins keep the original name — this is only for cue
    letters. ``H`` prefers C or D (open mouth), then the previous cue.
    """

    excluded_set = excluded if isinstance(excluded, set) else excluded_shape_set(excluded)
    loud = str(shape or "").endswith("_loud")
    base = _base_shape(shape).upper() or DEFAULT_SHAPE
    if not excluded_set or base not in excluded_set:
        return str(shape or DEFAULT_SHAPE)

    available_set: set[str] | None
    if available is None:
        available_set = None
    else:
        available_set = {str(name) for name in available}

    candidates: list[str] = []
    candidates.extend(PREFERRED_FALLBACK.get(base, ()))
    if previous:
        prev_base = _base_shape(previous).upper()
        if prev_base and prev_base not in excluded_set:
            candidates.append(prev_base)
    if base in MOUTH_SHAPES:
        index = MOUTH_SHAPES.index(base)
        for dist in range(1, len(MOUTH_SHAPES)):
            if index - dist >= 0:
                candidates.append(MOUTH_SHAPES[index - dist])
            if index + dist < len(MOUTH_SHAPES):
                candidates.append(MOUTH_SHAPES[index + dist])
    candidates.append(DEFAULT_SHAPE)

    seen: set[str] = set()
    for candidate in candidates:
        letter = _base_shape(candidate).upper()
        if not letter or letter in excluded_set or letter in seen:
            continue
        seen.add(letter)
        if available_set is not None and letter not in available_set and f"{letter}_loud" not in available_set:
            continue
        if loud and (available_set is None or f"{letter}_loud" in available_set):
            return f"{letter}_loud"
        return letter
    return DEFAULT_SHAPE


def remap_cues(
    cues: list[MouthCue],
    excluded: object = None,
    available: object = None,
) -> list[MouthCue]:
    excluded_set = excluded if isinstance(excluded, set) else excluded_shape_set(excluded)
    if not excluded_set or not cues:
        return list(cues)
    out: list[MouthCue] = []
    previous = DEFAULT_SHAPE
    for cue in cues:
        shape = remap_shape(cue.shape, excluded_set, previous=previous, available=available)
        out.append(MouthCue(start=cue.start, end=cue.end, shape=shape))
        previous = _base_shape(shape)
    return out


def shape_at_time(
    cues: list[MouthCue],
    t_seconds: float,
    excluded: object = None,
    available: object = None,
) -> str:
    """Return the mouth shape active at ``t_seconds``, or DEFAULT_SHAPE."""

    excluded_set = excluded if isinstance(excluded, set) else excluded_shape_set(excluded)
    previous = DEFAULT_SHAPE
    chosen = DEFAULT_SHAPE
    found = False
    for cue in cues:
        mapped = remap_shape(cue.shape, excluded_set, previous=previous, available=available)
        if cue.start <= t_seconds < cue.end:
            chosen = mapped
            found = True
        if cue.end <= t_seconds:
            previous = _base_shape(mapped)
        elif found:
            break
    return chosen if found else DEFAULT_SHAPE
