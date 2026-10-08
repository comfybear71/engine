"""Cut-out rig nesting: child offset/scale/flip composition with the parent,
and z-order between a parent's own base image and its children."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from compositor.asset_cache import AssetCache
from compositor.compositor import _draw_layer, _resolve_layer_placements
from compositor.timeline_loader import Child, Layer, Transform


def _layer(transform: Transform, children: list[Child] | None = None) -> Layer:
    return Layer(
        id="rig",
        asset=Path("parent.png"),
        z=0,
        transform=transform,
        children=children or [],
    )


class TestPlacementComposition:
    def test_parent_is_always_placement_zero(self):
        t = Transform(x=100, y=200, scale=1.0, anchor="top-left")
        placements = _resolve_layer_placements(_layer(t))
        assert len(placements) == 1
        p = placements[0]
        assert (p.x, p.y, p.z) == (100, 200, 0)

    def test_child_offset_applied_unflipped(self):
        t = Transform(x=100, y=200, scale=1.0, anchor="top-left", flip_x=False)
        child = Child(id="arm", asset=Path("arm.png"), z=1, offset_x=30, offset_y=-50)
        placements = _resolve_layer_placements(_layer(t, [child]))
        child_p = next(p for p in placements if p.asset == Path("arm.png"))
        assert (child_p.x, child_p.y) == (130, 150)

    def test_child_offset_mirrors_when_parent_flipped(self):
        t = Transform(x=100, y=200, scale=1.0, anchor="top-left", flip_x=True)
        child = Child(id="arm", asset=Path("arm.png"), z=1, offset_x=30, offset_y=-50)
        placements = _resolve_layer_placements(_layer(t, [child]))
        child_p = next(p for p in placements if p.asset == Path("arm.png"))
        # x offset is mirrored (100 - 30 = 70); y offset is untouched.
        assert (child_p.x, child_p.y) == (70, 150)
        assert child_p.flip_x is True  # inherits parent flip by default

    def test_child_scale_composes_with_parent_scale(self):
        t = Transform(x=0, y=0, scale=2.0, anchor="top-left")
        child = Child(id="arm", asset=Path("arm.png"), z=1, scale=0.5)
        placements = _resolve_layer_placements(_layer(t, [child]))
        child_p = next(p for p in placements if p.asset == Path("arm.png"))
        assert child_p.scale == pytest.approx(1.0)  # 2.0 * 0.5

    def test_child_offset_scales_with_parent_scale(self):
        t = Transform(x=1000, y=1000, scale=2.0, anchor="top-left")
        child = Child(id="arm", asset=Path("arm.png"), z=1, offset_x=10, offset_y=20)
        placements = _resolve_layer_placements(_layer(t, [child]))
        child_p = next(p for p in placements if p.asset == Path("arm.png"))
        assert (child_p.x, child_p.y) == (1020, 1040)  # offset * scale

    def test_child_flip_x_composes_as_xor_with_parent(self):
        t = Transform(x=0, y=0, flip_x=True, anchor="top-left")
        independently_flipped_child = Child(id="hand", asset=Path("h.png"), z=1, flip_x=True)
        placements = _resolve_layer_placements(_layer(t, [independently_flipped_child]))
        child_p = next(p for p in placements if p.asset == Path("h.png"))
        # parent flipped AND child flip_x=True -> cancels out (True XOR True = False).
        assert child_p.flip_x is False

    def test_placements_sorted_by_z_parent_implicit_zero(self):
        t = Transform(x=0, y=0, anchor="top-left")
        behind = Child(id="behind", asset=Path("behind.png"), z=-1, offset_x=0, offset_y=0)
        front = Child(id="front", asset=Path("front.png"), z=5, offset_x=0, offset_y=0)
        placements = _resolve_layer_placements(_layer(t, [behind, front]))
        assert [p.asset.name for p in placements] == ["behind.png", "parent.png", "front.png"]

    def test_opacity_and_rotation_compose(self):
        t = Transform(x=0, y=0, anchor="top-left", opacity=0.5, rotation=10)
        child = Child(id="arm", asset=Path("arm.png"), z=1, opacity=0.5, rotation=15)
        placements = _resolve_layer_placements(_layer(t, [child]))
        parent_p = next(p for p in placements if p.asset == Path("parent.png"))
        child_p = next(p for p in placements if p.asset == Path("arm.png"))
        assert parent_p.opacity == pytest.approx(0.5)
        assert parent_p.rotation == pytest.approx(10)
        assert child_p.opacity == pytest.approx(0.25)  # 0.5 * 0.5
        assert child_p.rotation == pytest.approx(15)  # child rotation is independent


def _write_solid_png(path: Path, size: int, bgr: tuple[int, int, int]) -> None:
    img = np.zeros((size, size, 4), dtype=np.uint8)
    img[:, :, 0], img[:, :, 1], img[:, :, 2], img[:, :, 3] = bgr[0], bgr[1], bgr[2], 255
    cv2.imwrite(str(path), img)


class TestRigZOrderIntegration:
    """End-to-end through the real draw path (AssetCache + draw_image), not
    just the pure placement math above."""

    def test_child_with_higher_z_draws_in_front_of_parent(self, tmp_path):
        parent_path = tmp_path / "torso.png"
        child_path = tmp_path / "arm.png"
        _write_solid_png(parent_path, 40, (0, 0, 255))  # red
        _write_solid_png(child_path, 40, (255, 0, 0))  # blue

        t = Transform(x=0, y=0, anchor="top-left")
        child = Child(id="arm", asset=child_path, z=1, offset_x=0, offset_y=0, pivot="top-left")  # fully overlaps parent
        layer = Layer(id="rig", asset=parent_path, z=0, transform=t, children=[child])

        canvas = np.full((40, 40, 3), 255, dtype=np.uint8)
        _draw_layer(canvas, layer, AssetCache(), 0, fps=24)
        assert tuple(canvas[20, 20]) == (255, 0, 0)  # blue (child) wins

    def test_child_with_lower_z_draws_behind_parent(self, tmp_path):
        parent_path = tmp_path / "torso.png"
        child_path = tmp_path / "arm.png"
        _write_solid_png(parent_path, 40, (0, 0, 255))  # red
        _write_solid_png(child_path, 40, (255, 0, 0))  # blue

        t = Transform(x=0, y=0, anchor="top-left")
        child = Child(id="arm", asset=child_path, z=-1, offset_x=0, offset_y=0, pivot="top-left")
        layer = Layer(id="rig", asset=parent_path, z=0, transform=t, children=[child])

        canvas = np.full((40, 40, 3), 255, dtype=np.uint8)
        _draw_layer(canvas, layer, AssetCache(), 0, fps=24)
        assert tuple(canvas[20, 20]) == (0, 0, 255)  # red (parent) wins
