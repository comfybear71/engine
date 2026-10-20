"""Blockout of three rooms (bedroom, hall, living room) with a camera that
flies through the doorways. Renders a PNG sequence with flat colours and
object outlines so it reads as a rough cartoon preview.

Run:
    blender -b -P tools/blender/house_flythrough.py -- --out renders/house --frames 72

Writes <out>/frame_0001.png and so on. Tested with Blender 5.2.2 LTS.
Needs no GPU (Workbench engine). This is a blockout, not final art.
"""

import argparse
import math
import os
import sys

import bpy

DOOR_W = 1.0
DOOR_H = 2.2
WALL_H = 3.0
WALL_T = 0.12


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="house_frames")
    p.add_argument("--frames", type=int, default=72)
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    args = p.parse_args(argv)
    # Blender resolves relative paths oddly without a .blend file (on Windows
    # it used the drive root), so always work from the current folder.
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def material(name, color):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = color
    return mat


def box(name, x0, x1, y0, y1, z0, z1, color):
    """Axis-aligned box from min/max corners."""
    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (x1 - x0, y1 - y0, z1 - z0)
    obj.data.materials.append(material(name.split(".")[0] + "_m", color))
    return obj


def wall_with_door(name, y, x_min, x_max, door_x, color):
    """A wall across the X axis at depth y with a doorway centred at door_x."""
    h = DOOR_W / 2
    box(name + "_L", x_min, door_x - h, y - WALL_T / 2, y + WALL_T / 2, 0, WALL_H, color)
    box(name + "_R", door_x + h, x_max, y - WALL_T / 2, y + WALL_T / 2, 0, WALL_H, color)
    box(name + "_top", door_x - h, door_x + h, y - WALL_T / 2, y + WALL_T / 2, DOOR_H, WALL_H, color)


def side_wall(name, x, y0, y1, color):
    box(name, x - WALL_T / 2, x + WALL_T / 2, y0, y1, 0, WALL_H, color)


def build_house():
    cream = (0.93, 0.88, 0.76, 1)
    blue = (0.62, 0.78, 0.9, 1)
    green = (0.7, 0.85, 0.65, 1)

    box("floor_bed", -3, 3, 0, 4, -0.1, 0, (0.78, 0.6, 0.4, 1))
    box("floor_hall", -1, 1, 4, 8, -0.1, 0, (0.55, 0.45, 0.4, 1))
    box("floor_living", -3, 3, 8, 13, -0.1, 0, (0.62, 0.5, 0.35, 1))

    side_wall("bed_wall_W", -3, 0, 4, blue)
    side_wall("bed_wall_E", 3, 0, 4, blue)
    box("bed_wall_S", -3, 3, -WALL_T, 0, 0, WALL_H, blue)
    wall_with_door("bed_to_hall", 4, -3, 3, 0, cream)

    side_wall("hall_wall_W", -1, 4, 8, cream)
    side_wall("hall_wall_E", 1, 4, 8, cream)
    wall_with_door("hall_to_living", 8, -3, 3, 0, cream)

    side_wall("living_wall_W", -3, 8, 13, green)
    side_wall("living_wall_E", 3, 8, 13, green)
    box("living_wall_N", -3, 3, 13, 13 + WALL_T, 0, WALL_H, green)

    box("bed", -2.9, -1.1, 1.2, 3.4, 0, 0.55, (0.85, 0.3, 0.3, 1))
    box("bedside", -0.9, -0.4, 3.2, 3.7, 0, 0.5, (0.45, 0.3, 0.2, 1))
    box("hall_table", 0.55, 0.95, 5.4, 6.4, 0, 0.8, (0.45, 0.3, 0.2, 1))
    box("sofa", -2.9, -1.0, 10.0, 12.2, 0, 0.8, (0.35, 0.45, 0.75, 1))
    box("coffee_table", -0.6, 0.6, 10.4, 11.6, 0, 0.4, (0.45, 0.3, 0.2, 1))
    box("tv_unit", 2.7, 2.95, 10.0, 12.0, 0, 1.1, (0.2, 0.2, 0.25, 1))


# (frame fraction, x, y, z, pitch_deg, yaw_deg) -- yaw 0 looks toward +Y.
CAMERA_PATH = [
    (0.00, -1.2, 0.5, 1.5, 84, -20),
    (0.25, 0.0, 3.0, 1.5, 86, 0),
    (0.45, 0.0, 5.5, 1.4, 88, 0),
    (0.65, 0.0, 8.5, 1.5, 84, 15),
    (0.85, 1.0, 10.5, 1.6, 80, 55),
    (1.00, 0.5, 12.0, 1.6, 78, 150),
]


def add_camera(frames):
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.data.lens = 18
    cam.data.clip_start = 0.05
    scene = bpy.context.scene
    scene.camera = cam
    scene.frame_start = 1
    scene.frame_end = frames
    for frac, x, y, z, pitch, yaw in CAMERA_PATH:
        frame = 1 + round(frac * (frames - 1))
        cam.location = (x, y, z)
        cam.rotation_euler = (math.radians(pitch), 0, math.radians(yaw))
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_euler", frame=frame)
    return cam


def setup_render(out, width, height):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "MATERIAL"
    shading.show_object_outline = True
    shading.object_outline_color = (0.1, 0.07, 0.05)
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.fps = 24
    scene.render.filepath = os.path.join(out, "frame_")
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("sky")
    world.color = (0.75, 0.88, 0.97)
    scene.world = world


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_house()
    add_camera(args.frames)
    setup_render(args.out, args.width, args.height)
    bpy.ops.render.render(animation=True)
    print("WROTE", args.out)


if __name__ == "__main__":
    main()
