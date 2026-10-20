# Blender capabilities: what we can make, and what we have proved

The goal is a library of everything Blender can do for us through scripts and
Cursor, so we are never limited by not knowing what is possible. This page is a
checklist. Add a row whenever we find a new facet, and move it up the ladder as
we test it.

## How to read the status

| Status | Meaning |
|---|---|
| **Confirmed** | We ran it, in Blender 5.2.2 LTS, and looked at the picture. Evidence named. |
| **Ran, needs work** | It ran and made a picture, but the picture was not right yet. |
| **Known, not tried** | Blender has this feature (general knowledge of the program). We have not tried it, so we do not know how well it works for us. |
| **Not for us (yet)** | Exists but unlikely to matter for our shows. |

Blender is huge. "Known, not tried" is not a promise that it will be easy or look
good. Each row says how we would test it, so the list turns into evidence.

## Capability lab (what we have run so far)

`tools/blender/capability_lab.py` runs one small test per facet and writes one
picture each, a contact sheet and a report. Run it with:

```
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P tools\blender\capability_lab.py -- --out renders\capability
```

Add `--list` to see the tests, `--only text_3d,hair_particles` to run some.
"PASS" in the report only means a picture was made, so check the sheet too.

Run on the assistant's Linux machine, 480x270 tiles, 16 samples, about 25 seconds
for all ten. Not yet run on the user's PC. Sheet:
[images/capability-lab-sheet.png](images/capability-lab-sheet.png) (left to right,
top to bottom: modifiers, PBR materials, procedural textures, geometry nodes, 3D
text, armature pose, rigid body, hair, depth of field, Eevee).

| Facet | Status | What we saw |
|---|---|---|
| Modelling with modifiers (boolean cut, bevel) | Ran, needs work | A bevelled block with a round hole cut through it. The other two cutters made a slot instead of two more holes, so the cut set-up needs fixing. |
| Metal, glass, plastic, glowing materials (Principled shader, Cycles) | Confirmed | Gold sphere, clear glass sphere with refraction, blue plastic, a glowing pink ball. |
| Procedural textures (no image files) | Ran, needs work | Noise (green clouds) and Voronoi (coloured cells) worked. The brick texture rendered as white with tiny marks, so its scale or mapping is wrong. |
| Geometry Nodes (scatter objects over a surface) | Confirmed | A hilly surface covered with hundreds of cone trees from a node tree built by script. |
| 3D text (extruded, bevelled, metal) | Confirmed | "SUNNY BANKS" as gold 3D letters standing on a floor with shadow. |
| Armature and automatic weights, posing | Ran, needs work | A rig drove a body mesh, so skinning works, but this was a plain tube with one bone. It has not been tried on a character shape. |
| Rigid body physics | Confirmed | A ball knocked a tower of blocks over, simulated by script to frame 30. |
| Hair and particles (grass) | Confirmed | A patch of dense grass blades. |
| Depth of field on a perspective camera | Confirmed | Sharp front cube, blurred cones behind it. |
| Eevee (the fast real-time engine) | Confirmed | Rendered on a machine with no graphics card in about 14 seconds. The sphere was faceted because smooth shading was not switched on. |

Earlier confirmed work, from the other scripts in `tools/blender/`:
flat emission materials and outlines (Freestyle), Workbench render, Cycles with
denoising, orthographic camera, lights with real shadows and glow, camera
keyframes (position and lens), numpy post-processing, headless runs on Windows
and Linux, a full-house layout, and Grok restyle of a render.

## Catalogue of facets (most of these are still Known, not tried)

Order is roughly "most useful for the shows first".

### Looks

- **Toon and outline looks:** Freestyle outlines (Confirmed). Shader-to-RGB
  toon ramps in Eevee, Grease Pencil line art, inverted-hull outlines, cel
  shading with a few colour bands. Test: one character with a two-tone cel ramp.
- **Painterly textures:** hand-painted texture maps, Grok-restyled textures
  projected onto models (not tried).
- **Materials:** Principled shader (Confirmed), procedural textures (partly),
  displacement, bump, subsurface skin, fabric (sheen), water, fire, clouds.
- **Lighting:** point, sun, area lights (Confirmed), sky and HDRI lighting,
  volumetric fog and light shafts, emissive lamps (Confirmed), light baked into
  textures.
- **Compositing:** Blender can post-process a render with nodes (colour grade,
  glow, blur, vignette). We used numpy for bloom and vignette (Confirmed). The
  built-in compositor would let us do it inside Blender.

### Building things

- **Modelling:** primitives and modifiers (Confirmed), booleans (needs work),
  curves and pipes, text (Confirmed), array and mirror modifiers, remesh,
  sculpting (interactive, hard to script), kit-bashing from asset packs.
- **Procedural worlds:** Geometry Nodes (Confirmed for scatter). Candidates for
  the caravan park: grass fields, fences, rows of caravans, trees, paths, roofs,
  brick walls, road markings, lamp posts.
- **Free asset sources:** Poly Haven (models, textures, skies, free, CC0),
  Sketchfab and Poly Pizza (licences vary, check each). Not tried.
- **AI model generators:** Meshy, Tripo, Hunyuan3D, Hyper3D Rodin turn pictures
  or text into 3D models. Cost credits. Quality for characters and props is
  unknown for us (see the EP06 plan).
- **Blender add-ons and extensions:** extensions.blender.org has free toon,
  outline, rigging and prop packs. Not checked one by one.

### Characters and animation

- **Rigging:** armatures and automatic weights (ran, tested on a tube only),
  inverse kinematics, shape keys for mouth shapes and expressions, drivers.
- **Lip sync in 3D:** map the mouth shapes we already produce (Rhubarb A to H)
  onto shape keys. Not tried. The Engine already makes these cues.
- **Walk and action cycles:** hand keyframing, pose libraries, retargeting a
  stock motion (Mixamo or similar, licence to check).
- **Cloth, hair, soft body, fluids, smoke, fire:** physics simulations. Rigid
  body is Confirmed; the rest are Known, not tried, and they can be slow.
- **Crowds:** instancing and Geometry Nodes for background people (not tried).

### Camera and shots

- **Perspective, orthographic, lens, depth of field:** Confirmed.
- **Dolly zoom, push-ins, orbits, drone paths, handheld shake:** the dolly zoom
  maths is Confirmed (`dolly_zoom.py`); camera paths along curves, follow
  targets, shake are Known, not tried. See [shot-library.md](shot-library.md).
- **Camera roll (Dutch angle), focus pulls, light changes over time:** Known,
  not tried in Blender; the Engine cannot do them.
- **Multiple cameras and cuts inside one scene:** Known, not tried (markers can
  switch the active camera).

### Output and pipeline

- **Render engines:** Workbench, Eevee, Cycles all confirmed on CPU. Cycles is
  the slow one.
- **Image sequences, video, alpha (transparent) renders:** sequences confirmed;
  transparent backgrounds for dropping characters on other backgrounds are Known,
  not tried.
- **Render passes:** depth, normals, object masks. A depth pass could give the
  Engine real depth for parallax. Known, not tried.
- **Video editing inside Blender (VSE):** Known, not needed while the Engine
  assembles the show.
- **Import and export:** glTF, FBX, OBJ for moving models in and out of Unity or
  Unreal. Known, not tried.
- **Running Blender from Cursor:** headless scripts (Confirmed), live link via
  MCP (not tried, see [blender-plan.md](blender-plan.md)).

## How to add and test a facet

1. Add a row above with the status "Known, not tried" and the question to ask.
2. Write a small test in `capability_lab.py` (a function that builds a tiny scene
   and a line in `TESTS`).
3. Run it, look at the picture, and set the status to Confirmed, Ran, needs work,
   or Not for us (yet). Put what we saw in the "What we saw" column.
4. If the finding is a lesson (a gotcha, a setting), also add it to
   [lessons-learned.md](lessons-learned.md).
