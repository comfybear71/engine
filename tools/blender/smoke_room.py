"""Smoke test: build a simple box room and a camera, render one still.

Run (from any folder):
    blender -b -P tools/blender/smoke_room.py -- --out renders/smoke_room.png

Tested with Blender 5.2.2 LTS. Needs no GPU (uses the Workbench engine).
"""

import argparse
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="smoke_room.png")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def add_box(name, size, location, color):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    mat = bpy.data.materials.new(name + "_mat")
    mat.diffuse_color = color
    obj.data.materials.append(mat)
    return obj


def build_room():
    add_box("floor", (6, 6, 0.1), (0, 0, -0.05), (0.55, 0.38, 0.22, 1))
    add_box("wall_back", (6, 0.1, 3), (0, 3, 1.5), (0.85, 0.80, 0.70, 1))
    add_box("wall_left", (0.1, 6, 3), (-3, 0, 1.5), (0.75, 0.82, 0.88, 1))
    add_box("bed", (2.0, 1.4, 0.5), (-1.7, 1.8, 0.25), (0.8, 0.25, 0.25, 1))
    add_box("table", (1.0, 1.0, 0.7), (1.5, 1.5, 0.35), (0.35, 0.25, 0.15, 1))


def add_camera():
    bpy.ops.object.camera_add(location=(2.6, -4.2, 1.8), rotation=(1.35, 0, 0.5))
    cam = bpy.context.active_object
    cam.data.lens = 28
    bpy.context.scene.camera = cam


def render(path, width, height):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def main():
    args = parse_args()
    reset_scene()
    build_room()
    add_camera()
    render(args.out, args.width, args.height)
    print("WROTE", args.out)


main()
