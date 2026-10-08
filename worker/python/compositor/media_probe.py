"""Thin wrapper around ffprobe for reading audio durations."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def probe_duration_seconds(path: Path) -> float:
    """Return the duration of a media file in seconds, via ffprobe."""

    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffprobe not found on PATH. FFmpeg (which includes ffprobe) is "
            "required; see README.md for install instructions."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on {path}: {exc.stderr}") from exc

    data = json.loads(result.stdout)
    duration = data.get("format", {}).get("duration")
    if duration is None:
        raise RuntimeError(f"ffprobe returned no duration for {path}")
    return float(duration)
