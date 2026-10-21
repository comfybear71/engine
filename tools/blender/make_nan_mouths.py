"""Make Nan's talking mouth set from her approved picture.

Plain Python (not Blender). Needs Pillow, numpy, opencv-python-headless:
    python tools/blender/make_nan_mouths.py

Reads  tools/blender/assets/sunnybanks/cut-nan.png  (background removed)
Writes nan-nomouth.png   same picture with her thin grumpy mouth line painted out
       nan-mouths.png    3x3 atlas of nine mouths, order A B C / D E F / G H X
       nan-mouths.json   where the mouth sits on the picture
       nan-mouth-preview.png  all nine on her face

Unlike Dazza, Nan has a closed mouth and no grin to squash, so the open
mouths are drawn: a lens shape along her own mouth line (so the tilt and the
frown match), a thin lip outline, a pale lip band, dentures and tongue. X is
her own mouth line, cut out of the picture. To hand-fix a mouth, edit that
square in nan-mouths.png in any paint program and do not re-run this script.
"""

import json
import math
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets", "sunnybanks")

BOX = (108, 202, 202, 248)  # left, top, right, bottom of each sprite
SS = 6
OUT_SCALE = 3
LAYOUT = ["A", "B", "C", "D", "E", "F", "G", "H", "X"]

# Her mouth line in cut-nan.png (x, y), left corner to right corner.
LINE = [(128, 222.5), (134, 220.0), (142, 218.0), (152, 217.2), (164, 217.0), (174, 216.8), (182, 217.8)]
LINE_BOX = (127, 211, 188, 225)  # region searched for the dark line to paint out

INK = (66, 36, 30, 255)
INSIDE = (60, 22, 26, 255)
TEETH = (246, 242, 228, 255)
TEETH_GAP = (196, 186, 166, 255)
TONGUE = (196, 98, 100, 255)
LIP = (206, 132, 114, 255)
LIP_DARK = (170, 100, 88, 255)


def centre_y(x):
    xs, ys = zip(*LINE)
    return float(np.interp(x, xs, ys))


def remove_line(rgba):
    rgb = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2BGR)
    lum = rgba[..., :3].astype(int).mean(2)
    l, t, r, b = LINE_BOX
    region = np.zeros(lum.shape, np.uint8)
    region[t:b, l:r] = 255
    line = ((lum < 158) & (region > 0)).astype(np.uint8) * 255
    line = cv2.dilate(line, np.ones((5, 5), np.uint8))
    filled = cv2.inpaint(rgb, line, 5, cv2.INPAINT_TELEA)
    soft = cv2.GaussianBlur(filled, (0, 0), 1.6)
    filled = np.where(line[..., None] > 0, soft, filled)
    out = rgba.copy()
    out[..., :3] = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB)
    return out, line


def canvas():
    w, h = (BOX[2] - BOX[0]) * SS, (BOX[3] - BOX[1]) * SS
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def to_px(x, y):
    return ((x - BOX[0]) * SS, (y - BOX[1]) * SS)


def profile(t, power):
    return max(math.sin(math.pi * t), 0.0) ** power


def lens_points(wf, height, power, arch=0.0, centre=0.52):
    """Upper and lower lip curves of an open mouth, both in picture pixels."""
    xl, xr = LINE[0][0], LINE[-1][0]
    xc = xl + (xr - xl) * centre
    half = (xr - xl) / 2 * wf
    xs = np.linspace(xc - half, xc + half, 60)
    upper, lower = [], []
    for x in xs:
        t = (x - (xc - half)) / (2 * half)
        y = centre_y(x)
        p = profile(t, power)
        upper.append((x, y - arch * height * p))
        lower.append((x, y + (1 - arch) * height * p))
    return upper, lower


def band(im, pts, width, colour, blur, dy=0.0):
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).line([(*to_px(x, y + dy),) for x, y in pts], fill=colour,
                               width=int(width * SS), joint="curve")
    im.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur * SS)))


def open_mouth(wf, height, power=0.6, teeth=0.0, lower_teeth=0.0, tongue=0.0,
               tongue_up=False, pucker=False, lip_over=False, arch=0.0):
    im = canvas()
    upper, lower = lens_points(wf, height, power, arch)
    poly = [to_px(x, y) for x, y in upper] + [to_px(x, y) for x, y in reversed(lower)]

    band(im, lower, 4.0 if not pucker else 6.0, LIP, 1.1, dy=2.4)
    band(im, upper, 2.2, LIP, 0.9, dy=-1.4)
    if pucker:
        band(im, upper, 5.0, LIP, 1.1, dy=-2.2)

    inside = Image.new("L", im.size, 0)
    ImageDraw.Draw(inside).polygon(poly, fill=255)
    fill = Image.new("RGBA", im.size, INSIDE)

    parts = Image.new("RGBA", im.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(parts)
    xs = [p[0] for p in poly]
    x_left, x_right = min(xs), max(xs)
    mid = (x_left + x_right) / 2
    top_y = min(p[1] for p in poly)
    bot_y = max(p[1] for p in poly)
    if tongue:
        tw = (x_right - x_left) * (0.30 if tongue_up else 0.34)
        if tongue_up:
            ty0, ty1 = top_y + 0.1 * (bot_y - top_y), top_y + 0.62 * (bot_y - top_y)
        else:
            ty0, ty1 = bot_y - tongue * 0.62 * (bot_y - top_y), bot_y + 4 * SS
        pd.ellipse([mid - tw, ty0, mid + tw, ty1], fill=TONGUE)
    if teeth:
        td = teeth * SS
        pd.rectangle([x_left, top_y - 2 * SS, x_right, top_y + td + (0 if lip_over else 0)], fill=TEETH)
        gap = 5.2 * SS
        x = x_left + gap
        while x < x_right:
            pd.line([(x, top_y), (x, top_y + td)], fill=TEETH_GAP, width=max(1, int(0.5 * SS)))
            x += gap
        pd.line([(x_left, top_y + td), (x_right, top_y + td)], fill=TEETH_GAP, width=max(1, int(0.5 * SS)))
    if lower_teeth:
        td = lower_teeth * SS
        pd.rectangle([x_left + 4 * SS, bot_y - td, x_right - 4 * SS, bot_y + 2 * SS], fill=TEETH)

    fill.alpha_composite(parts)
    im.paste(fill, (0, 0), inside)
    d = ImageDraw.Draw(im)
    d.line(poly + [poly[0]], fill=INK, width=int(1.7 * SS), joint="curve")
    if pucker:
        cx, cy = mid, (top_y + bot_y) / 2
        rx = (x_right - x_left) / 2
        for ang in (-50, 0, 50, 130, 180, 230):
            a = math.radians(ang)
            r0 = rx + 3.2 * SS
            r1 = rx + 6.2 * SS
            d.line([(cx + math.cos(a) * r0, cy + math.sin(a) * r0 * 0.9),
                    (cx + math.cos(a) * r1, cy + math.sin(a) * r1 * 0.9)],
                   fill=LIP_DARK, width=int(0.9 * SS))
    return im


def pressed_line(thick):
    """A: lips pressed together, a bit narrower than at rest."""
    im = canvas()
    pts = [(x, y) for x, y in LINE if 130 <= x <= 180]
    xs = np.linspace(131, 179, 50)
    curve = [(x, centre_y(x) + 0.4) for x in xs]
    band(im, curve, 5.4, LIP, 1.2, dy=2.0)
    band(im, curve, 3.0, LIP, 1.0, dy=-1.6)
    d = ImageDraw.Draw(im)
    d.line([to_px(x, y) for x, y in curve], fill=INK, width=int(thick * SS), joint="curve")
    return im


def rest_from_picture(orig, line_mask):
    """X: the mouth line exactly as drawn in her picture."""
    left, top, right, bottom = BOX
    rgb = orig[top:bottom, left:right, :3]
    alpha = line_mask[top:bottom, left:right].copy()
    alpha = cv2.GaussianBlur(alpha, (0, 0), 0.8)
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


SHAPES = {
    "B": dict(wf=0.86, height=5.0, power=0.55, teeth=2.8),
    "C": dict(wf=0.92, height=11.0, power=0.6, teeth=4.0, tongue=0.35),
    "D": dict(wf=1.0, height=19.0, power=0.62, teeth=5.0, lower_teeth=3.6, tongue=0.8),
    "E": dict(wf=0.64, height=14.0, power=0.5, teeth=3.0, tongue=0.3, arch=0.25),
    "F": dict(wf=0.42, height=12.0, power=0.5, pucker=True, arch=0.5),
    "G": dict(wf=0.9, height=5.6, power=0.55, teeth=3.6, lip_over=True),
    "H": dict(wf=0.82, height=12.5, power=0.6, teeth=3.6, tongue=1.0, tongue_up=True),
}


def make_sprite(name, orig, line_mask):
    if name == "X":
        img = rest_from_picture(orig, line_mask)
    elif name == "A":
        img = pressed_line(2.6).resize((BOX[2] - BOX[0], BOX[3] - BOX[1]), Image.LANCZOS)
    else:
        img = open_mouth(**SHAPES[name]).resize((BOX[2] - BOX[0], BOX[3] - BOX[1]), Image.LANCZOS)
    size = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    return img.resize(size, Image.LANCZOS)


def main():
    src = Image.open(os.path.join(ASSETS, "cut-nan.png")).convert("RGBA")
    orig = np.asarray(src).copy()
    base_arr, line_mask = remove_line(orig)
    base = Image.fromarray(base_arr, "RGBA")
    base.save(os.path.join(ASSETS, "nan-nomouth.png"))

    cell = ((BOX[2] - BOX[0]) * OUT_SCALE, (BOX[3] - BOX[1]) * OUT_SCALE)
    atlas = Image.new("RGBA", (cell[0] * 3, cell[1] * 3), (0, 0, 0, 0))
    face_box = (BOX[0] - 40, BOX[1] - 100, BOX[2] + 40, BOX[3] + 50)
    face = base.crop(face_box)
    face = face.resize((face.width * OUT_SCALE, face.height * OUT_SCALE), Image.LANCZOS)
    preview = Image.new("RGB", (face.width * 3, face.height * 3), (255, 0, 255))
    for i, name in enumerate(LAYOUT):
        sprite = make_sprite(name, orig, line_mask)
        atlas.paste(sprite, ((i % 3) * cell[0], (i // 3) * cell[1]))
        tile = Image.new("RGBA", face.size, (255, 0, 255, 255))
        tile.paste(face, (0, 0), face)
        tile.alpha_composite(sprite, ((BOX[0] - face_box[0]) * OUT_SCALE, (BOX[1] - face_box[1]) * OUT_SCALE))
        ImageDraw.Draw(tile).text((6, 6), name, fill=(0, 0, 0, 255))
        preview.paste(tile.convert("RGB"), ((i % 3) * face.width, (i // 3) * face.height))
    atlas.save(os.path.join(ASSETS, "nan-mouths.png"))
    preview.save(os.path.join(ASSETS, "nan-mouth-preview.png"))
    with open(os.path.join(ASSETS, "nan-mouths.json"), "w") as fh:
        json.dump({"picture_size": list(src.size), "box": list(BOX), "layout": LAYOUT,
                   "columns": 3, "rows": 3}, fh, indent=1)
    print("wrote nan-nomouth.png, nan-mouths.png, nan-mouths.json, nan-mouth-preview.png")


if __name__ == "__main__":
    main()
