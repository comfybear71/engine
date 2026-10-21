"""Make Dazza's talking mouth set from his approved picture.

Plain Python (not Blender). Needs Pillow, numpy, opencv-python-headless:
    python tools/blender/make_dazza_mouths.py

Reads  tools/blender/assets/sunnybanks/cut-dazza.png  (background removed)
Writes dazza-nomouth.png   same picture with his open grin painted out
       dazza-mouths.png    3x3 atlas of nine drawn mouths, order
                           A B C / D E F / G H X  (Rhubarb shape letters)
       dazza-mouths.json   where the mouth sits on the picture

The mouths are drawn with code, not by an artist, so they are plain. The
files are committed, so this only needs re-running to change the drawings.
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


def to_canvas(p):
    return ((p[0] - BOX[0]) * SS, (p[1] - BOX[1]) * SS)


def draw_mouth(name):
    s = SHAPES[name]
    w, h = (BOX[2] - BOX[0]) * SS, (BOX[3] - BOX[1]) * SS
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    sag = s.get("sag", 0.0)
    ts = np.linspace(s["t0"], s["t1"], 60)
    top = [upper_edge(t, sag) for t in ts]
    width_scale = (s["t1"] - s["t0"])
    if s["open"] > 0:
        drop = [np.array([0, s["open"] * math.sin(math.pi * (i / 59)) ** 0.7]) for i in range(60)]
        bottom = [top[i] + drop[i] for i in range(60)]
        poly = [to_canvas(p) for p in top] + [to_canvas(p) for p in bottom[::-1]]
        d.polygon(poly, fill=MOUTH_DARK)
        if s.get("tongue"):
            k = s["tongue"]
            cx = (top[30][0] + bottom[30][0]) / 2
            by = bottom[30][1]
            ty = by - s["open"] * 0.45 * k if not s.get("tongue_up") else top[30][1] + s["open"] * 0.25
            rx = 24 * max(width_scale, 0.5)
            d.ellipse([to_canvas((cx - rx, ty)), to_canvas((cx + rx, by + 1))], fill=TONGUE)
            im2 = Image.new("RGBA", im.size, (0, 0, 0, 0))
            m = Image.new("L", im.size, 0)
            ImageDraw.Draw(m).polygon(poly, fill=255)
            im2.paste(im, (0, 0), m)
            im = im2
            d = ImageDraw.Draw(im)
        if s.get("teeth"):
            th = min(14, s["open"] * 0.45)
            tooth_w = 13
            n = int((s["t1"] - s["t0"]) * 150 / tooth_w)
            for i in range(n):
                t = s["t0"] + (i + 0.5) / n * (s["t1"] - s["t0"])
                if 0.44 < t < 0.54:
                    continue
                p = upper_edge(t, sag)
                y_top = p[1] + 1
                d.rounded_rectangle([to_canvas((p[0] - tooth_w / 2 + 1, y_top)),
                                     to_canvas((p[0] + tooth_w / 2 - 1, y_top + th))],
                                    radius=3 * SS, fill=TEETH, outline=(120, 100, 70, 255), width=1)
        if s.get("lip_over"):
            p = bottom[30]
            d.ellipse([to_canvas((p[0] - 30, p[1] - 10)), to_canvas((p[0] + 30, p[1] + 5))],
                      fill=(214, 140, 116, 255), outline=INK, width=2 * SS)
        d.line([to_canvas(p) for p in top], fill=INK, width=int(2.6 * SS), joint="curve")
        d.line([to_canvas(p) for p in bottom], fill=INK, width=int(2.4 * SS), joint="curve")
        d.line([to_canvas(top[0]), to_canvas(bottom[0])], fill=INK, width=int(2.2 * SS))
        d.line([to_canvas(top[-1]), to_canvas(bottom[-1])], fill=INK, width=int(2.2 * SS))
    else:
        pts = [to_canvas(p) for p in top]
        d.line(pts, fill=INK, width=int(3.2 * SS), joint="curve")
        for end, sign in ((top[0], -1), (top[-1], 1)):
            d.line([to_canvas(end), to_canvas(end + np.array([sign * -3, -5]))], fill=INK, width=int(2.4 * SS))
    out_size = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    return im.filter(ImageFilter.GaussianBlur(0.6)).resize(out_size, Image.LANCZOS)


def main():
    src = Image.open(os.path.join(ASSETS, "cut-dazza.png")).convert("RGBA")
    remove_grin(src).save(os.path.join(ASSETS, "dazza-nomouth.png"))
    cell = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    atlas = Image.new("RGBA", (cell[0] * 3, cell[1] * 3), (0, 0, 0, 0))
    for i, name in enumerate(LAYOUT):
        atlas.paste(draw_mouth(name), ((i % 3) * cell[0], (i // 3) * cell[1]))
    atlas.save(os.path.join(ASSETS, "dazza-mouths.png"))
    with open(os.path.join(ASSETS, "dazza-mouths.json"), "w") as fh:
        json.dump({"picture_size": list(src.size), "box": list(BOX), "layout": LAYOUT,
                   "columns": 3, "rows": 3}, fh, indent=1)
    print("wrote dazza-nomouth.png, dazza-mouths.png, dazza-mouths.json")


if __name__ == "__main__":
    main()
