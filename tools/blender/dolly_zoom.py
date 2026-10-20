"""Dolly zoom (Vertigo effect) test scene for Blender.

The camera moves along Y while the lens changes so the subject keeps the same
size in frame and the background stretches or squashes. The rule is that the
width visible at the subject stays constant:

    focal_length = sensor_width * distance / visible_width_at_subject

Use setup_dolly_zoom() on your own scene (camera looks along +Y at a target),
or run this file to render a test: three stills and a contact sheet.

    blender -b -P tools/blender/dolly_zoom.py -- --out renders/dolly

Options: --start 12 --end 4 (camera distances in metres, first to last frame),
--frames 48, --width 1280 --height 720.
"""

import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    import argparse

    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/dolly")
    p.add_argument("--start", type=float, default=12.0)
    p.add_argument("--end", type=float, default=4.0)
    p.add_argument("--frames", type=int, default=48)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def setup_dolly_zoom(camera_obj, target, start_frame, end_frame, start_distance, end_distance, visible_width):
    """Key camera Y and lens so `visible_width` metres stay in frame at the target.

    The camera sits on the -Y side of the target, looking along +Y.
    """
    cam = camera_obj.data
    cam.lens_unit = "MILLIMETERS"
    for frame in (start_frame, end_frame):
        t = (frame - start_frame) / max(1, end_frame - start_frame)
        distance = start_distance + (end_distance - start_distance) * t
        camera_obj.location.y = target.location.y - distance
        camera_obj.keyframe_insert(data_path="location", index=1, frame=frame)
        cam.lens = cam.sensor_width * distance / visible_width
        cam.keyframe_insert(data_path="lens", frame=frame)
    # Lens is not linear in time while distance is, so key every frame: a
    # straight line between two lens values would drift off the true curve.
    for frame in range(start_frame + 1, end_frame):
        t = (frame - start_frame) / (end_frame - start_frame)
        distance = start_distance + (end_distance - start_distance) * t
        camera_obj.location.y = target.location.y - distance
        camera_obj.keyframe_insert(data_path="location", index=1, frame=frame)
        cam.lens = cam.sensor_width * distance / visible_width
        cam.keyframe_insert(data_path="lens", frame=frame)
    for fc in _fcurves(camera_obj) + _fcurves(cam):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"


def _fcurves(idblock):
    ad = idblock.animation_data
    if not ad or not ad.action:
        return []
    action = ad.action
    try:
        return list(action.fcurves)
    except AttributeError:
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        return out


def flat_material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = tuple(color) + (1,)
    return mat


def build_scene(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {
        "floor": flat_material("floor", (0.55, 0.5, 0.42)),
        "subject": flat_material("subject", (0.9, 0.25, 0.2)),
        "pillar_a": flat_material("pa", (0.25, 0.45, 0.8)),
        "pillar_b": flat_material("pb", (0.9, 0.75, 0.25)),
        "wall": flat_material("wall", (0.75, 0.8, 0.9)),
    }

    def box(name, cx, cy, cz, sx, sy, sz, mat):
        bpy.ops.mesh.primitive_cube_add(location=(cx, cy, cz))
        ob = bpy.context.active_object
        ob.name = name
        ob.scale = (sx / 2, sy / 2, sz / 2)
        ob.data.materials.append(mat)
        return ob

    box("floor", 0, 25, -0.05, 300, 80, 0.1, mats["floor"])
    box("wall", 0, 60, 20, 300, 0.5, 60, mats["wall"])
    subject = box("subject", 0, 0, 1.0, 0.8, 0.8, 2.0, mats["subject"])
    for i, y in enumerate((6, 12, 18, 26, 36, 48)):
        for side in (-1, 1):
            box("pillar_%d_%d" % (i, side), side * (2.2 + 0.35 * i), y, 1.5, 0.8, 0.8, 3.0,
                mats["pillar_a" if i % 2 == 0 else "pillar_b"])

    bpy.ops.object.camera_add(location=(0, -args.start, 1.2), rotation=(math.pi / 2, 0, 0))
    cam_obj = bpy.context.active_object
    bpy.context.scene.camera = cam_obj

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.frame_start, scene.frame_end = 1, args.frames
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.7, 0.85, 1.0, 1)
    scene.world = world
    return cam_obj, subject


def subject_height_px(scene, cam_obj):
    """Pixel height of the 2 m subject (feet at z=0, head at z=2) in the current frame."""
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    feet = world_to_camera_view(scene, cam_obj, Vector((0, 0, 0)))
    head = world_to_camera_view(scene, cam_obj, Vector((0, 0, 2.0)))
    return abs(head.y - feet.y) * scene.render.resolution_y


def main():
    args = parse_args()
    cam_obj, subject = build_scene(args)
    scene = bpy.context.scene
    visible_width = 6.0
    setup_dolly_zoom(cam_obj, subject, 1, args.frames, args.start, args.end, visible_width)

    picks = (1, (1 + args.frames) // 2, args.frames)
    paths = []
    for f in picks:
        scene.frame_set(f)
        print("frame %d: camera y %.2f, lens %.1f mm, subject height %.1f px" % (
            f, cam_obj.location.y, cam_obj.data.lens, subject_height_px(scene, cam_obj)))
        scene.render.filepath = os.path.join(args.out, "dolly_%03d.png" % f)
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)

    import style_lab

    style_lab.tile_sheet([paths], os.path.join(args.out, "dolly_sheet.png"))
    print("WROTE", os.path.join(args.out, "dolly_sheet.png"))


if __name__ == "__main__":
    main()
