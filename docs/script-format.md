# `script.txt` format reference

This describes the plain-text script format the parser
(`worker/src/parser/`) reads and turns into a validated `timeline.json`
(see [docs/timeline-schema.md](timeline-schema.md)), resolving every
character/slot/drawing/location/mark reference against the
[shared asset library](assets.md).

```bash
cd worker
node src/cli.js parse  ../projects/sample              # script.txt -> timeline.json + lines.json
node src/cli.js lint   ../projects/sample              # parse + validate only, no files written
node src/cli.js voices ../projects/sample [--dry-run]  # ElevenLabs WAVs + Rhubarb cues (never from watch)
node src/cli.js render ../projects/sample --from-script # parse, then render
node src/cli.js watch  ../projects/sample --from-script # re-parse + re-render on every script.txt save
```

Every error the parser raises cites the **script.txt line number** it came
from (`Line 14: ...`) -- never a bare stack trace.

## Full example

This is (an abridged form of) `projects/sample/script.txt`:

```text
# Lines starting with "#" (or containing "//") are comments.
# "===" lines are purely decorative; they do nothing.

===
[Scene: Morning Argument]
[Location: bedroom]
[Cast: Hicks, Dana]

Hicks: Where's the rent money, Dana?
Dana: I told you, it's coming Friday.
[Action: Hicks eyes=furious]
Hicks: Friday was last Friday too.
Dana: Don't start with me this early.
[Pause: 0.5s]
[Action: Hicks right_hand=point]
Hicks: I'm not starting anything, I'm just asking.
Dana: Then stop asking in that tone.

===
[Scene: Hallway Standoff]
[Location: corridor]
[Cast: Hicks, Dana]

Hicks: We are not done talking about this.
[Action: Dana at=far_right]
Dana: Oh, we are so done.
[Action: Hicks eyes=open]
Hicks: Fine. Friday. I'm holding you to it.
```

## Tags

### `[Scene: <name>]`

Starts a new scene. `<name>` is turned into the scene's `id` by
lowercasing and replacing anything that isn't `a-z0-9` with `_`
("Morning Argument" -> `morning_argument`); a numeric suffix is appended if
two scenes would otherwise collide. Everything before the first `[Scene:
...]` tag, and anything after the last scene's content, is simply ignored.

A bare line of `=` characters (`===`, `=====`, ...) is accepted anywhere as
a purely decorative scene divider -- it's optional and does nothing, for
scripts (like Stuart's existing Deck exports) that already use it visually.

### `[Location: <location>]`

Sets the scene's background and [staging profile](assets.md#staging) to
`projects/_global_assets/backgrounds/<location>/` (or a project-local
override at the same relative path). Must appear before any `[Cast: ...]`,
`[Action: ...]`, or dialogue line in the scene, since those need to resolve
marks against it. Unknown locations raise a line-numbered error listing
every known location.

### `[Cast: Name, Name, ...]`

Lists which characters are present in the scene, in order. This order
matters: a character with no explicit `at=` gets auto-assigned a mark by
their position in this list, using the location's `auto_order` (see
[docs/assets.md#staging](assets.md#staging)) -- first name in `[Cast: ...]`
gets `auto_order[0]`, and so on. Every name must resolve to a known
character (matched case-insensitively against its `character.json`
`aliases`); unknown names raise a line-numbered error listing known
characters.

A character who speaks before ever being listed in `[Cast: ...]` is added
automatically (at the next available auto-assigned mark), with a warning --
this is not an error, since it naturally covers a walk-on line.

### `[Action: Name key=value key=value ... free text note]`

Sets one or more things about a character, effective from this exact point
in the scene's timeline onward (held until the next change):

| Key | Meaning |
|---|---|
| `at=<mark>` | Moves the character to that mark (see [mark resolution order](assets.md#mark-field-resolution-order)). |
| `scale=<number>` | Overrides the resolved scale for this character from here on. |
| `flip` (bare) or `flip=true`/`flip=false` | Overrides `flip_x` from here on. |
| `z=<integer>` | Overrides this character's draw order from here on. |
| *(anything else)* | Treated as a **slot name** on that character (e.g. `eyes=furious`, `right_hand=point`, `body=walk_side`): the value is either a **named cycle** declared on that slot in `character.json` (emits a `{ frame, cycle, fps }` keyframe) or a drawing that must exist in that slot's folder (see [docs/assets.md](assets.md)). A drawing becomes a held-until-changed keyframe at the current frame. The reserved `mouth` slot can't be set this way -- it's always driven by dialogue. |

Any `at=`/`scale=`/`flip`/`z` change **that actually differs** from the
character's current values ends their current layer and starts a new one
(same `character_id`, back-to-back in time) -- an instant cut, never a
tween, and never a duplicate layer just for speaking (see
[Timing and layers](#timing-and-layers) below). To *tween* to a new mark
or coordinate, use `[Move: ...]` instead -- that stays on the current
layer. Setting the *same* mark again, or correcting a just-auto-assigned
mark before any dialogue has happened, does not create a redundant extra
layer. `[Action: Name flip]` after a `[Move]` opens the new layer at the
**moved-to** position, not the original mark.

Parsing a tag's key/value pairs stops at the first token that isn't a valid
`key=value` -- everything from there to the end of the line is kept as a
free-text note (e.g. `[Action: Hicks at=left storms across the room]`), not
an error. It's not currently used for anything, but it's there for a human
(or a future feature) to read.

### `[Pause: <N>]` or `[Pause: <N>s]`

Advances the scene's timeline by `N` frames, or `N` seconds (converted to
frames at the document's fps), without creating a dialogue clip -- for a
dramatic beat of silence.

### `[Move: Name to=<mark | x,y> over=<secs>s ease=linear|inout wait=true|false scale=<n>?]`

Tweens the character's **current layer** from wherever they are now to a
target. Does **not** start a new layer (`flip_x` is still not keyframed --
turn them around with `[Action: Name flip]`, which *does* fork a layer).

| Key | Meaning |
|---|---|
| `to=<mark>` | Target is that staging mark's `x`/`y` (and its `scale` if the mark defines one). |
| `to=<x,y>` | Explicit canvas coordinates (no spaces). Keeps the current scale unless `scale=` is also given. |
| `over=<secs>s` | Duration in seconds (e.g. `1s`, `0.5s`), converted to frames at the document fps. |
| `ease=linear` or `ease=inout` | How to interpolate from the start keyframe. Default `linear`. |
| `wait=true` (default) | Advance the scene clock by the duration, like `[Pause]`. |
| `wait=false` | Leave the clock where it is so following lines/tags run *during* the move. |
| `scale=<n>` | Override the target scale. |

The layer gets two `transform_keyframes` (from the current pose to the
target, layer-local frames). After the move, the character's current
position *is* the target -- the next `[Move]` or a later `[Action: flip]`
continues from there.

### `[Pose: Name part=deg part2=deg over=<secs>s ease=linear|inout wait=true|false]`

Tweens one or more rig children's rotation from their current angle to
the given degrees. Same `over` / `ease` / `wait` rules as `[Move]`.
`part` is a `character.json` child id (`right_arm=40`, `forearm=-15`).
Unknown parts raise a line-numbered error listing every child id.

Writes `{ frame, rotation, ease? }` onto that child's `rotation_keyframes`.
The new angle becomes the current pose, so a later `[Pose]` or `[Swing]`
continues from there (and a flipped new layer keeps the posed angle).

### `[Swing: Name part=±deg ... period=<secs>s for=<secs>s wait=true|false]`

Generates a back-and-forth rotation around each part's **current** angle,
then ends back at it. Ease is always `inout`.

| Key | Meaning |
|---|---|
| `part=±deg` | Amplitude (and first-swing direction) relative to the current angle. `right_arm=30` swings +30 then -30; `right_arm=-30` goes the other way first. |
| `period=<secs>s` | One full cycle (center → +amp → center → −amp → center). |
| `for=<secs>s` | How long to keep swinging. |
| `wait=` | Same as `[Move]`: default `true` advances the clock; `wait=false` lets a dialogue line play over the swing. |

Keyframe count for `for` = `period` at 24 fps is 5 (frames 0, T/4, T/2,
3T/4, T), first and last at the start angle.

### `Character: dialogue text`

A spoken line. `Character` is matched the same way as in `[Cast: ...]`.
Lines run **strictly in sequence against one shared per-scene cursor** --
there's no overlapping dialogue -- so each line's `start_frame` is wherever
the cursor currently is, and the cursor then advances by that line's
duration before the next line/tag is processed.

That duration is:

- **Real**, via `ffprobe`, if `audio/<scene_id>/<nnn>_<character>.wav`
  already exists on disk (`<nnn>` = 1-based line number *within the
  scene*, not a global counter and never a frame number -- so inserting or
  reordering lines in one scene never renames another scene's files).
- **Estimated** otherwise, from word count: `words / 2.5 + 0.3` seconds.
  The line is still placed and timed using that estimate (so the rest of
  the scene lays out sensibly before any audio exists); `lines.json` marks
  it `"status": "missing"` with the estimate, for a later voice-generation
  step to fill in -- see [`lines.json`](#linesjson-manifest) below.

Comments (`#` or `//`, full-line or trailing) are stripped before any of
this classification happens.

## Mark resolution order

See [docs/assets.md#mark-field-resolution-order](assets.md#mark-field-resolution-order)
for the full per-field walkthrough (script tag > mark's own value >
character default > canvas/library default).

## Timing and layers

- **One layer per character per position they hold in a scene.** Every
  dialogue line for a character while they're in one position attaches to
  that one layer's `dialogue` list -- never a new layer per line (this was
  a specific, named bug in an earlier draft parser).
- **Instant cuts fork a new layer.** If an `[Action: ...]` changes a
  character's resolved position/scale/flip/z partway through a scene (after
  they've already spoken or had time pass), the current layer's
  `timing.end_frame` is set to that frame and a new layer (`<id>_2`, `_3`,
  ...) opens there with the new transform. `flip_x` is not keyframed, so
  turning a character around is always this kind of cut.
- **`[Move:]` does not fork a layer.** It writes `transform_keyframes` on
  the current layer from the current pose to the target. After the move,
  the current position *is* the target, so `[Action: Name flip]` opens the
  new layer there (not back at the original mark).
- **`[Pose:]` / `[Swing:]` never fork a layer.** They write
  `rotation_keyframes` on the named rig children.
- **Slot changes never fork a layer.** `[Action: ... eyes=furious]` or
  `[Action: ... body=walk_side]` becomes a keyframe (drawing or named
  cycle) on the existing layer -- see
  [docs/timeline-schema.md#slots](timeline-schema.md#slots--drawing-swaps-mouths-blinks-hand-poses).
- **Scene duration** is `{ "from_dialogue": true, "padding_frames": 12 }`
  whenever the scene has any dialogue at all (the normal case) -- it runs
  until the last line across every character finishes, plus padding.

## `lines.json` manifest

Written alongside `timeline.json`, one entry per dialogue line, in script
order:

```json
{
  "lines": [
    {
      "scene_id": "morning_argument",
      "line_number": 1,
      "character": "hicks",
      "text": "Where's the rent money, Dana?",
      "audio_path": "audio/morning_argument/001_hicks.wav",
      "cues_path": "audio/morning_argument/001_hicks.wav.rhubarb.json",
      "voice_id": null,
      "status": "ok"
    }
  ]
}
```

`status` is `"ok"` if that audio file already exists (real duration used)
or `"missing"` if it doesn't (estimated duration used; an
`estimated_duration_seconds` field is also present in that case).
`node src/cli.js voices` re-parses the script (so every dialogue line is
considered, not only `"missing"` rows), records through ElevenLabs when
the credit-guard sidecar doesn't match, writes Rhubarb cues next to the
WAV when Rhubarb is installed, then re-runs parse so timings come from
the real files -- see [docs/voices.md](voices.md).

## Errors

Every error is a `ScriptError` with a `lineNumber` and a message that
includes **what was available**, so you don't have to go spelunking in the
asset library to fix a typo:

```
Line 14: Hicks has no right_hand drawing "pointt". Available: fist, flat, point
Line 9: Alice has no eyes drawing or cycle "walk_side". Available drawings: open, closed. Available cycles: blink_loop
Line 11: Unknown part "left_foot" on Alice. Available: right_arm, forearm
Line 8: Invalid over "nope" -- expected seconds like "1s" or "0.5s".
Line 7: Unknown mark "upstage" for location "corridor". Available: centre, left, right, far_left, far_right
Line 3: Unknown character "Zelda". Known characters: Hicks, Dana
Line 2: Unknown location "nowhere" (no backgrounds/nowhere/bg.png). Available: bedroom, corridor
```

`node src/cli.js lint <project>` runs the exact same parse + validation
path as `render`/`parse`, without writing a (non-throwaway) `timeline.json`,
so you can check a script for errors on its own. It also warns if two
characters share a staging mark at the same time with the same z, and
errors if a used character's mouth folder is missing rest shape X or any
Rhubarb shape A–H (listing what's there).

## Walk + talk example

Walking a rectangle of marks with a body cycle and a flip on each corner,
while the arms flail over a line (`wait=false` so the swing and the
dialogue share the clock):

```text
[Scene: Walkabout]
[Location: bedroom]
[Cast: Hicks]

[Action: Hicks at=left body=walk_side]
[Move: Hicks to=right over=2s ease=inout]
[Action: Hicks flip]
[Move: Hicks to=far_right over=2s]
[Action: Hicks flip]
[Move: Hicks to=far_left over=2s]
[Action: Hicks flip]
[Move: Hicks to=left over=2s]
[Action: Hicks body=front]

[Swing: Hicks right_arm=25 period=0.4s for=2s wait=false]
Hicks: I'm fine, this is fine.
```

`body=walk_side` only works if that name is a cycle (or a drawing) on
`slots.body` in `character.json` -- see
[docs/assets.md#the-body-as-a-slot](assets.md#the-body-as-a-slot). The
sample Hicks character does not ship a body slot; the tags above are the
syntax, not a runnable sample-project script.
