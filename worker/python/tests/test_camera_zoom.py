"""Camera zoom is folded into placement; zoom=1 matches the old renderer."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from compositor.asset_cache import AssetCache
from compositor.camera import Camera, CameraKeyframe, Shake, apply_camera
from compositor.compositor import compose_scene_frame
from compositor.timeline_loader import Background, Layer, Scene, Transform


def _write_bgra(path: Path, img: np.ndarray) -> Path:
    cv2.imwrite(str(path), img)
    return path


def _solid_bgra(w: int, h: int, bgr: tuple[int, int, int], alpha: int = 255) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, 0] = bgr[0]
    img[:, :, 1] = bgr[1]
    img[:, :, 2] = bgr[2]
    img[:, :, 3] = alpha
    return img


def _checker_bgra(w: int, h: int, cell: int = 4) -> np.ndarray:
    """High-frequency checker so Laplacian variance can tell soft from sharp."""

    img = np.zeros((h, w, 4), dtype=np.uint8)
    yy, xx = np.indices((h, w))
    on = ((xx // cell) + (yy // cell)) % 2 == 0
    img[on] = (0, 0, 0, 255)
    img[~on] = (255, 255, 255, 255)
    return img


def _scene(
    tmp_path: Path,
    *,
    canvas: int = 400,
    piece: np.ndarray | None = None,
    x: float = 200.0,
    y: float = 200.0,
    scale: float = 0.79,
    camera: Camera | None = None,
    bg: tuple[int, int, int] = (40, 80, 30),
    anchor: str = "center",
) -> Scene:
    bg_path = _write_bgra(tmp_path / "bg.png", _solid_bgra(canvas, canvas, bg)[:, :, :3])
    if piece is None:
        piece = _solid_bgra(64, 64, (0, 0, 220))
    piece_path = _write_bgra(tmp_path / "piece.png", piece)
    return Scene(
        id="s",
        total_frames=8,
        background=Background(asset=bg_path),
        layers=[
            Layer(
                id="piece",
                asset=piece_path,
                z=1,
                transform=Transform(x=x, y=y, scale=scale, anchor=anchor),
            )
        ],
        camera=camera,
    )


def _compose(scene: Scene, frame: int = 0, canvas: int = 400) -> np.ndarray:
    return compose_scene_frame(scene, frame, canvas, canvas, 24, AssetCache())


def _compose_legacy(scene: Scene, frame: int = 0, canvas: int = 400) -> np.ndarray:
    """Old renderer: composite at canvas size, then crop-and-upscale."""

    plain = replace(scene, camera=None)
    composed_idx = frame - (frame % max(1, scene.frame_step))
    canvas_bgr = compose_scene_frame(plain, frame, canvas, canvas, 24, AssetCache())
    return apply_camera(canvas_bgr, scene.camera, composed_idx, 24)


def _laplacian_var(img: np.ndarray) -> float:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _centroid(mask: np.ndarray) -> tuple[float, float]:
    ys, xs = np.where(mask)
    return float(xs.mean()), float(ys.mean())


def test_zoom_1_and_no_camera_match_the_current_renderer(tmp_path: Path):
    piece = _checker_bgra(128, 128, cell=6)
    base = _scene(tmp_path, piece=piece, camera=None)
    zoom1 = replace(
        base,
        camera=Camera(keyframes=[CameraKeyframe(frame=0, zoom=1.0)]),
    )
    zoom1_centred = replace(
        base,
        camera=Camera(keyframes=[CameraKeyframe(frame=0, x=200.0, y=200.0, zoom=1.0)]),
    )

    none_frame = _compose(base)
    zoom1_frame = _compose(zoom1)
    centred_frame = _compose(zoom1_centred)
    legacy_none = _compose_legacy(base)
    legacy_zoom1 = _compose_legacy(zoom1)

    assert none_frame.shape == (400, 400, 3)
    assert np.array_equal(none_frame, zoom1_frame)
    assert np.array_equal(none_frame, centred_frame)
    assert np.array_equal(none_frame, legacy_none)
    assert np.array_equal(zoom1_frame, legacy_zoom1)


def test_zoom_3_crop_is_sharper_than_crop_and_upscale(tmp_path: Path):
    piece = _checker_bgra(512, 512, cell=4)
    scene = _scene(
        tmp_path,
        piece=piece,
        x=200.0,
        y=200.0,
        scale=0.79,
        camera=Camera(keyframes=[CameraKeyframe(frame=0, x=200.0, y=200.0, zoom=3.0)]),
    )
    new = _compose(scene)
    old = _compose_legacy(scene)
    # Centre crop of the high-detail piece, away from the background.
    new_crop = new[160:240, 160:240]
    old_crop = old[160:240, 160:240]
    assert _laplacian_var(new_crop) > _laplacian_var(old_crop)


def test_zoom_placement_matches_old_path_within_1px(tmp_path: Path):
    marker = _solid_bgra(20, 20, (0, 0, 255))
    # 480 / 3 = 160 so the old integer crop window is exact, not a
    # 400/3 rounding artifact.
    canvas = 480
    scene = _scene(
        tmp_path,
        canvas=canvas,
        piece=marker,
        x=180.0,
        y=160.0,
        scale=1.0,
        camera=Camera(keyframes=[CameraKeyframe(frame=0, x=180.0, y=160.0, zoom=3.0)]),
        bg=(0, 0, 0),
    )
    new = _compose(scene, canvas=canvas)
    old = _compose_legacy(scene, canvas=canvas)
    new_mask = np.all(new == (0, 0, 255), axis=2)
    old_mask = np.all(old == (0, 0, 255), axis=2)
    assert new_mask.any() and old_mask.any()
    nx, ny = _centroid(new_mask)
    ox, oy = _centroid(old_mask)
    assert abs(nx - ox) <= 1.0
    assert abs(ny - oy) <= 1.0


def test_shake_at_zoom_still_matches_old_path_within_1px(tmp_path: Path):
    marker = _solid_bgra(24, 24, (0, 255, 0))
    scene = _scene(
        tmp_path,
        piece=marker,
        x=200.0,
        y=200.0,
        scale=1.0,
        camera=Camera(
            keyframes=[CameraKeyframe(frame=0, x=200.0, y=200.0, zoom=2.0)],
            shake=Shake(amplitude_px=6.0, frequency_hz=8.0),
        ),
        bg=(0, 0, 0),
    )
    still = replace(
        scene,
        camera=Camera(keyframes=[CameraKeyframe(frame=0, x=200.0, y=200.0, zoom=2.0)]),
    )
    new = _compose(scene, frame=3)
    old = _compose_legacy(scene, frame=3)
    unshaken = _compose(still, frame=3)
    assert not np.array_equal(new, unshaken)
    new_mask = np.all(new == (0, 255, 0), axis=2)
    old_mask = np.all(old == (0, 255, 0), axis=2)
    assert new_mask.any() and old_mask.any()
    nx, ny = _centroid(new_mask)
    ox, oy = _centroid(old_mask)
    assert abs(nx - ox) <= 1.0
    assert abs(ny - oy) <= 1.0
