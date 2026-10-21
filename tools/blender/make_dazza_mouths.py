"""Make Dazza's talking mouth set from his approved picture.

Plain Python (not Blender). Needs Pillow, numpy, opencv-python-headless:
    python tools/blender/make_dazza_mouths.py

Reads  tools/blender/assets/sunnybanks/cut-dazza.png  (background removed)
Writes dazza-nomouth.png   same picture with his open grin painted out
       dazza-mouths.png    3x3 atlas of nine drawn mouths, order
                           A B C / D E F / G H X  (Rhubarb shape letters)
       dazza-mouths.json   where the mouth sits on the picture

The open mouths are squashed copies of Dazza's own grin (his real teeth,
tongue and shading), so they match his art. The closed mouths are a line along
the top of that grin. To hand-fix a mouth, open dazza-mouths.png in any paint
program, change that square, save, and skip this script. The files are
committed, so this only needs re-running to change how the mouths are made.
dazza-mouth-preview.png shows all nine on his face.
"""

import json
import math
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets", "sunnybanks")

# Where his grin sits in cut-dazza.png (pixels), and the box the sprites cover.
GRIN_POLY = [(90, 224), (104, 236), (125, 243), (160, 239), (190, 225), (210, 206),
             (222, 202), (226, 225), (216, 262), (198, 287), (166, 300), (138, 298),
             (120, 286), (104, 264), (92, 242)]
BOX = (76, 192, 236, 306)  # left, top, right, bottom
SS = 4
OUT_SCALE = 2
LAYOUT = ["A", "B", "C", "D", "E", "F", "G", "H", "X"]
INK = (14, 8, 6, 255)
MOUTH_DARK = (30, 8, 8, 255)
TEETH = (238, 226, 182, 255)
TONGUE = (196, 98, 92, 255)

# open: how far the lower lip drops (px); t0..t1: how much of the grin width
# is used; kind: extra detail
SHAPES = {
    "X": dict(open=0, t0=0.0, t1=1.0, sag=-6),
    "A": dict(open=0, t0=0.05, t1=0.95, sag=0),
    "B": dict(open=12, t0=0.0, t1=1.0, teeth=True),
    "C": dict(open=34, t0=0.0, t1=1.0, teeth=True, tongue=0.5),
    "D": dict(open=56, t0=0.0, t1=1.0, teeth=True, tongue=1.0),
    "E": dict(open=38, t0=0.2, t1=0.8, teeth=False, tongue=0.4),
    "F": dict(open=30, t0=0.34, t1=0.66, teeth=False, tongue=0.0),
    "G": dict(open=16, t0=0.0, t1=1.0, teeth=True, lip_over=True),
    "H": dict(open=36, t0=0.05, t1=0.95, teeth=True, tongue=1.0, tongue_up=True),
}

L, C, R = np.array([93, 229.0]), np.array([152, 262.0]), np.array([219, 208.0])


def upper_edge(t, sag=0.0):
    c = C + np.array([0, sag])
    return (1 - t) ** 2 * L + 2 * (1 - t) * t * c + t ** 2 * R


def remove_grin(img):
    rgba = np.asarray(img).copy()
    rgb = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2BGR)
    mask = np.zeros(rgb.shape[:2], np.uint8)
    cv2.fillPoly(mask, [np.array(GRIN_POLY, np.int32)], 255)
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=1)
    solid = cv2.erode((rgba[..., 3] > 250).astype(np.uint8) * 255, np.ones((7, 7), np.uint8))
    outside = cv2.dilate((rgba[..., 3] < 250).astype(np.uint8) * 255, np.ones((3, 3), np.uint8))
    mask = cv2.bitwise_and(mask, solid)
    unknown = cv2.bitwise_or(mask, outside)
    filled = cv2.inpaint(rgb, unknown, 7, cv2.INPAINT_TELEA)
    filled = np.where(outside[..., None] > 0, rgb, filled)
    soft = cv2.GaussianBlur(filled, (0, 0), 3)
    filled = np.where(mask[..., None] > 0, soft, filled)
    rgba[..., :3] = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgba, "RGBA")


def grin_mask(orig, base):
    """Pixels that differ from the painted-out face: his teeth, tongue, dark
    inside and outline."""
    poly = np.zeros(orig.shape[:2], np.uint8)
    cv2.fillPoly(poly, [np.array(GRIN_POLY, np.int32)], 255)
    poly = cv2.dilate(poly, np.ones((5, 5), np.uint8))
    diff = np.abs(orig[..., :3].astype(int) - base[..., :3].astype(int)).max(2)
    m = ((diff > 24) & (poly > 0)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    m = (lab == biggest).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 255, -1)
    return filled


def column_extents(mask):
    ys, xs = np.nonzero(mask)
    x0, x1 = xs.min(), xs.max()
    top = np.full(mask.shape[1], np.nan)
    bot = np.full(mask.shape[1], np.nan)
    for x in range(x0, x1 + 1):
        col = np.nonzero(mask[:, x])[0]
        if len(col):
            top[x], bot[x] = col.min(), col.max()
    return x0, x1, top, bot


def squashed(orig, mask, extents, k, xscale=1.0):
    """The grin squeezed upward to a fraction k of its height (pinned along the
    top lip) and, if xscale < 1, narrower about its middle."""
    x0, x1, top, bot = extents
    left, top_box, right, bottom_box = BOX
    cx = (x0 + x1) / 2
    xs, ys = np.meshgrid(np.arange(left, right, dtype=np.float32),
                         np.arange(top_box, bottom_box, dtype=np.float32))
    src_x = cx + (xs - cx) / xscale
    col = np.clip(np.round(src_x).astype(int), 0, len(top) - 1)
    yt = top[col]
    valid = ~np.isnan(yt) & (src_x >= x0) & (src_x <= x1)
    yt = np.where(valid, yt, 0)
    src_y = yt + (ys - yt) / k
    map_x = src_x.astype(np.float32)
    map_y = src_y.astype(np.float32)
    rgb = cv2.remap(orig[..., :3], map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    alpha = cv2.remap(mask, map_x, map_y, cv2.INTER_LINEAR, borderValue=0)
    alpha = np.where(valid, alpha, 0).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 0.7)
    return np.dstack([rgb, alpha])


def closed_line(extents, thick):
    x0, x1, top, bot = extents
    left, top_box, right, bottom_box = BOX
    xs = np.arange(int(x0), int(x1) + 1)
    ys = np.array([top[x] for x in xs], dtype=float)
    good = ~np.isnan(ys)
    ys = np.interp(xs, xs[good], ys[good])
    ys = cv2.GaussianBlur(ys.reshape(1, -1).astype(np.float32), (0, 0), 3).ravel()
    w, h = (right - left) * SS, (bottom_box - top_box) * SS
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pts = [((x - left) * SS, (y + 3 - top_box) * SS) for x, y in zip(xs, ys)]
    d.line(pts, fill=INK, width=int(thick * SS), joint="curve")
    ex, ey = pts[-1]
    d.line([(ex, ey), (ex + 3 * SS, ey - 5 * SS)], fill=INK, width=int(2.4 * SS))
    sx, sy = pts[0]
    d.line([(sx, sy), (sx - 2 * SS, sy - 4 * SS)], fill=INK, width=int(2.4 * SS))
    return im.resize((right - left, bottom_box - top_box), Image.LANCZOS)


# shape: (how much of the grin's height, how narrow)
SQUASH = {
    "B": (0.30, 1.0),
    "C": (0.62, 1.0),
    "D": (1.00, 1.0),
    "E": (0.78, 0.62),
    "F": (0.60, 0.42),
    "G": (0.22, 0.95),
    "H": (0.70, 0.9),
}


def make_sprite(name, orig, mask, extents):
    if name in ("A", "X"):
        img = closed_line(extents, 3.6 if name == "A" else 3.0)
    else:
        k, xs = SQUASH[name]
        img = Image.fromarray(squashed(orig, mask, extents, k, xs), "RGBA")
    return img.resize(((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE), Image.LANCZOS)


def main():
    src = Image.open(os.path.join(ASSETS, "cut-dazza.png")).convert("RGBA")
    base = remove_grin(src)
    base.save(os.path.join(ASSETS, "dazza-nomouth.png"))
    orig = np.asarray(src)
    mask = grin_mask(orig, np.asarray(base))
    extents = column_extents(mask)
    cell = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    atlas = Image.new("RGBA", (cell[0] * 3, cell[1] * 3), (0, 0, 0, 0))
    face = base.crop((BOX[0] - 20, BOX[1] - 60, BOX[2] + 20, BOX[3] + 30))
    face = face.resize((face.width * OUT_SCALE, face.height * OUT_SCALE), Image.LANCZOS)
    preview = Image.new("RGB", (face.width * 3, face.height * 3), (255, 0, 255))
    for i, name in enumerate(LAYOUT):
        sprite = make_sprite(name, orig, mask, extents)
        atlas.paste(sprite, ((i % 3) * cell[0], (i // 3) * cell[1]))
        tile = Image.new("RGBA", face.size, (255, 0, 255, 255))
        tile.paste(face, (0, 0), face)
        tile.alpha_composite(sprite, (20 * OUT_SCALE, 60 * OUT_SCALE))
        d = ImageDraw.Draw(tile)
        d.text((6, 6), name, fill=(0, 0, 0, 255))
        preview.paste(tile.convert("RGB"), ((i % 3) * face.width, (i // 3) * face.height))
    atlas.save(os.path.join(ASSETS, "dazza-mouths.png"))
    preview.save(os.path.join(ASSETS, "dazza-mouth-preview.png"))
    with open(os.path.join(ASSETS, "dazza-mouths.json"), "w") as fh:
        json.dump({"picture_size": list(src.size), "box": list(BOX), "layout": LAYOUT,
                   "columns": 3, "rows": 3}, fh, indent=1)
    print("wrote dazza-nomouth.png, dazza-mouths.png, dazza-mouths.json, dazza-mouth-preview.png")


if __name__ == "__main__":
    main()
