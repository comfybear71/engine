"""Cue parsing, cue-to-mouth-frame mapping, and the Rhubarb fallback chain."""

from __future__ import annotations

import json
import warnings

import pytest

from compositor import lipsync


def _write_cues(path, cues):
    data = {"metadata": {"duration": cues[-1]["end"] if cues else 0}, "mouthCues": cues}
    path.write_text(json.dumps(data))


def test_load_cues_file_parses_and_sorts(tmp_path):
    cues_path = tmp_path / "cues.json"
    _write_cues(
        cues_path,
        [
            {"start": 1.0, "end": 2.0, "value": "B"},
            {"start": 0.0, "end": 1.0, "value": "X"},
        ],
    )
    cues = lipsync.load_cues_file(cues_path)
    assert [c.shape for c in cues] == ["X", "B"]
    assert cues[0].start == 0.0 and cues[0].end == 1.0


class TestCueToMouthFrameMapping:
    def setup_method(self):
        self.cues = [
            lipsync.MouthCue(start=0.0, end=0.5, shape="X"),
            lipsync.MouthCue(start=0.5, end=1.0, shape="B"),
            lipsync.MouthCue(start=1.0, end=1.5, shape="C"),
        ]

    def test_exact_start_boundary(self):
        assert lipsync.shape_at_time(self.cues, 0.5) == "B"

    def test_mid_cue(self):
        assert lipsync.shape_at_time(self.cues, 0.25) == "X"
        assert lipsync.shape_at_time(self.cues, 1.25) == "C"

    def test_before_first_cue_defaults_to_idle(self):
        assert lipsync.shape_at_time(self.cues, -0.1) == lipsync.DEFAULT_SHAPE

    def test_after_last_cue_defaults_to_idle(self):
        assert lipsync.shape_at_time(self.cues, 5.0) == lipsync.DEFAULT_SHAPE

    def test_empty_cues_always_idle(self):
        assert lipsync.shape_at_time([], 0.3) == lipsync.DEFAULT_SHAPE

    def test_frame_to_time_mapping_at_24fps(self):
        fps = 24
        # frame 11 at 24fps -> t = 11/24 ~= 0.458s -> within the first cue (X).
        t = 11 / fps
        assert lipsync.shape_at_time(self.cues, t) == "X"
        # frame 15 -> t = 0.625s -> within the second cue (B).
        t = 15 / fps
        assert lipsync.shape_at_time(self.cues, t) == "B"


class TestGetCuesResolutionOrder:
    def test_uses_committed_cues_file_when_present(self, tmp_path, monkeypatch):
        cues_path = tmp_path / "line.rhubarb.json"
        _write_cues(cues_path, [{"start": 0.0, "end": 1.0, "value": "A"}])

        def _boom(*a, **k):
            raise AssertionError("run_rhubarb must not be called when a cues file already exists")

        monkeypatch.setattr(lipsync, "run_rhubarb", _boom)

        config = {"cues": "line.rhubarb.json", "audio": "line.wav"}
        cues = lipsync.get_cues(config, tmp_path)
        assert [c.shape for c in cues] == ["A"]

    def test_runs_rhubarb_when_cues_missing_and_binary_available(self, tmp_path, monkeypatch):
        audio_path = tmp_path / "line.wav"
        audio_path.write_bytes(b"not-really-a-wav")
        expected_cues_path = tmp_path / "line.wav.rhubarb.json"

        def fake_run_rhubarb(audio, output_json_path, dialogue_text=None, rhubarb_bin=None):
            assert output_json_path == expected_cues_path
            _write_cues(output_json_path, [{"start": 0.0, "end": 1.0, "value": "D"}])
            return output_json_path

        monkeypatch.setattr(lipsync, "run_rhubarb", fake_run_rhubarb)
        monkeypatch.setattr(lipsync, "find_rhubarb_binary", lambda: "/usr/bin/rhubarb")

        config = {"audio": "line.wav"}
        cues = lipsync.get_cues(config, tmp_path)
        assert [c.shape for c in cues] == ["D"]

    def test_missing_binary_falls_back_cleanly_with_warning_not_exception(self, tmp_path, monkeypatch):
        """High-priority requirement: a missing rhubarb binary must never
        hard-error and halt the render. It must warn and degrade to the
        idle mouth shape instead."""

        audio_path = tmp_path / "line.wav"
        audio_path.write_bytes(b"not-really-a-wav")

        monkeypatch.setattr(lipsync, "find_rhubarb_binary", lambda: None)

        def _boom(*a, **k):
            raise AssertionError("run_rhubarb must not be invoked when no binary is available")

        monkeypatch.setattr(lipsync, "run_rhubarb", _boom)

        config = {"audio": "line.wav"}
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            cues = lipsync.get_cues(config, tmp_path)

        assert cues == []
        assert lipsync.shape_at_time(cues, 0.3) == lipsync.DEFAULT_SHAPE
        assert any("rhubarb" in str(w.message).lower() for w in caught)

    def test_missing_binary_still_prefers_existing_cues_file_if_one_appears(self, tmp_path, monkeypatch):
        # If both a cues path and audio are given and the cues file exists,
        # a missing binary is irrelevant: we never even look for rhubarb.
        cues_path = tmp_path / "cached.json"
        _write_cues(cues_path, [{"start": 0.0, "end": 2.0, "value": "H"}])
        monkeypatch.setattr(lipsync, "find_rhubarb_binary", lambda: None)

        config = {"cues": "cached.json", "audio": "line.wav"}
        cues = lipsync.get_cues(config, tmp_path)
        assert [c.shape for c in cues] == ["H"]

    def test_raises_on_missing_cues_and_no_audio_given(self, tmp_path):
        config = {"cues": "does_not_exist.json"}
        with pytest.raises(FileNotFoundError):
            lipsync.get_cues(config, tmp_path)

    def test_requires_cues_or_audio(self, tmp_path):
        with pytest.raises(ValueError):
            lipsync.get_cues({}, tmp_path)
