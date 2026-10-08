"""Generic drawing-swap slots: held-until-changed keyframes, and the
lipsync-driven case delegating to the same cue-to-shape mapping as before."""

from __future__ import annotations

from pathlib import Path

from compositor import lipsync
from compositor.slots import Slot, SlotKeyframe, active_drawing


def _slot_with_keyframes(keyframes):
    return Slot(
        images={"open": Path("open.png"), "fist": Path("fist.png")},
        keyframes=[SlotKeyframe(frame=f, drawing=d) for f, d in keyframes],
    )


class TestKeyframeDrivenSlot:
    def test_before_first_keyframe_holds_first_drawing(self):
        slot = _slot_with_keyframes([(10, "fist"), (30, "open")])
        assert active_drawing(slot, 0, fps=24) == "fist"
        assert active_drawing(slot, 9, fps=24) == "fist"

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
