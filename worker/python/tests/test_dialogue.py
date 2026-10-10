"""Multi-line dialogue per character: a layer's `dialogue` list, the
`source: "dialogue"` mouth-slot driver, and the `from_dialogue` scene
duration mode."""

from __future__ import annotations

import json

import pytest

from compositor.schema_validate import TimelineValidationError, validate_timeline
from compositor.slots import Slot, active_drawing
from compositor.timeline_loader import load_timeline

from .conftest import write_png_1x1, write_wav


def _write_cues(path, cues):
    path.write_text(json.dumps({"mouthCues": cues}))


def _mouth_images(tmp_path):
    for shape in ("A", "B", "C", "D", "E", "F", "G", "H", "X"):
        write_png_1x1(tmp_path / f"{shape}.png")
    return {s: f"{s}.png" for s in ("A", "B", "C", "D", "E", "F", "G", "H", "X")}


def _base_project(tmp_path, fps=24):
    write_png_1x1(tmp_path / "bg.png")
    write_png_1x1(tmp_path / "body.png")
    return tmp_path


def _write_timeline(tmp_path, scene_raw, fps=24):
    doc = {
        "series": "Test",
        "episode": "1",
        "fps": fps,
        "scenes": [scene_raw],
    }
    (tmp_path / "timeline.json").write_text(json.dumps(doc))
    return tmp_path / "timeline.json"


class TestDialogueClipsList:
    def test_multiple_clips_resolved_with_own_duration_and_cues(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "line1.wav", 1.0)
        write_wav(tmp_path / "line2.wav", 0.5)
        _write_cues(tmp_path / "line1.wav.rhubarb.json", [{"start": 0, "end": 1.0, "value": "B"}])
        _write_cues(tmp_path / "line2.wav.rhubarb.json", [{"start": 0, "end": 0.5, "value": "C"}])

        scene = {
            "id": "s1",
            "duration": {"frames": 100},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {"audio": "line1.wav", "start_frame": 0},
                        {"audio": "line2.wav", "start_frame": 30},
                    ],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        layer = timeline.scenes[0].layers[0]

        assert len(layer.dialogue) == 2
        assert layer.dialogue[0].start_frame == 0
        assert layer.dialogue[0].duration_frames == 24  # 1.0s @ 24fps
        assert [c.shape for c in layer.dialogue[0].cues] == ["B"]
        assert layer.dialogue[1].start_frame == 30
        assert layer.dialogue[1].duration_frames == 12  # 0.5s @ 24fps
        assert [c.shape for c in layer.dialogue[1].cues] == ["C"]

    def test_clips_sorted_by_start_frame_regardless_of_json_order(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "a.wav", 0.2)
        write_wav(tmp_path / "b.wav", 0.2)

        scene = {
            "id": "s1",
            "duration": {"frames": 100},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {"audio": "b.wav", "start_frame": 50},
                        {"audio": "a.wav", "start_frame": 0},
                    ],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        layer = timeline.scenes[0].layers[0]
        assert [c.start_frame for c in layer.dialogue] == [0, 50]

    def test_legacy_single_audio_still_works_as_one_clip(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "legacy.wav", 0.75)

        scene = {
            "id": "s1",
            "duration": {"frames": 100},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "timing": {"start_frame": 10},
                    "audio": "legacy.wav",
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        layer = timeline.scenes[0].layers[0]
        assert len(layer.dialogue) == 1
        assert layer.dialogue[0].start_frame == 0  # layer-local; clip starts when the layer starts
        assert layer.dialogue[0].duration_frames == 18  # 0.75s @ 24fps
        clips = timeline.all_audio_clips()
        assert len(clips) == 1
        assert clips[0].start_seconds == pytest.approx(10 / 24)

    def test_dialogue_takes_priority_over_legacy_audio_if_both_given(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "legacy.wav", 1.0)
        write_wav(tmp_path / "real.wav", 0.5)

        scene = {
            "id": "s1",
            "duration": {"frames": 100},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "audio": "legacy.wav",
                    "dialogue": [{"audio": "real.wav", "start_frame": 0}],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        layer = timeline.scenes[0].layers[0]
        assert len(layer.dialogue) == 1
        assert layer.dialogue[0].audio.name == "real.wav"

    def test_audio_mixing_places_every_clip_at_its_start(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "line1.wav", 1.0)
        write_wav(tmp_path / "line2.wav", 0.5)

        scene = {
            "id": "s1",
            "duration": {"frames": 100},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {"audio": "line1.wav", "start_frame": 0},
                        {"audio": "line2.wav", "start_frame": 48},  # 2s in at 24fps
                    ],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        clips = timeline.all_audio_clips()
        assert len(clips) == 2
        starts = sorted(c.start_seconds for c in clips)
        assert starts == pytest.approx([0.0, 2.0])

    def test_layer_start_frame_offsets_clip_audio_and_scene_duration(self, tmp_path):
        """A clip's start_frame is layer-local. A layer that begins at
        frame 47 with a clip at start_frame 0 must mix audio at 47/fps
        and last long enough to include that clip."""
        _base_project(tmp_path)
        write_wav(tmp_path / "line.wav", 1.0)  # 24 frames at 24fps

        scene = {
            "id": "s1",
            "duration": {"from_dialogue": True, "padding_frames": 0},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "dana_2",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "timing": {"start_frame": 47},
                    "dialogue": [{"audio": "line.wav", "start_frame": 0}],
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene, fps=24))
        clips = timeline.all_audio_clips()
        assert len(clips) == 1
        assert clips[0].start_seconds == pytest.approx(47 / 24.0)
        # layer.start 47 + clip.start 0 + 24 frames; scene must cover the clip
        assert timeline.scenes[0].total_frames >= 47 + 24
        assert timeline.scenes[0].total_frames == 71


class TestMouthSlotDrivenByDialogue:
    def test_shows_cues_within_clip_window_and_idle_between_lines(self, tmp_path):
        _base_project(tmp_path)
        images = _mouth_images(tmp_path)
        write_wav(tmp_path / "line1.wav", 1.0)
        write_wav(tmp_path / "line2.wav", 1.0)
        _write_cues(tmp_path / "line1.wav.rhubarb.json", [{"start": 0, "end": 1.0, "value": "D"}])
        _write_cues(tmp_path / "line2.wav.rhubarb.json", [{"start": 0, "end": 1.0, "value": "H"}])

        scene = {
            "id": "s1",
            "duration": {"frames": 200},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [
                        {"audio": "line1.wav", "start_frame": 0},   # frames [0, 24)
                        {"audio": "line2.wav", "start_frame": 48},  # frames [48, 72)
                    ],
                    "slots": {
                        "mouth": {"images": images, "lipsync": {"source": "dialogue"}},
                    },
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        mouth = timeline.scenes[0].layers[0].slots["mouth"]

        assert active_drawing(mouth, 10, fps=24) == "D"   # inside line1
        assert active_drawing(mouth, 30, fps=24) == "X"   # gap between lines -> idle
        assert active_drawing(mouth, 60, fps=24) == "H"   # inside line2
        assert active_drawing(mouth, 500, fps=24) == "X"  # after both lines -> idle

    def test_mouth_view_falls_back_to_front_then_default_images(self, tmp_path):
        front_b = tmp_path / "front_B.png"
        side_b = tmp_path / "side_B.png"
        default_b = tmp_path / "default_B.png"
        write_png_1x1(front_b)
        write_png_1x1(side_b)
        write_png_1x1(default_b)
        slot = Slot(
            images={"B": default_b},
            images_by_view={"front": {"B": front_b}, "left_side": {"B": side_b}},
        )
        assert slot.resolve_image("B", view="left_side") == side_b
        assert slot.resolve_image("B", view="up") == front_b
        empty = Slot(images={"B": default_b})
        assert empty.resolve_image("B", view="left_side") == default_b

    def test_requires_non_empty_dialogue(self, tmp_path):
        _base_project(tmp_path)
        images = _mouth_images(tmp_path)

        scene = {
            "id": "s1",
            "duration": {"frames": 10},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks",
                    "asset": "body.png",
                    "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "slots": {
                        "mouth": {"images": images, "lipsync": {"source": "dialogue"}},
                    },
                }
            ],
        }
        with pytest.raises(ValueError, match="non-empty 'dialogue'"):
            load_timeline(_write_timeline(tmp_path, scene))


class TestFromDialogueSceneDuration:
    def test_duration_is_max_clip_end_across_all_layers_plus_padding(self, tmp_path):
        _base_project(tmp_path)
        write_wav(tmp_path / "hicks1.wav", 1.0)   # ends at frame 24
        write_wav(tmp_path / "dana1.wav", 0.5)    # starts at 30, ends at 42

        scene = {
            "id": "s1",
            "duration": {"from_dialogue": True, "padding_frames": 5},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks", "asset": "body.png", "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [{"audio": "hicks1.wav", "start_frame": 0}],
                },
                {
                    "id": "dana", "asset": "body.png", "z": 2,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "dialogue": [{"audio": "dana1.wav", "start_frame": 30}],
                },
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        # dana's clip ends latest: 30 + round(0.5*24) = 30 + 12 = 42, + padding 5 = 47
        assert timeline.scenes[0].total_frames == 47

    def test_requires_at_least_one_dialogue_clip(self, tmp_path):
        _base_project(tmp_path)
        scene = {
            "id": "s1",
            "duration": {"from_dialogue": True},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks", "asset": "body.png", "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                }
            ],
        }
        with pytest.raises(ValueError, match="from_dialogue"):
            load_timeline(_write_timeline(tmp_path, scene))

    def test_schema_allows_from_dialogue_duration_mode(self):
        raw = {
            "series": "T", "episode": "1", "fps": 24,
            "scenes": [{
                "id": "s1",
                "duration": {"from_dialogue": True, "padding_frames": 3},
                "background": {"asset": "bg.png"},
                "layers": [],
            }],
        }
        validate_timeline(raw)  # must not raise

    def test_schema_rejects_mixed_duration_modes(self):
        raw = {
            "series": "T", "episode": "1", "fps": 24,
            "scenes": [{
                "id": "s1",
                "duration": {"from_dialogue": True, "from_audio": "a.wav"},
                "background": {"asset": "bg.png"},
                "layers": [],
            }],
        }
        with pytest.raises(TimelineValidationError):
            validate_timeline(raw)


class TestSlotLipsyncSingleClipStillWorks:
    """Backward compatibility: a slot can still be driven by a single
    cues/audio pair (not part of a `dialogue` list) for simple, non-episodic
    cases, exactly as before this feature."""

    def test_single_pair_lipsync_unaffected_by_dialogue_feature(self, tmp_path):
        _base_project(tmp_path)
        images = _mouth_images(tmp_path)
        cues_path = tmp_path / "grunt.rhubarb.json"
        _write_cues(cues_path, [{"start": 0, "end": 1.0, "value": "A"}])

        scene = {
            "id": "s1",
            "duration": {"frames": 50},
            "background": {"asset": "bg.png"},
            "layers": [
                {
                    "id": "hicks", "asset": "body.png", "z": 1,
                    "transform": {"x": 0, "y": 0, "anchor": "top-left"},
                    "slots": {
                        "mouth": {
                            "images": images,
                            "lipsync": {"cues": "grunt.rhubarb.json", "audio": "grunt.wav"},
                        }
                    },
                }
            ],
        }
        timeline = load_timeline(_write_timeline(tmp_path, scene))
        mouth = timeline.scenes[0].layers[0].slots["mouth"]
        assert mouth.dialogue is None
        assert mouth.cues is not None
        assert active_drawing(mouth, 5, fps=24) == "A"
