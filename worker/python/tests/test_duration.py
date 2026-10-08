"""Audio-derived duration: scenes/layers can derive their frame length from
an audio file's duration instead of only a hand-typed frame count."""

from __future__ import annotations

import pytest

from compositor.media_probe import probe_duration_seconds
from compositor.timeline_loader import load_timeline
from compositor.schema_validate import validate_timeline

from .conftest import write_png_1x1, write_wav


def test_probe_duration_seconds_matches_written_wav(tmp_path):
    wav_path = tmp_path / "tone.wav"
    write_wav(wav_path, 1.5)
    duration = probe_duration_seconds(wav_path)
    assert duration == pytest.approx(1.5, abs=0.02)


def test_probe_missing_file_raises(tmp_path):
    with pytest.raises(RuntimeError):
        probe_duration_seconds(tmp_path / "nope.wav")


def test_hand_set_frames_still_supported(tmp_path):
    write_png_1x1(tmp_path / "bg.png")
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
