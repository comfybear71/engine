"""Min-hold, smoothing, loud-variant fallback, blink seed, head-bob keys."""

from __future__ import annotations

from pathlib import Path

from compositor import lipsync
from compositor.lipsync_natural import (
    apply_min_hold,
    apply_smoothing,
    cues_to_frames,
    frames_to_cues,
    head_bob_at,
    head_bob_starts,
    project_seed,
    schedule_blinks,
    select_loud_variants,
)
from compositor.slots import Slot


def _cue(start, end, shape):
    return lipsync.MouthCue(start=start, end=end, shape=shape)


class TestMinHold:
    def test_merges_sub_two_frame_cues_and_keeps_real_a(self):
        fps = 24
        # 1-frame B, 2-frame A (M/B/P), 1-frame C, then a held D.
        frames = (
            ["B"]
            + ["A", "A"]
            + ["C"]
            + ["D"] * 6
        )
        held = apply_min_hold(frames)
        assert held[1:3] == ["A", "A"]
        assert "C" not in held
        assert held[0] in {"A", "B"}
        assert held[-1] == "D"
        assert all(end - start >= 2 for start, end, _shape in _runs(held))

    def test_single_frame_a_is_not_kept(self):
        frames = ["B", "B", "A", "C", "C"]
        held = apply_min_hold(frames)
        assert "A" not in held


class TestSmoothing:
    def test_light_collapses_c_b_c_within_three_frames(self):
        frames = ["C", "B", "C", "C", "C"]
        assert apply_smoothing(frames, "light") == ["C", "C", "C", "C", "C"]

    def test_off_leaves_flicker(self):
        frames = ["C", "B", "C"]
        assert apply_smoothing(frames, "off") == ["C", "B", "C"]

    def test_medium_collapses_two_frame_island(self):
        frames = ["C", "C", "B", "B", "C", "C"]
        assert apply_smoothing(frames, "medium") == ["C"] * 6
        assert apply_smoothing(frames, "light") == frames


class TestLoudSelection:
    def test_promotes_when_file_exists_and_falls_back_when_missing(self):
        cues = [_cue(0.0, 0.2, "B"), _cue(0.2, 0.4, "C"), _cue(0.4, 0.6, "X")]
        rms = [0.1, 0.9, 0.0]
        loud = select_loud_variants(
            cues, rms, threshold_percentile=0.5, available={"B", "C", "C_loud", "X"}
        )
        assert [c.shape for c in loud] == ["B", "C_loud", "X"]

        missing = select_loud_variants(
            cues, rms, threshold_percentile=0.5, available={"B", "C", "X"}
        )
        assert [c.shape for c in missing] == ["B", "C", "X"]

    def test_resolve_image_falls_back_from_loud_to_normal(self):
        slot = Slot(images={"B": Path("b.png"), "X": Path("x.png")})
        assert slot.resolve_image("B_loud") == Path("b.png")
        slot_loud = Slot(images={"B": Path("b.png"), "B_loud": Path("b_loud.png")})
        assert slot_loud.resolve_image("B_loud") == Path("b_loud.png")


class TestBlinkSchedule:
    def test_same_seed_is_deterministic_and_avoids_pins(self):
        kwargs = dict(
            duration_frames=24 * 20,
            fps=24,
            every=(3.0, 6.0),
            blink_frames=5,
            pinned=[(48, 72)],
        )
        a = schedule_blinks(seed=42, **kwargs)
        b = schedule_blinks(seed=42, **kwargs)
        c = schedule_blinks(seed=43, **kwargs)
        assert a == b
        assert a != c
        assert a
        for start, end in a:
            assert end - start == 5
            assert not (start < 72 and end > 48)
        assert project_seed(Path("/tmp/ep1"), "hicks") == project_seed(Path("/tmp/ep1"), "hicks")
        assert project_seed(Path("/tmp/ep1"), "hicks") != project_seed(Path("/tmp/ep1"), "dana")


class TestHeadBob:
    def test_keyframes_from_stressed_times(self):
        starts = head_bob_starts(
            [0.5, 1.5],
            trim_in=0.0,
            clip_start_frame=10,
            fps=24,
            duration_frames=200,
        )
        assert starts == [10 + 12, 10 + 36]
        peak_dy, peak_rot = head_bob_at(starts, starts[0] + 2, amp=4.0, rotation=1.0)
        rest_dy, rest_rot = head_bob_at(starts, starts[0] + 6, amp=4.0, rotation=1.0)
        before_dy, _before_rot = head_bob_at(starts, starts[0] - 1, amp=4.0, rotation=1.0)
        assert peak_dy == 4.0
        assert abs(peak_rot) == 1.0
        assert rest_dy == 0.0
        assert rest_rot == 0.0
        assert before_dy == 0.0

    def test_overlapping_pulses_are_skipped(self):
        starts = head_bob_starts(
            [0.0, 0.1],
            trim_in=0.0,
            clip_start_frame=0,
            fps=24,
            span=6,
        )
        assert starts == [0]


def _runs(frames):
    runs = []
    start = 0
    current = frames[0]
    for idx, shape in enumerate(frames[1:], start=1):
        if shape == current:
            continue
        runs.append((start, idx, current))
        start = idx
        current = shape
    runs.append((start, len(frames), current))
    return runs


def test_quantize_roundtrip_preserves_held_shapes():
    cues = [_cue(0.0, 0.5, "X"), _cue(0.5, 1.0, "B")]
    frames = cues_to_frames(cues, 24, 24)
    back = frames_to_cues(frames, 24)
    assert [c.shape for c in back] == ["X", "B"]
