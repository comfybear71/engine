from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from compositor.validate_assets import check_png, validate_character


def _write_rgba(path: Path, w: int, h: int, inset: int = 2, alpha: int = 255) -> Path:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    if alpha:
        img[inset : h - inset, inset : w - inset] = (30, 40, 200, alpha)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img)
    return path


def test_check_png_reports_size_blank_and_edge(tmp_path: Path):
    canvas = {"w": 16, "h": 16, "pivot": {"x": 8, "y": 14}}
    ok = _write_rgba(tmp_path / "ok.png", 16, 16, inset=2)
    assert check_png(ok, canvas, "ok.png") == []

    wrong = _write_rgba(tmp_path / "wrong.png", 8, 8, inset=1)
    size_issues = check_png(wrong, canvas, "wrong.png")
    assert any("expected 16x16 RGBA, got 8x8 RGBA" in line for line in size_issues)

    blank = _write_rgba(tmp_path / "blank.png", 16, 16, inset=0, alpha=0)
    assert any("blank PNG" in line for line in check_png(blank, canvas, "blank.png"))

    edge = _write_rgba(tmp_path / "edge.png", 16, 16, inset=0)
    assert any("touches the canvas edge" in line for line in check_png(edge, canvas, "edge.png"))


def test_validate_character_is_per_file(tmp_path: Path):
    char_dir = tmp_path / "characters" / "bill"
    canvas = {"w": 16, "h": 16, "pivot": {"x": 8, "y": 14}}
    (char_dir / "head_base").mkdir(parents=True)
    (char_dir / "eyes").mkdir()
    _write_rgba(char_dir / "head_base" / "neutral.png", 16, 16, inset=2)
    _write_rgba(char_dir / "eyes" / "open.png", 16, 16, inset=0)
    _write_rgba(char_dir / "eyes" / "closed.png", 8, 8, inset=1)
    config = {
        "id": "bill",
        "groups": {"head": ["head_base", "eyes"]},
        "slots": {
            "head_base": {"drawings_dir": "head_base", "canvas": canvas},
            "eyes": {"drawings_dir": "eyes", "canvas": canvas},
        },
    }
    (char_dir / "character.json").write_text(json.dumps(config))
    issues = validate_character(char_dir, config, roots=[tmp_path])
    joined = "\n".join(issues)
    assert "head_base/neutral.png" not in joined
    assert "eyes/open.png" in joined and "touches the canvas edge" in joined
    assert "eyes/closed.png" in joined and "expected 16x16 RGBA, got 8x8 RGBA" in joined


def test_validate_character_scans_views_true_folders_without_canvas(tmp_path: Path):
    char_dir = tmp_path / "characters" / "bill"
    (char_dir / "torso").mkdir(parents=True)
    (char_dir / "torso_left_34").mkdir()
    _write_rgba(char_dir / "torso" / "front.png", 16, 16, inset=2)
    _write_rgba(char_dir / "torso_left_34" / "front.png", 16, 16, inset=0)
    config = {
        "id": "bill",
        "slots": {
            "torso": {"drawings_dir": "torso", "views": True, "default_drawing": "front"},
        },
    }
    (char_dir / "character.json").write_text(json.dumps(config))
    issues = validate_character(char_dir, config, roots=[tmp_path])
    joined = "\n".join(issues)
    assert "missing canvas" not in joined
    assert "torso/front.png" not in joined
    assert "torso_left_34/front.png" in joined and "touches the canvas edge" in joined


def test_validate_character_accepts_three_level_children(tmp_path: Path):
    char_dir = tmp_path / "characters" / "bill"
    char_dir.mkdir(parents=True)
    config = {
        "id": "bill",
        "children": [
            {"id": "upper", "asset": "parts/upper.png", "z": -3.5, "offset": {"x": 0, "y": 0}},
            {"id": "forearm", "asset": "parts/forearm.png", "z": -3, "offset": {"x": 0, "y": 10}, "parent": "upper"},
            {"id": "hand", "asset": "parts/hand.png", "z": 4, "offset": {"x": 0, "y": 10}, "parent": "forearm"},
        ],
    }
    (char_dir / "character.json").write_text(json.dumps(config))
    assert validate_character(char_dir, config, roots=[tmp_path]) == []


def test_validate_character_rejects_child_parent_cycle(tmp_path: Path):
    char_dir = tmp_path / "characters" / "bill"
    char_dir.mkdir(parents=True)
    config = {
        "id": "bill",
        "children": [
            {"id": "upper", "asset": "a.png", "z": 1, "offset": {"x": 0, "y": 0}, "parent": "hand"},
            {"id": "hand", "asset": "b.png", "z": 2, "offset": {"x": 0, "y": 0}, "parent": "upper"},
        ],
    }
    (char_dir / "character.json").write_text(json.dumps(config))
    issues = validate_character(char_dir, config, roots=[tmp_path])
    assert any("cycles" in line for line in issues)


def test_validate_character_scans_back_view_folder(tmp_path: Path):
    char_dir = tmp_path / "characters" / "bill"
    (char_dir / "torso").mkdir(parents=True)
    (char_dir / "torso_back").mkdir()
    _write_rgba(char_dir / "torso" / "front.png", 16, 16, inset=2)
    _write_rgba(char_dir / "torso_back" / "front.png", 16, 16, inset=0)
    config = {
        "id": "bill",
        "slots": {
            "torso": {"drawings_dir": "torso", "views": True, "default_drawing": "front"},
        },
    }
    (char_dir / "character.json").write_text(json.dumps(config))
    issues = validate_character(char_dir, config, roots=[tmp_path])
    joined = "\n".join(issues)
    assert "torso/front.png" not in joined
    assert "torso_back/front.png" in joined and "touches the canvas edge" in joined
