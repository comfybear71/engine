# Sunny Banks EP06: plan for a big upgrade

Status: **a plan, not a result.** Nothing here has been built. It comes from the
user's goals plus what we have confirmed in [lessons-learned.md](lessons-learned.md)
and [blender-capabilities.md](blender-capabilities.md). Change it as we learn.

## What the user wants (their words, tidied)

- Use Sunny Banks EP06 as the real project for the new tools, instead of more
  house experiments (the house was only a proof of concept).
- Design the whole caravan park and its shops in Blender.
- Turn the characters into models.
- Get depth perception and real camera angles.
- Keep the end goal in view: **video direct**, meaning the user describes shots
  and scenes in plain words and the assistant builds them, with the user reviewing
  each stage.
- Learn step by step, ticking each one off.

## What we know today

- The Engine is a 2D cut-out compositor with exact script, timing and camera.
  The camera moves in x, y and zoom only, with no depth, rotation or lighting
  change.
- Blender backgrounds work as Engine backgrounds with room-to-room camera moves
  (Confirmed). They are stills, so the Engine's zoom is the only camera motion.
- A Grok restyle can give a Blender render a painted look and keep the layout
  (Confirmed, one room, one try each).
- (The real cast, locations and conflicts between sources are in [sunny-banks-bible.md](sunny-banks-bible.md). `dana` and `hicks` below are only the repo's test characters.)
- Existing characters are 2D cut-outs (for example `dana` and `hicks` in
  `projects/_global_assets/characters`), with mouth shapes from Rhubarb cues and
  LTX talking-head clips for close-ups.
- Not known: how good 3D character models from pictures would look, how much work
  rigging them is, and how a 3D scene and the 2D Engine would be joined.

## Three ways to get depth, from least to most work

These are the real choices. We should test each on one character before choosing.

### A. 2D characters on a 3D-rendered background (least work)

Blender renders the caravan park as a still or a video. The Engine puts the flat
characters on top, as it does now. Perspective lives in the background only.

- Gains: perspective backgrounds, real lighting, one location rendered from many
  angles. Cheap.
- Loses: characters do not move through the space. A camera move that changes the
  perspective will not move the characters correctly.
- Needs: nothing new in the Engine for stills. A video background needs an Engine
  change (open question).

### B. 2D characters as flat cards inside the 3D scene ("2.5D", cut-out in space)

The character drawings become flat planes placed in the Blender scene. Blender
renders the whole thing with a real camera, so the cards get correct perspective,
size, parallax and shadow. The drawings still come from the 2D rig, for example one
render per pose or mouth shape.

- Gains: real depth and camera moves (dolly, orbit, crane) with the characters
  keeping their 2D look. Very close to how many 2D shows use 3D backgrounds.
- Loses: cards look flat from the side, so big angle changes need extra drawings
  or are avoided.
- Not tried. The open question is how to feed the Engine's poses and lip sync into
  Blender frame by frame.

### C. Full 3D character models (most work)

Characters become rigged 3D models, rendered in a toon look.

- How: make a model from the existing design (hand modelling, or an image-to-3D
  tool such as Meshy, Tripo or Hunyuan3D, costs credits), then rig it with an
  armature and shape keys for the mouth and face. The mouth shapes we already
  produce could drive the shape keys.
- Gains: any camera angle, true depth, walk cycles, lighting that matches the
  background.
- Loses: much more work per character. Quality of AI-made models for stylised
  cartoon characters is unknown to us. Hands, faces and clothes often need cleanup.
  The characters would look different from the 2D versions.
- Not tried. The armature test in the capability lab only covers a tube.

Recommendation, as an opinion: build the park first (needed for A, B and C),
then try B on one character, because it keeps the characters we already have and
tests depth cheaply. Treat C as a separate experiment on one character so it does
not hold the episode back.

## Stages

Tick these off as we go. Each stage ends with the user looking at a result.

1. **Choose the look.** Pick from what we have seen: outlined flat cartoon, soft
   glow without outlines, or the Grok-painted version. Write the choice in a one
   page style guide for the show (colours, outline or not, light, camera habits).
   Test: one caravan and a patch of grass in each look.
2. **Plan the park.** A top-down sketch or a list: where the entrance, shops,
   caravans, amenity block, play area, roads and trees are, and which scenes happen
   where. Needs the user's input (see questions).
3. **Block out the park in Blender.** Correct scale, simple shapes, a camera
   that can go anywhere. Use Geometry Nodes for repeated parts such as caravans,
   fences, trees and lamp posts (scatter confirmed on a hill).
4. **Dress and style it.** Materials, signs (3D text confirmed), props from free
   libraries, lighting for times of day. Test a Grok restyle of the key views.
5. **Shot list.** For each scene: location, camera angle, move, characters. Use
   [shot-library.md](shot-library.md). Mark which shots are Blender plates and which
   are Engine shots.
6. **Characters in the space.** Test A, then B, then C on one character as above.
7. **Join to the Engine.** Decide what the Engine needs (video backgrounds, depth,
   camera data). That is a code change and needs the user's go-ahead.
8. **Direct by description.** The user describes a scene, the assistant proposes a
   shot list and script, builds it, and the user approves each stage.

## Questions for the user

- Which characters are in EP06, and are all of them already drawn as 2D cut-outs?
- What happens in the caravan park, in a few lines, so we know which locations
  and angles matter first?
- Which look from the tests so far is closest: outlined, glow, or Grok-painted?
- Is the show mostly dialogue with the camera on faces, or lots of walking and
  wide shots? That decides how much depth we need.
- How long is the episode, and is a first test scene of 10 to 20 seconds a good
  starting size?
- Any characters that must stay exactly as drawn?

## Risks to keep in view

- Scope: a whole caravan park plus 3D characters is a very large project. Start
  with one location and one scene.
- Look drift: AI restyles and Blender renders can make the park look different
  from scene to scene. The style guide and fixed prompts are the defence. Whether
  it holds across rooms is untested.
- Time per render: Cycles stills took about 45 seconds on the user's PC, and moving
  video would take much longer.
- Cost: image-to-3D and Grok restyles use credits, so each paid test needs a go.
- The Engine may need new features. We do not change Engine code without the
  user's say-so.
