"""Flat character pictures standing at different depths in front of a
location picture, with a moving camera ("2.5D" cut-outs in Blender).

No 3D characters: each one is their own picture (background removed) on a
flat card. The depth comes from where the cards stand and how the camera moves.

Run:
    blender -b -P tools/blender/cutout_scene.py -- --out renders/cutout

Writes frames, cutout_sheet.png (four frames side by side) and, if ffmpeg
is installed, cutout.mp4.
Options: --plate (a 16:9 location picture), --frames, --width, --height,
--samples, --still N (render only frame N). Tested with Blender 5.2.2 LTS.
"""

import argparse
import math
import os
import shutil
import subprocess
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import style_lab as sl  # noqa: E402

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "sunnybanks")

# name, picture, height in metres, x, y (y is distance away from the camera line)
CAST = [
    ("dazza", "cut-dazza.png", 1.85, -1.25, -1.0),
    ("nan", "cut-nan.png", 1.50, 1.25, 1.6),
    ("shazza", "cut-shazza.png", 1.85, -0.35, 3.6),
]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/cutout")
    p.add_argument("--plate", default=os.path.join(ASSETS, "park-site-4.jpg"))
    p.add_argument("--frames", type=int, default=96)
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--still", type=int, default=0)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def picture_material(name, path, alpha):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    tex = nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(path)
    img.alpha_mode = "STRAIGHT"
    tex.image = img
    emit = nodes.new("ShaderNodeEmission")
    links.new(tex.outputs["Color"], emit.inputs["Color"])
    if alpha:
        clear = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
        links.new(clear.outputs[0], mix.inputs[1])
        links.new(emit.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs["Surface"])
    else:
        links.new(emit.outputs[0], out.inputs["Surface"])
    return m, img


def card(name, material, width, height, x, y, z_bottom):
    """A flat card whose origin is the middle of its bottom edge, facing -Y."""
    verts = [(-width / 2, 0, 0), (width / 2, 0, 0), (width / 2, 0, height), (-width / 2, 0, height)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new()
    for loop, co in zip(mesh.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[loop.index].uv = co
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.location = (x, y, z_bottom)
    return obj


def shadow_material():
    size = 128
    yy, xx = np.mgrid[0:size, 0:size]
    r = np.sqrt(((xx - size / 2) / (size / 2)) ** 2 + ((yy - size / 2) / (size / 2)) ** 2)
    a = np.clip(1 - r, 0, 1) ** 1.5 * 0.45
    px = np.zeros((size, size, 4), dtype=np.float32)
    px[..., 3] = a
    img = bpy.data.images.new("shadow", size, size, alpha=True)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    m = bpy.data.materials.new("shadow")
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    clear = nodes.new("ShaderNodeBsdfTransparent")
    black = nodes.new("ShaderNodeEmission")
    black.inputs["Color"].default_value = (0.03, 0.02, 0.01, 1)
    mix = nodes.new("ShaderNodeMixShader")
    links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    links.new(clear.outputs[0], mix.inputs[1])
    links.new(black.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs["Surface"])
    return m


def key(obj, frame, **values):
    for attr, value in values.items():
        setattr(obj, attr, value)
        obj.keyframe_insert(attr, frame=frame)


def smooth(obj):
    if obj.animation_data and obj.animation_data.action:
        for fc in sl_fcurves(obj.animation_data.action):
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"


def sl_fcurves(action):
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                out.extend(bag.fcurves)
    return out


def build(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.max_bounces = 4
    scene.cycles.transparent_max_bounces = 16
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("w")
    scene.frame_start, scene.frame_end = 1, args.frames
    scene.render.fps = 24

    plate_mat, plate_img = picture_material("plate", args.plate, alpha=False)
    aspect = plate_img.size[0] / plate_img.size[1]
    plate_h = 18.0
    card("plate", plate_mat, plate_h * aspect, plate_h, 0, 18, -7.5)

    shadow = shadow_material()
    chars = []
    for name, file, h, x, y in CAST:
        m, img = picture_material(name, os.path.join(ASSETS, file), alpha=True)
        w = h * img.size[0] / img.size[1]
        c = card(name, m, w, h, x, y, 0.0)
        s = card(name + "_shadow", shadow, w * 0.9, 0.35 * h, x, y, 0.0)
        s.rotation_euler.x = math.radians(-90)
        s.location.y = y - 0.17 * h
        s.location.z = 0.01
        chars.append((c, h))

    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 38
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_euler = (math.radians(90), 0, 0)
    key(cam, 1, location=(1.0, -8.5, 1.15))
    key(cam, args.frames, location=(-0.35, -5.4, 1.0))
    smooth(cam)

    for k, (c, h) in enumerate(chars):
        for f in range(1, args.frames + 1, 6):
            t = f / 24.0
            breathe = 1.0 + 0.012 * math.sin(t * 2.4 + k * 1.7)
            key(c, f, scale=(1.0, 1.0, breathe))
    return scene


def main():
    args = parse_args()
    scene = build(args)
    frames = [args.still] if args.still else list(range(1, args.frames + 1))
    paths = []
    for f in frames:
        scene.frame_set(f)
        path = os.path.join(args.out, f"frame_{f:03d}.png")
        sl.render_still(path)
        paths.append(path)
    if len(paths) > 3:
        picks = [paths[int(i * (len(paths) - 1) / 3)] for i in range(4)]
        sl.tile_sheet([picks], os.path.join(args.out, "cutout_sheet.png"))
        if shutil.which("ffmpeg"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i",
                 os.path.join(args.out, "frame_%03d.png"), "-pix_fmt", "yuv420p",
                 os.path.join(args.out, "cutout.mp4")], check=False)
        else:
            print("ffmpeg not found; frames are saved as frame_001.png and so on")
    print("done", args.out)


main()
