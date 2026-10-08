# `timeline.json` schema reference

This is the shared contract between the Studio (which will write this file)
and the render worker (which validates and renders it). The machine-readable
schema lives at [`schema/timeline.schema.json`](../schema/timeline.schema.json)
(JSON Schema draft-07); this document explains every field in prose with the
reasoning behind it, for whoever writes the `script.txt` -> `timeline.json`
parser next.

A complete, working example lives at
[`projects/sample/timeline.json`](../projects/sample/timeline.json).

## Ground rules

- **All asset/audio paths are relative to the project folder** -- the
  directory containing `timeline.json` itself -- never to the current
  working directory of whatever process is reading the file. A path like
  `"assets/characters/stuart.png"` in `projects/sample/timeline.json`
  resolves to `projects/sample/assets/characters/stuart.png` regardless of
  where you run the worker from.
- **Every frame-based time value is in frames at the document's `fps`.**
  There is no per-scene frame rate.
- The worker validates the whole document against the JSON Schema *before*
  rendering a single frame, so a malformed Studio export fails fast with a
  clear, field-by-field error list instead of crashing deep inside the
  compositor.

## Top level

```json
{
  "series": "Sunny Banks",
  "episode": "101",
  "fps": 24,
  "canvas": { "width": 1920, "height": 1080 },
  "scenes": [ /* ... */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `series` | string | yes | e.g. `"Sunny Banks"`, `"Skidmarks"`, `"Shorts"`. |
| `episode` | string or integer | yes | Episode number/slug. |
| `fps` | integer (1-120) | yes | Frame rate for the whole render. |
| `canvas` | object | no | `{ width, height }`. **Defaults to 1920x1080** if omitted. |
| `scenes` | array of [Scene](#scene) | yes | At least one. |

### Why a fixed canvas?

Every layer's `x`/`y` is expressed in canvas pixel space, **not** relative to
the background image's native resolution. The background is scaled
("fitted") to the canvas before anything is drawn on top of it (see
[Background](#background)). This means you can swap a background for a
higher- or lower-resolution version, or reuse the same character
placement across scenes with different backgrounds, without recomputing any
layer coordinates.

## Scene

```json
{
  "id": "scene-1-porch",
  "duration": { "from_audio": "assets/audio/line1.wav", "padding_frames": 6 },
  "background": { "asset": "assets/backgrounds/bg.png", "fit": "cover" },
  "audio": "assets/audio/ambience.wav",
  "camera": { /* optional, see Camera */ },
  "layers": [ /* ... */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique within the document. |
| `duration` | object | yes | See [Duration](#duration). |
| `background` | object | yes | See [Background](#background). |
| `audio` | string | no | Scene-wide audio bed (music/ambience), mixed in starting at this scene's first frame. |
| `camera` | object | no | See [Camera](#camera). |
| `layers` | array of [Layer](#layer) | no | Drawn back-to-front by `z`. |

### `frame_step` (cut-out "on Ns" cadence)

```json
"frame_step": 2
```

Default `1` (recompute and draw every frame, i.e. "on 1s"). Setting it to
`2` or `3` gives the classic cut-out/stop-motion cadence of animating "on
2s"/"on 3s": the scene (including camera position and every slot's active
drawing -- see [Slots](#slots--drawing-swaps-mouths-blinks-hand-poses)
below) is only recomputed every `frame_step` frames; the frames in between
hold and re-emit the exact same rendered picture instead of recomposing.
This is purely a visual cadence choice -- **audio always plays at full,
continuous rate** regardless of `frame_step`, since it's mixed by FFmpeg
against wall-clock start times, not against this per-frame loop.

### Duration

A scene's length can be hand-set or derived from an audio file, satisfying
"timing should be able to come from audio, not just a hand-typed total" while
still allowing a hand-typed value when there's no audio to derive it from.
Exactly one of:

```json
{ "frames": 150 }
```
```json
{ "from_audio": "assets/audio/line1.wav", "padding_frames": 6 }
```

`from_audio` probes the audio file's duration (via `ffprobe`) and computes
`round(duration_seconds * fps) + padding_frames`. `padding_frames` (default
0) is useful for holding the last frame briefly after dialogue ends.

### Background

```json
{ "asset": "assets/backgrounds/bg.png", "fit": "cover" }
```

- `asset`: path to the background image. It does **not** need to match the
  canvas resolution -- it's fitted to it.
- `fit`: `"cover"` (default) scales to fill the canvas, cropping any
  overflow symmetrically (no letterboxing). `"contain"` scales to fit
  entirely inside the canvas, letterboxed with black bars.

## Layer

```json
{
  "id": "stuart",
  "character_id": "stuart",
  "asset": "assets/characters/stuart_body.png",
  "z": 10,
  "transform": {
    "x": 1650, "y": 1080, "scale": 1.3,
    "anchor": "bottom-center", "flip_x": false,
    "rotation": 0, "opacity": 1.0
  },
  "timing": { "start_frame": 24, "end_from_audio": "assets/audio/line1.wav" },
  "audio": "assets/audio/line1.wav",
  "slots": { /* optional, see Slots */ },
  "children": [ /* optional, see Cut-out rig nesting */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique within the scene. |
| `character_id` | string | no | Logical character identity, for continuity across scenes and future tooling (the script.txt parser can use this to track a recurring character without caring about per-scene layer ids). |
| `asset` | string | yes | This layer's own root/base image. PNG with alpha recommended; non-alpha images still work (treated as fully opaque). |
| `z` | integer | yes | **Explicit** draw order, ascending (higher `z` draws on top). The background is implicitly behind every layer. |
| `transform` | object | yes | See below. |
| `timing` | object | no | See below. Omit entirely for "visible for the whole scene". |
| `audio` | string | no | This layer's dialogue/sound audio, mixed in starting at the layer's `start_frame`. |
| `slots` | object | no | Drawing-swap slots attached to this layer's own root image. See [Slots](#slots--drawing-swaps-mouths-blinks-hand-poses). |
| `children` | array | no | Cut-out rig parts nested under this layer. See [Cut-out rig nesting](#cut-out-rig-nesting). |

### Transform

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `y` | number | — (required) | Canvas-space position of the **anchor point** (not the top-left corner). |
| `scale` | number > 0 | `1.0` | Uniform scale. |
| `anchor` | enum | `"bottom-center"` | One of `top-left`, `top-center`, `top-right`, `center-left`, `center`, `center-right`, `bottom-left`, `bottom-center`, `bottom-right`. `bottom-center` is the default because it's the natural "feet on the ground" anchor for a standing character. |
| `flip_x` | boolean | `false` | Mirrors the asset horizontally. Flipping does **not** change anchor semantics -- the anchor box doesn't move, only the pixel content inside it mirrors. |
| `rotation` | number (degrees) | `0` | Clockwise, around the anchor point. |
| `opacity` | number 0-1 | `1.0` | Multiplies the asset's own per-pixel alpha. |

**Off-screen layers are clipped, not skipped.** A character walking in from
off-frame, or a tall layer that extends above/below the canvas, renders
whatever portion of it overlaps the canvas. Only a layer that is *entirely*
outside the canvas draws nothing.

### Timing

Omit `timing` entirely for a layer visible for the whole scene. Otherwise:

| Field | Type | Default | Notes |
|---|---|---|---|
| `start_frame` | integer | `0` | Scene-relative. |
| `end_frame` | integer | scene length | Hand-set end frame. Mutually exclusive with `end_from_audio`. |
| `end_from_audio` | string | — | Path to an audio file; `end_frame = start_frame + round(duration_seconds * fps)`. Mutually exclusive with `end_frame`. |

## Slots / drawing-swaps (mouths, blinks, hand poses)

A layer (or a [rig child](#cut-out-rig-nesting)) can carry any number of
named **slots** -- Toon Boom/Moho style drawing-swap attachment points. Each
slot shows exactly one named drawing at a time, held until it's told to
change. **This is one unified mechanism for mouths, blinks and hand poses**
-- only the *driver* differs:

- a `keyframes`-driven slot holds a drawing until the next keyframe (a
  blink, a hand changing from an open palm to a fist, ...);
- a `lipsync`-driven slot is fed by Rhubarb cue timings -- a mouth is simply
  a slot whose driver happens to be lip-sync cues instead of hand-authored
  keyframes.

```json
"slots": {
  "mouth": {
    "offset": { "x": 0, "y": -558 },
    "images": {
      "A": "assets/mouths/stuart/A.png",
      "B": "assets/mouths/stuart/B.png",
      "...": "...",
      "X": "assets/mouths/stuart/X.png"
    },
    "lipsync": {
      "cues": "assets/cues/line1_cues.json",
      "audio": "assets/audio/line1.wav"
    }
  },
  "eyes": {
    "offset": { "x": 0, "y": -624 },
    "images": { "open": "assets/eyes/stuart/open.png", "closed": "assets/eyes/stuart/closed.png" },
    "keyframes": [
      { "frame": 0, "drawing": "open" },
      { "frame": 34, "drawing": "closed" },
      { "frame": 38, "drawing": "open" }
    ]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `offset.x` / `offset.y` | number | no (default 0,0) | Where this slot's drawing sits, relative to its owner's anchor/pivot point, in the owner's **local (pre-scale) pixel space**. Automatically scaled with the owner and mirrored in `x` when the owner is flipped, so it tracks the face/part through scale/flip changes. |
| `images` | object | yes | Map of drawing name -> image path. A `lipsync`-driven slot's names must be Rhubarb shapes (`A`-`H`, `X`); a `keyframes`-driven slot's names can be anything (`"fist"`, `"open"`, ...). A missing drawing at render time falls back to `"X"` if present, else the first entry. |
| `keyframes` | array | exactly one of `keyframes`/`lipsync` | `{ frame, drawing }`, sorted ascending by `frame`. The drawing is **held until the next keyframe's frame is reached**. Frames are relative to the slot's owner's own `start_frame`. Before the first keyframe, the first keyframe's drawing is used. |
| `lipsync` | object | exactly one of `keyframes`/`lipsync` | See [Lip-sync cue resolution order](#lip-sync-cue-resolution-order) below. |

Slots on the same owner are drawn in the order given in the JSON, after
that owner's own image. A layer's `slots` attach to its own root image; a
child's `slots` (see below) attach to that specific part instead -- e.g. put
a `mouth` slot on a `head` child in a full rig, rather than on the layer
root.

### Lip-sync cue resolution order

This is the important bit for making renders reliable without requiring
every machine to have Rhubarb installed:

1. **If a `cues` file already exists on disk** (either the explicit `cues`
   path, or, when only `audio` is given, the default cache path
   `"<audio>.rhubarb.json"` next to it), it is loaded directly and **Rhubarb
   is never invoked.** A committed cues file is the primary source of truth.
2. **Else, if the `audio` file is given and a `rhubarb` binary is found on
   PATH**, it's run once and the result is written to the `cues` path (so
   the next render reuses it instead of re-running Rhubarb).
3. **Else**, this does not fail the render: it prints a warning and the
   slot falls back to its idle (`X`) shape for its whole duration. A
   missing Rhubarb install must never halt a render.

The sample project ships a committed `assets/cues/line1_cues.json`, so
`worker/python/scripts/generate_sample_assets.py` + the sample render work
with **zero** Rhubarb installation.

See the [README](../README.md#rhubarb-lip-sync-optional) for how to install
Rhubarb if you want to generate cues from new audio.

### Cue format

A cues file is Rhubarb's own JSON output format:

```json
{
  "metadata": { "soundFile": "line1.wav", "duration": 2.5 },
  "mouthCues": [
    { "start": 0.0, "end": 0.21, "value": "X" },
    { "start": 0.21, "end": 0.42, "value": "B" }
  ]
}
```

At render time, for a given frame the compositor converts the frame index to
a scene/layer-relative timestamp (`frame / fps`) and picks whichever cue's
`[start, end)` range contains it.

## Cut-out rig nesting

A layer can carry `children`: separate parts (head, arm, hand, ...) nested
under it with their own position, scale, flip and draw order **relative to
the parent root**. The parent's own `transform` (position, scale, `flip_x`)
applies to every child automatically, so flipping the whole character or
walking it on/off-screen keeps all its parts aligned and clipped together as
one unit.

```json
"children": [
  {
    "id": "right_arm",
    "asset": "assets/parts/stuart_arm.png",
    "z": 1,
    "offset": { "x": -170, "y": -480 },
    "pivot": "top-center",
    "slots": {
      "hand": {
        "offset": { "x": 0, "y": 230 },
        "images": { "open": "assets/parts/stuart_hand_open.png", "fist": "assets/parts/stuart_hand_fist.png" },
        "keyframes": [
          { "frame": 0, "drawing": "open" },
          { "frame": 30, "drawing": "fist" },
          { "frame": 50, "drawing": "open" }
        ]
      }
    }
  }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique within the parent layer. |
| `asset` | string | yes | This part's image. |
| `z` | integer | yes | Draw order **relative to the parent's own base image and sibling children only** -- the parent's own image is implicitly `z = 0` among its children (e.g. an arm behind the torso uses `z < 0`; one in front uses `z > 0`). This stacking is local to the parent; it does not interleave with other top-level scene layers' `z`. |
| `offset.x` / `offset.y` | number | no (default 0,0) | In the parent's local (pre-scale) pixel space, from the parent's anchor point to this child's pivot point. Mirrored in `x` when the parent is flipped. |
| `pivot` | enum | no (default `"center"`) | Which point of this child's own (post-scale) bounding box sits at `offset` -- also the rotation center. Same enum as a layer's `transform.anchor`. |
| `scale` | number > 0 | no (default `1.0`) | Multiplies the **parent's own** scale. |
| `flip_x` | boolean | no (default `false`) | Composed with the parent's `flip_x` via XOR: `false` (default) means this part simply mirrors along with the parent (the common case); `true` gives it an *independent* mirror on top of that (e.g. a hand drawn facing the "wrong" way in its source art). |
| `rotation` | number (degrees) | no (default `0`) | Clockwise, around this child's own `pivot`. |
| `opacity` | number 0-1 | no (default `1.0`) | Multiplies the **parent's own** opacity. |
| `slots` | object | no | Drawing-swap slots attached to this specific child instead of the parent root (e.g. a hand-pose slot on an arm, or a mouth slot on a head). |

**Known limitations, by design** (documented rather than solved here, to
keep this PR's scope sensible):

- **Children are a single level deep.** A child cannot itself have
  children. One level covers "head, arms, hands" style rigs; deeper
  recursion (fingers on a hand on an arm on a body) would need a proper
  scene-graph/transform-stack rewrite.
- **A rotating parent's `transform.rotation` is not composed into its
  children's placement.** The parent's own base image still rotates
  correctly around its own anchor; each child also rotates correctly around
  its own `pivot`. What's *not* done is rotating each child's `offset`
  vector together with the parent -- so if the parent layer itself spins,
  its children stay at their unrotated offset instead of swinging around
  with it. Composing the two correctly needs a real 2D affine transform
  chain (rotate-then-translate order matters), which is more machinery than
  this PR's "simplest working version" scope called for.

## Camera

Deliberately minimal, structured so it can grow:

```json
"camera": {
  "keyframes": [
    { "frame": 0, "zoom": 1.0 },
    { "frame": 65, "x": 1000, "y": 500, "zoom": 1.08 }
  ],
  "shake": { "amplitude_px": 4, "frequency_hz": 10, "start_frame": 10, "end_frame": 40 }
}
```

- `keyframes`: `{ frame, x?, y?, zoom? }`, linearly interpolated between
  consecutive keyframes by frame number. `x`/`y` default to canvas center;
  `zoom` defaults to `1.0` (no zoom; the full canvas is visible). `zoom > 1`
  zooms in.
- `shake`: a simple additive sine-based jitter, active between
  `start_frame`/`end_frame` (default: whole scene).

**Known limitation:** the camera is applied as a post-process crop + resize
on the already-composited, canvas-resolution frame (there's no separate
higher-resolution "world" to re-render from a new viewpoint). Zooming in
therefore re-samples already-rendered pixels rather than revealing more
detail. This is fine for the kind of modest pans/zooms used in cut-out
animation; it would need revisiting if large zoom-ins become common.

## Mouth shape reference (Rhubarb)

| Shape | Typical mouth position |
|---|---|
| `A` | Closed, relaxed (M, B, P sounds) |
| `B` | Slightly open (consonants like K, S, T) |
| `C` | Open, mid-height (EH, AE vowels) |
| `D` | Wide open (AA vowel) |
| `E` | Rounded, medium (ER, AO) |
| `F` | Puckered (OO, W) |
| `G` | Teeth on lip (F, V) |
| `H` | Tongue visible (L) |
| `X` | Idle/closed (silence) |

(Approximate -- see [Rhubarb's own documentation](https://github.com/DanielSWolf/rhubarb-lip-sync#mouth-shapes) for the authoritative descriptions.)
