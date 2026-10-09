"""Key + split on tiny synthetic sheets (no sample art)."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compositor.cutout import estimate_screen_bgr, is_empty, key_green, process_image

# Grok Imagine green is RGB(16, 221, 31) ≈ 49 away from exact #00FF00.
GROK_GREEN_BGR = (31, 221, 16)  # OpenCV BGR of RGB(16, 221, 31)


def _green_sheet() -> np.ndarray:
    # 10x20 BGR: pure #00FF00, a red square in the left cell, blue in the right.
    img = np.zeros((10, 20, 3), dtype=np.uint8)
    img[:] = (0, 255, 0)
    img[1:9, 1:9] = (0, 0, 255)  # red
    img[1:9, 11:19] = (255, 0, 0)  # blue
    return img


def test_key_and_split_tiny_green_sheet(tmp_path: Path):
    cells = process_image(_green_sheet(), key=True, grid=(2, 1), split="grid", trim=True)
    assert len(cells) == 2

    left, right = cells
    assert left.shape[2] == 4
    assert right.shape[2] == 4
    assert not is_empty(left)
    assert not is_empty(right)

    left_opaque = left[left[:, :, 3] > 128]
    right_opaque = right[right[:, :, 3] > 128]
    assert len(left_opaque) >= 16
    assert len(right_opaque) >= 16

    # Foreground stays red / blue; leftover screen green is gone (keyed + despilled).
    assert left_opaque[:, 2].mean() > 200  # R
    assert left_opaque[:, 1].mean() < 80  # G
    assert right_opaque[:, 0].mean() > 200  # B
    assert right_opaque[:, 1].mean() < 80  # G

    # Fully green pixels in each cell should be transparent.
    left_green = np.all(left[:, :, :3] == (0, 255, 0), axis=2)
    if left_green.any():
        assert left[left_green][:, 3].max() < 40

    out = tmp_path / "left.png"
    assert cv2.imwrite(str(out), left)
    assert out.stat().st_size > 0


def _jpeg_noisy(bgr: np.ndarray, *, sigma: float = 6.0, quality: int = 80) -> np.ndarray:
    rng = np.random.default_rng(0)
    noisy = np.clip(bgr.astype(np.float32) + rng.normal(0.0, sigma, bgr.shape), 0, 255)
    ok, buf = cv2.imencode(".jpg", noisy.astype(np.uint8), [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    decoded = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    assert decoded is not None
    return decoded


def _grok_sheet(h: int = 80, w: int = 160) -> tuple[np.ndarray, np.ndarray]:
    """Two-cell sheet: Grok green, red square left, blue square right."""
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:] = GROK_GREEN_BGR
    # Inset subjects so trim has room to shrink each 80x80 cell.
    img[20:60, 20:60] = (0, 0, 220)  # red
    img[20:60, 100:140] = (220, 30, 20)  # blue
    bg = np.ones((h, w), dtype=bool)
    bg[20:60, 20:60] = False
    bg[20:60, 100:140] = False
    # Ignore a thin halo around subjects: JPEG ringing mixes those pixels.
    bg = cv2.erode(bg.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1).astype(bool)
    return img, bg


def test_key_grok_green_jpeg_noise_clears_background_and_trims():
    clean, bg_mask = _grok_sheet()
    sheet = _jpeg_noisy(clean)
    cell_h, cell_w = 80, 80

    screen = estimate_screen_bgr(sheet)
    # Estimated screen should track Grok green, not snap to exact #00FF00.
    assert abs(float(screen[1]) - GROK_GREEN_BGR[1]) < 30
    assert float(screen[1]) - max(float(screen[0]), float(screen[2])) > 80

    keyed = key_green(sheet)
    bg_alpha = keyed[:, :, 3][bg_mask]
    clear_frac = float(np.mean(bg_alpha == 0))
    assert clear_frac > 0.95, f"background only {clear_frac:.1%} fully transparent"

    cells = process_image(sheet, key=True, grid=(2, 1), split="grid", trim=True)
    assert len(cells) == 2
    for cell in cells:
        assert not is_empty(cell)
        assert cell.shape[0] < cell_h
        assert cell.shape[1] < cell_w


def test_drops_small_lowsat_bottom_right_watermark():
    img = np.zeros((80, 80, 3), dtype=np.uint8)
    img[:] = GROK_GREEN_BGR
    img[12:50, 12:50] = (30, 40, 200)  # red subject, well clear of the corner
    img[68:78, 52:78] = (190, 188, 185)  # grey Grok-style logo

    cells = process_image(img, key=True, grid=(1, 1), split="grid", trim=True)
    assert len(cells) == 1
    cell = cells[0]
    assert not is_empty(cell)
    # Trimmed to the subject, not the full sheet and not the logo strip.
    assert cell.shape[0] < 60
    assert cell.shape[1] < 60
    # No leftover grey blob: opaque pixels stay red-ish, not near-neutral.
    opaque = cell[cell[:, :, 3] > 128]
    assert len(opaque) > 50
    sat = opaque[:, :3].max(axis=1) - opaque[:, :3].min(axis=1)
    assert float(sat.mean()) > 60


def test_grid_cell_drops_intruding_blob_from_next_row():
    """3x3 sheet: a blob from the next row at the cell bottom must be removed."""
    cell = 60
    rows, cols = 3, 3
    img = np.zeros((cell * rows, cell * cols, 3), dtype=np.uint8)
    img[:] = GROK_GREEN_BGR

    def paint(row: int, col: int, y0: int, y1: int, x0: int, x1: int, bgr: tuple[int, int, int]) -> None:
        img[row * cell + y0 : row * cell + y1, col * cell + x0 : col * cell + x1] = bgr

    red = (0, 0, 220)
    blue = (220, 40, 20)
    dark = (30, 30, 40)

    # Top-left cell: main figure, nearby sunglasses, hat-top from the row below.
    paint(0, 0, 12, 44, 14, 46, red)
    paint(0, 0, 6, 10, 20, 36, dark)
    paint(0, 0, 52, 60, 20, 40, blue)
    for row in range(rows):
        for col in range(cols):
            if row == 0 and col == 0:
                continue
            paint(row, col, 14, 46, 14, 46, red)

    cells = process_image(img, key=True, grid=(3, 3), split="grid", trim=True)
    assert len(cells) == 9
    top_left = cells[0]
    assert not is_empty(top_left)
    # Intrusion would pin the trim to the full 60px cell height.
    assert top_left.shape[0] < 55
    assert top_left.shape[1] < 55

    opaque = top_left[:, :, 3] > 128
    assert int(np.count_nonzero(opaque)) > 50
    blue_ch, _green_ch, red_ch = top_left[:, :, 0], top_left[:, :, 1], top_left[:, :, 2]
    blueish = opaque & (blue_ch > 150) & (blue_ch > red_ch)
    assert int(np.count_nonzero(blueish)) == 0
    # Detached sunglasses (dark, sitting just above the head) stay.
    darkish = opaque & (red_ch < 80) & (blue_ch < 80)
    assert int(np.count_nonzero(darkish)) >= 8
