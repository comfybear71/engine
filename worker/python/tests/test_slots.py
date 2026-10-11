"""Generic drawing-swap slots: held-until-changed keyframes, and the
lipsync-driven case delegating to the same cue-to-shape mapping as before."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor import lipsync
from compositor.asset_cache import AssetCache
from compositor.compositor import _Placed, _draw_layer, _draw_slot
from compositor.slots import Slot, SlotKeyframe, active_drawing
from compositor.timeline_loader import Layer, Transform


def _slot_with_keyframes(keyframes):
    return Slot(
        images={"open": Path("open.png"), "fist": Path("fist.png")},
        keyframes=[SlotKeyframe(frame=f, drawing=d) for f, d in keyframes],
    )


def _write_bgra(path: Path, bgr: tuple[int, int, int], alpha: int = 255) -> Path:
    img = np.zeros((8, 8, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    cv2.imwrite(str(path), img)
    return path


def _owner(x: float = 40.0, y: float = 40.0) -> _Placed:
    return _Placed(
        z=0, x=x, y=y, scale=1.0, flip_x=False, rotation=0.0,
        opacity=1.0, anchor="center", asset=Path("unused.png"), slots={},
    )


def _has_color(canvas: np.ndarray, bgr: tuple[int, int, int]) -> bool:
    b, g, r = bgr
    return bool(np.any(
        (np.abs(canvas[:, :, 0].astype(int) - b) < 40)
        & (np.abs(canvas[:, :, 1].astype(int) - g) < 40)
        & (np.abs(canvas[:, :, 2].astype(int) - r) < 40)
    ))


class TestKeyframeDrivenSlot:
    def test_before_first_keyframe_is_hidden(self):
        slot = _slot_with_keyframes([(10, "fist"), (30, "open")])
        assert active_drawing(slot, 0, fps=24) == "none"
        assert active_drawing(slot, 9, fps=24) == "none"
        assert active_drawing(slot, 10, fps=24) == "fist"

    def test_exact_boundary_switches_immediately(self):
        slot = _slot_with_keyframes([(0, "open"), (10, "fist"), (30, "open")])
        assert active_drawing(slot, 9, fps=24) == "open"
        assert active_drawing(slot, 10, fps=24) == "fist"

    def test_held_until_next_change(self):
        slot = _slot_with_keyframes([(0, "open"), (10, "fist"), (30, "open")])
        for f in range(10, 30):
            assert active_drawing(slot, f, fps=24) == "fist"

    def test_after_last_keyframe_holds_last_drawing(self):
        slot = _slot_with_keyframes([(0, "open"), (10, "fist")])
        assert active_drawing(slot, 10_000, fps=24) == "fist"

    def test_a_blink_is_just_a_keyframed_slot(self):
        # One unified mechanism: a blink is open -> closed -> open, exactly
        # like a hand pose change, with no lipsync involved at all.
        slot = _slot_with_keyframes([(0, "open"), (34, "fist"), (38, "open")])
        assert active_drawing(slot, 20, fps=24) == "open"
        assert active_drawing(slot, 34, fps=24) == "fist"
        assert active_drawing(slot, 37, fps=24) == "fist"
        assert active_drawing(slot, 38, fps=24) == "open"


class TestLipsyncDrivenSlot:
    def test_mouth_is_just_a_cue_driven_slot(self):
        cues = [
            lipsync.MouthCue(start=0.0, end=0.5, shape="X"),
            lipsync.MouthCue(start=0.5, end=1.0, shape="D"),
        ]
        slot = Slot(images={"X": Path("x.png"), "D": Path("d.png")}, cues=cues)
        assert active_drawing(slot, 0, fps=24) == "X"  # t = 0/24
        # frame 13 at 24fps -> t ~= 0.542s -> within the second cue.
        assert active_drawing(slot, 13, fps=24) == "D"

    def test_excluded_h_falls_back_to_c(self):
        cues = [
            lipsync.MouthCue(start=0.0, end=0.5, shape="X"),
            lipsync.MouthCue(start=0.5, end=1.0, shape="H"),
        ]
        slot = Slot(
            images={"X": Path("x.png"), "C": Path("c.png"), "H": Path("h.png")},
            cues=cues,
            exclude_from_lipsync=frozenset({"H"}),
        )
        assert active_drawing(slot, 0, fps=24) == "X"
        assert active_drawing(slot, 13, fps=24) == "C"
        assert slot.resolve_image("H") == Path("h.png")


class TestSlotResolveImageFallback:
    def test_resolves_known_drawing(self):
        slot = Slot(images={"A": Path("a.png"), "X": Path("x.png")})
        assert slot.resolve_image("A") == Path("a.png")

    def test_falls_back_to_idle_shape_when_drawing_missing(self):
        slot = Slot(images={"A": Path("a.png"), "X": Path("x.png")})
        assert slot.resolve_image("Q") == Path("x.png")

    def test_falls_back_to_first_image_when_no_idle_shape_present(self):
        slot = Slot(images={"fist": Path("fist.png")})
        assert slot.resolve_image(None) == Path("fist.png")
        assert slot.resolve_image("nonexistent") == Path("fist.png")

    def test_no_images_returns_none(self):
        slot = Slot(images={})
        assert slot.resolve_image("A") is None

    def test_drawing_none_hides_the_slot(self):
        slot = Slot(
            images={"fist": Path("fist.png"), "X": Path("x.png")},
            keyframes=[SlotKeyframe(frame=0, drawing="none")],
        )
        assert active_drawing(slot, 0, fps=24) == "none"
        assert slot.resolve_image("none") is None

    def test_none_keyframe_returns_none_string(self):
        hide = Slot(
            images={"bloodshot": Path("bloodshot.png"), "open": Path("open.png")},
            keyframes=[SlotKeyframe(frame=0, drawing="none")],
        )
        missing = Slot(
            images={"bloodshot": Path("bloodshot.png"), "open": Path("open.png")},
            keyframes=[SlotKeyframe(frame=0, drawing=None)],
        )
        assert active_drawing(hide, 0, fps=24) == "none"
        assert active_drawing(missing, 0, fps=24) == "none"


class TestDrawSlotHide:
    def test_none_keyframe_draws_nothing(self, tmp_path):
        first = _write_bgra(tmp_path / "bloodshot.png", (0, 0, 255))
        other = _write_bgra(tmp_path / "open.png", (0, 255, 0))
        for drawing in (None, "none"):
            slot = Slot(
                images={"bloodshot": first, "open": other},
                keyframes=[SlotKeyframe(frame=0, drawing=drawing)],
            )
            assert active_drawing(slot, 0, fps=24) == "none"
            canvas = np.zeros((80, 80, 3), dtype=np.uint8)
            _draw_slot(canvas, AssetCache(), slot, _owner(), 0, 24, {"slot": "none"})
            assert not canvas.any()

    def test_future_first_keyframe_draws_nothing_until_it_arrives(self, tmp_path):
        bent = _write_bgra(tmp_path / "bent.png", (255, 0, 0))
        slot = Slot(
            images={"bent": bent},
            keyframes=[SlotKeyframe(frame=1306, drawing="bent")],
        )
        assert active_drawing(slot, 0, fps=24) == "none"
        assert active_drawing(slot, 1305, fps=24) == "none"
        assert active_drawing(slot, 1306, fps=24) == "bent"
        canvas = np.zeros((80, 80, 3), dtype=np.uint8)
        _draw_slot(canvas, AssetCache(), slot, _owner(), 0, 24, {"mic_arm": "none"})
        assert not canvas.any()

    def test_hidden_slot_draws_nothing_and_mouth_stays_visible_when_face_is_none(self, tmp_path):
        body = _write_bgra(tmp_path / "body.png", (0, 0, 0), alpha=0)
        grin = _write_bgra(tmp_path / "grin.png", (0, 0, 255))
        mouth = _write_bgra(tmp_path / "mouth.png", (0, 255, 0))
        layer = Layer(
            id="char",
            asset=body,
            z=0,
            transform=Transform(x=40, y=40, anchor="center"),
            slots={
                "face": Slot(
                    images={"grin": grin},
                    keyframes=[SlotKeyframe(frame=0, drawing="none")],
                ),
                "mouth": Slot(
                    images={"open": mouth},
                    keyframes=[SlotKeyframe(frame=0, drawing="open")],
                    visible_when={"face": ["none"]},
                ),
            },
        )
        assert active_drawing(layer.slots["face"], 0, fps=24) == "none"
        canvas = np.zeros((80, 80, 3), dtype=np.uint8)
        _draw_layer(canvas, layer, AssetCache(), 0, fps=24)
        assert not _has_color(canvas, (0, 0, 255))  # face/grin must stay hidden
        assert _has_color(canvas, (0, 255, 0))  # mouth stays visible when face=none
