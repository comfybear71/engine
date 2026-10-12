"""End-to-end: render the sample project and confirm the output has both a
video and an audio stream (via ffprobe), matching the project's duration."""

from __future__ import annotations

import json
import shutil
import subprocess

import cv2
import numpy as np
import pytest

from compositor.asset_cache import AssetCache
from compositor.compositor import compose_scene_frame, render
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


def _solid_png(path, w, h, bgr):
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0], img[:, :, 1], img[:, :, 2], img[:, :, 3] = bgr[0], bgr[1], bgr[2], 255
    cv2.imwrite(str(path), img)


def test_one_second_walk_renders_with_head_slots(tmp_path):
    """A 1s walk still draws head slots (eyes) on top of the limb rig."""

    _solid_png(tmp_path / "bg.png", 80, 80, (20, 20, 20))
    _solid_png(tmp_path / "body.png", 8, 8, (40, 40, 40))
    _solid_png(tmp_path / "eyes_open.png", 10, 10, (0, 255, 0))
    _solid_png(tmp_path / "thigh.png", 6, 20, (0, 0, 200))

    cycle = [0, 15, 25, 15, 0, -15, -25, -15, 0, 10, 20, 10]
    doc = {
        "series": "Test",
        "episode": "walk",
        "fps": 24,
        "canvas": {"width": 80, "height": 80},
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 24},
                "background": {"asset": "bg.png"},
                "layers": [
                    {
                        "id": "rodney",
                        "asset": "body.png",
                        "z": 1,
                        "transform": {"x": 10, "y": 40, "anchor": "top-left", "scale": 1},
                        "transform_keyframes": [
                            {"frame": i, "x": 10 + i * 2, "y": 40, "ease": "linear"} for i in range(25)
                        ],
                        "slots": {
                            "eyes": {
                                "offset": {"x": 20, "y": 0},
                                "images": {"open": "eyes_open.png"},
                                "keyframes": [{"frame": 0, "drawing": "open"}],
                            }
                        },
                        "children": [
                            {
                                "id": "right_thigh",
                                "asset": "thigh.png",
                                "z": 1,
                                "offset": {"x": 0, "y": 8},
                                "pivot": {"x": 3, "y": 0},
                                "rotation_keyframes": [
                                    {"frame": i, "rotation": cycle[i % 12], "ease": "linear"}
                                    for i in range(25)
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    }
    (tmp_path / "timeline.json").write_text(json.dumps(doc))
    timeline = load_timeline(tmp_path / "timeline.json")
    frame = compose_scene_frame(timeline.scenes[0], 12, 80, 80, 24, AssetCache())
    greens = np.all(frame == (0, 255, 0), axis=2)
    assert greens.any(), "expected head-slot (eyes) pixels on the 1s walk frame"
