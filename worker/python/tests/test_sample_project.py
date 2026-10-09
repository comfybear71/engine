"""Sanity checks on the committed, script-generated projects/sample/timeline.json
(produced by `node src/cli.js parse`, not hand-written). These guard against
silent regressions in the parser's output shape without requiring Node."""

from __future__ import annotations

from compositor.timeline_loader import load_timeline

from .conftest import SAMPLE_PROJECT_DIR


def _load():
    return load_timeline(SAMPLE_PROJECT_DIR / "timeline.json")


def test_two_scenes_in_different_locations():
    timeline = _load()
    assert len(timeline.scenes) == 2
    bg_assets = [s.background.asset.parent.name for s in timeline.scenes]  # "bedroom" vs "corridor"
    assert bg_assets[0] != bg_assets[1]  # different location backgrounds


def test_same_cast_order_positions_differently_per_location():
    """The staging addition: auto-assigned marks by Cast order must resolve
    to different canvas positions in the bedroom vs. the corridor scene,
    since each location has its own staging.json."""

    timeline = _load()
    bedroom_scene, corridor_scene = timeline.scenes[0], timeline.scenes[1]

    bedroom_hicks = next(l for l in bedroom_scene.layers if l.character_id == "hicks")
    corridor_hicks = next(l for l in corridor_scene.layers if l.character_id == "hicks")

    assert bedroom_hicks.transform.x != corridor_hicks.transform.x
    assert bedroom_hicks.transform.scale != corridor_hicks.transform.scale


def test_characters_have_dialogue_mouth_and_eyes():
    timeline = _load()
    scene = timeline.scenes[0]
    hicks = next(l for l in scene.layers if l.character_id == "hicks")
    dana = next(l for l in scene.layers if l.character_id == "dana")

    assert len(hicks.dialogue) >= 3  # "at least 3 lines per character"
    assert len(dana.dialogue) >= 3
    assert "mouth" in hicks.slots
    assert "eyes" in hicks.slots
    assert hicks.slots["mouth"].dialogue is not None  # dialogue-driven, not keyframes


def test_hicks_has_rig_arm_with_hand_slot():
    timeline = _load()
    hicks = next(l for l in timeline.scenes[0].layers if l.character_id == "hicks")
    assert len(hicks.children) == 1
    arm = hicks.children[0]
    assert "right_hand" in arm.slots
    assert arm.slots["right_hand"].keyframes is not None


def test_dana_reposition_in_second_scene_creates_a_new_layer_segment():
    """Scripted [Action: Dana at=far_right] mid-scene must split into a new
    layer (same character_id, back-to-back timing), never a position tween."""

    timeline = _load()
    corridor_scene = timeline.scenes[1]
    dana_layers = [l for l in corridor_scene.layers if l.character_id == "dana"]
    assert len(dana_layers) == 2
    first, second = sorted(dana_layers, key=lambda l: l.start_frame)
    assert first.end_frame == second.start_frame
    assert first.transform.x != second.transform.x


def test_scene_durations_derived_from_dialogue():
    timeline = _load()
    for scene in timeline.scenes:
        assert scene.total_frames > 0
        all_clip_ends = [
            c.start_frame + c.duration_frames for layer in scene.layers for c in layer.dialogue
        ]
        assert max(all_clip_ends) < scene.total_frames  # padding was added
