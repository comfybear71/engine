"""Style lab: render the same house at three camera positions in several
cartoon looks, then tile them into one picture to compare.

Run:
    blender -b -P tools/blender/style_lab.py -- --out renders/style_lab

Writes one PNG per style and position, plus style_sheet.png (one row per
style, columns are bedroom, hall, living room). Row order is printed and
saved in style_sheet.txt. Tested with Blender 5.2.2 LTS, CPU only.
"""

import argparse
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import house_flythrough as house  # noqa: E402  (guarded, does not auto-run)

FRAMES = 72
SAMPLE_FRAMES = [1, 30, 58]
STYLES = ["flat", "ink", "shaded", "toon"]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="style_lab")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--styles", default=",".join(STYLES))
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def set_outline(on, thickness=2.5):
    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    scene.render.use_freestyle = on
    view_layer.use_freestyle = on
    if not on:
        return
    scene.render.line_thickness_mode = "ABSOLUTE"
    scene.render.line_thickness = thickness
    settings = view_layer.freestyle_settings
    settings.as_render_pass = False
    lineset = settings.linesets[0] if settings.linesets else settings.linesets.new("ink")
    lineset.select_silhouette = True
    lineset.select_border = True
    lineset.select_crease = True
    lineset.select_edge_mark = False
    lineset.select_by_visibility = True
    if lineset.linestyle is None:
        lineset.linestyle = bpy.data.linestyles.new("ink")
    lineset.linestyle.color = (0.08, 0.05, 0.04)
    lineset.linestyle.thickness = thickness


def toon_materials():
    for mat in bpy.data.materials:
        color = tuple(mat.diffuse_color)
        mat.use_nodes = True
        tree = mat.node_tree
        tree.nodes.clear()
        out = tree.nodes.new("ShaderNodeOutputMaterial")
        bsdf = tree.nodes.new("ShaderNodeBsdfToon")
        bsdf.inputs["Color"].default_value = color
        bsdf.inputs["Size"].default_value = 0.6
        bsdf.inputs["Smooth"].default_value = 0.05
        tree.links.new(bsdf.outputs[0], out.inputs["Surface"])


def add_sun():
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 4.0
    sun.color = (1.0, 0.9, 0.72)
    sun.angle = 0.02
    obj = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler = (0.9, 0.35, 0.6)


def setup_style(name, width, height):
    scene = bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.view_settings.view_transform = "Standard"
    shading = scene.display.shading
    if name in ("flat", "ink", "shaded"):
        scene.render.engine = "BLENDER_WORKBENCH"
        shading.color_type = "MATERIAL"
        shading.show_object_outline = name == "flat"
        shading.show_shadows = name == "shaded"
        shading.show_cavity = False
        shading.light = "STUDIO" if name == "shaded" else "FLAT"
        if name == "shaded":
            shading.shadow_intensity = 0.4
            shading.show_object_outline = True
        set_outline(name == "ink")
    elif name == "toon":
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 48
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
        scene.world.use_nodes = False
        scene.world.color = (0.55, 0.62, 0.7)
        set_outline(True, 2.5)
    else:
        raise SystemExit("unknown style " + name)


def render_still(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def load_pixels(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    bpy.data.images.remove(img)
    return arr.reshape(h, w, 4)


def tile_sheet(rows, out_path):
    row_imgs = [np.concatenate([load_pixels(p) for p in row], axis=1) for row in rows]
    sheet = np.concatenate(row_imgs[::-1], axis=0)
    h, w = sheet.shape[:2]
    img = bpy.data.images.new("sheet", w, h)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = out_path
    img.file_format = "PNG"
    img.save()


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    house.build_house()
    house.add_camera(FRAMES)
    house.setup_render(args.out, args.width, args.height)
    add_sun()

    styles = [s for s in args.styles.split(",") if s]
    rows = []
    toon_done = False
    for style in styles:
        if style == "toon" and not toon_done:
            toon_materials()
            toon_done = True
        setup_style(style, args.width, args.height)
        row = []
        for frame in SAMPLE_FRAMES:
            bpy.context.scene.frame_set(frame)
            path = os.path.join(args.out, "%s_f%04d.png" % (style, frame))
            render_still(path)
            row.append(path)
        rows.append(row)

    tile_sheet(rows, os.path.join(args.out, "style_sheet.png"))
    with open(os.path.join(args.out, "style_sheet.txt"), "w") as f:
        f.write("Rows, top to bottom: " + ", ".join(styles) + "\n")
        f.write("Columns: bedroom, hall, living room\n")
    print("ROWS top to bottom:", ", ".join(styles))
    print("WROTE", os.path.join(args.out, "style_sheet.png"))


main()
