# Reference: Higgsfield "Passport Rush" breakdown

Saved for reference while we develop the Engine. This is **not** a spec and
nothing here is scheduled work. It records what another team does, what we
can learn from it, and how it maps to our software.

Sources:

- Video: "How To Animate a Short Film with Blender + Higgsfield (Breakdown)",
  Higgsfield Animation channel, episode 1 (about 28 minutes).
- Prompt page: `higgsfield.ai/@emilywallace/blogs/blender-higgsfield-animation-pipeline-breakdown-animated-short-film`
  (the page text is loaded from a data file, so it was extracted from the
  raw data. Asset prompts, the lighting block and the first scene prompts were
  read. The middle scene prompts were only skimmed. Re-open the page for the
  full prompts).

Caveats: this is a promotional breakdown by a vendor. Their numbers (18 scenes
in 3 days, 5-minute film) are their claims. Costs were promised for a later
video. Their pipeline generates whole shots with an AI video model. Ours
composites 2D cut-outs and flipbook clips, so only some lessons transfer.

## Their pipeline in one view

1. Script, storyboard. Boards are marked orange (needs Blender previs) or
   blank (straight text-to-video). Boards are a guide, not fixed.
2. Asset sheets first (characters, props, locations, effects) with an image
   model (Soul 2.0), then hand-corrected in Photoshop.
3. Test stage between pre-production and production: put the assets into
   video and see what breaks. The findings become project rules.
4. Production: video model (Seedance 2.5) with assets attached as image
   references. For hard shots, a grey Blender previs video is attached as the
   motion and camera guide.
5. Review each take against the previs and the sheets, then revise the
   specific cause.

Tools named on the page: Soul 2.0 (base images), Photoshop (hand work),
Seedream 5.0 Pro (edit an existing image, e.g. the roofless taxi), Blender
(camera and action blocking), Seedance 2.5 (video). Claude was used to write
the long prompts from a saved system prompt ("skill").

Roles: "asset managers" own character, prop and background sheets (art
director equivalent). Everyone writes prompts for their own department.

## Lessons (with video timestamps)

| # | Lesson | Time |
|---|---|---|
| 1 | Asset first: the quality of the image inputs decides the quality of the film. | 4:12 |
| 2 | Generate 4 options, compare, then hand-fix. Fix a design once and reuse the corrected reference everywhere. | 5:16 |
| 3 | Add hand-painted strokes around a 3D silhouette so it matches a painted world. | 8:08 |
| 4 | Midday light looked flat. Late-afternoon warm key light with long hard shadows gave depth and became "the visual formula". | 11:01 |
| 5 | Do not stack dense texture on both prop and background. Watercolor car on watercolor road broke in motion. Keep the prop clean and the world painted. | 13:38 |
| 6 | Only build sheets for things that recur (three trucks), not every prop. | 14:26 |
| 7 | Wording matters: "mushroom-shaped explosion" gave a literal mushroom. "nuclear blast" fixed it. | 14:50 |
| 8 | Previs for complex camera or timing. If animating is faster than explaining, make a previs. | 12:34, 20:49 |
| 9 | Previs is grey geometry, motion and camera only. The images supply the look. | 16:09 |
| 10 | If the model does not understand the previs, you cannot see enough of it. Pull the camera back. | 23:36 |
| 11 | References must match the sheet. A camera-angle screenshot with no headphones made every take lose them. Paint the headphones into the reference. | 24:25 |
| 12 | Empty car at first test produced random people. Adding characters stopped it. | 22:16 |
| 13 | Changing the character design changed the camera. Re-lock framing with screenshots of the takes you liked. | 24:00 |
| 14 | AI struggles with subtle acting beats and small continuity props (the ceiling-handle gag). Big action was easier. They call it a "performance gap". | 25:04 |

## Prompt anatomy (video)

The first ~20% of a prompt is followed most strictly. Blocks, in order:

1. Scene context and style. Plain sentences, world physics, style rules.
2. Active references. Say what each attached image or video is. Give
   personality and quality, not visual description (the image carries that).
   Add "100% matches the reference."
3. Shot structure. One block per hard cut, action beat by beat with seconds.
4. Locks and constraints. Hard rules the model must obey. They always add
   "no music, SFX only" to keep post flexible.
5. Animation principles. List the 12 principles, "animation on twos". They
   say the model only follows them partly, but it helps.

From the prompt page, the working order for a scene:

1. Storyboard or simple previs establishes the shot.
2. Attach approved character, prop, interior and location references.
3. Describe the action as timed beats, including how the shot ends.
4. Lock continuity: seats, accessories, vehicle damage, lighting.
5. Check against references and fix the specific source of the error.

Reference numbering (`<<<image_N>>>`, `<<<video_1>>>`) is local to each
prompt. Keep every prompt together with its own reference map.

### Vocabulary worth copying

- Named locks, each its own paragraph: SEAT LOCK, CAMERA RIG LOCK, BRAKE
  PHYSICS LOCK, LAUNCH LOCK. Each states the rule in hard terms and says
  what must not happen.
- A layout lock for who sits where ("right-hand drive, driver front-right,
  girl rear-left, front-left seat empty").
- Beat timing like "Beat 2 (~0.15 s)" with the physical event and the facial
  acting change in it.
- A composition key: describe the exact framing of a keyframe image and say
  "reproduce this composition", then say which reference wins on design.
- Motion-matched cut: the movement continues across the cut.
- Audio line: "No dialogue. No music."
- Quality line: "no ghosting, no flicker, no frame-skipping stutter".

### Shared lighting fragment (summary)

A reusable block pasted into every scene prompt:

- Low golden-hour key light cutting diagonally across the whole frame.
- Long, hard-edged shadows across the car and characters.
- Shadows lean cool, highlights lean warm, colour temperature consistent.
- No other light source ever appears.
- The light is fixed to the world, not to the subject. It never rotates to
  follow a face. As subjects move, the lit side and the shadow edge travel
  across them.
- Key light plus a rim light to separate hair and shoulders from the
  background.
- Cabin interior one stop darker than outside the glass.

### Asset sheet prompt habits

- Character on her own, full length, plain flat background, nothing else in
  frame, face fully visible, empty hands.
- Three-view sheets (front, back, close-up portrait) on the same ground line.
- Faint soft shadow directly under the feet, background stays pure.
- "Consistent design, identical face and clothing across all three views",
  "no text, no labels, no arrows".
- Car sheet: three views stacked in bands, plain seamless light background,
  soft contact shadow, exact marks (plate and roof-sign text) repeated.
- Edit prompt: "Use image_1 as the base, preserving identity, proportions,
  colour, camera angle" then describe the change and what to avoid.
- Effects sheet on a white background, hand-textured afterwards.

## Mapping to our Engine (what we have, what we would need)

Verified against the repo docs when this was written (not by running new code):

- Script already locks timing: `at_time=`, `trim_*`, `speed=`, `[Pause:]`,
  `to=`/`over=`/`ease=`. This covers their "performance gap", because acting
  beats are ours, not the model's.
- Camera: `[Camera:]` supports zoom, pan, tilt, `to=x,y zoom=`, reset, over,
  ease, `at_time=`, `wait=false`. Camera keyframes are x, y, zoom only.
  There is no rotation and no perspective. The camera is applied equally to
  every layer, so there is no parallax today.
- Layers: `z` is draw order only. The background is one image per scene
  (`[Location:]`), fitted to a 1920x1080 canvas.
- A timed background track is already queued in `docs/notes.md`.

Candidate ideas (none scheduled, all need a decision first):

1. Show style guide file: lighting fragment, asset-sheet template, talking
   head prompt template, palette rules. No code.
2. Pre-episode test stage checklist: put the real character on the real
   backgrounds, check keying, lighting and scale before writing the script.
3. LTX prompt blocks: named locks and timed beats in the talking-head
   recipe. Test on a few clips before adopting.
4. Asset requests with a plain black or flat backdrop so the head keyer
   gets a clean edge (our keyer removes dark border pixels only).
5. "Animation on twos" setting for flipbook clips (hold each drawing 2
   frames). Check what the flipbook already supports first.
6. Contact shadow and per-scene light tint for cut-outs.
7. Soft outline or paint-stroke edge on cut-outs to match painted
   backgrounds.
8. Parallax or 2.5D depth for layers. See
   [docs/reference/shot-recipe-drone-house.md](shot-recipe-drone-house.md).
