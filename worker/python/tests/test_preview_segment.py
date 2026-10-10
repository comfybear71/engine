from pathlib import Path

import cv2
import numpy as np

from compositor.compositor import compose_frame
from compositor.ffmpeg_writer import write_preview_segment
from compositor.preview_server import handle
from compositor.timeline_loader import Background, Canvas, Scene, Timeline


def _timeline(tmp_path: Path) -> Timeline:
    bg = tmp_path / "bg.png"
    cv2.imwrite(str(bg), np.full((20, 20, 3), (0, 0, 255), dtype=np.uint8))
    return Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=20, height=20),
        scenes=[Scene(id="s1", total_frames=6, background=Background(asset=bg), layers=[])],
        project_dir=tmp_path,
    )


def test_write_preview_segment_makes_an_mp4(tmp_path):
    timeline = _timeline(tmp_path)
    frames = [compose_frame(timeline, i, width=16, height=16) for i in range(3)]
    out = tmp_path / "seg.mp4"
    write_preview_segment(frames, out, 16, 16, 24)
    assert out.exists()
    assert out.stat().st_size > 32


def test_preview_server_segment_command(tmp_path):
    _timeline(tmp_path)
    tl_path = tmp_path / "timeline.json"
    raw = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "canvas": {"width": 20, "height": 20},
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 6},
                "background": {"asset": "bg.png"},
                "layers": [],
            }
        ],
    }
    import json

    tl_path.write_text(json.dumps(raw))
    out = tmp_path / "window.mp4"
    result = handle(
        {
            "id": 1,
            "cmd": "segment",
            "projectDir": str(tmp_path),
            "timeline": str(tl_path),
            "startFrame": 0,
            "frames": 3,
            "width": 16,
            "height": 16,
            "output": str(out),
        }
    )
    assert result["ok"] is True
    assert result["frames"] == 3
    assert out.exists()
