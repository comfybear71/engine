"""A more cartoon version of the three-room house: bold flat colours,
painted surface detail (planks, stripes, rug rings), trim, rounded
furniture, curtains, pictures, and thick ink outlines.

Two palettes are rendered so they can be compared:
    bold  - saturated, contrasting colours, flat floor
    wood  - warmer, muted colours, wooden plank floor and striped wallpaper

Run:
    blender -b -P tools/blender/cartoon_house.py -- --out renders/cartoon

Writes <palette>_f<frame>.png for each palette and camera position, plus
cartoon_sheet.png (one row per palette). Tested with Blender 5.2.2 LTS,
CPU only. Colours are flat (emission) so they match the palette exactly.
"""

import argparse
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import house_flythrough as house  # noqa: E402
import style_lab  # noqa: E402

FRAMES = 72
SAMPLE_FRAMES = [1, 40, 62]

PALETTES = {
    "bold": {
        "wall_bed": (0.98, 0.84, 0.32, 1),
        "wall_hall": (0.76, 0.66, 0.92, 1),
        "wall_living": (0.97, 0.6, 0.72, 1),
        "wall_living_stripe": None,
        "trim": (0.98, 0.95, 0.85, 1),
        "floor": ("flat", (0.05, 0.56, 0.52, 1)),
        "bed_wood": (0.55, 0.3, 0.15, 1),
        "blanket": (0.25, 0.45, 0.9, 1),
        "pillow": (1.0, 0.97, 0.9, 1),
        "sofa": (0.96, 0.5, 0.1, 1),
        "cushion": (1.0, 0.65, 0.25, 1),
        "rug": ((0.55, 0.25, 0.65, 1), (0.97, 0.45, 0.65, 1), (0.2, 0.35, 0.8, 1)),
        "lamp": (0.55, 0.25, 0.65, 1),
        "curtain": (0.1, 0.75, 0.75, 1),
        "frame": (0.97, 0.72, 0.15, 1),
        "picture": (0.2, 0.5, 0.92, 1),
        "table": (0.6, 0.35, 0.2, 1),
        "tv": (0.15, 0.15, 0.2, 1),
        "sky": (0.55, 0.8, 1.0, 1),
    },
    "wood": {
        "wall_bed": (0.72, 0.8, 0.56, 1),
        "wall_hall": (0.94, 0.89, 0.72, 1),
        "wall_living": (0.95, 0.77, 0.67, 1),
        "wall_living_stripe": (0.91, 0.69, 0.58, 1),
        "trim": (0.96, 0.92, 0.82, 1),
        "floor": ("planks", (0.76, 0.56, 0.33, 1), (0.33, 0.2, 0.11, 1)),
        "bed_wood": (0.45, 0.27, 0.14, 1),
        "blanket": (0.7, 0.28, 0.25, 1),
        "pillow": (0.97, 0.93, 0.82, 1),
        "sofa": (0.3, 0.55, 0.55, 1),
        "cushion": (0.85, 0.7, 0.3, 1),
        "rug": ((0.7, 0.2, 0.2, 1), (0.96, 0.9, 0.78, 1), (0.35, 0.35, 0.55, 1)),
        "lamp": (0.85, 0.7, 0.3, 1),
        "curtain": (0.65, 0.25, 0.25, 1),
        "frame": (0.45, 0.27, 0.14, 1),
        "picture": (0.4, 0.62, 0.7, 1),
        "table": (0.5, 0.3, 0.16, 1),
        "tv": (0.15, 0.15, 0.2, 1),
        "sky": (0.7, 0.85, 0.95, 1),
    },
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="cartoon")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--palettes", default=",".join(PALETTES))
    p.add_argument("--thickness", type=float, default=2.5)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


# ---- materials -----------------------------------------------------------

def _tree(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    return mat, tree


def _finish(tree, color_socket):
    emit = tree.nodes.new("ShaderNodeEmission")
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(color_socket, emit.inputs["Color"])
    tree.links.new(emit.outputs[0], out.inputs["Surface"])


def _math(tree, op, a, b=None):
    node = tree.nodes.new("ShaderNodeMath")
    node.operation = op
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            node.inputs[i].default_value = v
        else:
            tree.links.new(v, node.inputs[i])
    return node.outputs[0]


def _mix(tree, fac, a, b):
    node = tree.nodes.new("ShaderNodeMix")
    node.data_type = "RGBA"
    if isinstance(fac, (int, float)):
        node.inputs[0].default_value = fac
    else:
        tree.links.new(fac, node.inputs[0])
    for idx, v in ((6, a), (7, b)):
        if isinstance(v, tuple):
            node.inputs[idx].default_value = v
        else:
            tree.links.new(v, node.inputs[idx])
    return node.outputs[2]


def _world_xyz(tree):
    geo = tree.nodes.new("ShaderNodeNewGeometry")
    sep = tree.nodes.new("ShaderNodeSeparateXYZ")
    tree.links.new(geo.outputs["Position"], sep.inputs[0])
    return sep.outputs["X"], sep.outputs["Y"], sep.outputs["Z"]


_cache = {}


def flat(color):
    key = ("flat", tuple(color))
    if key not in _cache:
        mat, tree = _tree("flat_%d" % len(_cache))
        node = tree.nodes.new("ShaderNodeRGB")
        node.outputs[0].default_value = color
        _finish(tree, node.outputs[0])
        _cache[key] = mat
    return _cache[key]


def planks(base, dark):
    key = ("planks", tuple(base), tuple(dark))
    if key not in _cache:
        mat, tree = _tree("planks_%d" % len(_cache))
        x, y, _z = _world_xyz(tree)
        u = _math(tree, "MULTIPLY", x, 1 / 0.35)
        seam = _math(tree, "LESS_THAN", _math(tree, "FRACT", u), 0.06)
        row = _math(tree, "FLOOR", u)
        v = _math(tree, "ADD", _math(tree, "MULTIPLY", y, 0.45), _math(tree, "MULTIPLY", row, 0.37))
        joint = _math(tree, "LESS_THAN", _math(tree, "FRACT", v), 0.018)
        line = _math(tree, "MAXIMUM", seam, joint)
        tone = _math(tree, "MULTIPLY", _math(tree, "FRACT", _math(tree, "MULTIPLY", row, 0.618)), 0.9)
        shade = tuple(c * 0.86 for c in base[:3]) + (1,)
        plank_col = _mix(tree, tone, base, shade)
        _finish(tree, _mix(tree, line, plank_col, dark))
        _cache[key] = mat
    return _cache[key]


def stripes(c1, c2, freq=2.2):
    key = ("stripes", tuple(c1), tuple(c2))
    if key not in _cache:
        mat, tree = _tree("stripes_%d" % len(_cache))
        x, y, _z = _world_xyz(tree)
        s = _math(tree, "FRACT", _math(tree, "MULTIPLY", _math(tree, "ADD", x, y), freq))
        band = _math(tree, "GREATER_THAN", s, 0.5)
        _finish(tree, _mix(tree, band, c1, c2))
        _cache[key] = mat
    return _cache[key]


def rings(c0, c1, c2):
    key = ("rings", tuple(c0), tuple(c1), tuple(c2))
    if key not in _cache:
        mat, tree = _tree("rings_%d" % len(_cache))
        coord = tree.nodes.new("ShaderNodeTexCoord")
        sep = tree.nodes.new("ShaderNodeSeparateXYZ")
        tree.links.new(coord.outputs["Object"], sep.inputs[0])
        x, y = sep.outputs["X"], sep.outputs["Y"]
        r = _math(tree, "SQRT", _math(tree, "ADD", _math(tree, "MULTIPLY", x, x), _math(tree, "MULTIPLY", y, y)))
        ring = _math(tree, "FLOOR", _math(tree, "MULTIPLY", r, 3.2))
        inner = _mix(tree, _math(tree, "GREATER_THAN", ring, 0.5), c0, c1)
        _finish(tree, _mix(tree, _math(tree, "GREATER_THAN", ring, 1.5), inner, c2))
        _cache[key] = mat
    return _cache[key]


# ---- geometry ------------------------------------------------------------

def box(name, x0, x1, y0, y1, z0, z1, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(
        size=1, location=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (x1 - x0, y1 - y0, z1 - z0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("round", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    return obj


def cylinder(name, x, y, z0, z1, rx, ry, mat):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=1, depth=1, vertices=48, location=(x, y, (z0 + z1) / 2))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (rx, ry, z1 - z0)
    obj.data.materials.append(mat)
    return obj


def cone(name, x, y, z0, z1, r_bottom, r_top, mat):
    bpy.ops.mesh.primitive_cone_add(
        radius1=r_bottom, radius2=r_top, depth=z1 - z0, vertices=32,
        location=(x, y, (z0 + z1) / 2))
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def wall_with_door(name, y, x_min, x_max, mat):
    h = house.DOOR_W / 2
    t = house.WALL_T / 2
    box(name + "_L", x_min, -h, y - t, y + t, 0, house.WALL_H, mat)
    box(name + "_R", h, x_max, y - t, y + t, 0, house.WALL_H, mat)
    box(name + "_top", -h, h, y - t, y + t, house.DOOR_H, house.WALL_H, mat)


def door_frame(name, y, mat):
    h = house.DOOR_W / 2
    w = 0.08
    d = house.WALL_T / 2 + 0.03
    box(name + "_jl", -h - w, -h, y - d, y + d, 0, house.DOOR_H + w, mat)
    box(name + "_jr", h, h + w, y - d, y + d, 0, house.DOOR_H + w, mat)
    box(name + "_jt", -h - w, h + w, y - d, y + d, house.DOOR_H, house.DOOR_H + w, mat)


def picture(name, x0, x1, y0, y1, z0, z1, frame_mat, pic_mat):
    """Framed picture on a wall. Thin axis is the one with the smaller span."""
    box(name + "_frame", x0, x1, y0, y1, z0, z1, frame_mat)
    m = 0.07
    if (x1 - x0) < (y1 - y0):
        box(name + "_pic", x0 - 0.01, x1 + 0.01, y0 + m, y1 - m, z0 + m, z1 - m, pic_mat)
    else:
        box(name + "_pic", x0 + m, x1 - m, y0 - 0.01, y1 + 0.01, z0 + m, z1 - m, pic_mat)


def window_east(name, y0, y1, z0, z1, x_wall, pal):
    trim = flat(pal["trim"])
    box(name + "_trim", x_wall - 0.1, x_wall - 0.02, y0 - 0.1, y1 + 0.1, z0 - 0.1, z1 + 0.1, trim)
    box(name + "_sky", x_wall - 0.12, x_wall - 0.09, y0, y1, z0, z1, flat(pal["sky"]))
    mid = (y0 + y1) / 2
    box(name + "_bar_v", x_wall - 0.13, x_wall - 0.09, mid - 0.03, mid + 0.03, z0, z1, trim)
    box(name + "_bar_h", x_wall - 0.13, x_wall - 0.09, y0, y1, (z0 + z1) / 2 - 0.03, (z0 + z1) / 2 + 0.03, trim)
    cur = flat(pal["curtain"])
    box(name + "_cur_a", x_wall - 0.2, x_wall - 0.12, y0 - 0.35, y0 - 0.02, z0 - 0.2, z1 + 0.25, cur, 0.03)
    box(name + "_cur_b", x_wall - 0.2, x_wall - 0.12, y1 + 0.02, y1 + 0.35, z0 - 0.2, z1 + 0.25, cur, 0.03)


def build(pal):
    _cache.clear()
    trim = flat(pal["trim"])
    wood = flat(pal["table"])
    floor_spec = pal["floor"]
    floor_bed = floor_spec[0]
    if floor_bed == "planks":
        floor = planks(floor_spec[1], floor_spec[2])
        hall_floor = floor
    else:
        floor = flat(floor_spec[1])
        hall_floor = flat(tuple(c * 0.85 for c in floor_spec[1][:3]) + (1,))
    wall_bed = flat(pal["wall_bed"])
    wall_hall = flat(pal["wall_hall"])
    if pal["wall_living_stripe"]:
        wall_living = stripes(pal["wall_living"], pal["wall_living_stripe"])
    else:
        wall_living = flat(pal["wall_living"])
    T = house.WALL_T
    H = house.WALL_H

    box("floor_bed", -3, 3, 0, 4, -0.1, 0, floor)
    box("floor_hall", -1, 1, 4, 8, -0.1, 0, hall_floor)
    box("floor_living", -3, 3, 8, 13, -0.1, 0, floor)

    box("bed_wall_W", -3 - T / 2, -3 + T / 2, 0, 4, 0, H, wall_bed)
    box("bed_wall_E", 3 - T / 2, 3 + T / 2, 0, 4, 0, H, wall_bed)
    box("bed_wall_S", -3, 3, -T, 0, 0, H, wall_bed)
    wall_with_door("bed_to_hall", 4, -3, 3, wall_bed)
    box("hall_wall_W", -1 - T / 2, -1 + T / 2, 4, 8, 0, H, wall_hall)
    box("hall_wall_E", 1 - T / 2, 1 + T / 2, 4, 8, 0, H, wall_hall)
    wall_with_door("hall_to_living", 8, -3, 3, wall_living)
    box("living_wall_W", -3 - T / 2, -3 + T / 2, 8, 13, 0, H, wall_living)
    box("living_wall_E", 3 - T / 2, 3 + T / 2, 8, 13, 0, H, wall_living)
    box("living_wall_N", -3, 3, 13, 13 + T, 0, H, wall_living)

    door_frame("door_a", 4, trim)
    door_frame("door_b", 8, trim)

    bb, bh = 0.06, 0.16
    ix = 3 - T / 2
    box("bb_bed_W", -ix, -ix + bb, 0, 4, 0, bh, trim)
    box("bb_bed_E", ix - bb, ix, 0, 4, 0, bh, trim)
    box("bb_bed_S", -3, 3, 0, bb, 0, bh, trim)
    for side, ya, yb in (("a", 4 - T / 2 - bb, 4 - T / 2), ("b", 8 + T / 2, 8 + T / 2 + bb)):
        box("bb_dw_L" + side, -3, -0.6, ya, yb, 0, bh, trim)
        box("bb_dw_R" + side, 0.6, 3, ya, yb, 0, bh, trim)
    box("bb_hall_a", -1 + T / 2, -1 + T / 2 + bb, 4, 8, 0, bh, trim)
    box("bb_hall_b", 1 - T / 2 - bb, 1 - T / 2, 4, 8, 0, bh, trim)
    box("bb_hall_c", -1 + T / 2, -0.6, 7.94 - bb, 7.94, 0, bh, trim)
    box("bb_hall_d", 0.6, 1 - T / 2, 7.94 - bb, 7.94, 0, bh, trim)
    box("bb_liv_W", -ix, -ix + bb, 8, 13, 0, bh, trim)
    box("bb_liv_E", ix - bb, ix, 8, 13, 0, bh, trim)
    box("bb_liv_N", -3, 3, 13 - bb, 13, 0, bh, trim)

    # bedroom
    box("bed_base", -2.9, -1.0, 1.0, 3.4, 0, 0.35, flat(pal["bed_wood"]), 0.03)
    box("bed_blanket", -2.85, -1.05, 1.05, 3.0, 0.35, 0.62, flat(pal["blanket"]), 0.1)
    box("bed_pillow", -2.7, -1.2, 3.0, 3.35, 0.55, 0.78, flat(pal["pillow"]), 0.1)
    box("bed_head", -2.95, -0.95, 3.4, 3.52, 0, 1.15, flat(pal["bed_wood"]), 0.04)
    box("bedside", -0.85, -0.35, 3.2, 3.7, 0, 0.5, wood, 0.03)
    cylinder("bed_rug", 0.9, 1.8, 0.0, 0.02, 1.1, 0.8, rings(*pal["rug"]))
    window_east("bed_window", 1.3, 2.7, 1.2, 2.3, ix, pal)
    picture("bed_pic", -2.4, -1.4, 3.8, 3.86, 1.5, 2.2, flat(pal["frame"]), flat(pal["picture"]))

    # hall
    box("console", 0.45, 0.9, 5.2, 6.6, 0, 0.8, wood, 0.03)
    picture("hall_pic_a", -0.94, -0.88, 4.7, 5.6, 1.4, 2.1, flat(pal["frame"]), flat(pal["picture"]))
    picture("hall_pic_b", -0.94, -0.88, 6.3, 7.2, 1.4, 2.1, flat(pal["frame"]), flat(pal["picture"]))
    cylinder("hall_rug", 0.0, 6.0, 0.0, 0.02, 0.6, 1.6, rings(*pal["rug"]))

    # living room
    sofa = flat(pal["sofa"])
    box("sofa_seat", -2.8, -1.5, 10.0, 12.2, 0, 0.45, sofa, 0.08)
    box("sofa_back", -2.9, -2.4, 10.0, 12.2, 0.3, 1.05, sofa, 0.1)
    box("sofa_arm_a", -2.8, -1.5, 9.9, 10.25, 0, 0.7, sofa, 0.1)
    box("sofa_arm_b", -2.8, -1.5, 11.95, 12.3, 0, 0.7, sofa, 0.1)
    cush = flat(pal["cushion"])
    for i, ya in enumerate((10.3, 10.85, 11.4)):
        box("cushion_%d" % i, -2.4, -1.55, ya, ya + 0.5, 0.45, 0.58, cush, 0.05)
    cylinder("living_rug", -0.3, 11.1, 0.0, 0.02, 1.6, 1.15, rings(*pal["rug"]))
    box("coffee_table", -0.9, -0.1, 10.7, 11.5, 0.0, 0.42, wood, 0.03)
    cylinder("lamp_pole", -2.6, 9.55, 0.0, 1.6, 0.03, 0.03, flat(pal["lamp"]))
    cylinder("lamp_base", -2.6, 9.55, 0.0, 0.05, 0.2, 0.2, flat(pal["lamp"]))
    cone("lamp_shade", -2.6, 9.55, 1.45, 1.9, 0.33, 0.2, flat(pal["cushion"]))
    picture("living_pic", -2.94, -2.88, 10.4, 11.8, 1.5, 2.3, flat(pal["frame"]), flat(pal["picture"]))
    box("tv_unit", 2.45, 2.9, 10.0, 12.0, 0, 0.7, wood, 0.03)
    box("tv", 2.6, 2.7, 10.2, 11.8, 0.7, 1.45, flat(pal["tv"]), 0.03)
    window_east("living_window", 9.2, 10.0, 1.2, 2.3, ix, pal)


def setup_render(width, height, thickness):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.filter_width = 1.2
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.75, 0.88, 0.97, 1)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    style_lab.set_outline(True, thickness)


def main():
    args = parse_args()
    rows = []
    for name in [p for p in args.palettes.split(",") if p]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        build(PALETTES[name])
        house.add_camera(FRAMES)
        setup_render(args.width, args.height, args.thickness)
        row = []
        for frame in SAMPLE_FRAMES:
            bpy.context.scene.frame_set(frame)
            path = os.path.join(args.out, "%s_f%04d.png" % (name, frame))
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            row.append(path)
        rows.append(row)
    style_lab.tile_sheet(rows, os.path.join(args.out, "cartoon_sheet.png"))
    print("ROWS top to bottom:", args.palettes)
    print("WROTE", os.path.join(args.out, "cartoon_sheet.png"))


if __name__ == "__main__":
    main()
