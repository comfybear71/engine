"""Flipbook (``sequence``) layers: frame choice, CLI render, and JS/Python lock."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor.asset_cache import AssetCache
from compositor.compositor import compose_frame
from compositor.preview_graph import dump_preview_graph, evaluate_draw_ops
from compositor.sequence import FrameSequence, sequence_frame_index
from compositor.timeline_loader import Background, Canvas, Layer, Scene, Timeline, Transform, TransformKeyframe

from .test_preview_graph import _round_cmd, js_evaluate


def _png(path: Path, w: int, h: int, bgr: tuple[int, int, int]) -> Path:
    cv2.imwrite(str(path), np.full((h, w, 3), bgr, dtype=np.uint8))
    return path


def _timeline(tmp_path: Path, *, trim_in: float = 0.0, fps: float = 12.0) -> Timeline:
    bg = _png(tmp_path / "bg.png", 40, 40, (10, 20, 30))
    shades = [(0, 0, 40 * (i + 1)) for i in range(5)]
    frames = tuple(_png(tmp_path / f"f_{i + 1:04d}.png", 8, 8, shade) for i, shade in enumerate(shades))
    layer = Layer(
        id="clip",
        asset=frames[0],
        z=0,
        transform=Transform(x=20, y=30, scale=1.0, anchor="bottom-center"),
        start_frame=4,
        end_frame=20,
        sequence=FrameSequence(frames=frames, fps=fps, trim_in=trim_in),
    )
    return Timeline(
        series="Test",
        episode="1",
        fps=24,
        canvas=Canvas(width=40, height=40),
        scenes=[Scene(id="s1", total_frames=24, background=Background(asset=bg), layers=[layer])],
        project_dir=tmp_path,
    )


def test_frame_index_follows_playback_rate_trim_and_clamps(tmp_path):
    seq = _timeline(tmp_path).scenes[0].layers[0].sequence
    assert [sequence_frame_index(seq, f, 24) for f in (0, 1, 2, 3, 4, 100)] == [0, 0, 1, 1, 2, 4]
    trimmed = FrameSequence(frames=seq.frames, fps=12.0, trim_in=0.25)
    assert sequence_frame_index(trimmed, 0, 24) == 3


def test_cli_render_draws_the_sequence_frame(tmp_path):
    timeline = _timeline(tmp_path)
    layer = timeline.scenes[0].layers[0]
    # local frame 4 -> 4 / 24 s * 12 fps = frame index 2
    drawn = compose_frame(timeline, layer.start_frame + 4)
    assert drawn[26, 20, 2] == 120
    first = compose_frame(timeline, layer.start_frame)
    assert first[26, 20, 2] == 40


def test_render_keeps_one_decoded_frame_per_sequence(tmp_path):
    timeline = _timeline(tmp_path)
    cache = AssetCache()
    from compositor.compositor import compose_scene_frame

    scene = timeline.scenes[0]
    for local in range(4, 20):
        compose_scene_frame(scene, local, 40, 40, 24, cache)
    assert len([k for k in cache._raw if "f_" in k]) == 1


def test_draw_ops_match_js_for_sequence_layers(tmp_path):
    timeline = _timeline(tmp_path, trim_in=0.25)
    graph = dump_preview_graph(timeline)
    layer = graph["scenes"][0]["layers"][0]
    assert layer["rel"] == "f_0001.png"
    assert layer["sequence"]["files"][2] == "f_0003.png"
    frames = [3, 4, 5, 6, 8, 12, 19, 22]
    js_frames = js_evaluate(graph, frames)
    for index, frame in enumerate(frames):
        py = evaluate_draw_ops(timeline, frame)
        assert [_round_cmd(c) for c in js_frames[index]["commands"]] == [
            _round_cmd(c) for c in py["commands"]
        ]
    inside = evaluate_draw_ops(timeline, 4)["commands"][1]
    assert inside["rel"] == "f_0004.png"


def test_flipbook_layer_travels_with_transform_keyframes(tmp_path):
    """[Clip: ... x=-20 to=centre over=...] emits keyframes on the flipbook layer."""

    timeline = _timeline(tmp_path)
    layer = timeline.scenes[0].layers[0]
    layer = Layer(
        id=layer.id,
        asset=layer.asset,
        z=layer.z,
        transform=Transform(x=-20, y=30, scale=1.0, anchor="bottom-center"),
        start_frame=layer.start_frame,
        end_frame=layer.end_frame,
        sequence=layer.sequence,
        transform_keyframes=[
            TransformKeyframe(frame=0, x=-20, y=30, scale=1.0),
            TransformKeyframe(frame=12, x=20, y=30, scale=1.0),
        ],
    )
    timeline = Timeline(
        series=timeline.series,
        episode=timeline.episode,
        fps=timeline.fps,
        canvas=timeline.canvas,
        scenes=[Scene(id="s1", total_frames=24, background=timeline.scenes[0].background, layers=[layer])],
        project_dir=tmp_path,
    )

    def red_columns(frame_index):
        drawn = compose_frame(timeline, frame_index)
        return np.where((drawn[:, :, 2] > 30).any(axis=0))[0]

    assert red_columns(layer.start_frame).size == 0
    mid = red_columns(layer.start_frame + 6)
    assert mid.size > 0 and mid.max() < 20
    end = red_columns(layer.start_frame + 12)
    assert end.min() == 16 and end.max() == 23

    graph = dump_preview_graph(timeline)
    frames = [4, 6, 10, 16, 19]
    js_frames = js_evaluate(graph, frames)
    for index, frame in enumerate(frames):
        py = evaluate_draw_ops(timeline, frame)
        assert [_round_cmd(c) for c in js_frames[index]["commands"]] == [_round_cmd(c) for c in py["commands"]]
