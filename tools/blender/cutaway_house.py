"""Cutaway cartoon house: two floors, six rooms, stairs and a roof, seen
straight on from the front like a dolls house. Renders one large still that
can be used as a scene background; the Engine camera can then zoom and pan
room to room.

Run:
    blender -b -P tools/blender/cutaway_house.py -- --out renders/cutaway --palette wood

Writes <out>/cutaway_<palette>.png. Use --width 7680 --height 4320 for a
big background (slower). Outline thickness scales with width.
Tested with Blender 5.2.2 LTS, CPU only.

Layout (front view, X to the right, Z up):
    upstairs : bedroom | landing + stairwell | bathroom
    downstairs: living room | hall with stairs | kitchen
"""

import argparse
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cartoon_house as ch  # noqa: E402
import style_lab  # noqa: E402

DEPTH = 3.0
BACK_T = 0.15
FLOOR_Z = 3.25
CEIL_Z = 6.25
LEFT, RIGHT = -7.0, 7.0
PARTY_L, PARTY_R = -1.0, 2.0


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="cutaway")
    p.add_argument("--palette", default="wood", choices=list(ch.PALETTES))
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--thickness", type=float, default=3.0,
                   help="outline width in pixels at 1920 wide (scales with width)")
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def checker(c1, c2, size=0.6):
    key = ("checker", tuple(c1), tuple(c2))
    if key not in ch._cache:
        mat, tree = ch._tree("checker_%d" % len(ch._cache))
        x, y, _z = ch._world_xyz(tree)
        a = ch._math(tree, "FLOOR", ch._math(tree, "MULTIPLY", x, 1 / size))
        b = ch._math(tree, "FLOOR", ch._math(tree, "MULTIPLY", y, 1 / size))
        parity = ch._math(tree, "MODULO", ch._math(tree, "ADD", a, b), 2)
        ch._finish(tree, ch._mix(tree, ch._math(tree, "GREATER_THAN", parity, 0.5), c1, c2))
        ch._cache[key] = mat
    return ch._cache[key]


def room_shell(name, x0, x1, z0, z1, wall_mat):
    box(name + "_back", x0, x1, DEPTH, DEPTH + BACK_T, z0, z1, wall_mat)


box = ch.box
flat = ch.flat


def build(pal):
    ch._cache.clear()
    trim = flat(pal["trim"])
    wood = flat(pal["table"])
    white = flat(pal["pillow"])
    floor_spec = pal["floor"]
    if floor_spec[0] == "planks":
        living_floor = ch.planks(floor_spec[1], floor_spec[2])
        upper_floor = living_floor
    else:
        living_floor = flat(floor_spec[1])
        upper_floor = flat(tuple(c * 0.85 for c in floor_spec[1][:3]) + (1,))
    tile = checker((0.97, 0.95, 0.9, 1), (0.55, 0.65, 0.7, 1))
    structure = flat(tuple(c * 0.8 for c in pal["trim"][:3]) + (1,))

    wall_living = (ch.stripes(pal["wall_living"], pal["wall_living_stripe"])
                   if pal["wall_living_stripe"] else flat(pal["wall_living"]))
    wall_hall = flat(pal["wall_hall"])
    wall_kitchen = flat(tuple(min(1.0, c * 1.05) for c in pal["wall_bed"][:3]) + (1,))
    wall_bed = flat(pal["wall_bed"])
    wall_bath = flat(tuple(0.55 * c + 0.45 * 1.0 for c in pal["sky"][:3]) + (1,))

    # ground, slabs, outer and party walls
    box("grass", -9.5, 9.5, -1.2, DEPTH + 1.0, -1.0, -0.25, flat((0.42, 0.74, 0.3, 1)))
    box("slab_ground", LEFT - 0.2, RIGHT + 0.2, -0.2, DEPTH + BACK_T, -0.25, 0, structure)
    box("slab_up_L", LEFT - 0.2, -0.5, -0.2, DEPTH + BACK_T, 3.0, FLOOR_Z, structure)
    box("slab_up_R", PARTY_R, RIGHT + 0.2, -0.2, DEPTH + BACK_T, 3.0, FLOOR_Z, structure)
    box("slab_roof", LEFT - 0.5, RIGHT + 0.5, -0.4, DEPTH + BACK_T + 0.2, CEIL_Z, CEIL_Z + 0.25, structure)
    for name, x0, x1 in (("wall_L", LEFT - 0.2, LEFT), ("wall_R", RIGHT, RIGHT + 0.2),
                         ("party_a", PARTY_L - 0.06, PARTY_L + 0.06),
                         ("party_b", PARTY_R - 0.06, PARTY_R + 0.06)):
        box(name, x0, x1, -0.2, DEPTH + BACK_T, 0, CEIL_Z, structure)

    # floors (top surfaces) and back walls per room
    box("floor_living", LEFT, PARTY_L, 0, DEPTH, 0, 0.04, living_floor)
    box("floor_hall", PARTY_L, PARTY_R, 0, DEPTH, 0, 0.04, wall_hall)
    box("floor_kitchen", PARTY_R, RIGHT, 0, DEPTH, 0, 0.04, tile)
    box("floor_bed", LEFT, -0.5, 0, DEPTH, FLOOR_Z, FLOOR_Z + 0.04, upper_floor)
    box("floor_bath", PARTY_R, RIGHT, 0, DEPTH, FLOOR_Z, FLOOR_Z + 0.04, tile)
    room_shell("living", LEFT, PARTY_L, 0, FLOOR_Z, wall_living)
    room_shell("hall_low", PARTY_L, PARTY_R, 0, FLOOR_Z, wall_hall)
    room_shell("hall_up", PARTY_L, PARTY_R, FLOOR_Z, CEIL_Z, wall_hall)
    room_shell("kitchen", PARTY_R, RIGHT, 0, FLOOR_Z, wall_kitchen)
    room_shell("bed", LEFT, PARTY_L, FLOOR_Z, CEIL_Z, wall_bed)
    room_shell("bath", PARTY_R, RIGHT, FLOOR_Z, CEIL_Z, wall_bath)
    box("bed_extra", PARTY_L, -0.5, DEPTH, DEPTH + BACK_T, FLOOR_Z, CEIL_Z, wall_hall)

    # baseboards on the back wall
    for name, x0, x1, z in (("bb_liv", LEFT, PARTY_L, 0), ("bb_hall", PARTY_L, PARTY_R, 0),
                            ("bb_kit", PARTY_R, RIGHT, 0), ("bb_bed", LEFT, PARTY_L, FLOOR_Z),
                            ("bb_bath", PARTY_R, RIGHT, FLOOR_Z)):
        box(name, x0, x1, DEPTH - 0.06, DEPTH, z, z + 0.18, trim)

    # stairs: 12 solid steps rising to the left
    run = (1.95 - (-0.5)) / 12
    rise = FLOOR_Z / 12
    stair = flat(pal["bed_wood"])
    for k in range(12):
        x1 = 1.95 - k * run
        box("step_%d" % k, x1 - run, x1, 0.4, DEPTH - 0.1, 0, (k + 1) * rise, stair)
    box("rail_post", -0.55, -0.45, 0.45, 0.55, FLOOR_Z, FLOOR_Z + 1.0, trim, 0.02)
    box("rail_top", -0.58, 0.9, 0.45, 0.55, FLOOR_Z + 0.95, FLOOR_Z + 1.05, trim, 0.02)

    # living room
    sofa = flat(pal["sofa"])
    box("sofa_seat", -5.8, -2.4, 1.7, 2.85, 0, 0.5, sofa, 0.09)
    box("sofa_back", -5.9, -2.3, 2.55, 2.95, 0.3, 1.35, sofa, 0.12)
    box("sofa_arm_a", -5.9, -5.55, 1.6, 2.9, 0, 0.8, sofa, 0.12)
    box("sofa_arm_b", -2.65, -2.3, 1.6, 2.9, 0, 0.8, sofa, 0.12)
    for i, xa in enumerate((-5.5, -4.5, -3.5)):
        box("cushion_%d" % i, xa, xa + 0.95, 1.8, 2.6, 0.5, 0.65, flat(pal["cushion"]), 0.06)
    ch.cylinder("living_rug", -4.1, 0.9, 0.0, 0.03, 2.4, 0.75, ch.rings(*pal["rug"]))
    box("coffee_table", -4.8, -3.4, 0.5, 1.2, 0, 0.45, wood, 0.03)
    ch.cylinder("lamp_pole", -6.5, 2.5, 0.0, 1.8, 0.04, 0.04, flat(pal["lamp"]))
    ch.cylinder("lamp_base", -6.5, 2.5, 0.0, 0.06, 0.22, 0.22, flat(pal["lamp"]))
    ch.cone("lamp_shade", -6.5, 2.5, 1.6, 2.15, 0.38, 0.22, flat(pal["cushion"]))
    ch.picture("living_pic", -5.4, -3.2, 2.85, 2.95, 1.8, 2.7, flat(pal["frame"]), flat(pal["picture"]))
    ch.window_east  # noqa: B018 (kept for reference: east-wall helper, not used here)
    window_back("living_win", -2.9, -1.5, 1.2, 2.5, 0.0, pal)

    # hall
    ch.picture("hall_pic", 0.2, 1.2, 2.85, 2.95, 3.9, 4.8, flat(pal["frame"]), flat(pal["picture"]))
    ch.cylinder("hall_pendant", 0.5, 1.5, CEIL_Z - 0.9, CEIL_Z - 0.02, 0.03, 0.03, flat(pal["lamp"]))
    ch.cone("hall_shade", 0.5, 1.5, CEIL_Z - 1.4, CEIL_Z - 0.85, 0.45, 0.15, flat(pal["cushion"]))

    # kitchen
    cab = flat(pal["bed_wood"])
    box("counter", 2.4, 6.0, 2.2, 2.95, 0, 0.95, cab, 0.03)
    box("counter_top", 2.35, 6.05, 2.15, 2.97, 0.95, 1.03, trim, 0.02)
    box("sink", 4.0, 4.9, 2.3, 2.85, 1.0, 1.04, flat(pal["picture"]))
    box("upper_cab_a", 2.45, 3.9, 2.55, 2.95, 1.95, 2.8, cab, 0.04)
    box("upper_cab_b", 5.0, 6.0, 2.55, 2.95, 1.95, 2.8, cab, 0.04)
    box("fridge", 6.1, 6.9, 2.0, 2.95, 0, 2.2, white, 0.08)
    box("fridge_line", 6.1, 6.9, 1.97, 2.0, 1.4, 1.45, flat((0.2, 0.2, 0.25, 1)))
    window_back("kitchen_win", 4.15, 4.75, 1.45, 2.65, 0.0, pal, bars=False)
    ch.cylinder("table_top", 4.0, 1.2, 0.72, 0.8, 0.75, 0.75, wood)
    ch.cylinder("table_leg", 4.0, 1.2, 0.0, 0.72, 0.07, 0.07, wood)
    box("chair_a", 2.9, 3.3, 1.0, 1.4, 0, 0.45, flat(pal["sofa"]), 0.03)
    box("chair_a_back", 2.9, 3.3, 1.35, 1.4, 0.45, 1.1, flat(pal["sofa"]), 0.02)
    box("chair_b", 4.7, 5.1, 1.0, 1.4, 0, 0.45, flat(pal["sofa"]), 0.03)
    box("chair_b_back", 4.7, 5.1, 1.35, 1.4, 0.45, 1.1, flat(pal["sofa"]), 0.02)
    ch.cylinder("kit_pendant", 4.0, 1.2, CEIL_Z - 3.1, FLOOR_Z - 0.2, 0.03, 0.03, flat(pal["lamp"]))
    ch.cone("kit_shade", 4.0, 1.2, FLOOR_Z - 0.75, FLOOR_Z - 0.2, 0.45, 0.15, flat(pal["cushion"]))

    # bedroom
    z0 = FLOOR_Z + 0.04
    box("bed_base", -6.7, -3.4, 1.3, 2.9, z0, z0 + 0.4, flat(pal["bed_wood"]), 0.04)
    box("bed_blanket", -6.55, -3.5, 1.35, 2.85, z0 + 0.4, z0 + 0.7, flat(pal["blanket"]), 0.12)
    box("bed_pillow", -6.5, -5.7, 1.6, 2.6, z0 + 0.65, z0 + 0.9, flat(pal["pillow"]), 0.12)
    box("bed_head", -6.8, -6.6, 1.2, 3.0, z0, z0 + 1.3, flat(pal["bed_wood"]), 0.05)
    box("bedside", -3.1, -2.4, 2.2, 2.9, z0, z0 + 0.65, wood, 0.03)
    ch.cylinder("bed_rug", -3.6, 0.8, FLOOR_Z + 0.04, FLOOR_Z + 0.07, 2.0, 0.7, ch.rings(*pal["rug"]))
    ch.picture("bed_pic", -6.0, -4.4, 2.85, 2.95, z0 + 1.7, z0 + 2.5, flat(pal["frame"]), flat(pal["picture"]))
    window_back("bed_win", -2.4, -1.3, FLOOR_Z + 1.2, FLOOR_Z + 2.4, 0.0, pal)

    # bathroom
    box("tub", 2.4, 4.7, 1.7, 2.9, z0, z0 + 0.75, white, 0.1)
    box("tub_water", 2.55, 4.55, 1.85, 2.75, z0 + 0.74, z0 + 0.78, flat(pal["picture"]))
    ch.cylinder("toilet_bowl", 5.6, 2.2, z0, z0 + 0.45, 0.28, 0.32, white)
    box("toilet_tank", 5.4, 5.8, 2.6, 2.9, z0 + 0.3, z0 + 0.95, white, 0.05)
    box("sink_stand", 6.2, 6.7, 2.4, 2.9, z0, z0 + 0.8, white, 0.06)
    ch.picture("mirror", 6.1, 6.8, 2.85, 2.95, z0 + 1.4, z0 + 2.3, flat(pal["frame"]), flat((0.85, 0.95, 1.0, 1)))

    # roof (pyramid seen as a triangle from the front) and chimney
    roof_col = flat((0.75, 0.27, 0.2, 1) if pal is ch.PALETTES["bold"] else (0.62, 0.3, 0.2, 1))
    width = (RIGHT - LEFT) + 1.4
    bpy.ops.mesh.primitive_cone_add(
        radius1=width / 2 * math.sqrt(2), radius2=0, depth=2.6, vertices=4,
        location=(0, DEPTH / 2, CEIL_Z + 0.25 + 1.3), rotation=(0, 0, math.radians(45)))
    roof = bpy.context.active_object
    roof.name = "roof"
    roof.scale = (1, (DEPTH + 1.0) / width, 1)
    roof.data.materials.append(roof_col)
    box("chimney", 4.2, 5.0, 1.0, 2.0, CEIL_Z + 0.25, CEIL_Z + 2.2, flat((0.55, 0.35, 0.3, 1)), 0.03)


def window_back(name, x0, x1, z0, z1, _unused, pal, bars=True):
    """Window on the back wall with trim, sky, bars and curtains."""
    y = DEPTH
    trim = flat(pal["trim"])
    box(name + "_trim", x0 - 0.1, x1 + 0.1, y - 0.08, y, z0 - 0.1, z1 + 0.1, trim)
    box(name + "_sky", x0, x1, y - 0.1, y - 0.07, z0, z1, flat(pal["sky"]))
    if bars:
        mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
        box(name + "_bv", mx - 0.03, mx + 0.03, y - 0.12, y - 0.07, z0, z1, trim)
        box(name + "_bh", x0, x1, y - 0.12, y - 0.07, mz - 0.03, mz + 0.03, trim)
        cur = flat(pal["curtain"])
        box(name + "_ca", x0 - 0.45, x0 - 0.05, y - 0.22, y - 0.1, z0 - 0.2, z1 + 0.3, cur, 0.04)
        box(name + "_cb", x1 + 0.05, x1 + 0.45, y - 0.22, y - 0.1, z0 - 0.2, z1 + 0.3, cur, 0.04)


def setup_camera(width, height):
    bpy.ops.object.camera_add(location=(0, -30, 3.7), rotation=(math.pi / 2, 0, 0))
    cam = bpy.context.active_object
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 19.0
    cam.data.clip_end = 100
    bpy.context.scene.camera = cam


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build(ch.PALETTES[args.palette])
    setup_camera(args.width, args.height)
    thickness = args.thickness * args.width / 1920
    ch.setup_render(args.width, args.height, thickness)
    path = os.path.join(args.out, "cutaway_%s.png" % args.palette)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("WROTE", path)


if __name__ == "__main__":
    main()
