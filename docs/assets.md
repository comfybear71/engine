# Shared asset library layout

This describes `projects/_global_assets/`: the shared library of characters
and backgrounds the [script parser](script-format.md) draws on, plus how a
show and an individual episode project can override any piece of it.

All folder and file names in the library are **snake_case**. A drawing's
*name* (what you write after `=` in an `[Action: ...]` tag, or what Rhubarb
emits as a mouth shape) is always its filename without extension.

## Layout

```
projects/
├── _global_assets/                    # global library (every show + every experiment)
│   ├── staging_defaults.json
│   ├── backgrounds/<location>/{bg.png,staging.json,props/}
│   └── characters/<character_id>/
└── <experiment>/                      # ungrouped flat project (same layout as an episode)
    ├── script.txt
    └── …

shows/
└── <show-id>/
    ├── show.json                      # name, description, optional thumbnail
    ├── characters/                    # show-level shared art (same layout as _global_assets)
    ├── backgrounds/
    ├── props/
    ├── episodes/<episode-id>/         # existing-style project: script, audio, renders, local overrides
    └── final/
        ├── cut.json                   # ordered final-cut items + trims / gap / fade
        └── <name>.mp4
```

Lookup order for every character / prop / background file is **episode →
show**, then **global only if the project’s Independent setting is off**.
`_global_assets` stays an optional shared library. It is never written
by Studio or the parser.

**Independent** (`studio.json` `"independent": true`) is **on by default**
for new and existing projects: asset lookup uses only the project folder
(and the show folder for an episode). The shared library is skipped, so
a drawing you deleted in a project cannot come back from
`projects/_global_assets`. Set `"independent": false` to turn the old
fallback back on. The committed `projects/sample` demo does that so it
can keep using the shared Hicks/Dana library. **Make independent** in
Studio copies every global character, location, prop, and
`staging_defaults.json` the project currently uses into the project
folder, skips files already in `_trash/` / `_replaced/`, then turns
Independent on.

Show-level files still override the project’s missing files; an episode
file at the same relative path overrides the show. Flat projects under
`projects/` have no show layer, so with Independent on they resolve
only inside their own folder.

The sample project's library has two characters (`hicks`, `dana`) and two
locations (`bedroom`, `corridor`) built this way -- see
`worker/python/scripts/generate_global_assets.py` for exactly how they were
generated (everything is drawn programmatically, no binary art checked in
beyond the generated PNGs/WAVs themselves).

## `character.json`

```json
{
  "id": "hicks",
  "display_name": "Hicks",
  "aliases": ["Hicks"],
  "asset": "body.png",
  "z": 10,
  "default_scale": 1.0,
  "default_flip_x": false,
  "voice_id": null,
  "reference": "_reference/full.png",
  "slots": {
    "mouth": { "offset": { "x": 0, "y": -558 }, "drawings_dir": "mouth", "scale": 1.0, "rotation": 0 },
    "eyes": { "offset": { "x": 0, "y": -624 }, "drawings_dir": "eyes", "default_drawing": "open" }
  },
  "children": [
    {
      "id": "right_arm",
      "asset": "parts/arm.png",
      "z": 1,
      "offset": { "x": -170, "y": -480 },
      "pivot": "top-center",
      "slots": {
        "right_hand": { "offset": { "x": 0, "y": 230 }, "drawings_dir": "right_hand", "default_drawing": "flat" }
      }
    }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | Must match the folder name (`characters/<id>/`). |
| `display_name` | Shown in error messages and used as a script alias automatically. |
| `aliases` | Other names a script may use to refer to this character (e.g. a nickname). Matching is case-insensitive. |
| `asset` | This character's root/base image, relative to the character's own folder. |
| `z` | This character's default draw order (can be overridden per `[Action: ... z=N]`). |
| `default_scale` / `default_flip_x` | Used when neither an `[Action: ...]` tag nor the resolved staging mark specifies that field -- see [mark resolution order](script-format.md#mark-resolution-order) in the script format doc. |
| `voice_id` | Optional identifier for `node src/cli.js voices`. **Never a secret** -- it's a voice *identifier* (e.g. `"EXAVITQu4vr4xnSDxMaL"`), not an API key. `null` means "not assigned yet"; the real API key lives in `.env` as `ELEVENLABS_API_KEY`, never here. See [docs/voices.md](voices.md). |
| `style` | Optional free-text art direction for the Studio Grok Imagine prompt builder (e.g. `"painted semi-real"`, `"flat cartoon"`). Empty or omitted means the prompt falls back to "a consistent character style". See [docs/studio.md](studio.md#image-assets-grok-imagine). |
| `reference` | Optional path, relative to the character folder, to a full-body likeness image (typically `_reference/full.png`). Studio stores the original file — no chroma key or cut-out. Used as a Grok Imagine attach reminder and as the background in **Align head**. |
| `slots` | Map of slot name -> `{ offset, drawings_dir, default_drawing?, cycles?, visible_when?, scale?, rotation?, z?, canvas?, views?, drawings? }`. `drawings_dir` is a folder (relative to the character's own folder) whose image filenames (without extension) become that slot's valid drawing names. `default_drawing` is used for the slot's initial state before any `[Action: ...]` sets it (irrelevant for the `mouth` slot, which is always dialogue-driven). `cycles` is an optional map of cycle name -> `{ drawings: [drawing, ...], fps }` -- `[Action: Name slot=cycle_name]` emits a looping cycle keyframe; a plain drawing name still emits a held drawing. `visible_when` is copied onto the timeline slot as-is (e.g. hide a mouth unless `body` is showing `"front"`). `scale` (default `1.0`) multiplies the owner's scale around the slot center (the offset point). `rotation` (default `0`, clockwise degrees) is added to the owner's rotation around that same center. Optional `z` is draw order among slots on the same owner (ascending; omitted is 0; ties keep `character.json` order). Optional `canvas: { w, h, pivot: { x, y } }` is a fixed drawing size and neck pivot: the pivot pixel is placed at owner + offset and is the scale/rotation centre. Omit `canvas` for today's centred placement. The parser copies `scale`, `rotation`, `z`, and `canvas` onto the timeline slot. Optional `views: true` scans `<drawings_dir>_<view>/` the same way head-group slots do (then `*_front/`, then the base folder), including `<drawings_dir>_back/`. Those slots follow the line's `view=`; they do not get head bob and are not part of the legacy head-hiding set. A view-aware slot (head-group or `views: true`) with no `<slot>_back/` folder draws nothing in the back view — it does not error and does not fall back to front. That is how eyes and mouth stay off when the character faces away. Add `eyes_back/` / `mouth_back/` only if you want overlays on the back of the head. `drawings` is an optional per-drawing map (name -> `{ excludeFromLipSync?: true, hand?: "L"\|"R", align?: { x, y, scale } }`). When `excludeFromLipSync` is set, automatic lip sync (Rhubarb cues and natural lipsync) skips that drawing and falls back to a neighbour — `H` becomes `C` or `D`, or the previous cue — but the file stays in the slot for a manual face/expression pin. `align` is the drawing viewer's saved Scale/Nudge (`{x, y, scale}` in the same local-pixel / multiplier units as the panel). The parser copies it onto the timeline slot; the compositor applies it on top of the slot offset/scale, anchored at the attachment point (image centre, or `canvas.pivot` when set), so a Save shows in Stage preview and renders. Studio **Align head** writes slot-level `offset` / `scale` / `rotation` into a **project-local** `character.json` and never into `_global_assets`. |
| `groups` | Optional. `groups.head` lists the one-head rig slots (blank base + overlays). Opt-in: omit it and existing characters draw as they do today. See [One-head rig](#one-head-rig). |
| `children` | Rig parts, in the same shape as `schema/timeline.schema.json`'s `child` definition (`id`, `asset`, `z`, `offset`, `pivot`, `scale`, `flip_x`, `rotation`, `parent`, `visible_when`), plus their own optional `slots` (same shape as above). `parent` and `pivot` are passed through to the generated timeline. `pivot` is a named box anchor *or* `{x, y}` image pixels. `visible_when` is the same gate as on slots (hidden children and their children are skipped). `parent` names another child on the same character; chains may be any depth (shoulder → elbow → wrist). Cycles are rejected. See [docs/timeline-schema.md#cut-out-rig-nesting](timeline-schema.md#cut-out-rig-nesting). |

The `mouth` slot is special: it's always driven by the character's dialogue
(`lipsync.source: "dialogue"`), so it never has a `default_drawing` and
can't be set via `[Action: ...]` -- see
[docs/script-format.md](script-format.md). Optional per-head-view folders
sit next to it: `mouth/` or `mouth_front/` is the front set; `mouth_left_side/`,
`mouth_right_34/`, and the other `view=` names are used when that line's
`view=` is set. Missing shapes in a view folder fall back to front, then
to `mouth/`.

### Thirteen mouths per view

A full head-turn mouth set is **13 drawings per view**, not just Rhubarb's
nine. Loud variants are optional — if a `*_loud.png` is missing the
compositor keeps the normal shape.

| File | Shape |
|---|---|
| `X.png` | Idle / rest |
| `A.png` | Closed (M, B, P) |
| `B.png` | Slightly open |
| `C.png` | Mid-open (EH) |
| `D.png` | Wide open (AH) |
| `E.png` | Rounded (OH) |
| `F.png` | Puckered (OO, W) |
| `G.png` | Teeth on lip (F, V) |
| `H.png` | Tongue (L). Optional: mark `slots.mouth.drawings.H.excludeFromLipSync` so auto lip sync never uses it. |
| `B_loud.png` | Louder B (optional) |
| `C_loud.png` | Louder C (optional) |
| `D_loud.png` | Louder D (optional) |
| `E_loud.png` | Louder E (optional) |

Folders, one per `view=`:

```
characters/<id>/mouth/            # legacy front (still used if mouth_front/ is empty)
characters/<id>/mouth_front/      # front (default)
characters/<id>/mouth_left_34/
characters/<id>/mouth_left_side/
characters/<id>/mouth_right_34/
characters/<id>/mouth_right_side/
characters/<id>/mouth_up/
characters/<id>/mouth_down/
characters/<id>/mouth_back/       # optional; if missing, mouth is hidden in view=back
```

A line with `view=left_side` looks in `mouth_left_side/B_loud.png`, then
`mouth_left_side/B.png`, then the same names under `mouth_front/` / `mouth/`.
Lint still only requires rest `X` and A–H on the base mouth folder; loud
files and extra views are never required.

Optional `character.json` keys (project `studio.json` `lipsync` overrides
these for a whole episode):

```json
"lipsync": {
  "smoothing": "light",
  "head_bob": "subtle",
  "loud": "auto",
  "loud_threshold": 0.8
},
"blinks": { "every": [3, 6], "frames": 5 }
```

`blinks` is off automatically when the `eyes` slot has no `closed` drawing.
Auto blinks skip a held `[Action: Name eyes=…]` pin. When the active view
has a `half` drawing, a blink is `open → half → closed → half → open` in
the same total length; without `half` it stays `open → closed → open`.
Head bob only offsets `mouth` / `face` / `eyes` slots (not the body).
When `groups.head` is set, bob applies to every slot in that group (the
blank base plus overlays).

## One-head rig

Stage 1 of the rig redesign: **only one head may ever draw**. Eyes and
mouth are overlays on a blank head base. Every drawing in a rig-head slot
is the same canvas size, with a fixed neck pivot, so a swap needs no
per-drawing alignment.

This is opt-in via `groups.head`. Characters without that field are
unchanged.

```json
{
  "groups": { "head": ["head_base", "eyes", "mouth"] },
  "slots": {
    "head_base": {
      "offset": { "x": 0, "y": -200 },
      "drawings_dir": "head_base",
      "default_drawing": "neutral",
      "z": 0,
      "canvas": { "w": 1024, "h": 1024, "pivot": { "x": 512, "y": 900 } }
    },
    "eyes": {
      "offset": { "x": 0, "y": -200 },
      "drawings_dir": "eyes",
      "default_drawing": "open",
      "z": 1,
      "canvas": { "w": 1024, "h": 1024, "pivot": { "x": 512, "y": 900 } }
    },
    "mouth": {
      "offset": { "x": 0, "y": -200 },
      "drawings_dir": "mouth",
      "z": 2,
      "canvas": { "w": 1024, "h": 1024, "pivot": { "x": 512, "y": 900 } }
    }
  }
}
```

All three slots share the same `offset` and the same `canvas.pivot` (the
neck). The compositor places that pivot at owner-anchor + offset; scale
and rotation happen around it. `z` stacks base, then eyes, then mouth.

### File layout

One folder per slot per `view=` (same names as mouth already used).
Missing files in a view folder fall back to `*_front/`, then to the
slot's base folder.

```
characters/<id>/head_base/            # legacy front (used if head_base_front/ is empty)
characters/<id>/head_base_front/
characters/<id>/head_base_left_34/
characters/<id>/head_base_left_side/
characters/<id>/head_base_right_34/
characters/<id>/head_base_right_side/
characters/<id>/head_base_up/
characters/<id>/head_base_down/
characters/<id>/head_base_back/
characters/<id>/eyes/
characters/<id>/eyes_front/
characters/<id>/eyes_left_34/
…
characters/<id>/mouth/
characters/<id>/mouth_front/
…
```

A line with `view=left_34` draws `head_base_left_34` + `eyes_left_34` +
`mouth_left_34` only. `view=back` draws `head_base_back` (and any other
head-group slot that has a `_back` folder). Eyes and mouth typically
have no `_back` folder, so they render nothing — lip-sync does not show
a mouth on the back of the head. Legacy full-head slots (`head`, `face`, and an
`eyes` slot that is **not** in `groups.head`) do not draw a second head.

`head_base_<view>/` holds the blank turn (no painted eyes or mouth).
`eyes_<view>/` is the overlay set; a drawing named `closed` still drives
auto-blink. `mouth_<view>/` is the 13-shape sheet as below.

Lint (`node src/cli.js lint`) runs a canvas check on every PNG in these
slots: exact `canvas.w` × `canvas.h` RGBA, not blank, alpha bbox not
touching the edge. Studio **Fit to head canvas** takes a raw-cropped
eyes or mouth set and writes 1024×1024 files with one shared transform
(from the `head_base` drawing + the slot's default); originals go to
`_replaced/`.

### Named cycles

A slot may declare reusable loops so a script can say `body=walk_side`
instead of listing every drawing:

```json
"slots": {
  "body": {
    "offset": { "x": 0, "y": 0 },
    "drawings_dir": "body",
    "default_drawing": "stand_side",
    "cycles": {
      "walk_side": {
        "drawings": ["ws01", "ws02", "ws03", "ws04", "ws05", "ws06", "ws07", "ws08"],
        "fps": 12
      }
    }
  }
}
```

Each name in `drawings` must exist as a file in that slot's folder. The
parser expands the cycle name into a timeline keyframe
`{ "frame": N, "cycle": ["ws01", ...], "fps": 12 }`. `[Action: Bill body=stand_side]`
(a plain drawing) still works as a held-until-changed swap.

### The body as a slot

The layer still needs a root `asset` (the schema requires one). To make the
**body itself** a drawing-swap -- walk cycles, front/back views -- use a
blank/transparent PNG as the base image and put the real drawings on
`slots.body`:

```json
{
  "id": "bill",
  "asset": "blank.png",
  "slots": {
    "body": {
      "offset": { "x": 0, "y": 0 },
      "drawings_dir": "body",
      "default_drawing": "front",
      "cycles": { "walk_side": { "drawings": ["ws01", "ws02"], "fps": 12 } }
    },
    "mouth": {
      "offset": { "x": 0, "y": -200 },
      "drawings_dir": "mouth",
      "visible_when": { "body": ["front"] }
    }
  }
}
```

The parser already emits every `character.json` slot onto the layer
(including `body`); it only needs the blank file to exist. `visible_when`
is passed through so a mouth can hide while the body shows a back view.
If the base asset file is missing, the parser raises a line-numbered
error that points at this pattern.

## Actions

A character can ship looping motion in `characters/<id>/actions/<id>.json`.
Lookup is the same as `character.json`: episode (project folder) overrides
show, then global when Independent is off. `[Move: Rodney to=right action=walk_side]`
loads `characters/rodney/actions/walk_side.json`.

```json
{
  "id": "walk_side",
  "view": "right_side",
  "faces": "right",
  "fps": 12,
  "frames": 12,
  "distance_per_cycle": 80,
  "set_slots": { "torso": "rig" },
  "joints": {
    "left_thigh": [0, 12, 20, 12, 0, -12, -20, -12, 0, 8, 12, 6],
    "right_thigh": [0, -12, -20, -12, 0, 12, 20, 12, 0, -8, -12, -6]
  },
  "groups": { "head": [0, 2, 4, 2, 0, -2, -4, -2, 0, 2, 4, 2] },
  "bob": [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1]
}
```

| Field | Notes |
|---|---|
| `id` | Action name; must match the filename (`walk_side.json`). |
| `view` | Head/mouth set held for the walk or `[Do:]` (`right_side`, `front`, `back`, …). Walking the other way is this view plus a flip. `back` is a first-class view: `[View: Name view=back]`, `[Action:]` / dialogue `view=back`, and action `"view": "back"` are accepted. |
| `views` | Optional `frames`-long list of per-cycle-frame views. When set, `[Do:]` writes a held `view_keyframes` sample whenever the view changes, then restores. |
| `faces` | Which way the art faces when the layer is unflipped (`left` or `right`). Travel the other way starts a flipped layer, same as `[Action: flip]`. `[Do:]` ignores this (no auto-flip). |
| `fps` / `frames` | Cycle rate and length. Joint, group, bob, `views`, and each `slot_frames` array must be `frames` long. |
| `distance_per_cycle` | How far the character travels in **character-local pixels** during one cycle, before mark/layer scale. Required for `[Move: ... action=]` unless `over=` is given. Duration with no `over=` is `|dx| / (distance_per_cycle × layer scale × fps / frames)` seconds. A depth walk (`dx≈0`) must set `over=`. Optional for in-place `[Do:]`. |
| `set_slots` | Slot drawings to hold for the walk / `[Do:]` (e.g. `torso=rig`). Restored to the previous drawing at the end. Each drawing must exist. |
| `slot_frames` | Optional map of slot name -> array of exactly `frames` drawing names. The named slot may live on the layer or on any child (`children[].slots`). The parser emits a slot keyframe whenever the drawing changes (same cycle index as joints/bob, including a stretched `over=` rate), then restores the previous drawing at the end unless `"end": "hold"`. `none` hides the slot for that frame. Each name must exist in that slot's folder (including `<slot>_<view>/` for `views: true` / head-group slots). |
| `joints` | Child id -> clockwise degrees per cycle frame. Unknown child ids, or an array whose length is not `frames`, are line-numbered errors. |
| `groups` | Optional group name -> clockwise degrees per cycle frame (e.g. `head: [...]`). The named group must exist on `character.json`. `[Do:]` rotates the whole group rigidly about the group pivot; restored at the end unless `"end": "hold"`. |
| `bob` | Optional `frames`-long list of Y pixels per cycle frame (`+` is down). Multiplied by layer scale and applied as a position offset — including while standing still on `[Do:]`. Always restored at the end (a held pose does not keep bouncing). |
| `body_rotation` | Optional `frames`-long list of clockwise degrees about the layer anchor (feet / `bottom-center`). Written as `transform_keyframes.rotation`. Children and slots follow the layer rotation. Restored at the end unless `"end": "hold"`. |
| `prop_events` | Optional list of `{ frame, prop?, drawing?, z? }`. `frame` is an action-frame index (`0..frames-1`). `prop` is a location prop name, or `{prop}` bound by `[Do: Name action prop=mic_stand]`. A literal name in the action also works. `drawing` swaps that prop's staging drawing; `z` is the same as `[Layer: prop z=N]` at that frame. Unknown prop -> line-numbered error listing known props. Missing drawing file is a lint/parse error. Restored at the end unless `"end": "hold"`. |
| `end` | `"restore"` (default, today's behaviour) or `"hold"`. With `hold`, `[Do:]` does **not** restore joints, groups, `body_rotation`, `set_slots` / `slot_frames`, or prop events; the last frame stays in `childRotations` / `groupRotations` / active slots / body lean so following lines keep the pose. Lip-sync still runs: `mouth` is reserved and dialogue after a held `[Do:]` still gets cues. Release with `[Do: Name rest]` (built-in; restores `character.json` defaults). A later `[Do: Name other]` starts from the held values. |

The parser writes per-scene-frame `rotation_keyframes` (phase = elapsed
seconds × action fps, linear) and per-frame position keyframes with bob
folded into `y`. At the end of a `[Move]`, joints key back to 0. `[Do:
Name <id>]` plays the same cycle in place (no travel, no flip), loops if
`for=` exceeds one cycle, and restores view, slots, joints, group
rotations, body lean, prop events, and bob unless `"end": "hold"`. It
also writes `view_keyframes` for the action's `view` (held for the walk /
`[Do:]`, then the previous view), so a silent walk still uses the side
head / eyes / mouth drawings; a line with its own `view=` still wins
while it plays. Head, eyes, mouth, blinks, and lip-sync slots keep
drawing on top. Child `parent` chains may be any depth. A later
`[Action: at=/flip=/z=]` fork carries held child rotations, group
rotations, slot drawings, and body lean.

## Staging

A **mark** is a named stage position: `{ x, y, scale?, flip_x? }` in canvas
pixels. Marks are always named (`left`, `centre`, `far_right`, ...), **never
numbered slots** -- a script says `at=left`, not `at=1`.

### Per-location staging (`backgrounds/<location>/staging.json`)

```json
{
  "marks": {
    "centre": { "x": 960, "y": 1080, "scale": 1.15 },
    "left":   { "x": 800, "y": 1080, "scale": 1.15 },
    "right":  { "x": 1120, "y": 1080, "scale": 1.15, "flip_x": true },
    "far_left":  { "x": 680, "y": 1080, "scale": 1.05 },
    "far_right": { "x": 1240, "y": 1080, "scale": 1.05, "flip_x": true }
  },
  "auto_order": ["left", "right", "far_left", "far_right"],
  "props": {
    "letterbox": {
      "asset": "props/letterbox.png",
      "x": 960,
      "y": 1080,
      "anchor": "bottom-center",
      "scale": 1.0,
      "z": 5
    }
  }
}
```

- `marks`: every named position usable in this location, via an explicit
  `[Action: ... at=<mark>]` or via auto-assignment (below).
- `auto_order`: when a character has **no explicit `at=` tag**, they're
  auto-assigned a mark by their position in the scene's `[Cast: ...]` list --
  the first cast member gets `auto_order[0]`, the second gets `auto_order[1]`,
  and so on (wrapping around if there are more cast members than entries).
- `props`: optional still objects for this location (see [Props](#props)
  below). Not merged from `staging_defaults.json` -- only this location's
  own `staging.json` declares them.

### Props

A **prop** is a still image drawn as its own timeline layer, in the same
`z` list as characters, so a character can walk behind or in front of it
(a letterbox, a desk, a doorway frame). This replaces the old workaround
of faking a prop as a character with no slots.

Images live in `backgrounds/<location>/props/`. Each entry under
`staging.json` `props` is:

| Field | Notes |
|---|---|
| `asset` | Path relative to the location folder. Defaults to `props/<name>.png`. |
| `x` / `y` | Canvas-space position of the anchor. If both are set, the prop is placed from frame 0 when the scene's `[Location: ...]` is set. Omit them to keep the prop off-stage until a `[Prop: <name> at=...]` places it. |
| `anchor` | Same enum as a layer transform (`bottom-center` default). British `centre` spellings are accepted and stored as `center`. |
| `scale` | Default `1.0`. |
| `z` | Default draw order (`0` if omitted). Override mid-shot with `[Prop: ... z=N]` or `[Layer: <name> z=N]`. |
| `drawings` | Optional map of drawing name -> path relative to the location folder (e.g. `{ "default": "props/mic_stand_short.png", "pole": "props/mic_stand_short_pole.png" }`). The default `asset` is drawing `default` if that key is omitted. `[Prop: name drawing=pole]` or an action `prop_events` entry swaps the image; bottom-center anchoring keeps equal-width, bottom-aligned drawings in place. Lint errors if a declared drawing file is missing. |

The parser emits each visible prop as a timeline layer with `prop_id`
(no `character_id`, no slots). Lint (`node src/cli.js lint`) errors if a
declared prop's image is missing. Script control is `[Prop: ...]` and
`[Layer: ...]` -- see [docs/script-format.md](script-format.md).

The sample project deliberately ships two very different staging profiles to
make this visible: **`bedroom`** is a small room with marks close together
and a slightly larger scale (`left`/`right` only ~320px apart, scale 1.15),
while **`corridor`** is a big hallway with marks far apart and a smaller
scale (`left`/`right` over 1200px apart, scale 0.85). The exact same
`[Cast: Hicks, Dana]` order in both scenes of `script.txt` places them very
differently depending on which location they're in -- see
`docs/script-format.md` and the Node test
`test/scriptParser.test.js` ("same cast order resolves to different
positions in different locations") for the two ends of that proof.

### Library-wide fallback (`staging_defaults.json`)

At the library root, `staging_defaults.json` has the same `{ marks,
auto_order }` shape. Its marks are merged *underneath* a location's own
marks (the location's own definition for a given name always wins), so a
location's `staging.json` doesn't have to redefine universally-useful marks
like `off_left`/`off_right` (for walking a character fully off-frame) --
only the ones it wants to customize.

### Mark field resolution order

For a character being placed on a mark (auto-assigned or via `at=`), each
individual field of its final transform is resolved independently, in this
order (first one that's actually specified wins):

1. **Explicit script tag** -- e.g. `[Action: Hicks at=left scale=1.4]`'s own
   `scale=1.4` always wins over everything else, for that field only.
2. **The resolved mark's own value** -- e.g. the `left` mark's own `scale`
   or `flip_x`, if it defines one.
3. **Character default** -- `character.json`'s `default_scale` /
   `default_flip_x`.
4. **Engine default** -- `1.0` for scale, `false` for `flip_x`.

`x`/`y` always come directly from the resolved mark (that's its entire
purpose) -- there's no further fallback needed for position itself. "Canvas
default marks" in this resolution order means step 2 itself can fall back
to a mark only defined in the library-wide `staging_defaults.json` when the
location's own `staging.json` doesn't define that mark name at all (see
above).

## Overrides

An episode (or a flat experiment) can override **any individual file** in
the library by placing a file at the exact same relative path inside its
own folder. The parser checks the episode folder first, then the show
(`shows/<id>/characters/…` and `backgrounds/…`). `_global_assets` is
consulted only when Independent is off. For example, to give one episode a
special one-off angry mouth drawing without touching the shared character:

```
projects/my_episode/
└── characters/
    └── hicks/
        └── mouth/
            └── D.png     # overrides _global_assets/characters/hicks/mouth/D.png, just this one file
```

This works for anything: `character.json` itself, `body.png`, a single
rig-part image, a single drawing inside a slot folder, a location's
`bg.png`, its `staging.json`, or a single file in `props/`. With
Independent off, overriding a slot folder only replaces the specific
filenames you provide; any other drawing names in that slot still come
from the global version. With Independent on (the default), only files
that exist in the project (or show) folder are used.

Studio's Assets viewer/editor lists **project-local drawings only** and
lets you delete any of them. Writes stay under the episode (or flat
project) `characters/<id>/` folder — never `_global_assets`. Adding a
character from the shared Library **copies** the files into the project
and writes a project-local `character.json`. Replacing a drawing copies
the previous file to `characters/<id>/_replaced/<timestamp>/`. Delete
moves a **project-local** file to `characters/<id>/_trash/<timestamp>/`
— it is never unlinked without that copy. Those history folders are
ignored when scanning slot drawings. The shared library folder is left
untouched.

Paths written into the generated `timeline.json` reflect wherever the file
actually came from: `"characters/hicks/mouth/D.png"` for an episode-local
file, `"../../characters/hicks/mouth/D.png"` for a show-level file, or
(only when Independent is off)
`"../_global_assets/characters/hicks/mouth/D.png"` for the global library
from a flat project (paths are always relative to the project folder
containing `timeline.json`, per [docs/timeline-schema.md](timeline-schema.md)).
Lint warns when a script still resolves anything from `_global_assets`.
