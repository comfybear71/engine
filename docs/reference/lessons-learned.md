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

### 2026-10-20  A Blender cutaway house works as an Engine background for a room-to-room camera tour
- Area: Blender, camera, backgrounds
- Status: Confirmed on the assistant's machine (rendered with the Engine's own render command; frames inspected). Not yet run on the user's PC.
- What we did: rendered `tools/blender/cutaway_house.py` as one 16:9 picture, put it in a test project as `backgrounds/cutaway/bg.png` with a one-mark `staging.json`, and wrote a script with only `[Scene:]`, `[Location:]`, `[Camera:]` and `[Pause:]` lines (no characters needed). The tour went full house, living room, hall and stairs, kitchen, up to the bathroom, landing, bedroom, then pulled out.
- Sharpness (zoom 2.8, canvas 1920x1080): a 1920-wide source looks soft; a 3840-wide source looks crisp; at zoom 4 the 7680-wide source is slightly sharper than 3840 but the difference is small. Pictures: `docs/reference/images/cutaway-zoom4-4k-vs-8k.png`, `cutaway-tour-sheet.png`.
- Render time for the 15.5 s tour (372 frames) on the assistant's 4-core machine: about 14 s with a 1920 source, 63 s with 3840, 189 s with 7680. Big sources cost time because every frame resamples the whole picture.
- What to do next time: use a 3840-wide source for zooms up to about 3; use 7680 only for tighter zooms. Canvas coordinates for a camera target follow the picture: with this render, canvas x = 960 + 101 * X and canvas y = 540 - 101 * (Z - 3.7) for house coordinates X, Z.
- Limits: this is a flat straight-on view, not a flight through space. Framing of the first tour was a little low in some rooms. No characters were tested in it yet.
- Evidence: `tools/blender/cutaway_house.py`, images above.

### 2026-10-20  Blender Freestyle outline width grows with the square of the setting
- Area: Blender
- Status: Confirmed (at 7680 wide, outlines came out about 5 times too thick until the setting was scaled by the square root of the width ratio)
- What to do next time: the line width is applied twice (scene and line style). Treat the value as a square: 3 gives about 9 px. Scale by sqrt of the size change, not the size change.
- Evidence: `tools/blender/cutaway_house.py`.

### 2026-10-20  Reference sets the user chose for house interiors
- Area: style
- Status: From others (images are small thumbnails, many are licensed stock, so they are style direction only, not to be traced or used as direct inputs for published work without checking the licence)
- Simpsons living room and Rick and Morty house: thick outlines, flat colour, painted pattern detail, trim.
- Stock "cartoon house interior" grid: mostly no outlines; clean shapes with soft gradients, warm lamp and window glow, wood floors, patterned rugs, striped wallpaper, curtains; several cutaway dolls houses with stairs.
- Two images the user liked best: (1) a bright pink room with large windows, city view, sunlit wooden floor, patchwork rug, blue sofa, painterly look and no black outlines; (2) a symmetrical front view with striped wallpaper, wall lamps glowing warm, curtains, wooden floor, a rug, leather sofa. Both are single rooms viewed straight on, in a game-background style.
- What to do next time: try a no-outline, soft-glow version of our rooms. Build warm glow in Blender first (costs nothing) before deciding whether AI restyling is worth credits.

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

- Is there any scene transition beyond a hard cut?
- Can a background be a video, or only an image?
- Can flipbook clips hold each drawing for 2 frames ("on twos")?
- Does a black start-image backdrop key cleanly in our head keyer?
- Can our LTX setup take a video as a motion guide?
- Does the live Blender MCP route work smoothly with Blender 5.2.2 on the user's PC?
- Can an AI image tool restyle our Blender room renders (more painterly, warm glow) and keep the layout intact? Not tried. Costs credits, needs permission.
- Which colours and lighting read best on each of our backgrounds? (Needs a test sheet.)
- What keeps a character from jumping when it turns or anchors between clips? (Needs side-by-side tests.)

## Experiments log

Record each test, even failures.

| Date | Experiment | Result | Next |
|---|---|---|---|
| | | | |
