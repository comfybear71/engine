"""Min-hold, smoothing, loud-variant fallback, blink seed, head-bob keys."""

from __future__ import annotations

from pathlib import Path

from compositor import lipsync
from compositor.lipsync_natural import (
    apply_loud_shapes,
    apply_loud_to_cues,
    apply_min_hold,
    apply_smoothing,
    cues_to_frames,
    frames_to_cues,
    head_bob_at,
    head_bob_starts,
    insert_auto_blinks,
    load_character_config,
    loud_mask,
    merge_lipsync_settings,
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
    def test_threshold_and_hysteresis(self):
        # Enter above 0.8; stay loud until below 0.8 * 0.85 = 0.68.
        rms = [0.2, 0.9, 0.75, 0.75, 0.5, 0.5]
        assert loud_mask(rms, threshold=0.8, hysteresis=0.85, min_hold=2) == [
            False,
            True,
            True,
            True,
            False,
            False,
        ]

    def test_two_frame_hold_on_a_one_frame_spike(self):
        rms = [0.1, 0.95, 0.1, 0.1]
        assert loud_mask(rms, threshold=0.8, hysteresis=0.85, min_hold=2) == [
            False,
            True,
            True,
            False,
        ]
        assert loud_mask(rms, threshold=0.8, hysteresis=0.85, min_hold=1) == [
            False,
            True,
            False,
            False,
        ]

    def test_promotes_when_file_exists_and_falls_back_when_missing(self):
        frames = ["B", "C", "X"]
        rms = [0.1, 0.9, 0.0]
        loud = select_loud_variants(
            frames, rms, threshold_percentile=0.5, available={"B", "C", "C_loud", "X"}
        )
        assert loud == ["B", "C_loud", "X"]

        missing = select_loud_variants(
            frames, rms, threshold_percentile=0.5, available={"B", "C", "X"}
        )
        assert missing == ["B", "C", "X"]
        assert apply_loud_shapes(frames, [False, True, False], available={"B", "C", "X"}) == [
            "B",
            "C",
            "X",
        ]

    def test_never_changes_the_phoneme(self):
        frames = ["B", "D", "A", "F"]
        out = apply_loud_shapes(frames, [True, True, True, True], available={"B", "B_loud", "D", "A", "F"})
        assert out == ["B_loud", "D", "A", "F"]
        assert [shape.replace("_loud", "") for shape in out] == ["B", "D", "A", "F"]

    def test_identical_cues_without_loud_files_or_when_off(self, tmp_path):
        from .conftest import write_wav

        wav = write_wav(tmp_path / "line.wav", 0.5)
        cues = [_cue(0.0, 0.25, "B"), _cue(0.25, 0.5, "C")]
        no_files = apply_loud_to_cues(
            cues, wav, fps=24, duration_frames=12, available={"B", "C", "X"}
        )
        off = apply_loud_to_cues(
            cues,
            wav,
            fps=24,
            duration_frames=12,
            available={"B", "C", "C_loud", "X"},
            loud="off",
        )
        assert no_files == list(cues)
        assert off == list(cues)

    def test_character_loud_off_disables_auto(self):
        settings = merge_lipsync_settings({}, {"lipsync": {"loud": "off"}})
        assert settings.loud == "off"
        settings_auto = merge_lipsync_settings({}, {"lipsync": {"loud": 0.9}})
        assert settings_auto.loud == "auto"
        assert settings_auto.loud_threshold == 0.9

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


def _write_amp_wav(path: Path, frame_amps: list[float], fps: int = 24, sample_rate: int = 24000) -> Path:
    import math
    import struct
    import wave

    samples: list[int] = []
    n_per_frame = sample_rate // fps
    for amp in frame_amps:
        for i in range(n_per_frame):
            samples.append(int(amp * 30000 * math.sin(2 * math.pi * 440 * i / sample_rate)))
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(struct.pack("<h", s) for s in samples))
    return path


def test_load_timeline_loud_identity_and_promotion(tmp_path):
    """No *_loud files (or loud=off) keeps cues identical; loud files swap C."""

    import json

    from compositor.timeline_loader import load_timeline

    from .conftest import write_png_1x1

    write_png_1x1(tmp_path / "bg.png")
    write_png_1x1(tmp_path / "body.png")
    images = {}
    for shape in ("A", "B", "C", "D", "E", "F", "G", "H", "X"):
        write_png_1x1(tmp_path / f"{shape}.png")
        images[shape] = f"{shape}.png"
    _write_amp_wav(tmp_path / "line.wav", [0.05 + 0.95 * i / 23 for i in range(24)])
    cues_raw = [{"start": 0.0, "end": 1.0, "value": "C"}]
    (tmp_path / "line.wav.rhubarb.json").write_text(json.dumps({"mouthCues": cues_raw}))

    def _timeline(extra_images=None, loud=None):
        slot_images = dict(images)
        if extra_images:
            slot_images.update(extra_images)
        clip = {"audio": "line.wav", "start_frame": 0}
        if loud is not None:
            clip["loud"] = loud
        doc = {
            "series": "Test",
            "episode": "1",
            "fps": 24,
            "scenes": [
                {
                    "id": "s1",
                    "duration": {"frames": 24},
                    "background": {"asset": "bg.png"},
                    "layers": [
                        {
                            "id": "hicks",
                            "asset": "body.png",
                            "z": 1,
                            "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                            "dialogue": [clip],
                            "slots": {
                                "mouth": {
                                    "images": slot_images,
                                    "lipsync": {"source": "dialogue"},
                                }
                            },
                        }
                    ],
                }
            ],
        }
        (tmp_path / "timeline.json").write_text(json.dumps(doc))
        return load_timeline(tmp_path / "timeline.json")

    baseline = _timeline()
    off = _timeline(extra_images={"C_loud": "C.png"}, loud="off")
    assert [(c.start, c.end, c.shape) for c in baseline.scenes[0].layers[0].dialogue[0].cues] == [
        (0.0, 1.0, "C")
    ]
    assert [(c.start, c.end, c.shape) for c in off.scenes[0].layers[0].dialogue[0].cues] == [
        (0.0, 1.0, "C")
    ]

    write_png_1x1(tmp_path / "C_loud.png")
    promoted = _timeline(extra_images={"C_loud": "C_loud.png"})
    shapes = [c.shape for c in promoted.scenes[0].layers[0].dialogue[0].cues]
    assert "C_loud" in shapes
    assert all(s in {"C", "C_loud"} for s in shapes)
