# Blender in our pipeline (plan and notes)

Status: first smoke tests done (see Experiments). Update as we
learn, and log results in [lessons-learned.md](lessons-learned.md).

## Why

For shots the 2D engine cannot do alone (camera moving through space,
rooms, vehicles, depth), a rough 3D scene gives us camera, timing and
perspective. See [shot-recipe-drone-house.md](shot-recipe-drone-house.md) and
[higgsfield-passport-rush.md](higgsfield-passport-rush.md).

## Can AI bridge the gap? Current view

Reasons it should help (Suspected until we test them):
- Blender can be driven by Python scripts, including with no window
  (`blender -b -P script.py`). An AI can write such scripts to build simple
  shapes, place a camera and render. A script is plain text, so it can be
  saved, rerun and fixed.
- The scripts can be kept in this repo so a shot can be rebuilt.
- From others, not checked by us: community projects connect an AI assistant
  to a live Blender session.

Reasons for caution:
- Blender's scripting interface changes between versions. Generated code
  will sometimes fail and need fixing against the installed version.
- AI is weak at 3D space. Walls can float, scale can be wrong, a camera can
  point the wrong way. Every result needs a rendered picture checked by a
  person.
- Anything judged by eye (is the room cosy, does the move feel right) still
  needs the creator.
- Beginner steps still matter: opening files, viewing the scene, and
  understanding camera, units and frames.

Working guess: AI can build the blockout and the camera move, and you steer
by looking at test renders. Do not expect it to replace learning a few basics.

## Version

Use **Blender 5.2.2 LTS** (Long-Term Support, September 2026). A 5.3 beta
exists but is not a stable base for scripts. Scripts in `tools/blender/` are
tested on 5.2.2 only. 4.5 LTS is the fallback.

## Two ways to work

1. **Scripts from the assistant** (done first). The assistant writes a
   script, runs it headless in the same Blender version, looks at the render,
   fixes it, then the user runs it on their PC. Scripts live in
   `tools/blender/`.
2. **Live Blender MCP on the user's PC** (not tried yet). From others
   (YouTube, "Cursor AI + Blender MCP Tutorial", MrWonderHow, May 2026): the
   community add-on `github.com/ahujasid/blender-mcp` is installed in Blender,
   an MCP server entry is added to Cursor's `mcp.json`, and Python plus the
   `uv` package manager are needed. The author asks for a scene in plain
   English, then reports problems in plain words and the AI fixes them. His
   first results had glassy water, a fast animation and thick foam, and took
   several rounds. The add-on lets the AI run code inside Blender: save work
   first, use the original repository only, read its instructions.
   The video mentions an official Blender MCP tutorial too (not checked).
   Update 2026-10-20, from the project README (read, not run): the package was
   renamed `mcp-for-blender` (old `uvx blender-mcp` still works), it needs Blender
   3.0 or newer, it exposes tools to run Python, look at the viewport, fetch
   Poly Haven/Sketchfab assets and generate 3D models, usage statistics are on by
   default (set `DISABLE_TELEMETRY=true`), and it can only reach Blender on the
   machine where it runs, so a cloud agent cannot use it. See pc-control-options.md.

## Staged plan

1. Install Blender on the machine that runs the Engine. Confirm the version.
2. Smoke test: one script makes a box room and a camera, renders one still.
   Success means we can see the image.
3. House blockout: rooms and doorways as simple boxes with a camera path
   through them. Render a grey preview video.
4. Look: try an outline or flat-shaded render so it reads as a cartoon.
5. Hand-off to the Engine: decide how the render enters a scene (background
   plate or reference). Needs a timed or video background (queued in
   `docs/notes.md`) or a separate step.
6. Only if needed: export camera and anchor points so cut-out characters can
   follow the camera. Not built.

## Working rules

- Keep generated Blender scripts and settings in the repo, with a note of
  the Blender version used.
- Always render a test still or short preview before trusting a scene.
- Keep scenes simple and named. Record every attempt, including failures.
- Cost: running Blender locally costs no credits. Do not spend Comfy or Grok
  credits on this without asking.

## Open questions

- Which Blender version and which render engine run fine on the user's PC?
- Can the render be restyled enough to match our 2D look without AI video?
- How do we bring a rendered clip into a scene (plate, reference, or both)?
- Is there a simple way to keep cut-out characters locked to a moving 3D camera?

## Experiments

| Date | Experiment | Result | Next |
|---|---|---|---|
| 2026-10-20 | `smoke_room.py` on Blender 5.2.2 LTS (Linux, headless, Workbench engine) | Confirmed: rendered a box room still in about 4 s. Framing and lighting were rough. | Run on the user's PC. |
| 2026-10-20 | `house_flythrough.py`: three rooms, camera through two doorways, 72 frames | Confirmed (assistant's machine): 72 frames rendered in about 7 s. Contact sheet shows bedroom, doorway, hall, living room. Colours were washed out until the view transform was set to Standard. Outlines are faint. Flat blocks only. | Run on the user's PC. Try a stronger outline and a toon look. |
| 2026-10-20 | Both scripts on the user's PC (Windows, Blender 5.2.2 LTS, same build hash) | Confirmed: both ran with no errors, 72 frames in about 1.5 s. Pictures went to `C:\renders\...` instead of the Engine folder because a relative output path was resolved against the drive root. Pictures not yet looked at by the assistant. | Scripts now turn the output path into a full path (tested on Linux only). Re-run on Windows and check the folder. |
| 2026-10-20 | Re-run after the full-path fix, on the user's PC | Confirmed: the user's file explorer screenshot shows 72 frames in `C:\Users\Stuie\engine\renders\house`. | Delete the stray `C:\renders` folder. |
| 2026-10-20 | `style_lab.py`: same three camera positions in four looks (assistant's machine only) | Confirmed by looking at the sheet. **flat**: clean, outlines too faint. **ink** (Freestyle outlines, thick dark lines): clearly reads as a cartoon, best of the four so far, but some edges are missing and it is slow (about 10 s a frame). **shaded** (Workbench studio light with shadows): dark and muddy. **toon** (Cycles, warm sun, hard shadows, outlines): noisy at 24 samples, smooth at 48 samples with denoising; warm light patches add depth, but the toon bands are hardly visible. | User runs it on Windows and picks. Try ink lines on the warm-sun render. |
| 2026-10-20 | `style_lab.py` run on the user's PC | Confirmed: ran with no errors in about 21 s and wrote all 14 files. Only the thumbnails were seen by the assistant. The user was unsure which look they liked and asked for more cartoony, with Simpsons living room and Rick and Morty house images as references. | See next row. |
| 2026-10-20 | `cartoon_house.py` (assistant's machine only): same house with bold flat colours, painted planks and stripes, rug rings, trim, rounded furniture, curtains, pictures, thick outlines; two palettes. Sheet: [images/cartoon-house-v1-sheet.png](images/cartoon-house-v1-sheet.png) | Confirmed by looking: reads as a cartoon room, far closer to the references than the box version. Rendered in about 4 s. Open top shows sky where a ceiling would be. Hall is still a plain corridor. Lamp shade and furniture are simple shapes. Judged from small reference thumbnails, not copied from them. | User runs it and says which palette is closer. Then kitchen, stairs and more props. |
| 2026-10-20 | `cartoon_house.py` run on the user's PC | Confirmed: ran and wrote all files. The user said the results are "becoming awesome". Only thumbnails seen by the assistant. | Next: cutaway house. |
| 2026-10-20 | `cutaway_house.py` (assistant's machine only): two floors, six rooms, stairs, roof, straight-on orthographic view at 1920x1080. Sheet: [images/cutaway-house-v1-wood.png](images/cutaway-house-v1-wood.png) | Confirmed by looking: reads as a cartoon dolls house in about 5 s. Rough: the bathroom is almost white on white, rooms are sparse, no ceiling lamps glow. Not yet tried as an Engine background, and not yet rendered at 7680 wide. | Test in the Engine: sharpness at 3x to 4x zoom, then pan room to room. |
| 2026-10-20 | Cutaway used as an Engine background (assistant's machine): 15.5 s room-to-room camera tour, sources of 1920, 3840 and 7680 wide | Confirmed: the Engine rendered the tour with no characters and no code changes. 1920 source soft, 3840 crisp to about 3x, 7680 slightly sharper at 4x. Render times 14 s, 63 s, 189 s. Outlines were far too thick at 7680 until the width scaling was fixed. See lessons-learned.md. | User runs the tour on the PC. Test 2: no-outline warm-glow room. |
| 2026-10-20 | `glow_room.py`: one room with real lights, no outlines, bloom and vignette (evening, day, outlined hybrid) | Confirmed by looking (assistant's machine). Close to both favourite references. Cycles takes 1.5 to 2 min a still at 1280x720. See lessons-learned.md. | User runs it. Test 3: AI restyle of one render (needs permission). |
| 2026-10-20 | Test 3: Grok image edit of the glow rooms (user's PC, about $0.07 each) | Confirmed: layout and glow kept, painted look added; windows got an invented view and the blown-out lamp shades were fixed. See lessons-learned.md. | Restyle a second room and check style match and zoom sharpness. |
| 2026-10-20 | `capability_lab.py`: ten facets in one run (assistant's machine) | Confirmed by looking: PBR materials, Geometry Nodes scatter, 3D text, rigid body, hair, depth of field, Eevee work. Boolean cuts, brick texture and the armature test need work. See blender-capabilities.md. | Run on the PC; fix the three weak tests; add more facets. |
