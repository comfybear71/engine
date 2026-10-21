"""Dazza (Sunny Banks handyman) built from simple shapes, from his model sheet.

Run:
    blender -b -P tools/blender/dazza.py -- --out renders/dazza

Writes, for two looks (cel = flat banded colour with thick outline, soft =
smoother shading with a thin outline): front, three-quarter, side, back and a
head close-up, then dazza_sheet.png (row 1 cel, row 2 soft) and dazza.blend.

Look is from docs/reference/images/sunnybanks/sheet-dazza.jpg and the bible
(skinny, wild spiky blonde hair, bulging eyes, gap-toothed grin, tattooed
forearm, faded-blue singlet, torn brown shorts, bare feet). No props held.
He is built facing -Y, feet on z=0, about 2.2 units tall. Tested with Blender
5.2.2 LTS, CPU only.
"""

import argparse
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import style_lab as sl  # noqa: E402

COLORS = {
    "skin": (0.84, 0.64, 0.42),
    "hair": (0.90, 0.77, 0.36),
    "singlet": (0.48, 0.60, 0.72),
    "shorts": (0.36, 0.25, 0.15),
    "eye": (0.96, 0.88, 0.86),
    "iris": (0.42, 0.48, 0.52),
    "pupil": (0.02, 0.02, 0.02),
    "mouth": (0.10, 0.02, 0.02),
    "teeth": (0.88, 0.82, 0.58),
    "ink": (0.12, 0.17, 0.38),
}

_materials = {}
parts = []


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/dazza")
    p.add_argument("--width", type=int, default=420)
    p.add_argument("--height", type=int, default=600)
    p.add_argument("--samples", type=int, default=32)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def mat(name):
    if name not in _materials:
        m = bpy.data.materials.new(name)
        m.diffuse_color = (*COLORS[name], 1.0)
        _materials[name] = m
    return _materials[name]


def finish(obj, material, smooth=True):
    obj.data.materials.append(mat(material))
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    parts.append(obj)
    return obj


def ellipsoid(loc, scale, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1, location=loc)
    obj = bpy.context.active_object
    obj.scale = scale
    obj.rotation_euler = rot
    return finish(obj, material)


def limb(p0, p1, r0, r1, material):
    p0, p1 = Vector(p0), Vector(p1)
    direction = p1 - p0
    bpy.ops.mesh.primitive_cone_add(
        vertices=20, radius1=r0, radius2=r1, depth=direction.length,
        end_fill_type="NOTHING", location=(p0 + p1) / 2)
    obj = bpy.context.active_object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction)
    finish(obj, material)
    ellipsoid(p0, (r0,) * 3, material)
    ellipsoid(p1, (r1,) * 3, material)


def ragged_tube(loc, radius_xy, height, material, seed, jag=0.045, verts=28):
    """Open tube whose bottom edge is torn into points."""
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts, radius=1, depth=height, end_fill_type="NOTHING", location=loc)
    obj = bpy.context.active_object
    obj.scale = (radius_xy[0], radius_xy[1], 1)
    rng = random.Random(seed)
    for v in obj.data.vertices:
        if v.co.z < 0:
            v.co.z -= rng.choice([0, 0, 0.35, 0.7, 1.0]) * jag / obj.scale.z
    bpy.ops.object.shade_smooth()
    return finish(obj, material)


def build_body():
    sk = "skin"
    ellipsoid((0, 0, 1.22), (0.155, 0.105, 0.30), sk)
    limb((0, 0, 1.46), (0, 0, 1.62), 0.05, 0.045, sk)
    ellipsoid((0, 0.0, 0.98), (0.15, 0.10, 0.10), sk)

    singlet = ragged_tube((0, 0, 1.17), (0.172, 0.122), 0.60, "singlet", 3, jag=0.05)
    for v in singlet.data.vertices:
        t = (v.co.z + 0.30) / 0.60
        v.co.x *= 0.80 + 0.20 * min(1.0, t * 1.4)
        v.co.y *= 0.88 + 0.12 * t
        if v.co.z > 0.2:
            x = abs(v.co.x * 0.172) / 0.1
            v.co.z -= 0.16 * max(0.0, 1.0 - x * x) * (1.0 if v.co.y < 0 else 0.45)
            v.co.z += 0.03

    for sx in (-1, 1):
        ragged_tube((sx * 0.105, 0, 0.82), (0.105, 0.105), 0.34, "shorts", 11 + sx, jag=0.07)
        limb((sx * 0.105, 0, 0.66), (sx * 0.10, -0.01, 0.50), 0.046, 0.040, sk)
        limb((sx * 0.10, -0.01, 0.50), (sx * 0.095, 0.0, 0.10), 0.040, 0.036, sk)
        ellipsoid((sx * 0.095, -0.075, 0.045), (0.065, 0.14, 0.045), sk)
        for i in range(5):
            tx = sx * 0.095 + (i - 2) * 0.026
            ellipsoid((tx, -0.205 - (0.012 if i in (1, 2) else 0), 0.032),
                      (0.014, 0.018, 0.016), sk)
    ellipsoid((0, 0, 0.90), (0.21, 0.125, 0.12), "shorts")

    for sx in (-1, 1):
        shoulder = (sx * 0.185, 0, 1.44)
        elbow = (sx * 0.265, -0.025, 1.12)
        wrist = (sx * 0.30, -0.075, 0.80)
        limb(shoulder, elbow, 0.040, 0.034, sk)
        limb(elbow, wrist, 0.034, 0.028, sk)
        ellipsoid((wrist[0], wrist[1] - 0.005, wrist[2] - 0.065), (0.036, 0.022, 0.07), sk)
        for i in range(4):
            fx = wrist[0] + (i - 1.5) * 0.017
            limb((fx, wrist[1] - 0.005, wrist[2] - 0.11),
                 (fx + sx * 0.004, wrist[1] - 0.01, wrist[2] - 0.20 + (0.02 if i in (0, 3) else 0)),
                 0.011, 0.008, sk)
        limb((wrist[0] - sx * 0.035, wrist[1] - 0.02, wrist[2] - 0.07),
             (wrist[0] - sx * 0.05, wrist[1] - 0.04, wrist[2] - 0.15), 0.013, 0.009, sk)

    bpy.ops.object.text_add(location=(-0.285, -0.083, 0.96))
    text = bpy.context.active_object
    text.data.body = "AUSTRALIA"
    text.data.size = 0.032
    text.data.extrude = 0.002
    text.data.align_x = "CENTER"
    text.data.align_y = "CENTER"
    axes = (Vector((0, 0, -1)), Vector((1, 0, 0)), Vector((0, -1, 0)))
    text.rotation_euler = Matrix(axes).transposed().to_euler()
    finish(text, "ink", smooth=False)


def build_head():
    c = Vector((0, 0, 1.92))
    ellipsoid(c, (0.25, 0.23, 0.30), "skin")
    ellipsoid(c + Vector((0, -0.07, -0.20)), (0.15, 0.14, 0.14), "skin")
    for sx in (-1, 1):
        ellipsoid(c + Vector((sx * 0.245, 0.0, -0.02)), (0.03, 0.05, 0.075), "skin")
        eye = c + Vector((sx * 0.095, -0.155, 0.075))
        ellipsoid(eye, (0.082, 0.082, 0.088), "eye")
        ellipsoid(eye + Vector((sx * -0.004, -0.060, 0.0)), (0.044, 0.026, 0.048), "iris")
        ellipsoid(eye + Vector((sx * -0.004, -0.082, 0.0)), (0.022, 0.014, 0.026), "pupil")
        brow = c + Vector((sx * 0.095, -0.17, 0.17))
        ellipsoid(brow, (0.095, 0.04, 0.02), "skin", rot=(0, sx * 0.25, 0))

    ellipsoid(c + Vector((0, -0.225, -0.05)), (0.05, 0.075, 0.095), "skin", rot=(0.25, 0, 0))
    ellipsoid(c + Vector((0, -0.285, -0.11)), (0.052, 0.05, 0.05), "skin")
    for sx in (-1, 1):
        ellipsoid(c + Vector((sx * 0.032, -0.31, -0.115)), (0.014, 0.012, 0.016), "mouth")

    def arc(x):
        return -0.215 + 1.15 * x * x

    for i in range(-5, 6):
        x = i * 0.019
        ellipsoid((x, -0.195, 1.92 + arc(x) - 0.005), (0.024, 0.032, 0.036), "mouth")
    for i in range(-4, 5):
        x = i * 0.021
        z = 1.92 + arc(x) + 0.04
        ellipsoid((x, -0.222, z), (0.0095, 0.010, 0.016), "teeth")
    for i in range(-3, 4):
        if i in (-1, 2):
            continue
        x = i * 0.024
        z = 1.92 + arc(x) - 0.04
        ellipsoid((x, -0.215, z), (0.0095, 0.010, 0.016), "teeth")

    hair_base = Vector((0, 0.03, 2.0))
    ellipsoid(hair_base, (0.262, 0.245, 0.25), "hair")
    rng = random.Random(7)
    count = 0
    while count < 80:
        d = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.15, 1))).normalized()
        if d.z < 0.05 or (d.y < -0.55 and d.z < 0.55):
            continue
        base = hair_base + Vector((d.x * 0.262, d.y * 0.245, d.z * 0.25))
        tilt = (d + Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 0.55))).normalized()
        length = rng.uniform(0.13, 0.26)
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.045, radius2=0.0, depth=length,
                                        end_fill_type="NOTHING", location=base + tilt * length * 0.42)
        spike = bpy.context.active_object
        spike.rotation_mode = "QUATERNION"
        spike.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(tilt)
        finish(spike, "hair")
        count += 1


def setup_scene(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.80, 0.76, 0.66, 1.0)
    bg.inputs["Strength"].default_value = 0.55

    build_body()
    build_head()

    root = bpy.data.objects.new("dazza", None)
    bpy.context.collection.objects.link(root)
    for p in parts:
        p.parent = root

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.6
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = (0, -8, 1.1)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    scene.camera = cam

    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 2.2
    sun.angle = 0.1
    sun_obj = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(55), 0, math.radians(-30))
    fill = bpy.data.lights.new("fill", "SUN")
    fill.energy = 0.3
    fill_obj = bpy.data.objects.new("fill", fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(70), 0, math.radians(120))
    return root, cam


def apply_look(look):
    for m in bpy.data.materials:
        color = tuple(m.diffuse_color)
        m.use_nodes = True
        tree = m.node_tree
        tree.nodes.clear()
        out = tree.nodes.new("ShaderNodeOutputMaterial")
        if look == "cel":
            bsdf = tree.nodes.new("ShaderNodeBsdfToon")
            bsdf.inputs["Color"].default_value = color
            bsdf.inputs["Size"].default_value = 1.0
            bsdf.inputs["Smooth"].default_value = 0.03
        else:
            bsdf = tree.nodes.new("ShaderNodeBsdfDiffuse")
            bsdf.inputs["Color"].default_value = color
        tree.links.new(bsdf.outputs[0], out.inputs["Surface"])
    sl.set_outline(True, 2.2 if look == "cel" else 1.0)


def main():
    args = parse_args()
    root, cam = setup_scene(args)
    views = [("front", 0), ("three_quarter", 40), ("side", 90), ("back", 180)]
    rows = []
    for look in ("cel", "soft"):
        apply_look(look)
        row = []
        cam.data.ortho_scale = 2.6
        cam.location = (0, -8, 1.1)
        for name, deg in views:
            root.rotation_euler.z = math.radians(deg)
            path = os.path.join(args.out, f"dazza_{look}_{name}.png")
            sl.render_still(path)
            row.append(path)
        root.rotation_euler.z = math.radians(25)
        cam.data.ortho_scale = 1.1
        cam.location = (0, -8, 1.95)
        path = os.path.join(args.out, f"dazza_{look}_head.png")
        sl.render_still(path)
        row.append(path)
        rows.append(row)
        print("rendered", look)
    sl.tile_sheet(rows, os.path.join(args.out, "dazza_sheet.png"))
    root.rotation_euler.z = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, "dazza.blend"))
    print("done", args.out)


main()
