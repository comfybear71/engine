"""frame_step ("on Ns" cut-out cadence): the compositor must only recompute
on every Nth frame and re-emit the exact same canvas object on held frames,
never recomposing in between."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor import compositor as compositor_module
from compositor.asset_cache import AssetCache
from compositor.timeline_loader import Background, Scene


def _tiny_bg(tmp_path: Path) -> Path:
    path = tmp_path / "bg.png"
    cv2.imwrite(str(path), np.zeros((20, 20, 3), dtype=np.uint8))
    return path


def _scene(bg_path: Path, total_frames: int, frame_step: int) -> Scene:
    return Scene(
        id="s1",
        total_frames=total_frames,
        background=Background(asset=bg_path),
        layers=[],
        frame_step=frame_step,
    )


def test_frame_step_1_recomputes_every_frame(tmp_path):
    scene = _scene(_tiny_bg(tmp_path), total_frames=10, frame_step=1)
    frames = list(compositor_module.iter_scene_frames(scene, 20, 20, 24, AssetCache()))

    assert len(frames) == 10
    # frame_step=1 (the default/normal case): every frame is its own
    # recomputed canvas object, none are held/reused.
    assert len({id(f) for f in frames}) == 10


def test_frame_step_holds_and_reuses_the_same_canvas_object(tmp_path):
    scene = _scene(_tiny_bg(tmp_path), total_frames=10, frame_step=3)
    frames = list(compositor_module.iter_scene_frames(scene, 20, 20, 24, AssetCache()))

    assert len(frames) == 10
    # Recompute frames: 0, 3, 6, 9 -> 4 distinct underlying arrays.
    assert len({id(f) for f in frames}) == 4

    # Held frames are the *same object* (not just equal) as the most recent
    # recomputed frame -- i.e. genuinely re-sent, not recomposed.
    assert frames[1] is frames[0]
    assert frames[2] is frames[0]
    assert frames[4] is frames[3]
    assert frames[5] is frames[3]
    assert frames[7] is frames[6]
    assert frames[8] is frames[6]
    assert frames[9] is not frames[6]


def test_frame_step_only_invokes_draw_layer_on_key_frames(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        compositor_module, "_draw_layer",
        lambda canvas, layer, cache, local_frame, fps: calls.append(local_frame),
    )

    from compositor.timeline_loader import Layer, Transform

    layer = Layer(id="l1", asset=Path("x.png"), z=0, transform=Transform(x=0, y=0, anchor="top-left"))
    scene = _scene(_tiny_bg(tmp_path), total_frames=10, frame_step=4)
    object.__setattr__(scene, "layers", [layer])  # Scene is frozen; patch for this test

    list(compositor_module.iter_scene_frames(scene, 20, 20, 24, AssetCache()))

    # Recompute frames at 0, 4, 8 -> exactly 3 calls, not 10.
    assert calls == [0, 4, 8]


def test_default_frame_step_is_one():
    assert Scene(id="s", total_frames=5, background=Background(asset=Path("bg.png")), layers=[]).frame_step == 1
