"""Capability lab: one small test per Blender feature, one picture each.

Each test builds a tiny scene, renders a tile, and records PASS or FAIL. The
point is to learn what Blender can do for us through scripts. Add a test by
writing a function that builds a scene and registering it in TESTS.

    blender -b -P tools/blender/capability_lab.py -- --out renders/capability

Options: --only name1,name2  --samples 24  --list
Writes one PNG per test, capability_sheet.png, and capability_report.txt.
"""

import math
import os
import sys
import time
import traceback

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TILE_W, TILE_H = 480, 270


def parse_args():
    import argparse

    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/capability")
    p.add_argument("--only", default="")
    p.add_argument("--samples", type=int, default=24)
    p.add_argument("--list", action="store_true")
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = TILE_W, TILE_H
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    return scene


def cycles(scene, samples):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True


def sky(scene, color=(0.55, 0.7, 0.95), strength=1.0):
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = tuple(color) + (1,)
    bg.inputs["Strength"].default_value = strength
    scene.world = world


def camera(loc, target, lens=35):
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.data.lens = lens
    direction = Vector(target) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def sun(strength=3.0, rot=(0.9, 0.2, 0.6)):
    bpy.ops.object.light_add(type="SUN", rotation=rot)
    bpy.context.active_object.data.energy = strength


def ground(color=(0.6, 0.55, 0.45), size=40):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = "ground"
    ob.data.materials.append(diffuse(color))
    return ob


def diffuse(color, name=None):
    mat = bpy.data.materials.new(name or "m")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = tuple(color) + (1,)
    mat.diffuse_color = tuple(color) + (1,)
    return mat


def principled(color, metallic=0.0, roughness=0.5, transmission=0.0, name="p"):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = tuple(color) + (1,)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Transmission Weight"].default_value = transmission
    return mat


def t_modifiers(scene, n):
    """Boolean cut, bevel and subdivision: model a rounded block with holes."""
    cycles(scene, n)
    sky(scene)
    sun()
    ground()
    bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
    block = bpy.context.active_object
    block.data.materials.append(diffuse((0.85, 0.35, 0.25)))
    for i, x in enumerate((-0.9, 0, 0.9)):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.28, depth=3, location=(x, 0, 1), rotation=(math.pi / 2, 0, 0))
        cutter = bpy.context.active_object
        cutter.hide_render = True
        m = block.modifiers.new("cut%d" % i, "BOOLEAN")
        m.operation, m.object = "DIFFERENCE", cutter
    bev = block.modifiers.new("bevel", "BEVEL")
    bev.width, bev.segments = 0.08, 4
    camera((4.5, -5.5, 3.2), (0, 0, 1.0), 40)


def t_pbr_materials(scene, n):
    """Metal, glass, rough plastic and emission side by side."""
    cycles(scene, n)
    sky(scene, (0.8, 0.85, 0.95), 1.0)
    sun(3.0)
    ground((0.5, 0.5, 0.5))
    specs = [
        principled((0.9, 0.75, 0.3), metallic=1.0, roughness=0.15, name="gold"),
        principled((0.8, 0.9, 1.0), transmission=1.0, roughness=0.02, name="glass"),
        principled((0.2, 0.5, 0.9), roughness=0.6, name="plastic"),
    ]
    for i, mat in enumerate(specs):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=((i - 1) * 2.0, 0, 0.8))
        ob = bpy.context.active_object
        bpy.ops.object.shade_smooth()
        ob.data.materials.append(mat)
    mat = bpy.data.materials.new("glow")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    e = nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (1.0, 0.3, 0.6, 1)
    e.inputs["Strength"].default_value = 6
    o = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(e.outputs[0], o.inputs["Surface"])
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35, location=(0, -1.6, 0.35))
    bpy.context.active_object.data.materials.append(mat)
    camera((0, -7, 2.2), (0, 0, 0.7), 40)


def t_procedural(scene, n):
    """Procedural brick, noise and voronoi textures with no image files."""
    cycles(scene, n)
    sky(scene)
    sun()
    mats = []
    for kind in ("ShaderNodeTexBrick", "ShaderNodeTexNoise", "ShaderNodeTexVoronoi"):
        mat = bpy.data.materials.new(kind)
        mat.use_nodes = True
        tree = mat.node_tree
        tex = tree.nodes.new(kind)
        if kind == "ShaderNodeTexNoise":
            tex.inputs["Scale"].default_value = 6
            ramp = tree.nodes.new("ShaderNodeValToRGB")
            ramp.color_ramp.elements[0].color = (0.1, 0.25, 0.1, 1)
            ramp.color_ramp.elements[1].color = (0.6, 0.85, 0.3, 1)
            tree.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
            tree.links.new(ramp.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])
        elif kind == "ShaderNodeTexBrick":
            tex.inputs["Color1"].default_value = (0.7, 0.3, 0.2, 1)
            tex.inputs["Color2"].default_value = (0.55, 0.22, 0.16, 1)
            tex.inputs["Mortar"].default_value = (0.85, 0.85, 0.8, 1)
            tex.inputs["Scale"].default_value = 4
            tex.inputs["Mortar Size"].default_value = 0.03
            tex.inputs["Brick Width"].default_value = 0.5
            tex.inputs["Row Height"].default_value = 0.2
            tree.links.new(tex.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])
        else:
            tex.inputs["Scale"].default_value = 5
            tree.links.new(tex.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])
        mats.append(mat)
    for i, mat in enumerate(mats):
        bpy.ops.mesh.primitive_cube_add(size=1.6, location=((i - 1) * 2.0, 0, 0.8))
        ob = bpy.context.active_object
        ob.data.materials.append(mat)
        ob.rotation_euler = (0, 0, 0.5)
    ground((0.7, 0.7, 0.7))
    camera((0, -7, 3), (0, 0, 0.7), 40)


def t_geonodes(scene, n):
    """Geometry Nodes: scatter small cones as 'trees' over a hill."""
    cycles(scene, n)
    sky(scene)
    sun()
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=40, y_subdivisions=40, size=8)
    hill = bpy.context.active_object
    hill.data.materials.append(diffuse((0.45, 0.7, 0.3)))
    disp = hill.modifiers.new("hill", "DISPLACE")
    tex = bpy.data.textures.new("clouds", "CLOUDS")
    tex.noise_scale = 1.6
    disp.texture, disp.strength = tex, 1.4

    bpy.ops.mesh.primitive_cone_add(radius1=0.18, radius2=0, depth=0.8, location=(20, 20, 0))
    tree = bpy.context.active_object
    tree.data.materials.append(diffuse((0.1, 0.4, 0.15)))
    tree.hide_render = True

    ng = bpy.data.node_groups.new("scatter", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = ng.nodes, ng.links
    gin = nodes.new("NodeGroupInput")
    gout = nodes.new("NodeGroupOutput")
    dist = nodes.new("GeometryNodeDistributePointsOnFaces")
    dist.inputs["Density"].default_value = 6
    objinfo = nodes.new("GeometryNodeObjectInfo")
    objinfo.inputs["Object"].default_value = tree
    inst = nodes.new("GeometryNodeInstanceOnPoints")
    join = nodes.new("GeometryNodeJoinGeometry")
    links.new(gin.outputs[0], dist.inputs["Mesh"])
    links.new(dist.outputs["Points"], inst.inputs["Points"])
    links.new(objinfo.outputs["Geometry"], inst.inputs["Instance"])
    links.new(gin.outputs[0], join.inputs[0])
    links.new(inst.outputs["Instances"], join.inputs[0])
    links.new(join.outputs[0], gout.inputs[0])
    mod = hill.modifiers.new("gn", "NODES")
    mod.node_group = ng
    camera((0, -8, 4), (0, 0, 0.4), 38)


def t_text(scene, n):
    """3D extruded text for titles and signs."""
    cycles(scene, n)
    sky(scene, (0.9, 0.85, 0.7), 1.0)
    sun(4)
    ground((0.5, 0.5, 0.55))
    bpy.ops.object.text_add(location=(0, 0, 1.6), rotation=(math.pi / 2, 0, 0))
    ob = bpy.context.active_object
    ob.data.body = "SUNNY\nBANKS"
    ob.data.align_x = "CENTER"
    ob.data.extrude = 0.12
    ob.data.bevel_depth = 0.02
    ob.data.size = 1.2
    ob.data.materials.append(principled((0.95, 0.65, 0.15), metallic=0.6, roughness=0.3))
    camera((0, -9, 1.6), (0, 0, 1.3), 40)


def t_armature(scene, n):
    """Armature with automatic weights: bend an arm on a simple body."""
    cycles(scene, n)
    sky(scene)
    sun()
    ground()
    bpy.ops.mesh.primitive_cylinder_add(radius=0.18, depth=2.4, location=(0, 0, 1.2), vertices=24)
    body = bpy.context.active_object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=12)
    bpy.ops.object.mode_set(mode="OBJECT")
    body.data.materials.append(diffuse((0.9, 0.5, 0.3)))
    bpy.ops.object.armature_add(location=(0, 0, 0))
    arm = bpy.context.active_object
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    root = eb[0]
    root.head, root.tail = (0, 0, 0), (0, 0, 1.2)
    b2 = eb.new("upper")
    b2.head, b2.tail = (0, 0, 1.2), (0, 0, 2.4)
    b2.parent = root
    b2.use_connect = True
    bpy.ops.object.mode_set(mode="OBJECT")
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    bpy.ops.object.mode_set(mode="POSE")
    arm.pose.bones["upper"].rotation_mode = "XYZ"
    arm.pose.bones["upper"].rotation_euler = (math.radians(70), 0, 0)
    bpy.ops.object.mode_set(mode="OBJECT")
    camera((0, -6, 1.6), (0, 0, 1.2), 40)


def t_rigid_body(scene, n):
    """Rigid body physics: a stack of blocks knocked over, simulated to frame 30."""
    cycles(scene, n)
    sky(scene)
    sun()
    g = ground()
    bpy.ops.rigidbody.object_add(type="PASSIVE")
    colors = [(0.9, 0.3, 0.3), (0.3, 0.7, 0.9), (0.95, 0.8, 0.3), (0.4, 0.8, 0.4)]
    for i in range(12):
        bpy.ops.mesh.primitive_cube_add(size=0.5, location=(0.02 * (i % 3), 0, 0.26 + i * 0.5))
        ob = bpy.context.active_object
        ob.data.materials.append(diffuse(colors[i % 4]))
        bpy.ops.rigidbody.object_add(type="ACTIVE")
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.4, location=(-3.5, 0, 0.5))
    ball = bpy.context.active_object
    ball.data.materials.append(diffuse((0.2, 0.2, 0.25)))
    bpy.ops.rigidbody.object_add(type="ACTIVE")
    ball.rigid_body.mass = 20
    ball.rigid_body.linear_damping = 0
    ball.keyframe_insert("location", frame=1)
    ball.rigid_body.kinematic = True
    ball.keyframe_insert("rigid_body.kinematic", frame=1) if False else None
    ball.location = (0, 0, 0.5)
    ball.keyframe_insert("location", frame=10)
    camera((3, -8, 3), (0, 0, 2), 35)
    for f in range(1, 31):
        scene.frame_set(f)


def t_hair(scene, n):
    """Particle hair as grass on a patch of ground."""
    cycles(scene, n)
    sky(scene)
    sun()
    bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0, 0))
    patch = bpy.context.active_object
    patch.data.materials.append(diffuse((0.2, 0.45, 0.15)))
    bpy.ops.object.particle_system_add()
    ps = patch.particle_systems[0].settings
    ps.type = "HAIR"
    ps.count = 2500
    ps.hair_length = 0.35
    ps.child_type = "SIMPLE"
    ps.rendered_child_count = 6
    ground((0.3, 0.25, 0.2), size=10).location.z = -0.01
    camera((0, -3.2, 0.9), (0, 0, 0.1), 40)


def t_dof(scene, n):
    """Depth of field with a real perspective camera: sharp subject, blurred background."""
    cycles(scene, n)
    sky(scene)
    sun()
    ground()
    for i in range(7):
        bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1.6, location=(-3 + i, 3 + i * 1.5, 0.8))
        bpy.context.active_object.data.materials.append(diffuse((0.2 + 0.1 * i, 0.5, 0.8 - 0.08 * i)))
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
    bpy.context.active_object.data.materials.append(diffuse((0.95, 0.3, 0.2)))
    cam = camera((0.3, -4, 1.0), (0, 0, 0.6), 85)
    cam.data.dof.use_dof = True
    cam.data.dof.focus_distance = 4.1
    cam.data.dof.aperture_fstop = 1.4


def t_eevee(scene, n):
    """Eevee (the fast real-time engine). Often needs a graphics card, so a failure here is informative."""
    scene.render.engine = "BLENDER_EEVEE"
    sky(scene)
    sun()
    ground()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 1))
    bpy.context.active_object.data.materials.append(diffuse((0.9, 0.4, 0.3)))
    camera((4, -5, 2.5), (0, 0, 1), 40)


TESTS = [
    ("modifiers", t_modifiers),
    ("pbr_materials", t_pbr_materials),
    ("procedural_textures", t_procedural),
    ("geometry_nodes", t_geonodes),
    ("text_3d", t_text),
    ("armature_pose", t_armature),
    ("rigid_body", t_rigid_body),
    ("hair_particles", t_hair),
    ("depth_of_field", t_dof),
    ("eevee", t_eevee),
]


def main():
    args = parse_args()
    if args.list:
        for name, fn in TESTS:
            print("%-20s %s" % (name, (fn.__doc__ or "").strip()))
        return
    only = {s for s in args.only.split(",") if s}
    report, paths = [], []
    for name, fn in TESTS:
        if only and name not in only:
            continue
        path = os.path.join(args.out, name + ".png")
        t0 = time.time()
        try:
            scene = reset()
            fn(scene, args.samples)
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            ok = os.path.exists(path)
            status = "PASS" if ok else "FAIL (no picture)"
            if ok:
                paths.append(path)
        except Exception as exc:
            status = "FAIL %s: %s" % (type(exc).__name__, str(exc).splitlines()[0][:150] if str(exc) else "")
            traceback.print_exc()
        line = "%-20s %-8s %5.1fs  %s" % (name, status.split()[0], time.time() - t0, status if status != "PASS" else "")
        print("RESULT", line)
        report.append(line)
    with open(os.path.join(args.out, "capability_report.txt"), "w") as f:
        f.write("\n".join(report) + "\n")
    if paths:
        import style_lab

        cols = next(c for c in (3, 2, 1) if len(paths) % c == 0)
        rows = [paths[i:i + cols] for i in range(0, len(paths), cols)]
        style_lab.tile_sheet(rows, os.path.join(args.out, "capability_sheet.png"))
    print("DONE", args.out)


if __name__ == "__main__":
    main()
