"""Characters talking in one scene: Dazza, Nan and Shazza take turns.

Each speaker has their own mouth sheet (made by make_dazza_mouths.py,
make_nan_mouths.py and make_shazza_mouths.py) and their own Rhubarb cues file. The camera pushes in on
whoever is speaking. The audio of all lines is mixed into one track with
ffmpeg, each line starting at its own time.

Run:
    blender -b -P tools/blender/dialogue_scene.py -- --out renders/dialogue

The default lines are two short test lines made with the user's own ElevenLabs
voices for Dazza and Nan (dazza_tap.wav, nan_tap.wav, with the text beside
them in .txt files). They are not from a script. To use other lines, pass a
lines file:
    --lines my_lines.json
a list like
    [{"who": "dazza", "audio": "a.wav", "cues": "a_cues.json", "start": 0.3},
     {"who": "nan",   "audio": "b.wav", "cues": "b_cues.json"}]
or an object that also sets the location picture and where everyone stands:
    {"plate": "office-storefront.jpg",
     "cast": {"shazza": [-1.0, -2.0], "dazza": [0.5, -1.6], "nan": [2.3, -1.4]},
     "lines": [ ...the list above... ]}
Paths are relative to the lines file (the plate is looked for in assets/sunnybanks
too). "start" is optional: a line without it starts 0.4 s after the previous
one ends. Speakers: dazza, nan, shazza. Example: assets/sunnybanks/ep01_scene1/.
Options: --lines, --out, --width, --height, --samples, --still N.
Writes frames, dialogue.mp4 (needs ffmpeg) and dialogue_sheet.png.
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
GAP = 0.4
LEAD_IN = 0.5
TAIL = 0.8

MOUTHS = {
    "dazza": ("dazza-nomouth.png", "dazza-mouths.png", "dazza-mouths.json"),
    "nan": ("nan-nomouth.png", "nan-mouths.png", "nan-mouths.json"),
    "shazza": ("shazza-nomouth.png", "shazza-mouths.png", "shazza-mouths.json"),
}

# The wide shot is first and last. The close shot for each speaker is worked
# out from where they stand and how tall they are (see close_camera).
PUSH = 0.25


def wide_camera():
    xs = [x for _n, _f, _h, x, _y in cs.CAST]
    return (sum(xs) / len(xs), -7.2, 1.25)


def close_camera(who):
    """Camera spot for a close shot of a speaker: in front of them, a bit
    toward the middle of the group, further back for taller characters."""
    people = [(n, h, x, y) for n, _f, h, x, y in cs.CAST]
    cx = sum(x for _n, _h, x, _y in people) / len(people)
    _n, h, x, y = next(p for p in people if p[0] == who)
    return (0.7 * x + 0.3 * cx, y - (1.5 * h + 0.4), 0.7 * h)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="renders/dialogue")
    p.add_argument("--lines", default="")
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--still", type=int, default=0)
    args = p.parse_args(argv)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    return args


def load_scene(path):
    """Return (plate path, cast override, lines). Each line is a dict: who,
    audio (absolute), cues (list), start, end."""
    plate, cast = "park-site-4.jpg", None
    if path:
        base = os.path.dirname(os.path.abspath(path))
        raw = json.load(open(path))
        if isinstance(raw, dict):
            plate = raw.get("plate", plate)
            cast = raw.get("cast")
            raw = raw["lines"]
    else:
        base = cs.ASSETS
        raw = [
            {"who": "dazza", "audio": "dazza_tap.wav", "cues": "dazza_tap_cues.json", "start": LEAD_IN},
            {"who": "nan", "audio": "nan_tap.wav", "cues": "nan_tap_cues.json"},
        ]
    lines, cursor = [], LEAD_IN
    for item in raw:
        cues = json.load(open(os.path.join(base, item["cues"])))["mouthCues"]
        start = float(item["start"]) if "start" in item else cursor
        end = start + max(c["end"] for c in cues)
        lines.append({"who": item["who"], "audio": os.path.join(base, item["audio"]),
                      "cues": cues, "start": start, "end": end})
        cursor = end + GAP
    plate_path = plate if os.path.isabs(plate) else os.path.join(cs.ASSETS, plate)
    if not os.path.exists(plate_path):
        plate_path = os.path.join(base, plate)
    return plate_path, cast, lines


def shape_at(lines, who, t):
    for line in lines:
        if line["who"] != who:
            continue
        local = t - line["start"]
        for c in line["cues"]:
            if c["start"] <= local < c["end"]:
                return c["value"]
    return "X"


def add_mouth(who, frames, lines):
    nomouth, sheet, meta_file = MOUTHS[who]
    meta = json.load(open(os.path.join(cs.ASSETS, meta_file)))
    pic_w, pic_h = meta["picture_size"]
    left, top, right, bottom = meta["box"]
    body = bpy.data.objects[who]
    height = next(h for n, _f, h, _x, _y in cs.CAST if n == who)
    s = height / pic_h

    body.data.materials.clear()
    mat, _ = cs.picture_material(who + "_nomouth", os.path.join(cs.ASSETS, nomouth), alpha=True)
    body.data.materials.append(mat)

    mouth_mat, _ = cs.picture_material(who + "_mouths", os.path.join(cs.ASSETS, sheet), alpha=True)
    tree = mouth_mat.node_tree
    tex = next(n for n in tree.nodes if n.type == "TEX_IMAGE")
    tex.extension = "CLIP"
    coord = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1 / meta["columns"], 1 / meta["rows"], 1)
    tree.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])

    w, h = (right - left) * s, (bottom - top) * s
    card = cs.card(who + "_mouth", mouth_mat, w, h, 0, 0, 0)
    card.parent = body
    card.location = (((left + right) / 2 - pic_w / 2) * s, -0.004, (pic_h - bottom) * s)

    layout = meta["layout"]
    last = None
    for f in range(1, frames + 1):
        shape = shape_at(lines, who, (f - 1) / FPS)
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


def key_camera(lines, frames):
    """Wide at the start, then a close shot on each speaker for their line
    (a small push-in while they talk), then back out to wide. Lines that
    follow each other from the same speaker share one close shot."""
    cam = bpy.data.objects["cam"]
    cam.animation_data_clear()
    cs.key(cam, 1, location=wide_camera())
    segments = []
    for line in lines:
        if segments and segments[-1]["who"] == line["who"]:
            segments[-1]["end"] = line["end"]
        else:
            segments.append({"who": line["who"], "start": line["start"], "end": line["end"]})
    last = 1
    for seg in segments:
        f0 = max(last + 1, int(seg["start"] * FPS) + 1)
        f1 = max(f0 + 1, int(seg["end"] * FPS) + 1)
        x, y, z = close_camera(seg["who"])
        cs.key(cam, f0, location=(x, y, z))
        cs.key(cam, f1, location=(x * 0.9, y + PUSH, z))
        last = f1
    cs.key(cam, max(frames, last + 1), location=wide_camera())
    cs.smooth(cam)


def mix_audio(lines, path):
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for line in lines:
        cmd += ["-i", line["audio"]]
    parts = []
    for i, line in enumerate(lines):
        ms = int(line["start"] * 1000)
        parts.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(lines)))
    parts.append(f"{mix}amix=inputs={len(lines)}:duration=longest:normalize=0[out]")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[out]", path]
    subprocess.run(cmd, check=True)


def main():
    args = parse_args()
    plate, cast, lines = load_scene(args.lines)
    args.plate = plate
    if cast:
        cs.CAST[:] = [(n, f, h, *cast.get(n, (x, y))) for n, f, h, x, y in cs.CAST]
    duration = max(line["end"] for line in lines) + TAIL
    frames = int(math.ceil(duration * FPS))
    cs_args = argparse.Namespace(**vars(args), frames=frames)
    scene = cs.build(cs_args)
    for who in sorted({line["who"] for line in lines}):
        add_mouth(who, frames, lines)
    key_camera(lines, frames)

    todo = [args.still] if args.still else list(range(1, frames + 1))
    paths = []
    for f in todo:
        scene.frame_set(f)
        path = os.path.join(args.out, f"frame_{f:03d}.png")
        sl.render_still(path)
        paths.append(path)
    if len(paths) > 3:
        picks = []
        for line in lines:
            mid = int((line["start"] + line["end"]) / 2 * FPS) + 1
            picks.append(paths[min(mid, len(paths)) - 1])
        picks = (picks + [paths[0], paths[-1]])[:4]
        sl.tile_sheet([picks], os.path.join(args.out, "dialogue_sheet.png"))
        if shutil.which("ffmpeg"):
            audio = os.path.join(args.out, "dialogue_audio.wav")
            mix_audio(lines, audio)
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i",
                 os.path.join(args.out, "frame_%03d.png"), "-i", audio,
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                 os.path.join(args.out, "dialogue.mp4")], check=False)
        else:
            print("ffmpeg not found; frames saved, add the audio in any video editor")
    print("done", args.out)


if __name__ == "__main__":
    main()
