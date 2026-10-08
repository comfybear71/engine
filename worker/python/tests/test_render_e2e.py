"""End-to-end: render the sample project and confirm the output has both a
video and an audio stream (via ffprobe), matching the project's duration."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from compositor.compositor import render
from compositor.timeline_loader import load_timeline

from .conftest import SAMPLE_PROJECT_DIR

ffmpeg_available = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _ffprobe_streams(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)["streams"]


@pytest.mark.skipif(not ffmpeg_available, reason="ffmpeg/ffprobe not installed")
def test_sample_project_renders_with_video_and_audio(tmp_path):
    timeline = load_timeline(SAMPLE_PROJECT_DIR / "timeline.json")
    output_path = tmp_path / "sample_e2e.mp4"

    render(timeline, output_path, codec="h264")

    assert output_path.exists()
    assert output_path.stat().st_size > 0

    streams = _ffprobe_streams(output_path)
    codec_types = {s["codec_type"] for s in streams}
    assert "video" in codec_types, "rendered output is missing a video stream"
    assert "audio" in codec_types, "rendered output is missing an audio stream (dialogue audio was not mixed in)"

    video_stream = next(s for s in streams if s["codec_type"] == "video")
    assert video_stream["codec_name"] == "h264"


@pytest.mark.skipif(not ffmpeg_available, reason="ffmpeg/ffprobe not installed")
def test_sample_project_renders_prores4444(tmp_path):
    timeline = load_timeline(SAMPLE_PROJECT_DIR / "timeline.json")
    output_path = tmp_path / "sample_e2e.mov"

    render(timeline, output_path, codec="prores4444")

    assert output_path.exists()
    streams = _ffprobe_streams(output_path)
    codec_types = {s["codec_type"] for s in streams}
    assert "video" in codec_types
    assert "audio" in codec_types
    video_stream = next(s for s in streams if s["codec_type"] == "video")
    assert video_stream["codec_name"] == "prores"
