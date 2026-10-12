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
    insert_auto_blinks,
    load_character_config,
    process_mouth_cues,
    project_seed,
    schedule_blinks,
    select_loud_variants,
)
from compositor.slots import Slot, SlotKeyframe, active_drawing


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


class TestExcludeFromLipSync:
    def test_process_mouth_cues_remaps_h_before_hold(self):
        cues = [_cue(0.0, 0.2, "B"), _cue(0.2, 0.5, "H"), _cue(0.5, 0.8, "B")]
        out = process_mouth_cues(
            cues,
            duration_frames=20,
            fps=24,
            smoothing="off",
            excluded={"H"},
            available={"B", "C", "H", "X"},
        )
        assert all(cue.shape != "H" for cue in out)
        assert any(cue.shape == "C" for cue in out)


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

    def test_half_drawing_is_an_inbetween_with_the_same_blink_length(self):
        kwargs = dict(duration_frames=24 * 20, fps=24, seed=42, every=(3.0, 6.0), blink_frames=5)
        blinks = schedule_blinks(**kwargs)
        assert blinks
        start, end = blinks[0]
        assert end - start == 5

        with_half = insert_auto_blinks(
            [SlotKeyframe(frame=0, drawing="open")],
            {"open": Path("open.png"), "half": Path("half.png"), "closed": Path("closed.png")},
            **kwargs,
        )
        slot_half = Slot(
            images={"open": Path("open.png"), "half": Path("half.png"), "closed": Path("closed.png")},
            keyframes=with_half,
        )
        assert active_drawing(slot_half, start - 1, 24) == "open"
        assert active_drawing(slot_half, start, 24) == "half"
        assert active_drawing(slot_half, start + 1, 24) == "closed"
        assert active_drawing(slot_half, end - 2, 24) == "closed"
        assert active_drawing(slot_half, end - 1, 24) == "half"
        assert active_drawing(slot_half, end, 24) == "open"

        no_half = insert_auto_blinks(
            [SlotKeyframe(frame=0, drawing="open")],
            {"open": Path("open.png"), "closed": Path("closed.png")},
            **kwargs,
        )
        slot = Slot(images={"open": Path("open.png"), "closed": Path("closed.png")}, keyframes=no_half)
        assert active_drawing(slot, start - 1, 24) == "open"
        assert active_drawing(slot, start, 24) == "closed"
        assert active_drawing(slot, end - 1, 24) == "closed"
        assert active_drawing(slot, end, 24) == "open"


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


def test_character_config_resolves_episode_then_show_then_global(tmp_path):
    global_dir = tmp_path / "_global_assets" / "characters" / "rodney"
    show_dir = tmp_path / "shows" / "sunny" / "characters" / "rodney"
    episode = tmp_path / "shows" / "sunny" / "episodes" / "ep1"
    (tmp_path / "shows" / "sunny").mkdir(parents=True)
    (tmp_path / "shows" / "sunny" / "show.json").write_text("{}")
    global_dir.mkdir(parents=True)
    show_dir.mkdir(parents=True)
    (episode / "characters" / "rodney").mkdir(parents=True)
    (global_dir / "character.json").write_text('{"id":"rodney","lipsync":{"head_bob":"off"}}')
    (show_dir / "character.json").write_text('{"id":"rodney","lipsync":{"head_bob":"strong"}}')
    assert load_character_config(episode, "rodney")["lipsync"]["head_bob"] == "strong"
    (episode / "characters" / "rodney" / "character.json").write_text(
        '{"id":"rodney","lipsync":{"head_bob":"subtle"}}'
    )
    assert load_character_config(episode, "rodney")["lipsync"]["head_bob"] == "subtle"


def test_character_config_skips_global_when_independent(tmp_path):
    global_dir = tmp_path / "_global_assets" / "characters" / "rodney"
    project = tmp_path / "episode"
    global_dir.mkdir(parents=True)
    project.mkdir(parents=True)
    (global_dir / "character.json").write_text('{"id":"rodney","lipsync":{"head_bob":"off"}}')
    assert load_character_config(project, "rodney") == {}
    (project / "studio.json").write_text('{"independent": false}')
    assert load_character_config(project, "rodney")["lipsync"]["head_bob"] == "off"
