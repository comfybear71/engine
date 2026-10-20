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
