"""Dazza talks: the cut-out scene with his mouth swapped on cue.

Mouth shapes come from Rhubarb Lip Sync (a cues .json: time ranges tagged
A to H and X). Dazza's drawn mouths are in assets/sunnybanks/dazza-mouths.png
(made by make_dazza_mouths.py). Nan and Shazza just stand and breathe.

Run:
    blender -b -P tools/blender/talk_scene.py -- --out renders/talk

Defaults use assets/sunnybanks/dazza_pants.wav and dazza_pants_cues.json
(Dazza, EP01: "These are pants, Shaz. They cover the essentials.").
Writes frames, talk.mp4 with the audio (needs ffmpeg), and talk_sheet.png.
Options: --audio, --cues, --out, --width, --height, --samples, --still N.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cutout_scene as cs  # noqa: E402
import style_lab as sl  # noqa: E402

FPS = 24


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/talk")
    p.add_argument("--audio", default=os.path.join(cs.ASSETS, "dazza_pants.wav"))
    p.add_argument("--cues", default=os.path.join(cs.ASSETS, "dazza_pants_cues.json"))
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--still", type=int, default=0)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    args.plate = os.path.join(cs.ASSETS, "park-site-4.jpg")
    return args


def shape_at(cues, t):
    for c in cues:
        if c["start"] <= t < c["end"]:
            return c["value"]
    return "X"


def add_mouth(frames, cues):
    meta = json.load(open(os.path.join(cs.ASSETS, "dazza-mouths.json")))
    pic_w, pic_h = meta["picture_size"]
    left, top, right, bottom = meta["box"]
    body = bpy.data.objects["dazza"]
    height = CAST_HEIGHT
    s = height / pic_h

    body.data.materials.clear()
    mat, _ = cs.picture_material("dazza_nomouth", os.path.join(cs.ASSETS, "dazza-nomouth.png"), alpha=True)
    body.data.materials.append(mat)

    mouth_mat, _ = cs.picture_material("dazza_mouths", os.path.join(cs.ASSETS, "dazza-mouths.png"), alpha=True)
    tree = mouth_mat.node_tree
    tex = next(n for n in tree.nodes if n.type == "TEX_IMAGE")
    tex.extension = "CLIP"
    coord = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1 / meta["columns"], 1 / meta["rows"], 1)
    tree.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])

    w, h = (right - left) * s, (bottom - top) * s
    card = cs.card("dazza_mouth", mouth_mat, w, h, 0, 0, 0)
    card.parent = body
    card.location = (((left + right) / 2 - pic_w / 2) * s, -0.004, (pic_h - bottom) * s)

    layout = meta["layout"]
    last = None
    for f in range(1, frames + 1):
        shape = shape_at(cues, (f - 1) / FPS)
        if shape == last:
            continue
        last = shape
        i = layout.index(shape)
        col, row = i % meta["columns"], i // meta["columns"]
        mapping.inputs["Location"].default_value = (
            col / meta["columns"], (meta["rows"] - 1 - row) / meta["rows"], 0)
        mapping.inputs["Location"].keyframe_insert("default_value", frame=f)
    for fc in cs.sl_fcurves(tree.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = "CONSTANT"


CAST_HEIGHT = next(h for n, _f, h, _x, _y in cs.CAST if n == "dazza")


def main():
    args = parse_args()
    cues = json.load(open(args.cues))["mouthCues"]
    duration = max(c["end"] for c in cues)
    frames = int(math.ceil(duration * FPS)) + 6
    cs_args = argparse.Namespace(**vars(args), frames=frames)
    scene = cs.build(cs_args)
    add_mouth(frames, cues)
    cam = bpy.data.objects["cam"]
    cam.animation_data_clear()
    cs.key(cam, 1, location=(-0.6, -5.0, 1.35))
    cs.key(cam, frames, location=(-0.85, -3.9, 1.45))
    cs.smooth(cam)

    todo = [args.still] if args.still else list(range(1, frames + 1))
    paths = []
    for f in todo:
        scene.frame_set(f)
        path = os.path.join(args.out, f"frame_{f:03d}.png")
        sl.render_still(path)
        paths.append(path)
    if len(paths) > 3:
        picks = [paths[int(i * (len(paths) - 1) / 3)] for i in range(4)]
        sl.tile_sheet([picks], os.path.join(args.out, "talk_sheet.png"))
        if shutil.which("ffmpeg"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i",
                 os.path.join(args.out, "frame_%03d.png"), "-i", args.audio,
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                 os.path.join(args.out, "talk.mp4")], check=False)
        else:
            print("ffmpeg not found; frames saved, add the audio in any video editor")
    print("done", args.out)


main()
