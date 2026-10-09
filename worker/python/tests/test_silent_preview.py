"""Silent previews: a dialogue clip with no WAV yet still renders.

Uses the estimated length stored on the clip (or in lines.json), holds
the mouth on rest shape X, and always writes one audio stream covering
the full scene length (generated silence -- never drop the audio track).
"""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from compositor.compositor import render
from compositor.ffmpeg_writer import build_ffmpeg_cmd
from compositor.slots import active_drawing
from compositor.timeline_loader import AudioClip, load_timeline

from .conftest import write_png_1x1, write_wav

ffmpeg_available = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _mouth_images(tmp_path):
    for shape in ("A", "B", "C", "D", "E", "F", "G", "H", "X"):
        write_png_1x1(tmp_path / f"{shape}.png")
    return {s: f"{s}.png" for s in ("A", "B", "C", "D", "E", "F", "G", "H", "X")}


def _write_timeline(tmp_path, scene_raw, fps=24, canvas=None):
    doc = {
        "series": "Test",
        "episode": "1",
        "fps": fps,
        "scenes": [scene_raw],
    }
    if canvas is not None:
        doc["canvas"] = canvas
    (tmp_path / "timeline.json").write_text(json.dumps(doc))
    return tmp_path / "timeline.json"


def _tiny_estimated_scene(tmp_path, *, estimated_seconds=1.0, frames=36, fps=24, with_mouth=True):
    write_png_1x1(tmp_path / "bg.png")
    write_png_1x1(tmp_path / "body.png")
    images = _mouth_images(tmp_path) if with_mouth else None
    layer = {
        "id": "hicks",
        "asset": "body.png",
        "z": 1,
        "transform": {"x": 0, "y": 0, "anchor": "top-left"},
        "dialogue": [
            {
                "audio": "missing.wav",
                "start_frame": 0,
                "text": "Where is the rent?",
                "estimated": True,
                "estimated_duration_seconds": estimated_seconds,
            }
        ],
    }
    if with_mouth:
        layer["slots"] = {
            "mouth": {"images": images, "lipsync": {"source": "dialogue"}},
        }
    return {
        "id": "s1",
        "duration": {"frames": frames},
        "background": {"asset": "bg.png"},
        "layers": [layer],
    }


def _ffprobe_json(path, extra_args):
    result = subprocess.run(
        ["ffprobe", "-v", "error", *extra_args, "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


class TestEstimatedClipLoad:
    def test_missing_audio_uses_estimated_duration_stored_on_clip(self, tmp_path):
        scene = _tiny_estimated_scene(tmp_path, estimated_seconds=1.25)
        timeline = load_timeline(_write_timeline(tmp_path, scene, fps=24))
        clip = timeline.scenes[0].layers[0].dialogue[0]

        assert clip.estimated is True
        assert clip.duration_frames == 30  # round(1.25 * 24)
        assert clip.cues == []
        assert timeline.all_audio_clips() == []
        assert timeline.dialogue_line_counts() == (1, 1)

    def test_missing_audio_falls_back_to_lines_json(self, tmp_path):
        write_png_1x1(tmp_path / "bg.png")
        write_png_1x1(tmp_path / "body.png")
        (tmp_path / "lines.json").write_text(json.dumps({
            "lines": [
                {
                    "scene_id": "s1",
                    "line_number": 1,
                    "character": "hicks",
                    "text": "Hello there friend.",
                    "audio_path": "still_missing.wav",
                    "status": "missing",
                    "estimated_duration_seconds": 0.5,
                }
            ]
        }))
        scene = {
            "id": "s1",
            "duration": {"from_dialogue": True, "padding_frames": 6},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {"audio": "still_missing.wav", "start_frame": 0, "text": "Hello there friend."},
                    ],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene, fps=24))
        clip = timeline.scenes[0].layers[0].dialogue[0]
        assert clip.estimated is True
        assert clip.duration_frames == 12  # 0.5s @ 24fps
        # from_dialogue: 12 + padding 6
        assert timeline.scenes[0].total_frames == 18

    def test_real_wav_still_wins_over_estimated_flag(self, tmp_path):
        write_png_1x1(tmp_path / "bg.png")
        write_png_1x1(tmp_path / "body.png")
        write_wav(tmp_path / "real.wav", 0.75)
        scene = {
            "id": "s1",
            "duration": {"frames": 40},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {
                            "audio": "real.wav",
                            "start_frame": 0,
                            "estimated": True,
                            "estimated_duration_seconds": 9.9,
                        }
                    ],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene, fps=24))
        clip = timeline.scenes[0].layers[0].dialogue[0]
        assert clip.estimated is False
        assert clip.duration_frames == 18  # 0.75s @ 24fps, not the 9.9s estimate


class TestEstimatedMouthStaysX:
    def test_mouth_is_x_for_the_whole_estimated_clip(self, tmp_path):
        scene = _tiny_estimated_scene(tmp_path, estimated_seconds=1.0, frames=48)
        timeline = load_timeline(_write_timeline(tmp_path, scene, fps=24))
        mouth = timeline.scenes[0].layers[0].slots["mouth"]

        # Clip occupies frames [0, 24). Empty cues => idle X for every frame
        # inside the window, and also in the gap after it.
        assert active_drawing(mouth, 0, fps=24) == "X"
        assert active_drawing(mouth, 12, fps=24) == "X"
        assert active_drawing(mouth, 23, fps=24) == "X"
        assert active_drawing(mouth, 30, fps=24) == "X"


class TestAlwaysFullLengthAudioStream:
    def test_ffmpeg_cmd_always_includes_silence_bed(self, tmp_path):
        cmd = build_ffmpeg_cmd(
            tmp_path / "out.mp4",
            width=16, height=16, fps=24, codec="h264",
            audio_clips=[],
            duration_seconds=1.5,
        )
        assert "anullsrc=channel_layout=stereo:sample_rate=44100" in cmd
        assert "[aout]" in cmd
        assert "-c:a" in cmd

        cmd_with_real = build_ffmpeg_cmd(
            tmp_path / "out.mp4",
            width=16, height=16, fps=24, codec="h264",
            audio_clips=[AudioClip(path=tmp_path / "line.wav", start_seconds=0.25)],
            duration_seconds=1.5,
        )
        joined = " ".join(cmd_with_real)
        assert "anullsrc" in joined
        assert "adelay=250:all=1" in joined

    @pytest.mark.skipif(not ffmpeg_available, reason="ffmpeg/ffprobe not installed")
    def test_missing_audio_still_renders_with_matching_audio_stream(self, tmp_path, capsys):
        scene = _tiny_estimated_scene(
            tmp_path, estimated_seconds=1.0, frames=24, fps=12, with_mouth=True
        )
        timeline = load_timeline(_write_timeline(
            tmp_path, scene, fps=12, canvas={"width": 16, "height": 16}
        ))
        output_path = tmp_path / "silent_preview.mp4"
        render(timeline, output_path, codec="h264")

        assert output_path.exists()
        assert output_path.stat().st_size > 0

        printed = capsys.readouterr().out
        assert "1 of 1 lines are estimated/silent" in printed

        streams = _ffprobe_json(
            output_path,
            ["-show_entries", "stream=codec_type,codec_name,duration"],
        )["streams"]
        codec_types = {s["codec_type"] for s in streams}
        assert "video" in codec_types
        assert "audio" in codec_types, "silent preview must still have an audio stream"

        fmt = _ffprobe_json(output_path, ["-show_entries", "format=duration"])
        scene_seconds = timeline.total_frames / float(timeline.fps)
        assert float(fmt["format"]["duration"]) == pytest.approx(scene_seconds, abs=0.15)

    @pytest.mark.skipif(not ffmpeg_available, reason="ffmpeg/ffprobe not installed")
    def test_scene_with_no_dialogue_still_has_full_length_audio(self, tmp_path):
        write_png_1x1(tmp_path / "bg.png")
        scene = {
            "id": "s1",
            "duration": {"frames": 12},
            "background": {"asset": "bg.png"},
            "layers": [],
        }
        timeline = load_timeline(_write_timeline(
            tmp_path, scene, fps=12, canvas={"width": 16, "height": 16}
        ))
        output_path = tmp_path / "no_dialogue.mp4"
        render(timeline, output_path, codec="h264")

        streams = _ffprobe_json(
            output_path,
            ["-show_entries", "stream=codec_type"],
        )["streams"]
        assert {s["codec_type"] for s in streams} >= {"video", "audio"}

        fmt = _ffprobe_json(output_path, ["-show_entries", "format=duration"])
        scene_seconds = timeline.total_frames / float(timeline.fps)
        assert float(fmt["format"]["duration"]) == pytest.approx(scene_seconds, abs=0.15)
