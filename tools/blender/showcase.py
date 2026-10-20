"""Showcase: bigger, prettier scenes that show what Blender can make for us.

Each scene is built entirely by script (no downloaded assets), so it can be
rerun, changed, and used as a starting point. Pictures go to --out, one PNG
per scene, plus showcase_sheet.png.

    blender -b -P tools/blender/showcase.py -- --out renders/showcase

Options: --only storm,city  --list  --width 960 --height 540 --samples 48
Cycles on the CPU. Expect 20 seconds to 3 minutes per scene on a laptop.
"""

import colorsys
import math
import os
import random
import sys
import time
import traceback

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    import argparse

    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/showcase")
    p.add_argument("--only", default="")
    p.add_argument("--list", action="store_true")
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    p.add_argument("--samples", type=int, default=48)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def fresh(args, view="Khronos PBR Neutral"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = args.width, args.height, 100
    try:
        scene.view_settings.view_transform = view
    except TypeError:
        scene.view_settings.view_transform = "Standard"
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.volume_bounces = 0
    scene.cycles.volume_step_rate = 2.0
    return scene


def world(color, strength=1.0):
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = tuple(color) + (1,)
    bg.inputs["Strength"].default_value = strength
    bpy.context.scene.world = w
    return w


def nishita_sky(elevation_deg, rotation_deg=0.0, strength=1.0, dust=1.0):
    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    nt = w.node_tree
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_elevation = math.radians(elevation_deg)
    sky.sun_rotation = math.radians(rotation_deg)
    for attr in ("aerosol_density", "dust_density"):
        if hasattr(sky, attr):
            setattr(sky, attr, dust)
            break
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = strength
    nt.links.new(sky.outputs[0], bg.inputs["Color"])
    bpy.context.scene.world = w


def camera(loc, target, lens=35):
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def sun(strength, rot, color=(1, 1, 1), angle=0.02):
    bpy.ops.object.light_add(type="SUN", rotation=rot)
    s = bpy.context.active_object
    s.data.energy, s.data.color, s.data.angle = strength, color, angle
    return s


def point(loc, energy, color=(1, 1, 1), radius=0.1):
    bpy.ops.object.light_add(type="POINT", location=loc)
    p = bpy.context.active_object
    p.data.energy, p.data.color, p.data.shadow_soft_size = energy, color, radius
    return p


def mat(color, rough=0.5, metal=0.0, emit=None, emit_strength=0.0, name="m"):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = tuple(color) + (1,)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit is not None:
        b.inputs["Emission Color"].default_value = tuple(emit) + (1,)
        b.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = tuple(color) + (1,)
    return m


def emission(color, strength, name="e"):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = tuple(color) + (1,)
    e.inputs["Strength"].default_value = strength
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(e.outputs[0], o.inputs["Surface"])
    return m


def obj_from_bmesh(name, bm, material=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if material:
        me.materials.append(material)
    return ob


def box(name, c, size, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=c)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    ob.data.materials.append(material)
    if bevel:
        bpy.ops.object.transform_apply(scale=True)
        m = ob.modifiers.new("b", "BEVEL")
        m.width, m.segments = bevel, 3
    return ob


def cyl(name, c, r, h, material, verts=24, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=verts, location=c, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(material)
    return ob


def sphere(name, c, r, material, scale=(1, 1, 1), seg=32):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=c, segments=seg, ring_count=seg // 2)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = scale
    bpy.ops.object.shade_smooth()
    ob.data.materials.append(material)
    return ob


def plane(name, size, material, loc=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(material)
    return ob


def noise_color_material(scale, c0, c1, rough=0.8, detail=6, coord="Object", name="n"):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = detail
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = tuple(c0) + (1,)
    ramp.color_ramp.elements[1].color = tuple(c1) + (1,)
    nt.links.new(tc.outputs[coord], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    b = nt.nodes["Principled BSDF"]
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    return m


def volume_material(density, color=(1, 1, 1), anisotropy=0.0, emission_strength=0.0, name="vol"):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    v = nt.nodes.new("ShaderNodeVolumePrincipled")
    v.inputs["Color"].default_value = tuple(color) + (1,)
    v.inputs["Density"].default_value = density
    v.inputs["Anisotropy"].default_value = anisotropy
    if emission_strength:
        v.inputs["Emission Strength"].default_value = emission_strength
        v.inputs["Emission Color"].default_value = tuple(color) + (1,)
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(v.outputs[0], o.inputs["Volume"])
    return m


def displaced_grid(name, size, subdiv, strength, noise_size, material, loc=(0, 0, 0), seed=0):
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=subdiv, y_subdivisions=subdiv, size=size, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    bpy.ops.object.shade_smooth()
    ob.data.materials.append(material)
    tex = bpy.data.textures.new(name + "_tex", "CLOUDS")
    tex.noise_scale = noise_size
    tex.noise_depth = 4
    disp = ob.modifiers.new("disp", "DISPLACE")
    disp.texture, disp.strength = tex, strength
    disp.texture_coords = "OBJECT"
    return ob


# ---------------------------------------------------------------- scenes


def s_storm(args):
    """Rain and lightning over a farmhouse at night."""
    scene = fresh(args)
    world((0.05, 0.065, 0.11), 1.0)
    random.seed(4)
    wet = mat((0.05, 0.06, 0.05), rough=0.12, name="wet")
    plane("ground", 120, wet)
    house = mat((0.55, 0.45, 0.35), rough=0.8)
    box("house", (0, 6, 1.2), (4.2, 3.2, 2.4), house)
    roof = bpy.data.meshes.new("roof")
    bm = bmesh.new()
    verts = [bm.verts.new(v) for v in ((-2.4, 4.2, 2.4), (2.4, 4.2, 2.4), (2.4, 7.8, 2.4), (-2.4, 7.8, 2.4), (0, 4.2, 3.6), (0, 7.8, 3.6))]
    bm.faces.new((verts[0], verts[1], verts[4]))
    bm.faces.new((verts[2], verts[3], verts[5]))
    bm.faces.new((verts[0], verts[4], verts[5], verts[3]))
    bm.faces.new((verts[1], verts[2], verts[5], verts[4]))
    bm.faces.new((verts[0], verts[3], verts[2], verts[1]))
    obj_from_bmesh("roof", bm, mat((0.25, 0.1, 0.08), rough=0.7))
    win = emission((1.0, 0.75, 0.35), 8.0)
    box("window1", (-1.0, 4.38, 1.3), (0.8, 0.05, 0.9), win)
    box("window2", (1.0, 4.38, 1.3), (0.8, 0.05, 0.9), win)
    point((0, 3.2, 1.3), 300, (1.0, 0.7, 0.35), 0.6)
    trunk = mat((0.12, 0.08, 0.05))
    leaf = mat((0.04, 0.1, 0.05), rough=0.9)
    for i in range(26):
        x = random.uniform(-30, 30)
        y = random.uniform(10, 45)
        if abs(x) < 4 and y < 9:
            continue
        h = random.uniform(2.5, 5)
        cyl("t", (x, y, h / 2), 0.18, h, trunk, 8)
        sphere("l", (x, y, h + 0.8), random.uniform(1.0, 1.6), leaf, (1, 1, 1.3), 12)
    bm = bmesh.new()
    for _ in range(3200):
        x, y, z = random.uniform(-14, 14), random.uniform(-4, 30), random.uniform(0, 14)
        L, d = 1.0, 0.006
        sx = 0.18
        v = [bm.verts.new((x - d, y, z)), bm.verts.new((x + d, y, z)),
             bm.verts.new((x + d + sx, y, z - L)), bm.verts.new((x - d + sx, y, z - L))]
        bm.faces.new(v)
    rain = bpy.data.materials.new("rain")
    rain.use_nodes = True
    nt = rain.node_tree
    nt.nodes.clear()
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (0.75, 0.85, 1.0, 1)
    em.inputs["Strength"].default_value = 1.2
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = 0.35
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], o.inputs["Surface"])
    obj_from_bmesh("rain", bm, rain)

    def bolt(start, end, seed, width):
        rnd = random.Random(seed)
        pts = [Vector(start)]
        steps = 22
        for i in range(1, steps):
            t = i / steps
            p = Vector(start).lerp(Vector(end), t)
            p.x += rnd.uniform(-1.1, 1.1) * (1 - 0.3 * t)
            p.y += rnd.uniform(-0.6, 0.6)
            pts.append(p)
        pts.append(Vector(end))
        cu = bpy.data.curves.new("bolt", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_depth = width
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        for p, v in zip(sp.points, pts):
            p.co = (v.x, v.y, v.z, 1)
        ob = bpy.data.objects.new("bolt", cu)
        bpy.context.collection.objects.link(ob)
        cu.materials.append(emission((0.8, 0.88, 1.0), 400))
        return pts

    pts = bolt((-5, 22, 26), (-5.5, 20, 0.2), 3, 0.12)
    bolt((-5, 22, 18), (-10, 22, 11), 9, 0.06)
    bolt((-5.5, 21, 10), (-2, 21, 3), 12, 0.04)
    point((-6, 24, 14), 250000, (0.7, 0.8, 1.0), 2.0)
    point((-6, 20, 6), 60000, (0.7, 0.8, 1.0), 1.0)
    camera((3.5, -7, 2.2), (-2, 14, 4.5), 30)


def s_rainforest(args):
    """Rainforest with mist and light shafts."""
    scene = fresh(args)
    nishita_sky(35, 40, 0.5)
    random.seed(11)
    g = noise_color_material(1.5, (0.03, 0.12, 0.03), (0.12, 0.3, 0.06), rough=0.9, name="moss")
    displaced_grid("floor", 70, 120, 1.2, 4.0, g, seed=2)
    bark = mat((0.14, 0.09, 0.05), rough=0.9)
    leaf_a = mat((0.05, 0.28, 0.06), rough=0.7)
    leaf_b = mat((0.12, 0.4, 0.08), rough=0.7)
    fern = mat((0.1, 0.45, 0.1), rough=0.6)
    for i in range(70):
        x = random.uniform(-22, 22)
        y = random.uniform(2, 45)
        if abs(x) < 1.8 and y < 14:
            continue
        h = random.uniform(9, 18)
        t = cyl("trunk", (x, y, h / 2), random.uniform(0.25, 0.5), h, bark, 10)
        t.rotation_euler = (random.uniform(-0.05, 0.05), random.uniform(-0.05, 0.05), 0)
        for k in range(3):
            sphere("canopy", (x + random.uniform(-1.5, 1.5), y + random.uniform(-1.5, 1.5), h - k * 1.4), random.uniform(2.2, 3.4),
                   leaf_a if k % 2 else leaf_b, (1, 1, 0.55), 14)
    for i in range(160):
        x, y = random.uniform(-14, 14), random.uniform(1, 30)
        for k in range(7):
            a = k / 7 * math.tau
            bpy.ops.mesh.primitive_cone_add(radius1=0.12, radius2=0, depth=1.6, vertices=6,
                                            location=(x + math.cos(a) * 0.45, y + math.sin(a) * 0.45, 0.55),
                                            rotation=(math.sin(a) * 0.9, -math.cos(a) * 0.9, 0))
            bpy.context.active_object.data.materials.append(fern)
    sun(6, (math.radians(55), 0, math.radians(35)), (1.0, 0.92, 0.75), 0.03)
    bpy.ops.mesh.primitive_cube_add(location=(0, 22, 8))
    fog = bpy.context.active_object
    fog.scale = (30, 26, 9)
    fog.data.materials.append(volume_material(0.035, (0.9, 0.95, 0.9), 0.4))
    camera((0, -2, 1.7), (0, 20, 3.5), 28)


def s_ocean(args):
    """Ocean waves at sunset."""
    scene = fresh(args)
    nishita_sky(5, 0, 0.55, 2.0)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=400)
    sea = bpy.context.active_object
    sea.name = "ocean"
    sea.data.materials.append(mat((0.0, 0.05, 0.08), rough=0.03, name="water"))
    mod = sea.modifiers.new("ocean", "OCEAN")
    mod.geometry_mode = "GENERATE"
    mod.resolution = 18
    mod.repeat_x = mod.repeat_y = 1
    mod.spatial_size = 200
    mod.wave_scale = 2.4
    mod.choppiness = 1.4
    mod.wind_velocity = 14
    mod.time = 6.0
    mod.use_foam = False
    bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5)
    bpy.data.objects.remove(bpy.context.active_object)
    sun(3, (math.radians(84), 0, math.radians(180)), (1.0, 0.7, 0.45), 0.02)
    camera((0, -30, 5.5), (0, 40, 2.5), 40)


def s_clouds(args):
    """Volumetric cloud banks lit by a low sun."""
    scene = fresh(args)
    nishita_sky(7, 0, 0.6, 0.7)
    random.seed(5)
    m = bpy.data.materials.new("cloud")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.2
    noise.inputs["Detail"].default_value = 10
    noise.inputs["Roughness"].default_value = 0.62
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = 0.42
    ramp.inputs["From Max"].default_value = 0.72
    ramp.inputs["To Max"].default_value = 1.0
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    dens = nt.nodes.new("ShaderNodeMath")
    dens.operation = "MULTIPLY"
    dens.inputs[1].default_value = 1.2
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = (1, 0.97, 0.95, 1)
    vol.inputs["Anisotropy"].default_value = 0.35
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    nt.links.new(tc.outputs["Generated"], grad.inputs["Vector"])
    nt.links.new(ramp.outputs[0], mul.inputs[0])
    nt.links.new(grad.outputs["Fac"], mul.inputs[1])
    mul.inputs[1].default_value = 1
    nt.links.new(mul.outputs[0], dens.inputs[0])
    nt.links.new(dens.outputs[0], vol.inputs["Density"])
    nt.links.new(vol.outputs[0], o.inputs["Volume"])
    for i in range(16):
        bpy.ops.mesh.primitive_cube_add(location=(random.uniform(-90, 90), random.uniform(40, 260), random.uniform(0, 14)))
        c = bpy.context.active_object
        c.scale = (random.uniform(35, 60), random.uniform(25, 40), random.uniform(8, 14))
        c.data.materials.append(m)
    sun(4, (math.radians(83), 0, math.radians(180)), (1.0, 0.75, 0.5), 0.02)
    camera((0, -10, 16), (0, 90, 8), 30)


def s_planet(args):
    """A ringed planet, moon, nebula and stars."""
    scene = fresh(args)
    world((0, 0, 0), 0.0)
    random.seed(8)
    bm = bmesh.new()
    for _ in range(1800):
        v = Vector((random.gauss(0, 1), random.gauss(0, 1), random.gauss(0, 1))).normalized() * random.uniform(120, 160)
        size = random.choice((0.12, 0.12, 0.2, 0.35))
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=size, matrix=__import__("mathutils").Matrix.Translation(v))
    obj_from_bmesh("stars", bm, emission((1, 0.95, 0.9), 14))
    surface = bpy.data.materials.new("planet")
    surface.use_nodes = True
    nt = surface.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.4
    noise.inputs["Detail"].default_value = 12
    noise.inputs["Roughness"].default_value = 0.6
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.42, (0.02, 0.1, 0.35, 1)
    els[1].position, els[1].color = 0.55, (0.1, 0.5, 0.2, 1)
    e = els.new(0.8)
    e.color = (0.9, 0.85, 0.75, 1)
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    nt.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7
    sphere("planet", (0, 30, 0), 9, surface, seg=64)
    atmo = bpy.data.materials.new("atmo")
    atmo.use_nodes = True
    nt = atmo.node_tree
    nt.nodes.clear()
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.78
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (0.3, 0.6, 1.0, 1)
    em.inputs["Strength"].default_value = 2.0
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    fres = nt.nodes.new("ShaderNodeFresnel")
    fres.inputs["IOR"].default_value = 1.25
    nt.links.new(fres.outputs[0], mix.inputs["Fac"])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], o.inputs["Surface"])
    sphere("atmosphere", (0, 30, 0), 9.35, atmo, seg=64)
    ring = bpy.data.materials.new("ring")
    ring.use_nodes = True
    nt = ring.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeVectorMath")
    sep.operation = "LENGTH"
    rr = nt.nodes.new("ShaderNodeMapRange")
    rr.inputs["From Min"].default_value = 11.5
    rr.inputs["From Max"].default_value = 17
    bands = nt.nodes.new("ShaderNodeValToRGB")
    cr = bands.color_ramp
    stops = [(0.0, 0.0), (0.06, 0.75), (0.18, 0.25), (0.3, 0.85), (0.5, 0.9), (0.6, 0.12), (0.72, 0.65), (1.0, 0.0)]
    cr.elements[0].position, cr.elements[0].color = stops[0][0], (stops[0][1],) * 3 + (1,)
    cr.elements[1].position, cr.elements[1].color = stops[-1][0], (stops[-1][1],) * 3 + (1,)
    for pos, val in stops[1:-1]:
        el = cr.elements.new(pos)
        el.color = (val, val, val, 1)
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    nt.links.new(sep.outputs["Value"], rr.inputs["Value"])
    nt.links.new(rr.outputs[0], bands.inputs["Fac"])
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.9, 0.78, 0.6, 1)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Emission Color"].default_value = (0.9, 0.78, 0.6, 1)
    b.inputs["Emission Strength"].default_value = 0.35
    nt.links.new(bands.outputs["Color"], b.inputs["Alpha"])
    bpy.ops.mesh.primitive_circle_add(vertices=128, radius=17, fill_type="NGON", location=(0, 30, 0), rotation=(math.radians(76), 0, math.radians(-14)))
    rg = bpy.context.active_object
    rg.data.materials.append(ring)
    bm = bmesh.new()
    bm.from_mesh(rg.data)
    inner = [v for v in bm.verts]
    bm.free()
    # carve the hole with a boolean
    bpy.ops.mesh.primitive_cylinder_add(radius=11.5, depth=2, vertices=128, location=(0, 30, 0), rotation=(math.radians(76), 0, math.radians(-14)))
    hole = bpy.context.active_object
    hole.hide_render = True
    bm_mod = rg.modifiers.new("hole", "BOOLEAN")
    bm_mod.operation, bm_mod.object, bm_mod.solver = "DIFFERENCE", hole, "EXACT"
    moon = noise_color_material(5, (0.25, 0.24, 0.23), (0.7, 0.68, 0.64), rough=0.95, name="moon")
    sphere("moon", (-14, 18, 5), 1.7, moon, seg=48)
    bpy.ops.mesh.primitive_cube_add(location=(10, 60, -6))
    neb = bpy.context.active_object
    neb.scale = (70, 30, 30)
    nm = bpy.data.materials.new("nebula")
    nm.use_nodes = True
    nt = nm.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.05
    noise.inputs["Detail"].default_value = 8
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.9, 0.1, 0.5, 1)
    ramp.color_ramp.elements[1].color = (0.1, 0.3, 1.0, 1)
    thr = nt.nodes.new("ShaderNodeMapRange")
    thr.inputs["From Min"].default_value = 0.45
    thr.inputs["From Max"].default_value = 0.75
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Density"].default_value = 0.0
    vol.inputs["Emission Strength"].default_value = 0.5
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = 0.004
    es = nt.nodes.new("ShaderNodeMath")
    es.operation = "MULTIPLY"
    es.inputs[1].default_value = 0.012
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(noise.outputs["Fac"], thr.inputs["Value"])
    nt.links.new(thr.outputs[0], mul.inputs[0])
    nt.links.new(mul.outputs[0], vol.inputs["Density"])
    nt.links.new(ramp.outputs["Color"], vol.inputs["Emission Color"])
    nt.links.new(thr.outputs[0], es.inputs[0])
    nt.links.new(es.outputs[0], vol.inputs["Emission Strength"])
    nt.links.new(vol.outputs[0], o.inputs["Volume"])
    neb.data.materials.append(nm)
    sun(4, (math.radians(70), 0, math.radians(120)), (1.0, 0.95, 0.85), 0.01)
    camera((0, -38, 7), (-2, 30, 0), 40)


def s_scifi(args):
    """Off-world base: domes, tubes, solar fields, huge planet in the sky."""
    scene = fresh(args)
    world((0.01, 0.01, 0.02), 0.5)
    random.seed(21)
    rock = noise_color_material(0.25, (0.28, 0.1, 0.06), (0.55, 0.25, 0.14), rough=0.95, name="rock")
    displaced_grid("terrain", 200, 160, 3.5, 22.0, rock)
    hull = mat((0.85, 0.87, 0.9), rough=0.35, metal=0.4)
    dark = mat((0.02, 0.05, 0.22), rough=0.15, metal=0.3)
    glass = mat((0.6, 0.85, 1.0), rough=0.02, name="glass")
    glass.node_tree.nodes["Principled BSDF"].inputs["Transmission Weight"].default_value = 0.9
    glow = emission((0.4, 0.8, 1.0), 1.6)
    warm = emission((1.0, 0.7, 0.35), 3.0)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=6, location=(0, 0, 0), segments=48, ring_count=24)
    dome = bpy.context.active_object
    dome.scale = (1, 1, 0.75)
    dome.data.materials.append(glass)
    bpy.ops.object.shade_smooth()
    sphere("core", (0, 0, 1.4), 2.4, warm)
    for i, (x, y, r) in enumerate(((-13, 6, 3.2), (12, 5, 3.8), (4, 16, 2.6))):
        sphere("dome%d" % i, (x, y, 0), r, hull, (1, 1, 0.8), 32)
        sphere("domeglow%d" % i, (x, y, 0.2), r * 0.7, glow, (1, 1, 0.8), 16)
        a = Vector((x, y, 0.8))
        b = Vector((0, 0, 0.8))
        mid = (a + b) / 2
        length = (a - b).length
        t = cyl("tube%d" % i, mid, 0.55, length, hull, 16)
        t.rotation_euler = (b - a).to_track_quat("Z", "Y").to_euler()
    for i in range(3):
        h = 14 + i * 4
        x = -22 + i * 5
        cyl("tower%d" % i, (x, 14, h / 2), 0.9, h, hull, 12)
        sphere("beacon%d" % i, (x, 14, h + 0.4), 0.5, warm)
        cyl("band%d" % i, (x, 14, h * 0.6), 0.95, 0.5, glow, 12)
    for gx in range(6):
        for gy in range(3):
            bm = bmesh.new()
            bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.8)
            ob = obj_from_bmesh("panel", bm, dark)
            ob.location = (6 + gx * 4.2, -10 - gy * 4.2, 1.0)
            ob.rotation_euler = (math.radians(-35), 0, math.radians(15))
    sphere("planet", (-60, 150, 60), 50, noise_color_material(1.6, (0.05, 0.12, 0.35), (0.6, 0.45, 0.3), name="gas"), seg=64)
    sun(3.5, (math.radians(72), 0, math.radians(-50)), (1.0, 0.88, 0.7), 0.01)
    camera((18, -34, 6.5), (-2, 4, 5), 30)


def s_city(args):
    """Night city of procedural towers with lit windows and street haze."""
    scene = fresh(args)
    world((0.01, 0.015, 0.045), 1.0)
    random.seed(33)
    street = mat((0.02, 0.02, 0.03), rough=0.15)
    plane("street", 220, street)
    wm = bpy.data.materials.new("tower")
    wm.use_nodes = True
    nt = wm.node_tree
    tc = nt.nodes.new("ShaderNodeNewGeometry")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.7, 0.7, 0.55)
    chk = nt.nodes.new("ShaderNodeTexChecker")
    chk.inputs["Scale"].default_value = 1.0
    chk.inputs["Color1"].default_value = (1, 1, 1, 1)
    chk.inputs["Color2"].default_value = (0, 0, 0, 1)
    fl = nt.nodes.new("ShaderNodeVectorMath")
    fl.operation = "FLOOR"
    nz = nt.nodes.new("ShaderNodeTexWhiteNoise")
    nz.noise_dimensions = "3D"
    thr = nt.nodes.new("ShaderNodeMapRange")
    thr.inputs["From Min"].default_value = 0.45
    thr.inputs["From Max"].default_value = 0.46
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.04, 0.045, 0.07, 1)
    b.inputs["Roughness"].default_value = 0.3
    b.inputs["Metallic"].default_value = 0.4
    b.inputs["Emission Color"].default_value = (1.0, 0.75, 0.4, 1)
    nt.links.new(tc.outputs["Position"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], chk.inputs["Vector"])
    nt.links.new(mp.outputs[0], fl.inputs[0])
    nt.links.new(fl.outputs[0], nz.inputs["Vector"])
    nt.links.new(nz.outputs["Value"], thr.inputs["Value"])
    nt.links.new(chk.outputs["Fac"], mul.inputs[0])
    nt.links.new(thr.outputs[0], mul.inputs[1])
    em_s = nt.nodes.new("ShaderNodeMath")
    em_s.operation = "MULTIPLY"
    em_s.inputs[1].default_value = 1.8
    nt.links.new(mul.outputs[0], em_s.inputs[0])
    nt.links.new(em_s.outputs[0], b.inputs["Emission Strength"])
    for gx in range(-7, 8):
        for gy in range(0, 22):
            if gx in (-1, 0, 1) or gy % 4 == 0:
                continue
            x, y = gx * 9 + random.uniform(-1, 1), gy * 9 + random.uniform(-1, 1)
            h = random.choice((8, 12, 16, 24, 34, 46)) * random.uniform(0.7, 1.3) * (1.4 if abs(gx) < 4 else 0.8)
            w, d = random.uniform(5, 7.5), random.uniform(5, 7.5)
            bpy.ops.mesh.primitive_cube_add(location=(x, y, h / 2))
            t = bpy.context.active_object
            t.scale = (w / 2, d / 2, h / 2)
            t.data.materials.append(wm)
    for i in range(30):
        y = 4 + i * 5.5
        for sx in (-6, 6):
            cyl("pole", (sx, y, 2.6), 0.07, 5.2, mat((0.1, 0.1, 0.1)), 6)
            sphere("lamp", (sx, y, 5.3), 0.28, emission((1.0, 0.65, 0.3), 25), seg=8)
    bpy.ops.mesh.primitive_cube_add(location=(0, 70, 20))
    haze = bpy.context.active_object
    haze.scale = (80, 80, 22)
    haze.data.materials.append(volume_material(0.012, (0.55, 0.65, 0.9), 0.3))
    camera((0, -2, 3.2), (0, 60, 18), 28)


def s_psychedelic(args):
    """Rainbow ring tunnel on a mirror floor."""
    scene = fresh(args)
    world((0.0, 0.0, 0.01), 1.0)
    mirror = mat((0.01, 0.01, 0.02), rough=0.03, metal=0.9)
    plane("mirror", 80, mirror, (0, 20, -1.4))
    n = 46
    for i in range(n):
        hue = (i / n * 1.7) % 1.0
        r, g, b = colorsys.hsv_to_rgb(hue, 1.0, 1.0)
        z = i * 1.25
        bpy.ops.mesh.primitive_torus_add(major_radius=2.6 + 0.8 * math.sin(i * 0.35), minor_radius=0.11,
                                         major_segments=64, minor_segments=10,
                                         location=(math.sin(i * 0.22) * 1.2, z, math.cos(i * 0.22) * 0.5),
                                         rotation=(math.pi / 2, 0, i * 0.16))
        t = bpy.context.active_object
        t.data.materials.append(emission((r, g, b), 2.2))
        bpy.ops.object.shade_smooth()
    for i in range(14):
        hue = i / 14
        r, g, b = colorsys.hsv_to_rgb(hue, 0.7, 1.0)
        a = i / 14 * math.tau
        sphere("orb", (math.cos(a) * 1.4, 26 + i * 1.4, math.sin(a) * 1.4), 0.32, emission((r, g, b), 5), seg=16)
    camera((0, -3.5, 0.2), (0.3, 30, 0.3), 24)


def s_cloth(args):
    """Cloth simulation: a tablecloth dropped over a table and a ball."""
    scene = fresh(args)
    nishita_sky(35, 180, 0.25)
    plane("floor", 400, mat((0.2, 0.15, 0.1), rough=0.7))
    box("table_top", (0, 0, 1.0), (2.4, 1.6, 0.12), mat((0.3, 0.18, 0.1), rough=0.5), 0.02)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box("leg", (sx * 1.05, sy * 0.65, 0.5), (0.12, 0.12, 1.0), mat((0.3, 0.18, 0.1)))
    sphere("ball", (0.2, 0.0, 1.45), 0.38, mat((0.9, 0.7, 0.15), rough=0.25, metal=0.8))
    bpy.ops.mesh.primitive_plane_add(size=3.4, location=(0, 0, 2.3))
    cl = bpy.context.active_object
    cl.name = "cloth"
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.subdivide(number_cuts=60)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()
    m = bpy.data.materials.new("cloth")
    m.use_nodes = True
    nt = m.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    ch = nt.nodes.new("ShaderNodeTexChecker")
    ch.inputs["Scale"].default_value = 14
    ch.inputs["Color1"].default_value = (0.8, 0.05, 0.05, 1)
    ch.inputs["Color2"].default_value = (0.95, 0.9, 0.85, 1)
    nt.links.new(tc.outputs["UV"], ch.inputs["Vector"])
    b = nt.nodes["Principled BSDF"]
    nt.links.new(ch.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.9
    b.inputs["Sheen Weight"].default_value = 0.8
    cl.data.materials.append(m)
    cl.modifiers.new("cloth", "CLOTH")
    cl.modifiers["cloth"].settings.quality = 8
    for ob in bpy.data.objects:
        if ob.name.startswith(("table", "leg", "ball", "floor")):
            bpy.context.view_layer.objects.active = ob
            ob.select_set(True)
            bpy.ops.object.modifier_add(type="COLLISION")
            ob.select_set(False)
    scene.frame_start, scene.frame_end = 1, 70
    for f in range(1, 71):
        scene.frame_set(f)
    camera((3.2, -4.2, 2.2), (0, 0, 1.1), 40)


def s_caravan_park(args, view="road"):
    """First draft of the Sunny Banks caravan park at golden hour (blockout, not final art)."""
    scene = fresh(args)
    nishita_sky(14, 180, 0.5, 1.2)
    random.seed(2)
    grass = noise_color_material(0.8, (0.18, 0.4, 0.1), (0.35, 0.55, 0.15), rough=0.95, name="grass")
    displaced_grid("ground", 300, 100, 1.0, 12.0, grass)
    road = mat((0.18, 0.18, 0.2), rough=0.9)
    box("road", (0, 10, 0.02), (5, 80, 0.06), road)
    cream = mat((0.93, 0.9, 0.8), rough=0.5)
    stripes = [(0.75, 0.2, 0.15), (0.15, 0.4, 0.7), (0.9, 0.65, 0.1), (0.2, 0.55, 0.35)]
    glass = mat((0.25, 0.4, 0.5), rough=0.05, metal=0.2, name="g")
    wheel = mat((0.05, 0.05, 0.05))

    def caravan(x, y, rot, i):
        c = Vector((x, y, 0))
        body = box("cv", (x, y, 1.35), (2.4, 5.4, 2.1), cream, 0.35)
        body.rotation_euler = (0, 0, rot)
        s = box("cs", (x, y, 1.2), (2.46, 5.46, 0.4), mat(stripes[i % 4]), 0.1)
        s.rotation_euler = (0, 0, rot)
        for k in (-1, 1):
            w = box("cw", (x + math.cos(rot) * 1.22 * k, y + math.sin(rot) * 1.22 * k, 1.7), (0.06, 1.2, 0.7), glass)
            w.rotation_euler = (0, 0, rot)
            w2 = box("cw2", (x + math.cos(rot) * 1.22 * k, y + math.sin(rot) * 1.22 * k - 1.4 * math.cos(rot), 1.7), (0.06, 1.0, 0.7), glass)
            w2.rotation_euler = (0, 0, rot)
        for k in (-1, 1):
            wl = cyl("wh", (x + math.cos(rot) * 1.25 * k, y + math.sin(rot) * 1.25 * k, 0.4), 0.42, 0.25, wheel, 16,
                     (0, math.pi / 2, rot))
        awn = box("aw", (x - math.sin(rot) * 3.4, y + math.cos(rot) * 3.4, 2.15), (2.8, 1.8, 0.08), mat(stripes[(i + 1) % 4]))
        awn.rotation_euler = (0, 0, rot)

    i = 0
    for y in (14, 24, 34, 44, 56):
        for x, rot in ((-9, 0.08), (9, -0.05), (-22, 0.02), (22, 0.1)):
            caravan(x + random.uniform(-0.8, 0.8), y + random.uniform(-1, 1), rot + random.uniform(-0.12, 0.12), i)
            i += 1
    shop = mat((0.82, 0.45, 0.3), rough=0.6)
    box("shop", (-14, 8, 2.2), (10, 6, 4.4), shop, 0.1)
    box("shop_roof", (-14, 8, 4.6), (11, 7, 0.5), mat((0.25, 0.15, 0.12)), 0.1)
    box("shop_door", (-14, 4.95, 1.3), (1.6, 0.1, 2.5), mat((0.15, 0.3, 0.45)))
    box("shop_win", (-17, 4.95, 1.9), (3.0, 0.1, 1.6), glass)
    box("shop_awn", (-14, 3.9, 3.2), (9, 2.4, 0.1), mat((0.9, 0.7, 0.15)))
    bpy.ops.object.text_add(location=(-14, 4.8, 4.0), rotation=(math.pi / 2, 0, 0))
    t = bpy.context.active_object
    t.data.body = "SUNNY BANKS"
    t.data.align_x = "CENTER"
    t.data.size = 0.7
    t.data.extrude = 0.04
    t.data.materials.append(mat((1.0, 0.9, 0.5), rough=0.4, emit=(1.0, 0.8, 0.3), emit_strength=1.5))
    box("sign_post_a", (7.5, -4, 1.4), (0.2, 0.2, 2.8), mat((0.3, 0.2, 0.12)))
    box("sign_post_b", (12.5, -4, 1.4), (0.2, 0.2, 2.8), mat((0.3, 0.2, 0.12)))
    box("sign", (10, -4, 2.6), (6, 0.2, 1.4), mat((0.12, 0.35, 0.2)), 0.05)
    bpy.ops.object.text_add(location=(10, -4.15, 2.45), rotation=(math.pi / 2, 0, 0))
    t = bpy.context.active_object
    t.data.body = "CARAVAN PARK"
    t.data.align_x = "CENTER"
    t.data.size = 0.55
    t.data.extrude = 0.03
    t.data.materials.append(mat((0.97, 0.95, 0.85)))
    trunk = mat((0.2, 0.12, 0.07))
    leaf = [mat((0.15, 0.42, 0.12)), mat((0.2, 0.5, 0.15)), mat((0.1, 0.35, 0.1))]
    for k in range(42):
        x, y = random.choice((-1, 1)) * random.uniform(14, 60), random.uniform(0, 90)
        if abs(x) < 26 and 10 < y < 66:
            continue
        h = random.uniform(5, 9)
        cyl("trunk", (x, y, h / 2), 0.28, h, trunk, 8)
        sphere("leaf", (x, y, h + 1.2), random.uniform(2.3, 3.4), random.choice(leaf), (1, 1, 1.15), 12)
    for y in range(-2, 80, 9):
        for sx in (-3.4, 3.4):
            cyl("lamp", (sx, y, 2.2), 0.06, 4.4, mat((0.1, 0.1, 0.1)), 6)
            sphere("lampb", (sx, y, 4.5), 0.25, emission((1.0, 0.85, 0.55), 10), seg=8)
    sun(3.2, (math.radians(76), 0, math.radians(-25)), (1.0, 0.75, 0.5), 0.03)
    scene.view_settings.exposure = -0.6
    if view == "shop":
        camera((-3, -6, 2.3), (-14, 6, 2.6), 32)
    else:
        camera((2, -2, 3.6), (-2, 26, 2.8), 30)


SCENES = [
    ("storm", s_storm),
    ("rainforest", s_rainforest),
    ("ocean", s_ocean),
    ("clouds", s_clouds),
    ("planet", s_planet),
    ("scifi_base", s_scifi),
    ("city_night", s_city),
    ("psychedelic", s_psychedelic),
    ("cloth_physics", s_cloth),
    ("caravan_park", s_caravan_park),
    ("caravan_shop", lambda a: s_caravan_park(a, "shop")),
]


def main():
    args = parse_args()
    if args.list:
        for name, fn in SCENES:
            print("%-14s %s" % (name, (fn.__doc__ or s_caravan_park.__doc__ or "").strip()))
        return
    only = {s for s in args.only.split(",") if s}
    report, paths = [], []
    for name, fn in SCENES:
        if only and name not in only:
            continue
        path = os.path.join(args.out, name + ".png")
        t0 = time.time()
        try:
            fn(args)
            scene = bpy.context.scene
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            status = "PASS" if os.path.exists(path) else "FAIL"
            if status == "PASS":
                paths.append(path)
        except Exception as exc:
            traceback.print_exc()
            status = "FAIL %s: %s" % (type(exc).__name__, str(exc).splitlines()[0][:120] if str(exc) else "")
        line = "%-14s %-5s %6.1fs %s" % (name, status.split()[0], time.time() - t0, status if status != "PASS" else "")
        print("RESULT", line)
        report.append(line)
    with open(os.path.join(args.out, "showcase_report.txt"), "w") as f:
        f.write("\n".join(report) + "\n")
    print("DONE", args.out)


if __name__ == "__main__":
    main()
