# Lessons learned (running log)

Newest first inside each section. Use the status words from the
[README](README.md): Confirmed, Diagnosed, Suspected, From others.

## How to add a lesson

Copy this block to the top of the Lessons section:

```
### YYYY-MM-DD  Short title
- Area: script | camera | keying | LTX | audio | assets | staging | Blender | other
- Status: Confirmed | Diagnosed | Suspected | From others
- What happened:
- Why (only if known):
- What to do next time:
- Evidence: (script text, clip name, PR, URL)
```

## Lessons

### 2026-10-20  What makes a 3D room read as a 2D cartoon (from two reference sets)
- Area: Blender, style
- Status: Confirmed for our test (compared our box house with the cartoon house render); the list of qualities is from looking at Simpsons living room and Rick and Morty house search thumbnails, so it is a reading of small images
- What we saw in the references: bold limited colours that contrast (wall, floor, furniture each different); dark outline around everything; rounded furniture; painted surface detail (floor planks, wallpaper stripes, rug rings, picture frames, curtains); trim around doors, windows and the floor; almost no cast shadows.
- What worked: flat emission colours with Freestyle outlines in Cycles, painted patterns built from simple maths nodes using world position, bevelled furniture, baseboards and door frames. Adding detail changed the picture far more than changing the lighting.
- What to do next time: build detail and trim first, then judge lighting. Keep colours flat so the palette is exact.
- Evidence: `tools/blender/cartoon_house.py`, `docs/reference/images/cartoon-house-v1-sheet.png`.

### 2026-10-20  Outlines carry the cartoon look in Blender renders
- Area: Blender
- Status: Confirmed on the assistant's machine (looked at a four-style comparison sheet)
- What happened: flat colour with Workbench's built-in outline looked like cardboard. Freestyle outlines (thick dark lines) made the same scene read as a cartoon right away. Workbench studio lighting looked dark and muddy. A Cycles render with a warm sun gave hard shadows and depth, but was noisy until denoising was turned on.
- What to do next time: start from outlines, then add warm light. In scripts, a Freestyle line style may need to be created with `bpy.data.linestyles.new`. Freestyle slowed Workbench renders to about 10 s a frame.
- Evidence: `tools/blender/style_lab.py`.

### 2026-10-20  Blender relative output paths landed in `C:\renders` on Windows
- Area: Blender
- Status: Confirmed (terminal output showed `Saved: 'C:\renders\smoke_room.png'` after `--out renders\smoke_room.png`)
- What happened: with no .blend file, Blender resolved a relative path against the drive root. The assistant had only tested with full paths on Linux, so it was missed.
- Fix status: confirmed on Windows (user's folder screenshot shows frames in `engine\renders\house`).
- What to do next time: scripts turn `--out` into a full path with `os.path.abspath` before rendering. Test on the user's OS with a relative path. Delete the stray `C:\renders` folder.
- Evidence: `tools/blender/smoke_room.py`, `tools/blender/house_flythrough.py`.

### 2026-10-20  PowerShell needs `&` to run a quoted program path
- Area: other
- Status: Confirmed (PowerShell parser error when `&` was missing)
- What to do next time: give Windows commands as `& "C:\path\program.exe" args` for PowerShell.

### 2026-10-20  Blender default colour look washes out flat colours
- Area: Blender
- Status: Confirmed (compared two renders of the same scene)
- What happened: a flat-colour render came out pale and low contrast.
- What to do next time: set the scene's view transform to `Standard` for cartoon colours.
- Evidence: `tools/blender/house_flythrough.py`.

### 2026-10-20  Blender 5.x scripts: avoid the old action curve API
- Area: Blender
- Status: Diagnosed (I left out a loop that used `action.fcurves`, which I believe changed in 5.x; not tested on 5.2.2)
- What to do next time: use `keyframe_insert` and let Blender's default interpolation apply. Test any animation-curve code on the installed version first.

### 2026-10-20  Camera tags run in file order, each from the previous pose
- Area: camera
- Status: Diagnosed (explained from how `[Camera:]` is processed, user then reordered the script; the reordered result was not re-checked by us)
- What happened: a shot started fully zoomed in because a later-in-time camera tag sat earlier in the file.
- What to do next time: write camera and clip lines in time order. Use `wait=false` for a camera move that runs alongside a clip. Put a `[Camera: reset]` where the shot should start from the normal view.
- Evidence: `docs/script-format.md` camera section.

### 2026-10-20  Character tags read only the first word of a name
- Area: script
- Status: Confirmed (the parser error `Unknown character "Colnel"` showed it)
- What happened: `[Clip: Colnel Klink ...]` failed because only the first word is read as the character.
- What to do next time: use the single-word id or the slug form, for example `colnel_klink`, in tag position.
- Evidence: error text above; `parseActionTag`.

### 2026-10-20  A light start image leaves a box around a keyed head
- Area: keying, LTX
- Status: Diagnosed (from `key_head_on_black` in `worker/python/compositor/shot_capture.py`; not tested against the actual image)
- What happened: Ish's LTX head had a white rectangle behind it.
- Why: the keyer removes dark pixels connected to the border, so a white background survives.
- What to do next time: make start images with a plain black backdrop before LTX. Try this on a few images and record the result here.
- Evidence: head rig screenshot, `docs/ltx-talking-head.md`.

### 2026-10-20  Overlapping marks and equal z give a warning
- Area: staging
- Status: Confirmed (warning shown: two characters on mark `centre` with the same z)
- What to do next time: give characters different marks or different `z=`.

### From others  Higgsfield "Passport Rush" lessons
- Area: assets, lighting, prompts
- Status: From others
- See the 14 lessons in [higgsfield-passport-rush.md](higgsfield-passport-rush.md). Move any we confirm for ourselves into this log with our own evidence.

## Open questions

Each one should become a lesson once answered.

- How sharp is a high-resolution background at 3x to 4x camera zoom?
- Is there any scene transition beyond a hard cut?
- Can a background be a video, or only an image?
- Can flipbook clips hold each drawing for 2 frames ("on twos")?
- Does a black start-image backdrop key cleanly in our head keyer?
- Can our LTX setup take a video as a motion guide?
- Does the live Blender MCP route work smoothly with Blender 5.2.2 on the user's PC?
- Which colours and lighting read best on each of our backgrounds? (Needs a test sheet.)
- What keeps a character from jumping when it turns or anchors between clips? (Needs side-by-side tests.)

## Experiments log

Record each test, even failures.

| Date | Experiment | Result | Next |
|---|---|---|---|
| | | | |
