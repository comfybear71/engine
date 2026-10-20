# Shot library: camera moves and mood shifts

A running list of shots we want to be able to make, with what each one does,
what the Engine can do today, and what needs Blender.

Status words as in the [README](README.md). The shot descriptions below come
from an AI chat the user pasted (answers sourced from Wikipedia, film-school
videos and forum posts), so they are **From others** until we have tried them.
Where we ran something, it says **Confirmed** and names the evidence.

## What the Engine camera can do today

**Diagnosed** from `docs/timeline-schema.md` (Camera) and `docs/script-format.md`
(`[Camera:]`), not re-run for this note.

- The camera has `x`, `y`, `zoom`, an ease (`linear` or `inout`), and an additive
  `shake`.
- No rotation (so no Dutch angle), no perspective or depth (so no dolly zoom and
  no parallax), no focus or blur (so no rack focus), and no tint, fade or
  lighting change (so no normal-to-dark shift) in the timeline schema or the
  script tags we have today.
- The camera is applied to every layer in the same way, so a zoom enlarges the
  background and the characters together.

So anything that needs depth, tilt, focus or lighting is a Blender job (or a
change to the Engine), while straight push-ins and pans are available now.

## The shots

### 1. Dolly zoom (Vertigo effect, Hitchcock zoom, contra-zoom, trombone shot)

- Status: description From others; the Blender maths **Confirmed** (see below).
- What it is: the camera physically moves toward or away from the subject while
  the lens zooms the opposite way, so the subject stays the same size and the
  background stretches or squashes.
  - Dolly in and zoom out: background pushes away, space feels stretched. Used in
    Jaws when Brody realises the attack.
  - Dolly out and zoom in: background crowds in on the subject. Vertigo (1958) is
    the original; Goodfellas uses it in the diner scene.
- Meaning: sudden realisation, dread, a world that stops feeling safe.
- Engine today: **cannot be done**. The Engine camera has no perspective, so
  zooming only scales everything together.
- Blender: yes. The rule is that the width visible at the subject stays constant:

  `focal_length = sensor_width * distance / visible_width_at_subject`

  `tools/blender/dolly_zoom.py` does this and renders a test. Run it with
  `blender -b -P tools/blender/dolly_zoom.py -- --out renders/dolly`.
- Evidence (assistant's machine, Blender 5.2.2 LTS): camera from 12 m to 4 m over
  48 frames, lens 72 mm to 24 mm. The 2 m subject measured 426.7 px tall at the
  first, middle and last frame, while the pillars behind changed spacing and size.
  Sheet: [images/dolly-zoom-test-sheet.png](images/dolly-zoom-test-sheet.png).
  Not yet tried with a character, a cut-out layer, or on the user's PC.
- Notes: the lens is not a straight-line function of time, so the script keys
  every frame (two keys would drift off the curve). Keep the camera looking along
  +Y at the target, as the cutaway house does. A long lens needs a camera far
  away, a very wide lens needs room to move; check the walls do not show their
  edges at the wide end (it happened in the first test room).
- To use the result in a scene: render it as a plate or video in Blender and bring
  it in. The Engine has no video background yet (see the open questions in
  [lessons-learned.md](lessons-learned.md)).

### 2. Creeping push-in (the slow creep)

- Status: description From others.
- What it is: a very slow, barely noticeable move toward a face or object.
- Meaning: tension building, a character realising something, danger closing in.
  Named examples in the chat: The Silence of the Lambs, Seven.
- Engine today: **yes**, with `[Camera:]` and a slow ease. Example (not run for
  this note, tag syntax copied from `script-format.md`):

  ```
  [Camera: to=960,540 zoom=1.35 over=12s ease=inout]
  ```

  Pick the target so the character's face ends up where you want it, and keep the
  zoom change small (the chat says "almost unnoticeable"; start with 1.0 to 1.2).
  Zoom resamples the source once, so quality depends on the source size (see the
  cutaway lesson: 3840 wide is good to about 3x).
- Blender: not needed.

### 3. Dutch angle (canted frame)

- Status: description From others. Examples named in the chat: German
  Expressionism, Fight Club, The Dark Knight.
- What it is: the camera is rolled so the horizon is no longer level.
- Meaning: unease, disorientation, "something is wrong with this world".
- Engine today: **cannot be done** on the camera (no rotation). Scene layers and
  rig joints do have rotation, but there is no tag that rotates the whole frame.
  Possible later feature: a camera `roll`. That is a code change and needs your
  say-so.
- Blender: yes. Animate the camera roll (rotation about its view axis) from 0 to
  about -8 to -12.5 degrees over 24 to 48 frames. The chat suggested a slow roll
  rather than a fixed tilt for a shift mid-shot. Not run.

### 4. Normal to ominous by lighting

- Status: description From others. Not run.
- Ideas listed in the chat, all in-camera in live action:
  - **Dim the lights:** cut the fill and background light and leave one hard key
    light (chiaroscuro), cue it on a line of dialogue.
  - **Shadow cue:** a big shadow from an off-screen object or person slides over
    the face.
  - **Rack focus:** start with the subject sharp and the background soft, then
    shift focus to something dark or frightening behind them.
- Engine today: **cannot be done** (no tint, fade, light or blur on the camera or
  the scene). Candidates if we later add them: a timed colour grade or darkening
  overlay on the whole frame, a moving shadow layer (which today could be a dark
  cut-out prop drawn over the background), and a blur layer for rack focus.
- Blender: yes. Key the world strength (e.g. 1.0 down to 0.05), the key light
  colour (warm to cold blue), and `dof.focus_distance`. Because a Blender
  background is only a still or a video, the lighting change would have to be
  baked into frames in Blender and brought in as video, or done as two stills.

## Numbers and ideas from the chat, kept for reference

These are the chat's suggestions, **not tested by us** unless marked. Treat them
as starting points to try, not as rules.

| Idea | Starting value from the chat | Tried? |
|---|---|---|
| Dolly zoom length | 48 frames (2 s at 24 fps) | Yes, as the test above |
| Dolly zoom distance | 10 m to 3.5 m | We used 12 m to 4 m |
| Lens clamp | 12 mm to 300 mm | Not needed in the test |
| Dutch roll | -8 to +10, or -12.5 degrees, over 24 to 48 frames | No |
| Light dim | world 1.0 to 0.05, key light warm (1.0, 0.95, 0.9) to cold (0.3, 0.4, 0.8) | No |
| Rack focus | 12 frames, focus 3.5 m to 12 m | No |
| Easing | smoothstep `t*t*(3-2t)` between start and end frame | No (the Engine's `inout` ease is the same smoothstep) |

### About the pasted scripts

- The Blender dolly zoom script in the chat uses the correct maths (focal length
  proportional to distance). We rewrote it as `tools/blender/dolly_zoom.py` so it
  can be run and checked. The chat's version has an unused parameter and does not
  say that it only works when the camera looks along +Y.
- The "state controller" Python class in the chat just interpolates numbers
  (roll, light strength, light colour, focus distance) between two frames with a
  smoothstep and returns a dictionary. It is not wired to Blender or the Engine
  and we have not run it. If we need it, a few lines in a Blender script would do
  the same job.
- Both are suggestions from a chatbot. Check anything that matters in a test.

## Open questions

- Does a Blender-rendered dolly zoom work as an Engine background plate with
  cut-out characters on top? (Characters would not warp with the room, so a
  dolly zoom behind a flat character probably looks wrong. Needs a test.)
- Would a camera `roll` and a timed whole-frame grade be worth adding to the
  Engine? That is a decision for the user, not something to build unprompted.
- Can Grok or LTX video produce a dolly zoom or a normal-to-ominous shift from a
  prompt? Not tried, costs credits.
