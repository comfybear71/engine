# `timeline.json` schema reference

This is the shared contract between the Studio (which will write this file)
and the render worker (which validates and renders it). The machine-readable
schema lives at [`schema/timeline.schema.json`](../schema/timeline.schema.json)
(JSON Schema draft-07); this document explains every field in prose with the
reasoning behind it, for whoever writes the `script.txt` -> `timeline.json`
parser next.

A complete, working example lives at
[`projects/sample/timeline.json`](../projects/sample/timeline.json) -- note
that file is *generated* by the script parser
(`node src/cli.js parse projects/sample`) from
[`projects/sample/script.txt`](../projects/sample/script.txt); see
[docs/script-format.md](script-format.md) if you're authoring a script
rather than hand-writing a timeline.

## Ground rules

- **All asset/audio paths are relative to the project folder** -- the
  directory containing `timeline.json` itself -- never to the current
  working directory of whatever process is reading the file. A path like
  `"../_global_assets/characters/hicks/body.png"` in
  `projects/sample/timeline.json` resolves to
  `projects/_global_assets/characters/hicks/body.png` regardless of
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
| `layers` | array of [Layer](#layer) | no | Drawn back-to-front by `z`. Character layers and location-prop layers share this list; the background stays behind every layer. |

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

A scene's length can be hand-set or derived from audio, satisfying "timing
should be able to come from audio, not just a hand-typed total" while still
allowing a hand-typed value when there's no audio to derive it from. Exactly
one of:

```json
{ "frames": 150 }
```
```json
{ "from_audio": "assets/audio/line1.wav", "padding_frames": 6 }
```
```json
{ "from_dialogue": true, "padding_frames": 12 }
```

- `frames`: hand-set frame count.
- `from_audio`: probes one audio file's duration (via `ffprobe`) and
  computes `round(duration_seconds * fps) + padding_frames`.
- `from_dialogue`: for scenes built from a script with several lines per
  character (see [Multi-line dialogue](#multi-line-dialogue-per-character)
  below) -- the scene runs until the *latest* line finishes across every
  layer's `dialogue` list (`max(layer.timing.start_frame + clip.start_frame +
  that clip's own audio duration)`), plus `padding_frames`. This is what the
  script parser emits.

`padding_frames` (default 0, both modes) is useful for holding the last
frame briefly after the audio/dialogue ends.

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
  "id": "hicks",
  "character_id": "hicks",
  "asset": "../_global_assets/characters/hicks/body.png",
  "z": 10,
  "transform": {
    "x": 800, "y": 1080, "scale": 1.15,
    "anchor": "bottom-center", "flip_x": false,
    "rotation": 0, "opacity": 1.0
  },
  "transform_keyframes": [ /* optional, see Transform keyframes */ ],
  "view_keyframes": [ /* optional, held head/mouth/eyes view */ ],
  "timing": { "start_frame": 24, "end_from_audio": "audio/scene1/004_hicks.wav" },
  "dialogue": [ /* optional, see Multi-line dialogue per character */ ],
  "slots": { /* optional, see Slots */ },
  "children": [ /* optional, see Cut-out rig nesting */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique within the scene. A character that's repositioned mid-scene gets a second layer id (e.g. `hicks_2`), same `character_id`, back-to-back in `timing` -- see [Multi-line dialogue](#multi-line-dialogue-per-character). A prop that's moved, re-z'd, or hidden/shown mid-scene forks the same way (`letterbox_2`, same `prop_id`). |
| `character_id` | string | no | Logical character identity, for continuity across scenes and tooling (the script parser uses this to track a recurring character and to resolve its [asset library](assets.md) entry). |
| `prop_id` | string | no | Logical location-prop identity when this layer is a still object declared under `backgrounds/<location>/staging.json` `props` (see [docs/assets.md#props](assets.md#props)). The compositor draws prop and character layers together in ascending `z`. |
| `insert_id` | string | no | Insert-still identity from `[Insert: image=…]`. A PNG held for `timing.start_frame`..`end_frame` (a cutaway). Drawn in z order with other layers. |
| `sequence` | object | no | Flipbook from `[Clip: Name action]`. `{ frames: string[], fps: number, trim_in?: seconds }`. While the layer is visible the image drawn is `frames[floor((trim_in + local_frame / project_fps) * fps)]` (clamped to the last frame) instead of `asset`; `asset` is the first frame. `transform` places it like any layer. |
| `asset` | string | yes | This layer's own root/base image. PNG with alpha recommended; non-alpha images still work (treated as fully opaque). |
| `z` | integer | yes | **Explicit** draw order, ascending (higher `z` draws on top). The background is implicitly behind every layer. |
| `transform` | object | yes | See below. |
| `transform_keyframes` | array | no | Optional per-property animation of `x`/`y`/`scale`/`rotation`. See [Transform keyframes](#transform-keyframes). |
| `view_keyframes` | array | no | Optional held-until-changed head/mouth/eyes view (`{ frame, view }`, layer-local). A silent walk or `[Do:]` writes the action's view and restores the previous view at the end. A silent `[View:]` writes the new view from that frame. An active dialogue clip's own `view` wins while that line is playing. |
| `timing` | object | no | See below. Omit entirely for "visible for the whole scene". |
| `dialogue` | array of [dialogue clip](#multi-line-dialogue-per-character) | no | This character's spoken lines in the scene. See below. |
| `audio` | string | no, **deprecated** | Single-clip shorthand kept for backward compatibility: equivalent to `dialogue: [{ audio, start_frame: 0 }]` (the clip begins when the layer becomes visible). Ignored if `dialogue` is also given; prefer `dialogue` for anything with more than one line. |
| `slots` | object | no | Drawing-swap slots attached to this layer's own root image. See [Slots](#slots--drawing-swaps-mouths-blinks-hand-poses). |
| `groups` | object | no | Optional slot groups from `character.json`. `head` lists the one-head rig slots; see [docs/assets.md#one-head-rig](assets.md#one-head-rig). |
| `group_rotations` | object | no | Rest pose for each named group, clockwise degrees about that group's pivot. |
| `group_rotation_keyframes` | object | no | Map of group name -> `{ frame, rotation, ease? }` list. The whole group rotates rigidly about the group pivot (typically the neck). Flip mirrors the angle. Combines with automatic dialogue head-bob. |
| `children` | array | no | Cut-out rig parts nested under this layer. See [Cut-out rig nesting](#cut-out-rig-nesting). |

## Multi-line dialogue per character

Real scenes have many lines per character, not one. A character layer
carries a *list* of dialogue clips instead of a single `audio` field:

```json
"dialogue": [
  { "audio": "audio/scene1/001_hicks.wav", "start_frame": 0, "text": "Where's the rent money, Dana?" },
  { "audio": "audio/scene1/003_hicks.wav", "start_frame": 120, "text": "Friday was last Friday too." }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `audio` | string | yes | This line's audio file. |
| `start_frame` | integer | yes | Relative to the owning layer's `timing.start_frame` (layer-local): a clip at 0 on a layer that starts at 47 plays at scene frame 47. Typically computed by the script parser from the running total of prior lines/pauses in the scene minus that layer segment's start (see [docs/script-format.md](script-format.md)), but may be hand-set. |
| `cues` | string | no | This clip's Rhubarb cues JSON. Defaults to `"<audio>.rhubarb.json"` -- same [resolution order](#lip-sync-cue-resolution-order) as any other lipsync source. |
| `text` | string | no | The spoken line text. Used as Rhubarb's `--dialogFile` hint if cues must be generated from audio, and purely informational otherwise (it's what ends up in `lines.json` for a future ElevenLabs generation step). |
| `view` | string | no | Head/mouth set for this line: `front`, `left_34`, `left_side`, `right_34`, `right_side`, `up`, `down`, `back`. The compositor looks up `slot.images_by_view[view]`, then `front`, then `images`. `back` does not fall back to front when that view folder is missing — the slot (eyes, mouth) draws nothing. |
| `trim_in` | number | no | In-point in seconds from the start of the source audio file. Playback, Rhubarb cues, and duration use `[trim_in, trim_out)`. |
| `trim_out` | number | no | Out-point in seconds from the start of the source file. Omit to use the file end. |
| `words` | array | no | Optional word-level timestamps from `import-audio` / ElevenLabs Speech-to-Text: `[{ "word": "Hello", "start": 0.0, "end": 0.32 }, ...]`. Times are seconds from the start of this clip's **source** audio (not shifted by `trim_in`). The Studio Dialogue lane can show them. The compositor uses them (or WAV loudness peaks when they are missing) to place a subtle head bob on mouth/face/eyes slots. |

Every clip's audio is mixed into the final render at
`scene_start + layer.start_frame + clip.start_frame`. A `slots.mouth` with
`lipsync.source: "dialogue"` (see below) automatically shows each clip's own
cues within that clip's `[start_frame, start_frame + its audio duration)`
window, and the idle (`"X"`) shape in the gaps between lines -- so a
character's mouth closes between sentences instead of holding whatever
shape the last line ended on.

Clips may be listed in any order in the JSON; they're sorted by
`start_frame` when loaded. Overlapping clips on the *same* layer aren't
meaningful (a character can't speak two lines at once) and aren't
specifically validated against, but mixing engines mixing overlapping audio
on one layer is undefined behavior you shouldn't rely on.

### Transform

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `y` | number | — (required) | Canvas-space position of the **anchor point** (not the top-left corner). |
| `scale` | number > 0 | `1.0` | Uniform scale. |
| `anchor` | enum | `"bottom-center"` | One of `top-left`, `top-center`, `top-right`, `center-left`, `center`, `center-right`, `bottom-left`, `bottom-center`, `bottom-right`. `bottom-center` is the default because it's the natural "feet on the ground" anchor for a standing character. |
| `flip_x` | boolean | `false` | Mirrors the asset horizontally. Flipping does **not** change anchor semantics -- the anchor box doesn't move, only the pixel content inside it mirrors. |
| `rotation` | number (degrees) | `0` | Clockwise, around the anchor point. The pivot stays fixed: after the image is rotated (the canvas expands so nothing is clipped) the compositor places the result so the original anchor still sits at `x`/`y`. |
| `opacity` | number 0-1 | `1.0` | Multiplies the asset's own per-pixel alpha. |

`flip_x` is **not** keyframed. To turn a character around, add a second
layer (same `character_id`, back-to-back `timing`) with `flip_x: true`.

**Off-screen layers are clipped, not skipped.** A character walking in from
off-frame, or a tall layer that extends above/below the canvas, renders
whatever portion of it overlaps the canvas. Only a layer that is *entirely*
outside the canvas draws nothing.

### Transform keyframes

```json
"transform": { "x": 400, "y": 1080, "anchor": "bottom-center" },
"transform_keyframes": [
  { "frame": 0, "x": 400 },
  { "frame": 48, "x": 1200, "ease": "inout" },
  { "frame": 48, "rotation": 0 },
  { "frame": 72, "rotation": 12 }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `frame` | integer | yes | Layer-local (relative to this layer's `timing.start_frame`), same clock as slots. |
| `x`, `y`, `scale`, `rotation` | number | no | Each keyframe may specify any subset. A property is interpolated only between keyframes that mention it. Properties never mentioned keep the static `transform` value. |
| `ease` | `"linear"` or `"inout"` | no | How to interpolate **from this keyframe to the next one that specifies the same property**. Default `"linear"` (same lerp as [camera](#camera) keyframes). `"inout"` is a smoothstep ease-in-out. |

Held before the first keyframe that specifies a property and after the last
-- same hold-ends rule as the camera interpolator. Omit the whole array for
a pose that never moves (existing timelines keep rendering identically).

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
  blink, a hand changing from an open palm to a fist, ...), or loops a
  `cycle` of drawings at a given `fps` until the next keyframe;
- a `lipsync`-driven slot is fed by Rhubarb cue timings. Two forms:
  - `lipsync.source: "dialogue"` -- the normal case for a character's mouth:
    pulls its cue timeline from the owning layer's `dialogue` list (see
    [Multi-line dialogue](#multi-line-dialogue-per-character)), handling any
    number of lines and the idle gaps between them automatically. Requires
    the layer to have a non-empty `dialogue`.
  - `lipsync.cues`/`lipsync.audio` (no `source`) -- a single cues/audio pair
    for one-off lip-synced sounds that aren't part of a dialogue list (a
    grunt, a laugh, ...).

```json
"slots": {
  "body": {
    "offset": { "x": 0, "y": 0 },
    "images": { "front": ".../body_front.png", "back": ".../body_back.png" },
    "keyframes": [
      { "frame": 0, "drawing": "front" },
      { "frame": 120, "drawing": "back" }
    ]
  },
  "mouth": {
    "offset": { "x": 0, "y": -558 },
    "images": {
      "A": "../_global_assets/characters/hicks/mouth/A.png",
      "B": "../_global_assets/characters/hicks/mouth/B.png",
      "...": "...",
      "X": "../_global_assets/characters/hicks/mouth/X.png"
    },
    "lipsync": { "source": "dialogue" },
    "visible_when": { "body": ["front"] }
  },
  "eyes": {
    "offset": { "x": 0, "y": -624 },
    "images": { "open": "../_global_assets/characters/hicks/eyes/open.png", "closed": "../_global_assets/characters/hicks/eyes/closed.png" },
    "keyframes": [
      { "frame": 0, "drawing": "open" },
      { "frame": 34, "drawing": "closed" },
      { "frame": 38, "drawing": "open" }
    ]
  },
  "walk": {
    "offset": { "x": 0, "y": 0 },
    "images": { "s1": ".../step1.png", "s2": ".../step2.png", "s3": ".../step3.png" },
    "keyframes": [
      { "frame": 0, "cycle": ["s1", "s2", "s3"], "fps": 8 },
      { "frame": 48, "drawing": "s1" }
    ]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `offset.x` / `offset.y` | number | no (default 0,0) | Where this slot's drawing sits, relative to its owner's anchor/pivot point, in the owner's **local (pre-scale) pixel space**. Automatically scaled with the owner, mirrored in `x` when the owner is flipped, and rotated about the owner's pivot by the owner's current rotation, so it tracks the face/part through scale/flip/swing. When `canvas.pivot` is set, that image-space point (the neck) is placed here instead of the image centre. |
| `z` | integer | no (default 0) | Draw order among slots on the same owner. Sorted by `(z, declaration order)`. |
| `canvas` | object | no | `{ w, h, pivot: { x, y } }`. Fixed drawing size and neck pivot for a one-head rig slot. Omit for today's centred placement. |
| `scale` | number > 0 | no (default `1.0`) | Uniform scale of this slot's drawing around its center (the offset point). Multiplies the owner's scale, so the attachment point stays put when the drawing is resized. |
| `align` | object | no | Per-drawing Scale/Nudge from Studio Assets Save (`character.json` `slots.<slot>.drawings.<name>.align`). Map of drawing name -> `{ x, y, scale }`. `x`/`y` are local pixels added to this slot's offset; `scale` multiplies this slot's scale. The drawing stays anchored at the resulting attachment point (image centre, or `canvas.pivot` when set). Missing drawing: identity `(0, 0, 1)`. |
| `rotation` | number | no (default `0`) | Degrees, clockwise, around this slot's center. Added to the owner's current rotation. |
| `images` | object | yes | Map of drawing name -> image path. A `lipsync`-driven slot's names must be Rhubarb shapes (`A`-`H`, `X`); a `keyframes`-driven slot's names can be anything (`"fist"`, `"open"`, ...). A missing drawing at render time falls back to `"X"` if present, else the first entry. |
| `images_by_view` | object | no | Optional map of head view -> drawing name -> path (`mouth_left_side/`, …). Used when the layer's `view_keyframes` or an active dialogue clip has `view`. Missing views fall back to `front`, then `images`, except `back`: a view-aware slot with no `images_by_view.back` (no `<slot>_back/` folder) is hidden. |
| `keyframes` | array | exactly one of `keyframes`/`lipsync` | Sorted ascending by `frame`. Each entry is either `{ frame, drawing }` (held until the next keyframe) or `{ frame, cycle: [drawing, ...], fps }` (loops those drawings from this frame until the next keyframe). `drawing` may be `"none"` to hide the slot. A keyframe with only `frame` is invalid. Cycle index is `floor((frame - keyframe.frame) / document_fps * cycle.fps) % len(cycle)`. A scene `frame_step` of N>1 already holds the picture on in-between frames, so the cycle is only evaluated on recomputed frames. Frames are relative to the slot's owner's own `start_frame`. Before the first keyframe, the first keyframe's drawing/cycle is used. Empty `keyframes` is allowed when the slot has no default drawing yet. |
| `visible_when` | object | no | Map of `<slot name>` -> list of drawings. This slot only draws when each named slot's *currently active* drawing is in that list. Names are resolved on the same layer (the layer's own slots and every child's slots). Example: `"visible_when": { "body": ["front"] }` hides a mouth while the body slot is showing the back view. |
| `lipsync` | object | exactly one of `keyframes`/`lipsync` | See [Lip-sync cue resolution order](#lip-sync-cue-resolution-order) below. |

Slots on the same owner are drawn in the order given in the JSON, after
that owner's own image. A layer's `slots` attach to its own root image; a
child's `slots` (see below) attach to that specific part instead -- e.g. put
a `mouth` slot on a `head` child in a full rig, rather than on the layer
root.

### Lip-sync cue resolution order

This is the important bit for making renders reliable without requiring
every machine to have Rhubarb installed. It applies per cues/audio pair --
for a `source: "dialogue"` mouth slot, that means *per dialogue clip*,
independently:

1. **If a `cues` file already exists on disk** (either the clip's explicit
   `cues` path, or the default cache path `"<audio>.rhubarb.json"` next to
   its audio), it is loaded directly and **Rhubarb is never invoked.** A
   committed cues file is the primary source of truth.
2. **Else, if that clip's audio file exists and a `rhubarb` binary is found
   on PATH**, it's run once and the result is written to the cues path (so
   the next render/clip reuses it instead of re-running Rhubarb).
3. **Else**, this does not fail the render: it prints a warning and that
   clip's portion of the mouth falls back to the idle (`X`) shape. A
   missing Rhubarb install must never halt a render.

The sample project's lines all ship committed `audio/<scene>/<nnn>_<char>.wav.rhubarb.json`
cues files (see `worker/python/scripts/generate_sample_audio.py`), so parsing
and rendering it works with **zero** Rhubarb installation.

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

After cues are loaded, `compositor.lipsync_natural` (shared by Render and
the Stage preview) applies, all optional and all no-ops when art is missing:

1. **Minimum hold** — no shape shorter than 2 frames at 24 fps; sub-2-frame
   cues merge into a neighbour. A closed-mouth `A` that already lasts 2+
   frames is kept (a real M/B/P between words).
2. **Smoothing** — `lipsync.smoothing` `off` / `light` (default) / `medium`.
   Light collapses a 1-frame flicker such as C-B-C within 3 frames.
3. **Loud variants** — for shapes B, C, D, E, if RMS over that cue is above
   the clip's configured percentile (default ~75th, `lipsync.loud_threshold`
   in `studio.json` or `character.json`) the compositor looks for
   `B_loud.png` (and the same name under `mouth_<view>/`). Missing loud
   files stay on the normal drawing.
4. **Head bob** — `lipsync.head_bob` `off` / `subtle` (default) / `strong`.
   Stressed words (from `words`) or loudness peaks add a 6-frame down-and-back
   offset (4–10 px, ±1–1.5°) on `mouth` / `face` / `eyes` only.
5. **Auto blinks** — if `eyes` has a `closed` drawing, seeded blinks every
   3–6 s (`blinks: { every: [3, 6], frames: 5 }` on the character). Off
   when there is no closed drawing, or during a held `eyes=` pin.

See [docs/assets.md](assets.md#thirteen-mouths-per-view) for the 13-file
naming (`X`, `A`–`H`, `B_loud`, `C_loud`, `D_loud`, `E_loud` per view).

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
    "id": "upper_arm",
    "asset": "../_global_assets/characters/hicks/parts/upper_arm.png",
    "z": 1,
    "offset": { "x": -170, "y": -480 },
    "pivot": "top-center",
    "rotation_keyframes": [
      { "frame": 0, "rotation": 0 },
      { "frame": 24, "rotation": 40, "ease": "inout" }
    ]
  },
  {
    "id": "forearm",
    "asset": "../_global_assets/characters/hicks/parts/forearm.png",
    "z": 2,
    "parent": "upper_arm",
    "offset": { "x": 0, "y": 180 },
    "pivot": "top-center",
    "rotation_keyframes": [
      { "frame": 0, "rotation": 0 },
      { "frame": 24, "rotation": 25 }
    ],
    "slots": {
      "right_hand": {
        "offset": { "x": 0, "y": 160 },
        "images": { "flat": "../_global_assets/characters/hicks/right_hand/flat.png", "point": "../_global_assets/characters/hicks/right_hand/point.png" },
        "keyframes": [
          { "frame": 0, "drawing": "flat" },
          { "frame": 252, "drawing": "point" }
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
| `offset.x` / `offset.y` | number | no (default 0,0) | In the parent's local (pre-scale) pixel space, from the parent's pivot (the layer anchor, or the named `parent` child's pivot) to this child's pivot. Mirrored in `x` when that parent is flipped. When `parent` is another child, this offset is also rotated about that parent's pivot by the parent's current rotation. |
| `parent` | string | no | Id of another child on the same layer that this child hangs off (e.g. `forearm` of `upper_arm`, `hand` of `forearm`). The named parent must exist and must not create a cycle -- the loader rejects both. Chains may be any depth; the compositor places parent before child. Slots on this child follow the nested placement. |
| `pivot` | enum or `{x, y}` | no (default `"center"`) | Which point of this child's own (post-scale) image sits at `offset` -- also the rotation center. A named box anchor (same enum as a layer's `transform.anchor`) or `{x, y}` in unscaled image pixels (loaded as `pivot_px` and drawn like a canvas slot). After rotate+canvas-expand, this point stays fixed at `offset`. |
| `visible_when` | object | no | Same gate as [slot `visible_when`](#slots): this child and its children only draw when each named slot's active drawing is in the list. |
| `scale` | number > 0 | no (default `1.0`) | Multiplies the **parent's own** scale. |
| `flip_x` | boolean | no (default `false`) | Composed with the parent's `flip_x` via XOR: `false` (default) means this part simply mirrors along with the parent (the common case); `true` gives it an *independent* mirror on top of that (e.g. a hand drawn facing the "wrong" way in its source art). |
| `rotation` | number (degrees) | no (default `0`) | Clockwise, around this child's own `pivot`. Used when `rotation_keyframes` is omitted. Added to the parent's current rotation (the layer's `transform.rotation` for a top-level child). When this child is someone else's `parent`, rotations accumulate (grandchild world rotation = parent rotation + own rotation). |
| `rotation_keyframes` | array | no | `{ frame, rotation, ease? }`, layer-local frames, same interpolation as [transform keyframes](#transform-keyframes). |
| `opacity` | number 0-1 | no (default `1.0`) | Multiplies the **parent's own** opacity. |
| `slots` | object | no | Drawing-swap slots attached to this specific child instead of the parent root (e.g. a hand-pose slot on a forearm, or a mouth slot on a head). Slot offsets rotate with this child's current (accumulated) rotation. |

**Nesting and layer rotation:** parent chains may be any depth (shoulder
→ elbow → wrist). The loader rejects a missing parent or a cycle. A
layer's `transform.rotation` (whole-body lean) is composed into every
child's offset and world rotation about the layer anchor, so children
and their slots follow a `[Do:]` `body_rotation` track.

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

- `keyframes`: `{ frame, x?, y?, zoom?, ease? }`, interpolated between
  consecutive keyframes by frame number. `x`/`y` default to canvas center;
  `zoom` defaults to `1.0` (no zoom; the full canvas is visible). `zoom > 1`
  zooms in. `ease` is `"linear"` (default, same lerp as before) or
  `"inout"` (smoothstep), taken from the departing keyframe -- same as
  [transform keyframes](#transform-keyframes). The script parser writes
  these from `[Camera:]` tags (see [docs/script-format.md](script-format.md));
  omit the whole `camera` object when the scene never moves the camera.
- `shake`: a simple additive sine-based jitter, active between
  `start_frame`/`end_frame` (default: whole scene). Not authored by
  `[Camera:]` tags.

The compositor folds the camera into each layer's placement (and the
background sample) before drawing, so a zoom resamples each cut-out once
from its source PNG instead of cropping and upscaling the finished
1920×1080 frame. At zoom 1 with the centre on the canvas centre the
camera path is skipped and the frame matches a render with no camera.

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
