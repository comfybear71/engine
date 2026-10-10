# `script.txt` format reference

This describes the plain-text script format the parser
(`worker/src/parser/`) reads and turns into a validated `timeline.json`
(see [docs/timeline-schema.md](timeline-schema.md)), resolving every
character/slot/drawing/location/mark reference against the
[shared asset library](assets.md).

```bash
cd worker
node src/cli.js parse        ../projects/sample              # script.txt -> timeline.json + lines.json
node src/cli.js lint         ../projects/sample              # parse + validate only, no files written
node src/cli.js voices       ../projects/sample [--dry-run]  # ElevenLabs WAVs + Rhubarb cues (never from watch)
node src/cli.js import-audio ../projects/sample take.mp3 --character hicks --name monologue
node src/cli.js render       ../projects/sample --from-script # parse, then render
node src/cli.js watch        ../projects/sample --from-script # re-parse + re-render on every script.txt save
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
`[Action: ...]`, `[Prop: ...]`, `[Layer: ...]`, or dialogue line in the
scene, since those need to resolve marks and declared props against it.
Unknown locations raise a line-numbered error listing every known location.
Any [props](assets.md#props) declared on that location with `x`/`y` are
placed as timeline layers from frame 0 (unless a later `[Prop: ... hide]`
removes them). Missing prop images are a line-numbered error.

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
| `hold=<secs>s` | Optional hold length for this pin (Studio move / trim). When set, the lane block lasts that long instead of stretching to the next pin. Does not advance the scene clock. Studio writes `hold=` when you drag a pin so the block never silently lengthens. |
| `over=<secs>s` | Same as `hold=` on a pin (older alias). On `[Move:]` / `[Pose:]` / `[Camera:]`, `over=` is the timed duration and may advance the clock. |
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

`key=value` tokens and bare flags (`flip`) can appear in any order.
Parsing stops at the first token that is neither -- everything from there
to the end of the line is kept as a free-text note (e.g. `[Action: Hicks
at=left storms across the room]`), not an error. So
`[Action: Bill flip body=walk_side]` sets both flip and the body slot;
`[Action: Bill at=left hello body=walk_side]` treats `body=walk_side` as
part of the note and warns, because it looks like a swallowed assignment.

### `[Prop: <name> at=<mark>|x,y z=<n> scale=<s> hide|show]`

Adds, moves, or hides a [location prop](assets.md#props) from this point
on. `<name>` must be declared under `props` in the current location's
`staging.json` (matched case-insensitively). Declared props with `x`/`y`
are already on stage when the location is set; this tag changes them from
the current cursor onward (same instant-cut layer fork as `[Action: ...]`).

| Key | Meaning |
|---|---|
| `at=<mark>` | Move to that staging mark's `x`/`y` (and the mark's `scale` if it defines one). |
| `at=<x,y>` | Move to explicit canvas coordinates (no spaces). |
| `scale=<number>` | Override scale from here on. |
| `z=<integer>` | Override draw order from here on. |
| `hide` (bare) or `hide=true` | Hide the prop from this point (closes its current layer). |
| `show` (bare) or `show=true` | Show it again at its last pose, or at `at=`/`scale=`/`z=` if given. |

`hide` and `show` cannot appear on the same tag. A prop that was never
given `x`/`y` in staging.json is not placed until a `[Prop: ...]` supplies
`at=` (or `show` with a staging position). This replaces the old workaround
of faking a still object as a character with no slots.

### `[Layer: <Name> z=<n>]`

Changes a character's or prop's draw order from this point mid-shot,
forking a new layer (same `character_id` / `prop_id`, back-to-back in
time) when `z` actually differs. `<Name>` is resolved as a character
first (same aliases as `[Cast: ...]` / `[Action: ...]`), then as a
declared prop. `[Layer: ...]` only accepts `z=`; use `[Action: ...]` or
`[Prop: ...]` to move. `z=` inside `[Action: ...]` does the same
thing for a character or a declared prop (`[Prop: ... z=]` also works).

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

### `[Camera: zoom=<n> | pan=x,y | tilt=<dy> | to=x,y zoom=<n> | reset over=<secs>s ease=linear|inout wait=true|false]`

Tweens the scene's **virtual camera** (the compositor's post-process pan/zoom
on `camera.py`) from wherever it is now. Same `over` / `ease` / `wait` clock
as `[Move:]`: `wait=true` (default) advances the scene cursor; `wait=false`
leaves it so following lines/tags run during the move. Does not fork layers.

The parser writes `{ frame, x, y, zoom, ease? }` onto the scene's
`camera.keyframes`. `x`/`y` are the canvas-space centre of the visible
window (default: canvas centre, 960,540 on 1920x1080). `zoom` is absolute
(`1.0` = full canvas). Interpolation is linear unless `ease=inout`.

| Form | Meaning |
|---|---|
| `zoom=<n> over=<secs>s` | Push-in/out to that zoom, keeping the current centre. |
| `pan=<x,y> over=<secs>s` | Move the centre to those canvas coordinates, keeping the current zoom. |
| `tilt=<dy> over=<secs>s` | Vertical shift: add `dy` pixels to the current centre `y` (positive is down). |
| `to=<x,y> zoom=<n> over=<secs>s` | Combined pan + zoom in one tween. `zoom=` may be omitted to keep the current zoom; `to=` may be omitted if only `zoom=` is given. |
| `reset over=<secs>s` | Return to canvas centre, zoom 1.0. Cannot combine with `zoom`/`pan`/`tilt`/`to`. |

`ease=linear` (default) or `ease=inout`. Unknown keys, a missing `over=`,
`reset` mixed with a target, `to=`+`pan=`, or a non-`x,y` `pan=`/`to=` are
line-numbered errors.

A scene with no `[Camera:]` tags omits `camera` from the timeline (the
compositor then leaves the frame alone). After a camera move, the current
pose *is* the target -- the next `[Camera:]` continues from there.

This is how a project like `worms_eye` should author camera, instead of a
post-parse `add_camera.py` patching `timeline.json`:

```text
[Scene: Worms Eye]
[Location: bedroom]
[Cast: Hicks]

[Camera: to=960,820 zoom=1.4 over=8s ease=inout]
Hicks: The floor's closer than it looks.
[Camera: pan=960,540 over=3s]
[Camera: reset over=1s]
```

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

### `[Audio: Name file=<label>]`

Places a pre-recorded track imported with `node src/cli.js import-audio` as
that character's dialogue, starting at the current scene cursor. The
timeline then advances by the **real file duration** (via `ffprobe`), so a
3+ minute take extends the scene the same way a spoken line does.

```text
[Audio: Hicks file=monologue]
[Audio: Hicks file=monologue trim_in=1s trim_out=4s]
```

`file=` is the `--name` label from import-audio (not a raw path). The
parser looks for:

```
audio/<label>/001_<character>.wav
audio/<label>/001_<character>.wav.rhubarb.json
audio/<label>/001_<character>.words.json
```

The WAV is mixed and lip-synced through the existing dialogue + Rhubarb
path (`slots.mouth` with `lipsync.source: "dialogue"`). Missing WAV is a
line-numbered error -- this tag does not estimate duration. If
`words.json` is present, those `{word,start,end}` timings are copied onto
the dialogue clip as `words` (see [timeline-schema.md](timeline-schema.md))
and, unless `lines=false`, the Dialogue lane gets one block per
sentence/pause so the transcript is readable. The Audio lane still shows
the single imported file.

Import first (prints length + an ElevenLabs STT credit note before it
runs; `--dry-run` stops there; `--no-transcribe` skips STT):

```bash
cd worker
node src/cli.js import-audio ../projects/my_ep interview.mp3 --character hicks --name monologue
node src/cli.js import-audio ../projects/my_ep interview.mp3 --character hicks --name monologue --dry-run
node src/cli.js import-audio ../projects/my_ep interview.mp3 --character hicks --name monologue --no-transcribe
```

Single speaker only. Studio **Import audio** (Script tab, or Stage
transport / Script drawer) calls the same work via
`POST /api/projects/:name/import-audio` -- see [docs/studio.md](studio.md).

### `[View: Name view=<head view>]`

Sets the default head/mouth view for following spoken lines and `[Audio:]`
takes by that character. See [Head view](#head-view-view--view).

### `Character: dialogue text`

A spoken line. `Character` is matched the same way as in `[Cast: ...]`.
Optional `at_time=` / `start=`, `view=`, and `trim_in=` / `trim_out=` may
sit on the name: `Hicks at_time=2s view=left_side trim_in=0.5s: text`.
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

## Explicit start (`at_time=` / `start=`)

Every timed or placed event starts at the shared scene cursor unless you
set an optional **explicit start**. Studio timeline moves write this
attribute; you can also type it by hand.

| Form | Meaning |
|---|---|
| `at_time=2s` | Start 2 seconds into the **scene** (preferred name). |
| `at_time=0.5s` | Fractional seconds, converted at the document fps. |
| `at_time=48` | Start at scene-local frame 48. |
| `start=2s` or `start=48` | Same meaning; an alias. If both are present, `at_time=` wins. |

Accepted on `[Action:]`, `[Prop:]`, `[Layer:]`, `[Move:]`, `[Pose:]`,
`[Swing:]`, `[Camera:]`, `[Audio:]`, and on dialogue as
`Name at_time=2s: spoken text`. Zero is allowed (`at_time=0s`).

**The cursor does not move to `at_time=`.** A `wait=true` move, a
dialogue line, or `[Audio:]` still advances the shared clock from
wherever the cursor already was, by that event's duration. Later
sequential lines therefore keep the placement they would have had
without the attribute. That is how dragging one block later can leave a
gap (or overlap) without ripple-shifting the rest of the shot.

Omit `at_time=` / `start=` and timing is unchanged: script order, `wait=`,
`over=` / `for=` durations, and pin-until-next-hold.

Studio always writes the canonical `at_time=` name (seconds when that is
exact, otherwise a frame count). Several lane blocks that share one
script line (an `[Audio:]` take plus its sentence chips) share one
`at_time=` — moving any of them moves the tag.

## Trim (`trim_in=` / `trim_out=` / duration)

Studio edge-trims rewrite the script, then re-parse.

**Timed tags** (`[Move:]`, `[Pose:]`, `[Camera:]`, `[Swing:]`) change
`over=` or `for=`. Dragging the start edge also writes `at_time=` so the
end stays put. Instant pins (`[Action:]` / `[Prop:]` / `[Layer:]`) accept
optional `hold=` (or `over=`) to lock a fixed length instead of stretching
to the next pin. Dragging a pin writes `at_time=` and, if it had no
explicit length, `hold=` equal to its current visual span (until the next
pin). That move never silently lengthens the block.

**Dialogue and `[Audio:]`** set in/out points in the **source file**:

| Form | Meaning |
|---|---|
| `trim_in=0.5s` | Start 0.5 seconds into the WAV (or the estimated length if the file is still missing). |
| `trim_out=2s` | Stop at 2 seconds into the source. Omit to use the file end. |
| `trim_in=12` / `trim_out=48` | Same, as a frame count at the document fps. |

`start=` remains the timeline-start alias for `at_time=` — it is **not**
a source in-point. Playback, Rhubarb mouth cues, words, lane length, and
the cursor advance all use `[trim_in, trim_out)`. The married mouth
track follows the dialogue clip. Trims cannot go below 1 frame or past
the source length.

**Split at the playhead** (`S`, or the timeline **Split** button) turns
one line into two. Timed tags become two tags whose durations add up.
Audio/dialogue become two lines: the first keeps `trim_out=` at the
split, the second gets `at_time=` at the playhead and `trim_in=` at the
same source time. Word timings stay on the source file; spoken text is
split on those words when they exist.

```text
[Move: Hicks to=right over=1s]
[Move: Hicks to=right over=1s at_time=1s]
[Audio: Hicks file=monologue trim_out=2s]
[Audio: Hicks file=monologue at_time=2s trim_in=2s]
Hicks trim_out=0.8s: Hello there
Hicks at_time=0.8s trim_in=0.8s: friend.
```

```text
[Move: Hicks to=right over=2s at_time=1.5s]
[Action: Hicks eyes=furious at_time=3s]
[Camera: zoom=1.3 over=2s at_time=48]
[Audio: Hicks file=monologue at_time=2s]
Hicks at_time=4s: Where's the rent money, Dana?
```

## Studio clipboard, delete, and asset drops

The script stays the only source of truth. Copy / cut / paste / duplicate /
delete rewrite lines, then Studio re-parses.

**Delete** on Dialogue or Audio asks first, then removes the married
line(s) (Dialogue + Audio + the red Mouth block). Delete on a Mouth
block only clears that line's lip-sync cues (back to not synced) and
leaves the Dialogue and Audio lines in the script.

Sequential lines with no `at_time=` / `start=` would otherwise slide when
a clock-advancing line (dialogue, `[Audio:]`, `wait=true` move, `[Pause]`)
is removed. Studio therefore **pins** every later timed line in that
scene to an explicit `at_time=` equal to its current parsed start
*before* removing the selection. The gap stays. Other scenes are not
rewritten (each scene has its own cursor).

**Ripple delete** (Shift+Delete) does the same pin, removes the line(s),
then subtracts the deleted visual span from later `at_time=` values on
**all lanes** in that scene. Overlapping deleted blocks count once.

**Paste** (Ctrl+V, or the context menu at the playhead) inserts a copy of
the copied line(s) with a new `at_time=` at the playhead. Audio/dialogue
paste copies that one married line (mouth cues return on re-parse).
Paste onto a lane only when the type fits: speech on Dialogue / Audio /
Mouth / Face, face pins on Face, body on Body/Move, `[Prop:]` on Props,
`[Camera:]` on Camera.

Dragging from the Stage Assets tree inserts the same tags a person would
type. The new line is inserted in the scene that owns the drop time
(after the selected line if that line is in the same scene; otherwise
after the last line of that scene) — a hallway line selected while you
drop on scene 1 does not move the tag into the hallway:

```text
[Action: Hicks face=yap at_time=2s]
[Action: Hicks body=walk_side at_time=1s]
[Action: Hicks right_hand=point at_time=0.5s]
[Prop: letterbox show at_time=3s]
[Audio: Hicks file=monologue at_time=1s]
[Location: bedroom]
[Action: Hicks at=left at_time=0s]
[Prop: letterbox at=640,480 at_time=2s]
```

`[Location:]` still belongs at the start of the scene (see the tag
above). A background drop rewrites that scene's location tag; it does
not add `at_time=`. Generated `audio/<scene>/<nnn>_<character>.wav`
files are listed in the tree but do not create an `[Audio:]` tag — that
tag only resolves `audio/<label>/001_<character>.wav` from Import audio.
The reserved `mouth` slot still cannot be set with `[Action:]`.

## Head view (`view=` / `[View:]`)

Each spoken line (and `[Audio:]` take) can pick which mouth/head drawing
set lip-sync uses:

| Form | Meaning |
|---|---|
| `Name view=left_side: text` | This line uses `mouth_left_side/` (falls back to `mouth_front/` / `mouth/`). |
| `[View: Name view=left_side]` | Sets the default for following lines until another `[View:]` or a per-line `view=`. |
| `[Audio: Name file=monologue view=right_34]` | Same for an imported take. |

Allowed views: `front`, `left_34`, `left_side`, `right_34`, `right_side`,
`up`, `down`. `front` is the default and may be omitted. Studio writes
`view=` from the selected Dialogue block's dropdown. The compositor
resolves `images_by_view[view]` → `front` → `images` → shape `X`.

## Lip-sync (on demand)

Dialogue exists first. Rhubarb cues are generated per line:

- **Auto** (default): `voices` and Import audio still run Rhubarb when
  they create a WAV.
- **Manual**: `studio.json` `{ "lipSync": "manual" }` skips that; use
  Studio **Sync this line** / **Sync all**.

A line is **not synced** until `<wav>.rhubarb.json` has mouth cues,
**synced** when those cues match the current WAV + spoken text, and
**stale** when the WAV or text changed after the last sync.

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
  turning a character around is always this kind of cut. The new layer
  **keeps** each slot's active drawing or cycle (rotated so the cycle
  continues from the drawing that was showing) and each child's current
  rotation, unless the same tag sets that slot. `[Prop: ...]` and
  `[Layer: ... z=]` fork the same way for props (and `[Layer: ...]` for
  characters). Props and characters share one `layers` list and are drawn
  together in ascending `z`; the background stays behind every layer.
- **`[Move:]` does not fork a layer.** It writes `transform_keyframes` on
  the current layer from the current pose to the target. After the move,
  the current position *is* the target, so `[Action: Name flip]` opens the
  new layer there (not back at the original mark).
- **`[Pose:]` / `[Swing:]` never fork a layer.** They write
  `rotation_keyframes` on the named rig children.
- **`[Camera:]` never forks a layer.** It writes scene-level
  `camera.keyframes` (see [docs/timeline-schema.md#camera](timeline-schema.md#camera)).
  `wait=true` advances the shared cursor like `[Move:]`.
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
    },
    {
      "scene_id": "interview",
      "line_number": 1,
      "character": "hicks",
      "text": "Full transcript from words.json if present.",
      "audio_path": "audio/monologue/001_hicks.wav",
      "cues_path": "audio/monologue/001_hicks.wav.rhubarb.json",
      "words_path": "audio/monologue/001_hicks.words.json",
      "voice_id": null,
      "status": "ok",
      "source": "import"
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
the real files -- see [docs/voices.md](voices.md). Rows with
`"source": "import"` (from `[Audio: ...]`) are skipped so a pre-recorded
take is never overwritten.

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
Line 2: Prop "letterbox" is missing asset "backgrounds/corridor/props/letterbox.png". Available: (none)
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
