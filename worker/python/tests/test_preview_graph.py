"""Preview graph dump + JS/Python draw-list lock + 480p compose match."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.compositor import compose_frame, scale_frame
from compositor.preview_graph import background_dest_rect, dump_preview_graph, evaluate_draw_ops, rasterize_commands
from compositor.preview_server import handle
from compositor.slots import Slot, SlotKeyframe
from compositor.timeline_loader import Background, Canvas, Child, Layer, Scene, Timeline, Transform

SHARED = Path(__file__).resolve().parents[3] / "shared" / "placement.js"


def _png(path: Path, w: int, h: int, bgr: tuple[int, int, int]) -> Path:
    cv2.imwrite(str(path), np.full((h, w, 3), bgr, dtype=np.uint8))
    return path


def _rig_timeline(tmp_path: Path, frames: int = 48) -> Timeline:
    bg = _png(tmp_path / "bg.png", 40, 40, (10, 20, 30))
    body = _png(tmp_path / "body.png", 20, 30, (0, 0, 200))
    arm = _png(tmp_path / "arm.png", 8, 16, (0, 200, 0))
    mouth_a = _png(tmp_path / "mouth_a.png", 6, 4, (0, 255, 255))
    mouth_x = _png(tmp_path / "mouth_x.png", 6, 4, (255, 255, 0))
    mouth = Slot(
        images={"A": mouth_a, "X": mouth_x},
        offset_x=0,
        offset_y=-8,
        keyframes=[SlotKeyframe(frame=0, drawing="X"), SlotKeyframe(frame=12, drawing="A")],
    )
    child = Child(id="arm", asset=arm, z=1, offset_x=10, offset_y=-20, slots={"mouth": mouth})
    layer = Layer(
        id="rig",
        asset=body,
        z=0,
        transform=Transform(x=20, y=36, scale=1.0, anchor="bottom-center"),
        children=[child],
        slots={},
    )
    return Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=40, height=40),
        scenes=[
            Scene(
                id="s1",
                total_frames=frames,
                background=Background(asset=bg),
                layers=[layer],
            )
        ],
        project_dir=tmp_path,
    )


def _round_cmd(cmd: dict) -> dict:
    out = dict(cmd)
    for key in ("x", "y", "scale", "rotation", "opacity", "cx", "cy", "zoom", "originX", "originY", "sx", "sy"):
        if key in out and out[key] is not None:
            out[key] = round(float(out[key]), 3)
    if out.get("pivot"):
        out["pivot"] = [round(float(v), 3) for v in out["pivot"]]
    return out


def js_evaluate(graph: dict, frames: list[int]) -> list[dict]:
    script = (
        "import { readFileSync } from 'fs';"
        "import { evaluateFrame } from './placement.js';"
        "const {graph, frames} = JSON.parse(readFileSync(0, 'utf8'));"
        "process.stdout.write(JSON.stringify(frames.map((f) => evaluateFrame(graph, f))));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps({"graph": graph, "frames": frames}),
        cwd=str(SHARED.parent),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"js evaluate failed: {result.stderr}\n{result.stdout}")
    return json.loads(result.stdout)


def test_dump_graph_lists_rels_and_sizes(tmp_path):
    timeline = _rig_timeline(tmp_path)
    graph = dump_preview_graph(timeline)
    assert graph["fps"] == 24
    assert graph["totalFrames"] == 48
    assert graph["canvas"] == {"width": 40, "height": 40}
    layer = graph["scenes"][0]["layers"][0]
    assert layer["rel"] == "body.png"
    assert layer["width"] == 20
    assert layer["children"][0]["rel"] == "arm.png"
    assert "mouth" in layer["children"][0]["slots"]


def test_draw_ops_match_js_and_rasterize_matches_cli(tmp_path):
    timeline = _rig_timeline(tmp_path)
    graph = dump_preview_graph(timeline)
    frames = [0, 12, 24]
    js_frames = js_evaluate(graph, frames)
    for index, frame in enumerate(frames):
        py = evaluate_draw_ops(timeline, frame)
        js = js_frames[index]
        assert js["frame"] == frame
        assert [_round_cmd(c) for c in js["commands"]] == [_round_cmd(c) for c in py["commands"]]
        cli = compose_frame(timeline, frame)
        drawn = rasterize_commands(py["commands"], tmp_path, 40, 40)
        assert drawn.shape == cli.shape
        assert np.array_equal(drawn, cli)


def test_preview_server_graph_command(tmp_path):
    _rig_timeline(tmp_path)
    raw = {
        "series": "Test",
        "episode": "1",
        "fps": 24,
        "canvas": {"width": 40, "height": 40},
        "scenes": [
            {
                "id": "s1",
                "duration": {"frames": 8},
                "background": {"asset": "bg.png"},
                "layers": [],
            }
        ],
    }
    tl_path = tmp_path / "timeline.json"
    tl_path.write_text(json.dumps(raw))
    result = handle({"id": 9, "cmd": "graph", "projectDir": str(tmp_path), "timeline": str(tl_path)})
    assert result["ok"] is True
    assert result["graph"]["totalFrames"] == 8
    assert result["graph"]["scenes"][0]["background"]["rel"] == "bg.png"


def test_js_evaluate_720_frames_stays_realtime(tmp_path):
    timeline = _rig_timeline(tmp_path, frames=720)
    graph = dump_preview_graph(timeline)
    started = time.perf_counter()
    js_evaluate(graph, list(range(0, 720, 2)))
    elapsed = time.perf_counter() - started
    assert elapsed < 2.0, f"evaluateFrame of 360 samples took {elapsed:.3f}s"


def test_480p_preview_is_cli_scale_frame(tmp_path):
    timeline = _rig_timeline(tmp_path)
    cli = compose_frame(timeline, 0)
    preview = compose_frame(timeline, 0, width=20, height=20)
    assert np.array_equal(preview, scale_frame(cli, 20, 20))


def test_background_dest_rect_matches_js_cover_and_contain(tmp_path):
    bg = _png(tmp_path / "wide_bg.png", 80, 40, (10, 20, 30))
    timeline = Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=40, height=40),
        scenes=[
            Scene(
                id="s1",
                total_frames=8,
                background=Background(asset=bg, fit="cover"),
                layers=[],
            )
        ],
        project_dir=tmp_path,
    )
    graph = dump_preview_graph(timeline)
    js = js_evaluate(graph, [0])[0]
    py = evaluate_draw_ops(timeline, 0)
    js_bg = next(cmd for cmd in js["commands"] if cmd["kind"] == "bg")
    py_bg = next(cmd for cmd in py["commands"] if cmd["kind"] == "bg")

    script = (
        "import { readFileSync } from 'fs';"
        "import { backgroundDestRect } from './placement.js';"
        "const {cmd, w, h} = JSON.parse(readFileSync(0, 'utf8'));"
        "process.stdout.write(JSON.stringify(backgroundDestRect(cmd, w, h)));"
    )
    import subprocess as _sp

    result = _sp.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps({"cmd": js_bg, "w": 40, "h": 40}),
        cwd=str(SHARED.parent),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    js_box = json.loads(result.stdout)
    py_box = background_dest_rect(py_bg, 40, 40)
    assert [round(js_box[k], 3) for k in ("x", "y", "w", "h")] == [round(py_box[k], 3) for k in ("x", "y", "w", "h")]
    assert py_box["w"] == 80
    assert py_box["h"] == 40
    assert py_box["x"] == -20


def test_curtain_16x9_dest_rect_fills_canvas(tmp_path):
    bg = _png(tmp_path / "curtain.png", 1920, 1080, (80, 40, 120))
    timeline = Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=1920, height=1080),
        scenes=[
            Scene(
                id="s1",
                total_frames=1,
                background=Background(asset=bg, fit="cover"),
                layers=[],
            )
        ],
        project_dir=tmp_path,
    )
    py = evaluate_draw_ops(timeline, 0)
    py_bg = next(cmd for cmd in py["commands"] if cmd["kind"] == "bg")
    box = background_dest_rect(py_bg, 1920, 1080)
    assert box["x"] == 0
    assert box["y"] == 0
    assert box["w"] == 1920
    assert box["h"] == 1080
    frame = compose_frame(timeline, 0)
    assert frame.shape[:2] == (1080, 1920)
    assert tuple(int(v) for v in frame[0, 0]) == (80, 40, 120)
    assert tuple(int(v) for v in frame[1079, 1919]) == (80, 40, 120)
