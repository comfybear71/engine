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
show → global**. `_global_assets` stays the library for every show.
Show-level files override it; an episode file at the same relative path
overrides the show. Flat projects under `projects/` have no show layer,
so they still resolve as project → global.

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
| `slots` | Map of slot name -> `{ offset, drawings_dir, default_drawing?, cycles?, visible_when?, scale?, rotation? }`. `drawings_dir` is a folder (relative to the character's own folder) whose image filenames (without extension) become that slot's valid drawing names. `default_drawing` is used for the slot's initial state before any `[Action: ...]` sets it (irrelevant for the `mouth` slot, which is always dialogue-driven). `cycles` is an optional map of cycle name -> `{ drawings: [drawing, ...], fps }` -- `[Action: Name slot=cycle_name]` emits a looping cycle keyframe; a plain drawing name still emits a held drawing. `visible_when` is copied onto the timeline slot as-is (e.g. hide a mouth unless `body` is showing `"front"`). `scale` (default `1.0`) multiplies the owner's scale around the slot center (the offset point). `rotation` (default `0`, clockwise degrees) is added to the owner's rotation around that same center. The parser copies both onto the timeline slot. Studio **Align head** writes `offset` / `scale` / `rotation` into a **project-local** `character.json` and never into `_global_assets`. |
| `children` | Rig parts, in the same shape as `schema/timeline.schema.json`'s `child` definition (`id`, `asset`, `z`, `offset`, `pivot`, `scale`, `flip_x`, `rotation`, `parent`), plus their own optional `slots` (same shape as above). `parent` and `pivot` are passed through to the generated timeline. `parent` names one other child on the same character (one nesting level, e.g. `forearm` under `upper_arm`). See [docs/timeline-schema.md#cut-out-rig-nesting](timeline-schema.md#cut-out-rig-nesting). |

The `mouth` slot is special: it's always driven by the character's dialogue
(`lipsync.source: "dialogue"`), so it never has a `default_drawing` and
can't be set via `[Action: ...]` -- see
[docs/script-format.md](script-format.md). Optional per-head-view folders
sit next to it: `mouth/` or `mouth_front/` is the front set; `mouth_left_side/`,
`mouth_right_34/`, and the other `view=` names are used when that line's
`view=` is set. Missing shapes in a view folder fall back to front, then
to `mouth/`.

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
(`shows/<id>/characters/…` and `backgrounds/…`), and only then
`_global_assets`. For example, to give one episode a special one-off angry
mouth drawing without touching the shared character:

```
projects/my_episode/
└── characters/
    └── hicks/
        └── mouth/
            └── D.png     # overrides _global_assets/characters/hicks/mouth/D.png, just this one file
```

This works for anything: `character.json` itself, `body.png`, a single
rig-part image, a single drawing inside a slot folder, a location's
`bg.png`, its `staging.json`, or a single file in `props/`. Overriding a slot folder only replaces the
specific filenames you provide; any other drawing names in that slot still
come from the global version.

Studio's Assets viewer/editor uses the same lookup: episode
(`shows/<id>/episodes/<ep>/characters/…`) then show
(`shows/<id>/characters/…`) then `_global_assets`. Writes stay under the
episode (or flat project) `characters/<id>/` folder — never
`_global_assets`. Replacing a drawing copies the previous file to
`characters/<id>/_replaced/<timestamp>/`. Delete moves a **project-local**
file to `characters/<id>/_trash/<timestamp>/` — it is never unlinked
without that copy, and a show-level or shared-library drawing cannot be
removed from here. Those history folders are ignored when scanning slot
drawings.

Paths written into the generated `timeline.json` reflect wherever the file
actually came from: `"characters/hicks/mouth/D.png"` for an episode-local
override, `"../../characters/hicks/mouth/D.png"` for a show-level file, or
`"../_global_assets/characters/hicks/mouth/D.png"` for the global library
from a flat project (paths are always relative to the project folder
containing `timeline.json`, per [docs/timeline-schema.md](timeline-schema.md)).
