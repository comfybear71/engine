"""Audio-derived duration: scenes/layers can derive their frame length from
an audio file's duration instead of only a hand-typed frame count."""

from __future__ import annotations

import math
import struct
import wave

import pytest

from compositor.media_probe import probe_duration_seconds
from compositor.timeline_loader import load_timeline
from compositor.schema_validate import validate_timeline

from .conftest import SAMPLE_PROJECT_DIR


def _write_wav(path, duration_s: float, sample_rate: int = 44100):
    n_samples = int(duration_s * sample_rate)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        samples = [int(3000 * math.sin(2 * math.pi * 440 * i / sample_rate)) for i in range(n_samples)]
        wf.writeframes(b"".join(struct.pack("<h", s) for s in samples))


def test_probe_duration_seconds_matches_written_wav(tmp_path):
    wav_path = tmp_path / "tone.wav"
    _write_wav(wav_path, 1.5)
    duration = probe_duration_seconds(wav_path)
    assert duration == pytest.approx(1.5, abs=0.02)


def test_probe_missing_file_raises(tmp_path):
    with pytest.raises(RuntimeError):
        probe_duration_seconds(tmp_path / "nope.wav")


def test_sample_project_scene_duration_derived_from_audio():
    timeline = load_timeline(SAMPLE_PROJECT_DIR / "timeline.json")
    scene = timeline.scenes[0]
    audio_path = SAMPLE_PROJECT_DIR / "assets" / "audio" / "line1.wav"
    audio_seconds = probe_duration_seconds(audio_path)

    expected_frames = round(audio_seconds * timeline.fps) + 6  # padding_frames: 6 in timeline.json
    assert scene.total_frames == expected_frames


def test_hand_set_frames_still_supported(tmp_path):
    (tmp_path / "bg.png").write_bytes(_png_1x1())
    timeline_json = {
        "series": "Test",
        "episode": "1",
        "fps": 10,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 42},
                "background": {"asset": "bg.png"},
                "layers": [],
            }
        ],
    }
    import json

    (tmp_path / "timeline.json").write_text(json.dumps(timeline_json))
    timeline = load_timeline(tmp_path / "timeline.json")
    assert timeline.scenes[0].total_frames == 42


def test_duration_requires_exactly_one_mode():
    raw = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 10, "from_audio": "a.wav"},
                "background": {"asset": "bg.png"},
                "layers": [],
            }
        ],
    }
    with pytest.raises(Exception):
        validate_timeline(raw)


def _png_1x1() -> bytes:
    import cv2
    import numpy as np

    ok, buf = cv2.imencode(".png", np.zeros((1, 1, 3), dtype=np.uint8))
    assert ok
    return buf.tobytes()
