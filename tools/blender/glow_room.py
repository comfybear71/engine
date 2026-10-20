"""Warm-glow living room: one room seen straight on, lit by lamps and
windows, soft shading, bloom and a vignette, no black outlines. Aimed at the
look of the game-background style references (wall lamps glowing, striped
wallpaper, curtains, wooden floor).

Run:
    blender -b -P tools/blender/glow_room.py -- --out renders/glow --mood evening

Moods: evening (lamp light, dusk windows) and day (sun through the windows).
Add --outline to draw thin dark lines over it (hybrid look).
Writes <out>/glow_<mood>[_lined].png. Tested with Blender 5.2.2 LTS, CPU only.
"""

import argparse
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cartoon_house as ch  # noqa: E402
import style_lab  # noqa: E402

ch.SHADER = "diffuse"

W, D, H = 3.3, 5.0, 3.0

MOODS = {
    "evening": {
        "wall": ((0.62, 0.46, 0.44, 1), (0.54, 0.38, 0.38, 1)),
        "floor": ("planks", (0.66, 0.42, 0.22, 1), (0.28, 0.16, 0.08, 1)),
        "ceiling": (0.8, 0.72, 0.62, 1),
        "trim": (0.72, 0.5, 0.28, 1),
        "sofa": (0.55, 0.12, 0.17, 1),
        "cushion": (0.62, 0.72, 0.3, 1),
        "curtain": (0.78, 0.34, 0.2, 1),
        "rug_outer": (0.55, 0.62, 0.62, 1),
        "rug_inner": (0.82, 0.78, 0.66, 1),
        "wood": (0.5, 0.3, 0.14, 1),
        "world": (0.01, 0.01, 0.015),
        "lamp_light": (1.0, 0.62, 0.3),
        "lamp_power": 110,
        "window_glass": ((0.2, 0.3, 0.45), 1.2),
        "window_light": ((0.45, 0.6, 1.0), 40),
        "sun": None,
    },
    "day": {
        "wall": ((0.98, 0.58, 0.55, 1), (0.93, 0.5, 0.48, 1)),
        "floor": ("planks", (0.74, 0.52, 0.3, 1), (0.36, 0.22, 0.12, 1)),
        "ceiling": (0.98, 0.9, 0.8, 1),
        "trim": (0.96, 0.84, 0.6, 1),
        "sofa": (0.25, 0.62, 0.72, 1),
        "cushion": (0.96, 0.7, 0.3, 1),
        "curtain": (0.95, 0.75, 0.35, 1),
        "rug_outer": (0.5, 0.35, 0.7, 1),
        "rug_inner": (0.95, 0.6, 0.7, 1),
        "wood": (0.7, 0.42, 0.2, 1),
        "world": (0.5, 0.62, 0.8),
        "lamp_light": (1.0, 0.8, 0.55),
        "lamp_power": 15,
        "window_glass": ((0.5, 0.75, 1.0), 0.9),
        "window_light": ((0.8, 0.9, 1.0), 10),
        "sun": ((1.0, 0.85, 0.6), 2.2),
    },
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="glow")
    p.add_argument("--mood", default="evening", choices=list(MOODS))
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--samples", type=int, default=96)
    p.add_argument("--outline", action="store_true")
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def glow_mat(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    emit = tree.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = tuple(color[:3]) + (1,)
    emit.inputs["Strength"].default_value = strength
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def add_point(name, loc, color, power, radius=0.08):
    light = bpy.data.lights.new(name, "POINT")
    light.color = color
    light.energy = power
    light.shadow_soft_size = radius
    obj = bpy.data.objects.new(name, light)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    return obj


def add_area(name, loc, size, color, power, rot):
    light = bpy.data.lights.new(name, "AREA")
    light.shape = "RECTANGLE"
    light.size, light.size_y = size
    light.color = color
    light.energy = power
    obj = bpy.data.objects.new(name, light)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    return obj


def window(name, x0, x1, z0, z1, m):
    y = D
    trim = ch.flat(m["trim"])
    ch.box(name + "_trim", x0 - 0.1, x1 + 0.1, y - 0.1, y, z0 - 0.1, z1 + 0.1, trim, 0.015)
    glass_col, strength = m["window_glass"]
    ch.box(name + "_glass", x0, x1, y - 0.12, y - 0.09, z0, z1, glow_mat(name + "_g", glass_col, strength))
    mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
    ch.box(name + "_bv", mx - 0.025, mx + 0.025, y - 0.14, y - 0.09, z0, z1, trim)
    for k in (-1, 1):
        zz = mz + k * (z1 - z0) / 4
        ch.box(name + "_bh%d" % k, x0, x1, y - 0.14, y - 0.09, zz - 0.02, zz + 0.02, trim)
    ch.box(name + "_sill", x0 - 0.15, x1 + 0.15, y - 0.2, y, z0 - 0.15, z0 - 0.08, trim, 0.01)
    add_area(name + "_light", (mx, y + 0.3, mz), (x1 - x0, z1 - z0),
             m["window_light"][0], m["window_light"][1], (-math.pi / 2, 0, 0))


def lamp(name, x, m, glow_color):
    y = D - 0.5
    ch.cylinder(name + "_base", x, y, 0.7, 0.78, 0.13, 0.13, ch.flat(m["trim"]))
    ch.cylinder(name + "_stem", x, y, 0.78, 1.15, 0.025, 0.025, ch.flat(m["trim"]))
    ch.cone(name + "_shade", x, y, 1.1, 1.5, 0.28, 0.17, glow_mat(name + "_s", glow_color, 2.2))
    add_point(name + "_light", (x, y, 1.25), m["lamp_light"], m["lamp_power"])


def sconce(name, x, m, glow_color):
    y = D - 0.12
    ch.box(name + "_arm", x - 0.03, x + 0.03, y - 0.03, y + 0.01, 1.78, 1.9, ch.flat(m["trim"]))
    ch.cone(name + "_shade", x, y - 0.12, 1.85, 2.15, 0.14, 0.09, glow_mat(name + "_s", glow_color, 3.0))
    add_point(name + "_light", (x, y - 0.12, 2.0), m["lamp_light"], m["lamp_power"] * 0.5, 0.05)


def build(m):
    ch._cache.clear()
    wall = ch.stripes(m["wall"][0], m["wall"][1], freq=3.0)
    floor_spec = m["floor"]
    floor = ch.planks(floor_spec[1], floor_spec[2])
    ceiling = ch.flat(m["ceiling"])
    trim = ch.flat(m["trim"])
    wood = ch.flat(m["wood"])
    ch.box("floor", -W, W, -3, D, -0.1, 0, floor)
    ch.box("ceiling", -W, W, -3, D, H, H + 0.1, ceiling)
    ch.box("wall_back", -W, W, D, D + 0.12, 0, H, wall)
    ch.box("wall_L", -W - 0.12, -W, -3, D + 0.12, 0, H, wall)
    ch.box("wall_R", W, W + 0.12, -3, D + 0.12, 0, H, wall)
    ch.box("bb_back", -W, W, D - 0.05, D, 0, 0.16, trim)
    ch.box("bb_L", -W, -W + 0.05, 0, D, 0, 0.16, trim)
    ch.box("bb_R", W - 0.05, W, 0, D, 0, 0.16, trim)

    window("win_a", -1.3, -0.5, 1.3, 2.4, m)
    window("win_b", 0.5, 1.3, 1.3, 2.4, m)

    cur = ch.flat(m["curtain"])
    for side, (x0, x1) in (("L", (-3.15, -2.3)), ("R", (2.3, 3.15))):
        ch.box("curtain_" + side, x0, x1, D - 0.28, D - 0.06, 0.1, 2.85, cur, 0.05)
        ch.box("tieback_" + side, x0 + 0.05, x1 - 0.05, D - 0.3, D - 0.04, 1.2, 1.3, trim, 0.02)
    ch.box("valance", -3.2, 3.2, D - 0.32, D - 0.04, 2.8, 3.0, cur, 0.04)

    glow_color = tuple(min(1.0, c * 1.0) for c in m["lamp_light"])
    glow_shade = (1.0, 0.8, 0.45) if m["sun"] is None else (1.0, 0.9, 0.6)
    lamp("lamp_L", -2.35, m, glow_shade)
    lamp("lamp_R", 2.35, m, glow_shade)
    sconce("sconce_L", -1.9, m, glow_shade)
    sconce("sconce_R", 1.9, m, glow_shade)
    del glow_color

    # clock on the wall between the windows
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=0.06, vertices=48,
                                        location=(0, D - 0.08, 2.35), rotation=(math.pi / 2, 0, 0))
    face = bpy.context.active_object
    face.name = "clock"
    face.data.materials.append(ch.flat((0.96, 0.9, 0.74, 1)))
    bpy.ops.mesh.primitive_torus_add(location=(0, D - 0.1, 2.35), rotation=(math.pi / 2, 0, 0),
                                     major_radius=0.3, minor_radius=0.025)
    bpy.context.active_object.data.materials.append(wood)
    ch.box("hand_h", -0.01, 0.01, D - 0.125, D - 0.11, 2.35, 2.35 + 0.22, ch.flat((0.1, 0.07, 0.05, 1)))
    ch.box("hand_m", 0.0, 0.17, D - 0.135, D - 0.12, 2.34, 2.36, ch.flat((0.1, 0.07, 0.05, 1)))

    # side tables and bits
    for name, x0, x1 in (("tbl_L", -2.75, -1.95), ("tbl_R", 1.95, 2.75)):
        ch.box(name + "_top", x0 - 0.04, x1 + 0.04, D - 1.05, D - 0.2, 0.65, 0.7, wood, 0.012)
        ch.box(name + "_body", x0, x1, D - 1.0, D - 0.25, 0.1, 0.65, wood, 0.01)
        ch.box(name + "_drawer", x0 + 0.08, x1 - 0.08, D - 1.02, D - 1.0, 0.35, 0.58, ch.flat(tuple(c * 0.8 for c in m["wood"][:3]) + (1,)))
        for k, (lx) in enumerate((x0 + 0.04, x1 - 0.04)):
            ch.box(name + "_leg%d" % k, lx - 0.03, lx + 0.03, D - 0.98, D - 0.92, 0, 0.1, wood)
    ch.cylinder("bottle", -2.75 + 0.1, D - 0.9, 0.7, 1.0, 0.045, 0.045, ch.flat((0.45, 0.55, 0.3, 1)))
    ch.cylinder("vase", 2.55, D - 0.9, 0.7, 0.9, 0.07, 0.07, ch.flat((0.2, 0.4, 0.5, 1)))
    ch.cone("plant", 2.55, D - 0.9, 0.9, 1.25, 0.2, 0.05, ch.flat((0.35, 0.65, 0.25, 1)))

    sofa = ch.flat(m["sofa"])
    ch.box("sofa_seat", -1.5, 1.5, D - 1.4, D - 0.3, 0.1, 0.5, sofa, 0.07)
    ch.box("sofa_back", -1.5, 1.5, D - 0.65, D - 0.28, 0.3, 1.2, sofa, 0.12)
    ch.box("sofa_arm_L", -1.78, -1.42, D - 1.4, D - 0.28, 0.1, 0.78, sofa, 0.12)
    ch.box("sofa_arm_R", 1.42, 1.78, D - 1.4, D - 0.28, 0.1, 0.78, sofa, 0.12)
    ch.box("sofa_feet", -1.7, 1.7, D - 1.3, D - 0.4, 0.0, 0.1, wood)
    cush = ch.flat(m["cushion"])
    ch.box("cushion_L", -1.2, -0.55, D - 0.95, D - 0.62, 0.5, 1.0, cush, 0.1)
    ch.box("cushion_R", 0.55, 1.2, D - 0.95, D - 0.62, 0.5, 1.0, cush, 0.1)

    ch.box("rug_outer", -2.0, 2.0, 1.4, 4.0, 0.0, 0.015, ch.flat(m["rug_outer"]))
    ch.box("rug_inner", -1.82, 1.82, 1.58, 3.82, 0.015, 0.025, ch.flat(m["rug_inner"]))
    top = ch.flat(m["wood"])
    ch.box("coffee_top", -0.85, 0.85, 2.5, 3.35, 0.4, 0.46, top, 0.015)
    for k, (cx, cy) in enumerate(((-0.78, 2.56), (0.78, 2.56), (-0.78, 3.29), (0.78, 3.29))):
        ch.box("coffee_leg%d" % k, cx - 0.035, cx + 0.035, cy - 0.035, cy + 0.035, 0, 0.4, top)
    ch.cylinder("plate", 0.0, 2.9, 0.46, 0.485, 0.14, 0.14, ch.flat((0.96, 0.96, 0.9, 1)))
    for k, gx in enumerate((-0.3, -0.12)):
        ch.cylinder("glass_stem%d" % k, gx, 2.85, 0.46, 0.6, 0.008, 0.008, ch.flat((0.85, 0.9, 0.95, 1)))
        ch.cylinder("glass_bowl%d" % k, gx, 2.85, 0.6, 0.72, 0.04, 0.04, glow_mat("glass%d" % k, (1.0, 0.8, 0.6), 0.6))

    if m["sun"] is not None:
        sun = bpy.data.lights.new("sun", "SUN")
        sun.color = m["sun"][0]
        sun.energy = m["sun"][1]
        sun.angle = 0.03
        obj = bpy.data.objects.new("sun", sun)
        bpy.context.collection.objects.link(obj)
        obj.rotation_euler = (math.radians(100), math.radians(-12), math.radians(-10))


def setup_camera():
    bpy.ops.object.camera_add(location=(0, 0.2, 1.4), rotation=(math.pi / 2 - 0.02, 0, 0))
    cam = bpy.context.active_object
    cam.data.lens = 21
    cam.data.clip_start = 0.05
    bpy.context.scene.camera = cam


def setup_render(m, args):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.max_bounces = 6
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = tuple(m["world"]) + (1,)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    style_lab.set_outline(args.outline, 1.2)
    if args.outline:
        bpy.context.view_layer.freestyle_settings.linesets[0].linestyle.color = (0.0, 0.0, 0.0)


def box_blur(a, radius):
    """Separable box blur on an HxWxC array using cumulative sums."""
    out = a
    for axis in (0, 1):
        pad = [(0, 0)] * 3
        pad[axis] = (radius + 1, radius)
        padded = np.pad(out, pad, mode="edge")
        c = np.cumsum(padded, axis=axis, dtype=np.float64)
        n = 2 * radius + 1
        hi = np.take(c, np.arange(n, c.shape[axis]), axis=axis)
        lo = np.take(c, np.arange(0, c.shape[axis] - n), axis=axis)
        out = ((hi - lo) / n).astype(np.float32)
    return out


def post_process(path, mood_name):
    img = bpy.data.images.load(path)
    img.alpha_mode = "CHANNEL_PACKED"
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    px = px.reshape(h, w, 4)
    rgb = px[:, :, :3]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    thresh = 0.7 if mood_name == "evening" else 0.93
    bright = rgb * np.clip((lum - thresh) / (1 - thresh), 0, 1)[:, :, None]
    r = max(2, w // 90)
    bloom = box_blur(box_blur(box_blur(bright, r), r), r)
    out = rgb + bloom * 1.2
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d2 = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
    out = out * (1 - 0.3 * np.clip(d2 / 2, 0, 1))[:, :, None]
    grey = out @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    out = grey[:, :, None] + (out - grey[:, :, None]) * 1.25
    px[:, :, :3] = np.clip(out, 0, 1)
    new = bpy.data.images.new("post", w, h)
    new.pixels.foreach_set(px.ravel())
    new.filepath_raw = path
    new.file_format = "PNG"
    new.save()


def main():
    args = parse_args()
    m = MOODS[args.mood]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build(m)
    setup_camera()
    setup_render(m, args)
    name = "glow_%s%s.png" % (args.mood, "_lined" if args.outline else "")
    path = os.path.join(args.out, name)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    if not os.environ.get("GLOW_NOPOST"):
        post_process(path, args.mood)
    print("WROTE", path)


if __name__ == "__main__":
    main()
