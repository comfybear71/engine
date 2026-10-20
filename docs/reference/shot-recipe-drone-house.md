# Shot recipe study: drone fly-through of a house in a 2D cartoon

Question: how would we make a cartoon shot that looks like a drone flying
from the bedroom, down the hall, into the living room, kitchen, then
upstairs, when the show is 2D?

This is analysis, not a spec. "Exists today" claims come from the docs in
this repo (`docs/timeline-schema.md`, `docs/script-format.md`). Nothing here
was run. Items marked unknown need checking before anyone commits to them.

## What the Engine does today that matters

- One background image per scene, from `[Location:]`, fitted to the
  1920x1080 canvas (`fit` is `cover`, which crops, or letterboxed).
- Camera keyframes are x, y, zoom with optional ease. No rotation, no
  perspective, no depth. The camera is applied the same way to every layer,
  so foreground and background move together.
- Layers have `z` draw order only. Props can be placed and swapped over time.
- Characters are 2D cut-outs and flipbook clips with x, y, scale keyframes.
- Hard cuts between scenes. Whether there is any transition (dissolve,
  whip blur) is unknown.
- A timed background track is queued but not built (`docs/notes.md`).

## The core problem

A drone shot needs the viewpoint to move through space, so near things move
past faster than far things (parallax) and the view of each room changes.
A flat 2D background and a camera that only slides and zooms cannot do that
by itself. There are four honest ways to get the feeling, from cheapest to
heaviest.

## Option A: cutaway house, one big picture (cheapest)

Draw (or generate) one large cross-section of the house, like a dolls house
or a Simpsons-style cutaway: bedroom, hall, living room, kitchen side by
side, stairs up to a second floor. Put it in as one 16:9 background at high
resolution. The camera zooms in to about 3x and travels room to room with
`[Camera: to=x,y zoom= over= ease=inout]`, tilting up the stairs.

- Works with current camera moves. The docs say the camera resamples the
  background from the source at zoom, so a high-resolution source should stay
  sharp. Unknown until tested: how sharp it is at 3x to 4x.
- It does not need to be a very wide image. A wide panorama would be cropped
  by `cover`, so keep the house in a 16:9 frame and zoom in.
- Limits: it is a flat side view, not "flying inside". It reads as a classic
  cutaway tour, which is a legitimate cartoon look.
- Characters stand on marks in each room, and the camera visits them.

## Option B: one scene per room, hidden cuts

Each room is its own `[Scene:]` with its own background. Cut on movement:
the camera starts a fast pan toward a doorway at the end of one scene and
the next scene starts mid-pan from the other side. Match direction and speed
across the cut. A whoosh sound helps.

- Works today with hard cuts. Not a continuous take, but cartoons often
  use this.
- A dissolve or motion blur on the cut would help. Unknown if supported.

## Option C: 2.5D (flat cards in 3D space)

Build each room from a few flat painted layers placed at different depths:
back wall, side wall strips, floor, doorway frame, furniture cut-outs. A
virtual camera moves forward through them and each layer scales and shifts
by its depth. This is how many 2D shows fake a fly-through.

Needs new engine work:
- A depth value per layer (or a parallax factor) and a camera that applies it.
- Likely also camera z (dolly) and a small amount of rotation (roll or yaw).
- Doorways need cut-out holes so the camera can pass through. Layers must be
  painted with those openings.
- Art cost is high: every room needs layered art.
- Moderate invasiveness: it changes how the compositor applies the camera,
  which today folds one camera into every layer the same way.

## Option D: real 3D house, 2D look (heaviest, most convincing)

Build a rough 3D house (blockout is enough), fly a camera through it, render
a clip, then make it look 2D.

Ways to make it look cartoon:
1. Render with an outline or toon shader in Blender and keep it as is.
   Controllable and consistent. Needs Blender skills.
2. Use the grey previs as a motion guide for an AI video model together with
   style references, the way Higgsfield does. Result is less predictable and
   needs a model that accepts a video guide. Whether our LTX setup can do
   this is unknown.
3. Paint over or hand-correct key frames afterwards.

Then put the clip in as a moving background plate (needs a timed or video
background, the same gap noted in `docs/notes.md`).

Characters in a flythrough:
- Easiest: characters are only seen when the camera pauses in a room. Place
  them as normal cut-outs for that pause.
- Hard: characters visible while the camera moves. Blender can export where
  an anchor point sits on screen each frame. Those numbers could become our
  x, y, scale keyframes so a cut-out sticks to the floor as the camera moves.
  That "tracked anchor" import does not exist and would need building.
- Alternative: leave characters out of the flythrough and cut to them.

## Recommended order for trying it

1. Test Option A first. It needs no new code. Judge sharpness at zoom and
   whether the pacing feels like a tour.
2. Use Option B for any shot where a continuous move is not essential.
3. If we want a real fly-through, pick between C (2.5D card camera, more
   engine work, lots of layered art) and D (Blender plate, less engine work,
   more 3D skill). Decide after A and B show what is missing.
4. Whichever we choose, do the pre-production test first (see
   `higgsfield-passport-rush.md`, lesson 14 and the test-stage idea). Put the
   real characters in the real rooms and check scale, lighting and keying
   before drawing the whole house.

## Things to check before deciding

- Maximum background resolution the compositor accepts, and sharpness at
  3x to 4x zoom.
- Whether any scene transition exists beyond a hard cut.
- Whether a background can be a video, or only an image.
- Whether the flipbook can hold frames on twos.
- Whether our LTX setup can take a video guide (for Option D, route 2).
