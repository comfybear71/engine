"""Validate one-head rig slot drawings against their declared canvas.

Checks every PNG in a rig-head slot (``character.json`` ``groups.head``
members, or any slot that declares ``canvas``):

- file is exactly ``canvas.w`` × ``canvas.h`` RGBA
- not blank (no visible alpha)
- alpha bbox does not touch a canvas edge

Reports one clear line per file. Used by ``python -m compositor.validate_assets``
and the Node ``lint`` command.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .align import ALPHA_MIN, alpha_bbox

HEAD_VIEWS = ("front", "left_34", "left_side", "right_34", "right_side", "up", "down", "back")
SKIP_DIRS = {"_trash", "_replaced", "_reference", "_library"}
INTENTIONAL_BLANK_STEMS = frozenset({"none", "rig", "blank"})


def _is_png(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() == ".png"


def _view_prefix(drawings_dir: str, slot_name: str) -> str:
    dirname = drawings_dir or slot_name
    for view in HEAD_VIEWS:
        suffix = f"_{view}"
        if dirname.endswith(suffix):
            return dirname[: -len(suffix)]
    return dirname or slot_name


def _slot_dirs(char_dir: Path, slot_name: str, spec: dict) -> list[Path]:
    base = spec.get("drawings_dir") or slot_name
    prefix = _view_prefix(str(base), slot_name)
    dirs = [char_dir / base]
    for view in HEAD_VIEWS:
        dirs.append(char_dir / f"{prefix}_{view}")
    seen: set[Path] = set()
    out: list[Path] = []
    for folder in dirs:
        resolved = folder.resolve() if folder.exists() else folder
        if resolved in seen:
            continue
        seen.add(resolved)
        if folder.is_dir() and folder.name not in SKIP_DIRS:
            out.append(folder)
    return out


def _iter_pngs(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if _is_png(p) and not p.name.startswith("."))


def _load_character(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _head_group_names(config: dict) -> list[str]:
    raw_groups = config.get("groups")
    if isinstance(raw_groups, dict) and isinstance(raw_groups.get("head"), list):
        return [str(name) for name in raw_groups["head"] if name]
    return []


def _rig_head_slots(config: dict) -> dict[str, dict]:
    """Head-group members, slots with canvas, and slots with ``views: true``."""

    slots: dict[str, dict] = {}

    def walk(container: dict | None) -> None:
        if not container:
            return
        for name, spec in container.items():
            if isinstance(spec, dict):
                slots[str(name)] = spec

    walk(config.get("slots") if isinstance(config.get("slots"), dict) else None)
    for child in config.get("children") or []:
        if isinstance(child, dict):
            walk(child.get("slots") if isinstance(child.get("slots"), dict) else None)

    wanted = set(_head_group_names(config))
    for name, spec in slots.items():
        if spec.get("canvas") or spec.get("views") is True:
            wanted.add(name)
    return {name: slots[name] for name in wanted if name in slots}


def _rel_for(path: Path, roots: list[Path]) -> str:
    for root in roots:
        try:
            return str(path.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
    return path.name


def _drawing_meta(spec: dict | None, stem: str) -> dict | None:
    drawings = spec.get("drawings") if isinstance(spec, dict) and isinstance(spec.get("drawings"), dict) else None
    if not drawings:
        return None
    if stem in drawings and isinstance(drawings[stem], dict):
        return drawings[stem]
    wanted = str(stem or "").strip().lower()
    for key, value in drawings.items():
        if str(key).strip().lower() == wanted and isinstance(value, dict):
            return value
    return None


def is_intentional_blank(stem: str, spec: dict | None = None) -> bool:
    """True for drawings that are blank on purpose: none / rig / blank, or flagged in character.json."""

    name = str(stem or "").strip().lower()
    if name in INTENTIONAL_BLANK_STEMS:
        return True
    meta = _drawing_meta(spec, stem) or _drawing_meta(spec, name)
    return bool(meta and (meta.get("blank") is True or meta.get("intentional_blank") is True))


def check_png(path: Path, canvas: dict | None, rel: str, *, allow_blank: bool = False) -> list[str]:
    issues: list[str] = []
    stem = Path(rel).stem if rel else path.stem
    allow_blank = allow_blank or is_intentional_blank(stem)
    raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        return [f"{rel}: could not read PNG"]
    if raw.ndim != 3 or raw.shape[2] != 4:
        channels = 1 if raw.ndim == 2 else raw.shape[2]
        issues.append(f"{rel}: expected RGBA, got {raw.shape[1]}x{raw.shape[0]} {channels}-channel")
        return issues
    height, width = raw.shape[:2]
    if canvas:
        want_w = int(canvas.get("w") or 0)
        want_h = int(canvas.get("h") or 0)
        if want_w and want_h and (width != want_w or height != want_h):
            issues.append(f"{rel}: expected {want_w}x{want_h} RGBA, got {width}x{height} RGBA")
    alpha = raw[:, :, 3]
    if int(alpha.max()) <= ALPHA_MIN:
        if not allow_blank:
            issues.append(f"{rel}: blank PNG (no visible pixels)")
        return issues
    box = alpha_bbox(raw)
    if box is None:
        if not allow_blank:
            issues.append(f"{rel}: blank PNG (no visible pixels)")
        return issues
    x0, y0, x1, y1 = box
    if x0 <= 0 or y0 <= 0 or x1 >= width or y1 >= height:
        issues.append(f"{rel}: alpha bbox touches the canvas edge ({x0},{y0})-({x1},{y1}) on {width}x{height}")
    return issues


def _validate_child_parents(config: dict) -> list[str]:
    """Parent must exist; chains may be any depth; cycles are errors."""

    children = config.get("children") or []
    if not isinstance(children, list):
        return []
    ids = [c.get("id") for c in children if isinstance(c, dict) and c.get("id")]
    id_set = set(ids)
    issues: list[str] = []
    parents: dict[str, str] = {}
    for child in children:
        if not isinstance(child, dict):
            continue
        child_id = child.get("id")
        parent = child.get("parent")
        if not child_id or not parent:
            continue
        if parent not in id_set:
            issues.append(f"child {child_id!r} parent {parent!r} does not exist")
            continue
        if parent == child_id:
            issues.append(f"child {child_id!r} cannot be its own parent")
            continue
        parents[str(child_id)] = str(parent)
    for child_id in parents:
        seen: set[str] = set()
        current = child_id
        while current in parents:
            if current in seen:
                issues.append(f"child {child_id!r} parent chain cycles")
                break
            seen.add(current)
            current = parents[current]
    return issues


def validate_character(char_dir: Path, config: dict | None = None, *, roots: list[Path] | None = None) -> list[str]:
    config = config if config is not None else _load_character(char_dir / "character.json")
    if not config:
        return []
    issues: list[str] = []
    roots = roots or [char_dir.parent.parent]
    issues.extend(_validate_child_parents(config))
    head_group = set(_head_group_names(config))
    for slot_name, spec in _rig_head_slots(config).items():
        canvas = spec.get("canvas") if isinstance(spec.get("canvas"), dict) else None
        views_only = spec.get("views") is True and slot_name not in head_group
        if not canvas and not views_only:
            issues.append(f"{slot_name}: missing canvas {{w, h, pivot}} (required for rig-head slots)")
            continue
        folders = _slot_dirs(char_dir, slot_name, spec)
        if not folders:
            issues.append(f"{slot_name}: no drawings folder for rig-head slot")
            continue
        for folder in folders:
            for png in _iter_pngs(folder):
                issues.extend(
                    check_png(
                        png,
                        canvas,
                        _rel_for(png, roots),
                        allow_blank=is_intentional_blank(png.stem, spec),
                    )
                )
    return issues


def iter_character_dirs(project_dir: Path, global_assets_dir: Path | None = None) -> list[Path]:
    found: dict[str, Path] = {}
    search = []
    if global_assets_dir:
        search.append(global_assets_dir / "characters")
    search.append(project_dir / "characters")
    for root in search:
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if child.is_dir() and (child / "character.json").is_file() and not child.name.startswith("_"):
                found[child.name] = child
    return list(found.values())


def validate_project(
    project_dir: Path,
    global_assets_dir: Path | None = None,
    character_ids: list[str] | None = None,
) -> list[str]:
    issues: list[str] = []
    roots = [project_dir]
    if global_assets_dir:
        roots.append(global_assets_dir)
    wanted = {c.lower() for c in character_ids} if character_ids else None
    for char_dir in iter_character_dirs(project_dir, global_assets_dir):
        if wanted is not None and char_dir.name.lower() not in wanted:
            continue
        issues.extend(validate_character(char_dir, roots=roots))
    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate rig-head slot PNGs against their canvas")
    parser.add_argument("project_dir", type=Path, help="Project folder (or a character folder)")
    parser.add_argument("--global-assets", type=Path, default=None, help="Optional _global_assets folder")
    parser.add_argument("--character", action="append", dest="characters", help="Limit to this character id")
    args = parser.parse_args(argv)

    project_dir = args.project_dir.resolve()
    if (project_dir / "character.json").is_file():
        issues = validate_character(project_dir, roots=[project_dir.parent.parent, project_dir])
    else:
        issues = validate_project(project_dir, args.global_assets, args.characters)

    if issues:
        for line in issues:
            print(line)
        return 1
    print("OK: rig-head slot drawings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
