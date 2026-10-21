"""Make Shazza's talking mouth set from her approved picture.

Plain Python (not Blender). Needs Pillow, numpy, opencv-python-headless:
    python tools/blender/make_shazza_mouths.py

Reads  tools/blender/assets/sunnybanks/cut-shazza.png  (background removed)
Writes shazza-nomouth.png   same picture with her red lips painted out
       shazza-mouths.png    3x3 atlas of nine mouths, order A B C / D E F / G H X
       shazza-mouths.json   where the mouth sits on the picture
       shazza-mouth-preview.png  all nine on her face

She faces left in three-quarter view with a closed mouth, so the mouths are
made from her own lips: the picture is split along the line between the lips,
the upper lip stays and the lower lip drops by different amounts, with a dark
mouth (and teeth, tongue) painted in the gap. The lips are cut to her outline
so they never stick out past her face. X is her closed lips exactly as drawn.
To hand-fix a mouth, edit that square in shazza-mouths.png and do not re-run
this script.
"""

import json
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets", "sunnybanks")

LIPS_POLY = [(89, 292), (100, 289), (118, 290), (132, 297), (143, 307), (140, 312), (128, 322),
             (112, 328), (96, 327), (89, 320), (88, 308)]
PART_Y = 309.0  # the line between her lips
BOX = (80, 282, 154, 348)  # left, top, right, bottom of each sprite
OUT_SCALE = 4
SS = 4
LAYOUT = ["A", "B", "C", "D", "E", "F", "G", "H", "X"]

INSIDE = (70, 24, 28, 255)
TEETH = (246, 242, 230, 255)
TEETH_GAP = (206, 196, 180, 255)
TONGUE = (200, 96, 100, 255)

# drop: how far the lower lip goes down (px); lift: upper lip up; wf: width
# factor about the middle of the mouth; teeth / lower_teeth: depth (px);
# tongue: 0..1 how much of the gap it fills.
SHAPES = {
    "A": dict(drop=0.0, lift=0.0, wf=0.94, squeeze=True),
    "B": dict(drop=3.0, lift=0.5, wf=1.0, teeth=2.2),
    "C": dict(drop=7.0, lift=1.0, wf=1.0, teeth=3.2, tongue=0.3),
    "D": dict(drop=14.0, lift=2.0, wf=1.04, teeth=4.2, lower_teeth=2.4, tongue=0.7),
    "E": dict(drop=9.0, lift=1.0, wf=0.74, teeth=2.6, tongue=0.3),
    "F": dict(drop=7.0, lift=1.0, wf=0.52, pucker=True),
    "G": dict(drop=3.6, lift=0.6, wf=1.0, teeth=3.2, lip_over=True),
    "H": dict(drop=9.5, lift=1.5, wf=0.92, teeth=3.2, tongue=1.0),
    "X": dict(drop=0.0, lift=0.0, wf=1.0),
}


def remove_lips(rgba):
    rgb = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2BGR)
    poly = np.zeros(rgb.shape[:2], np.uint8)
    cv2.fillPoly(poly, [np.array(LIPS_POLY, np.int32)], 255)
    poly = cv2.dilate(poly, np.ones((5, 5), np.uint8))
    solid = cv2.erode((rgba[..., 3] > 250).astype(np.uint8) * 255, np.ones((3, 3), np.uint8))
    mask = cv2.bitwise_and(poly, solid)
    filled = rgb.copy()
    ys, xs = np.nonzero(mask)
    sample_x = slice(148, 156)
    rows = np.arange(ys.min() - 6, ys.max() + 7)
    row_colour = {}
    for y in rows:
        row_colour[y] = rgb[y, sample_x].astype(np.float32).mean(axis=0)
    ordered = np.array([row_colour[y] for y in rows])
    ordered = cv2.GaussianBlur(ordered.reshape(-1, 1, 3), (0, 0), 3).reshape(-1, 3)
    for y, colour in zip(rows, ordered):
        row_colour[y] = colour
    for y, x in zip(ys, xs):
        filled[y, x] = row_colour[y]
    soft_mask = cv2.GaussianBlur(mask, (0, 0), 1.6).astype(np.float32)[..., None] / 255.0
    patch = cv2.GaussianBlur(filled, (0, 0), 1.4).astype(np.float32)
    filled = (rgb * (1 - soft_mask) + patch * soft_mask).astype(np.uint8)
    out = rgba.copy()
    out[..., :3] = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB)
    return out


def lip_mask(orig, base):
    poly = np.zeros(orig.shape[:2], np.uint8)
    cv2.fillPoly(poly, [np.array(LIPS_POLY, np.int32)], 255)
    poly = cv2.dilate(poly, np.ones((5, 5), np.uint8))
    diff = np.abs(orig[..., :3].astype(int) - base[..., :3].astype(int)).max(2)
    m = ((diff > 22) & (poly > 0) & (orig[..., 3] > 250)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    m = (lab == biggest).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 255, -1)
    return filled


X_LEFT, X_RIGHT = 89.0, 143.0


def open_profile(w, power=0.7):
    """How open the mouth is at each column: zero at the corners, one in the
    middle, so the gap is lens-shaped instead of a box."""
    xs = np.arange(w, dtype=np.float32)
    t = np.clip((xs - X_LEFT) / (X_RIGHT - X_LEFT), 0, 1)
    return np.clip(np.sin(np.pi * t), 0, 1) ** power


def shifted_piece(orig, mask, upper, dy, wf, xc):
    """The upper or lower half of her lips, moved up or down by dy pixels in the
    middle (less toward the corners) and squeezed sideways by wf about xc."""
    h, w = mask.shape
    prof = open_profile(w)
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    src_x = xc + (xs - xc) / wf
    col = np.clip(np.round(src_x).astype(int), 0, w - 1)
    src_y = ys - dy * prof[col]
    rows = np.arange(h, dtype=np.float32)[:, None]
    half = (rows < PART_Y) if upper else (rows >= PART_Y)
    alpha = np.where(half, mask, 0).astype(np.uint8)
    a = cv2.remap(alpha, src_x, src_y, cv2.INTER_LINEAR, borderValue=0)
    rgb = cv2.remap(orig[..., :3], src_x, src_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return rgb, a


def column_edge(alpha, upper):
    """For each column, the lowest row of the upper piece or the highest row
    of the lower piece (nan if empty)."""
    h, w = alpha.shape
    edge = np.full(w, np.nan)
    for x in range(w):
        ys = np.nonzero(alpha[:, x] > 128)[0]
        if len(ys):
            edge[x] = ys.max() if upper else ys.min()
    return edge


def make_sprite(name, orig, mask, silhouette):
    spec = SHAPES[name]
    xc = X_LEFT + 0.3 * (X_RIGHT - X_LEFT) if spec["wf"] < 1 else (X_LEFT + X_RIGHT) / 2.0
    up_rgb, up_a = shifted_piece(orig, mask, True, -spec["lift"], spec["wf"], xc)
    lo_rgb, lo_a = shifted_piece(orig, mask, False, spec["drop"], spec["wf"], xc)
    lo_a = np.minimum(lo_a, silhouette)
    left, top, right, bottom = BOX
    h, w = mask.shape
    rows = np.arange(h)[:, None]

    inside = np.zeros((h, w), np.uint8)
    up_edge = column_edge(up_a, True)
    lo_edge = column_edge(lo_a, False)
    if spec["drop"] > 0.5:
        for x in range(w):
            if np.isnan(up_edge[x]) or np.isnan(lo_edge[x]):
                continue
            y0, y1 = int(up_edge[x]) - 2, int(lo_edge[x]) + 2
            if y1 > y0:
                inside[y0:y1, x] = 255

    colour = np.zeros((h, w, 4), np.uint8)
    colour[...] = INSIDE
    if inside.any():
        top_e = np.nan_to_num(up_edge, nan=0)[None, :]
        bot_e = np.nan_to_num(lo_edge, nan=0)[None, :]
        if spec.get("teeth"):
            band = (rows >= top_e - 1) & (rows <= top_e + spec["teeth"])
            colour[band] = TEETH
            gaps = (np.arange(w)[None, :] % 4 == 0) & band
            colour[gaps] = TEETH_GAP
        if spec.get("lower_teeth"):
            band = (rows >= bot_e - spec["lower_teeth"]) & (rows <= bot_e + 1)
            colour[band] = TEETH
        if spec.get("tongue"):
            ys, xs = np.nonzero(inside)
            mx, my1, my0 = (xs.min() + xs.max()) / 2, ys.max(), ys.min()
            tw = (xs.max() - xs.min()) * 0.3
            th = (my1 - my0) * 0.9 * spec["tongue"]
            tongue = np.zeros((h, w), np.uint8)
            cv2.ellipse(tongue, (int(mx), int(my1)), (int(tw), int(max(th, 1))), 0, 180, 360, 255, -1)
            colour[(tongue > 0) & (inside > 0)] = TONGUE
    gap_alpha = cv2.GaussianBlur(inside, (0, 0), 0.7)
    gap_alpha = np.minimum(gap_alpha, silhouette)
    colour[..., 3] = gap_alpha

    out = Image.fromarray(colour, "RGBA")
    out.alpha_composite(Image.fromarray(np.dstack([lo_rgb, lo_a]), "RGBA"))
    out.alpha_composite(Image.fromarray(np.dstack([up_rgb, up_a]), "RGBA"))
    sprite = out.crop(BOX)
    return sprite.resize(((right - left) * OUT_SCALE, (bottom - top) * OUT_SCALE), Image.LANCZOS)


def main():
    src = Image.open(os.path.join(ASSETS, "cut-shazza.png")).convert("RGBA")
    orig = np.asarray(src).copy()
    base_arr = remove_lips(orig)
    Image.fromarray(base_arr, "RGBA").save(os.path.join(ASSETS, "shazza-nomouth.png"))
    mask = lip_mask(orig, base_arr)
    silhouette = (orig[..., 3] > 128).astype(np.uint8) * 255
    silhouette = cv2.GaussianBlur(silhouette, (0, 0), 0.6)

    cell = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    atlas = Image.new("RGBA", (cell[0] * 3, cell[1] * 3), (0, 0, 0, 0))
    base = Image.fromarray(base_arr, "RGBA")
    face_box = (BOX[0] - 40, BOX[1] - 110, BOX[2] + 50, BOX[3] + 20)
    face = base.crop(face_box)
    face = face.resize((face.width * OUT_SCALE, face.height * OUT_SCALE), Image.LANCZOS)
    preview = Image.new("RGB", (face.width * 3, face.height * 3), (255, 0, 255))
    for i, name in enumerate(LAYOUT):
        sprite = make_sprite(name, orig, mask, silhouette)
        atlas.paste(sprite, ((i % 3) * cell[0], (i // 3) * cell[1]))
        tile = Image.new("RGBA", face.size, (255, 0, 255, 255))
        tile.paste(face, (0, 0), face)
        tile.alpha_composite(sprite, ((BOX[0] - face_box[0]) * OUT_SCALE, (BOX[1] - face_box[1]) * OUT_SCALE))
        ImageDraw.Draw(tile).text((6, 6), name, fill=(0, 0, 0, 255))
        preview.paste(tile.convert("RGB"), ((i % 3) * face.width, (i // 3) * face.height))
    atlas.save(os.path.join(ASSETS, "shazza-mouths.png"))
    preview.save(os.path.join(ASSETS, "shazza-mouth-preview.png"))
    with open(os.path.join(ASSETS, "shazza-mouths.json"), "w") as fh:
        json.dump({"picture_size": list(src.size), "box": list(BOX), "layout": LAYOUT,
                   "columns": 3, "rows": 3}, fh, indent=1)
    print("wrote shazza-nomouth.png, shazza-mouths.png, shazza-mouths.json, shazza-mouth-preview.png")


if __name__ == "__main__":
    main()
