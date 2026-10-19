# Studio

The Studio is a local Next.js app in `studio/`. It is built so it can be
deployed to Vercel later, but it **never** reads or writes project files
itself. The browser talks to the worker Express server running on the
user's PC (`WORKER_PORT`, default `4100` from the repo-root `.env`). That
server is bound to `127.0.0.1` only.

No Vercel Blob, no database, no auth. Voices TTS stays on the CLI
(`node src/cli.js voices`). Pre-recorded mp3/wav lip-sync is **Import
audio** in Studio (Script tab, or **Import audio** on the Stage transport
bar / Script drawer) — that calls `POST /api/projects/:name/import-audio` (ElevenLabs
Speech-to-Text + Rhubarb). A take longer than 60 s is split into 30–60 s
clips at silences (word timings / Rhubarb rest), each with its own
`[Audio:]` line, `.rhubarb.json`, and `words.json`. Existing long Audio
blocks have **Split long audio** on the context menu. Splitting never
re-runs ElevenLabs — it reuses `words.json`. You never need the command
line for that.

The **script is the source of truth**. Stage lanes are a view of a temp
parse. Timeline edits (select, move, trim, split, delete, ripple,
copy/paste, asset drops) rewrite the matching script line(s) with
`at_time=` / duration / `trim_in=` / `trim_out=`, then re-parse; they
never write `timeline.json`. Save, lint, preview, lanes, and Render
still parse the selected script to a temp timeline (the same `--script`
option as the CLI). Render writes `renders/<script-stem>.mp4`. The last
selected script is remembered per project in `localStorage`
(`engine.studio.activeScript.v1`) and in `studio.json` (`activeScript`),
so a browser refresh restores that file instead of falling back to
`script.txt`. Every script file has its own timeline: switching scripts
(the Script tab list, or the picker in the Stage header) shows that file's
stage and never deletes the one you left.

Stage timeline keys: **Ctrl+B** (or S) split at the playhead (the selection,
or everything under the playhead when nothing is selected), **Ctrl+C / X /
V / D** copy, cut, paste at the playhead, duplicate, **Delete** remove
(**Shift+Delete** ripple), **Ctrl+Z / Shift+Z** undo / redo, drag the edge
handles to trim. A trimmed audio part or Action Shot part is just a script
line with `trim_in=` / `trim_out=`, so copy/paste reuses it anywhere. The
Camera drawer's **Add camera move at playhead** writes
`[Camera: ... at_time= wait=false]` so the move starts where the playhead is.
The Head Rig timeline has the same keys, snaps clip edges to the playhead and
neighbouring cuts (hold Alt to turn snapping off), never lets clips overlap on
a track, and supports undo / redo.

**Talking head from audio.** Right-click an audio block on the Stage and
choose **Make talking head**. The block's trimmed slice of
`audio/<label>/001_<character>.wav` is read through its `words.json`, split on
pauses into windows of 10 s or less (Grok clips are 4/6/8/10 s), and one head
shot is generated per window with Grok. Window 1 starts from the character's
reference head; every later window starts from the frame of the previous clip
where that window ends (last frame to first frame). Grok never hears the audio:
each window's words go into its prompt, and the clip is trimmed to the
window's audio, so lip timing is approximate. The clips arrive in that
character's Head Rig (Assets, Characters) under **Talking heads**, where
**Play with audio** checks each clip against its audio slice and **Place on
head track** lays them back to back, trimmed to their audio. The chain is
sequential; if a clip fails, **Retry from failed clip** continues from it.
The audio needs a transcript (`words.json`), so import it with transcription on.

**Action Shot size on a new scene.** Baked Action Shots keep the pixel size of
the video they came from, and a `[Clip:]` with no `scale=` uses the mark's
scale, so on a fresh background (mark scale 1) a tall clip could come in as a
giant. When you drop an Action Shot on the Stage preview or the Action Shots
lane, Studio measures how high the character reaches above the bottom edge of
the clip's frames (the edge that stands on the mark, so empty space under the
boots counts), taking the highest of 24 frames spread over the whole clip so a
hat that rises on some frames counts. Only if the scene would draw that taller
than the picture, it writes a `scale=` that puts the highest point at 90% of the
picture height. It is a sample of frames, not every frame, so check the Stage
and adjust `scale=` if a few frames still touch the top. Clips that already fit
get no `scale=`, so existing scenes and hand-typed `[Clip:]` lines are unchanged.
**New scene** starts with nobody
ticked in its cast.

**Head follows body.** A head clip normally sits at one fixed spot, so on a
walking body the head floats while the body rises and falls. Select a head clip
and set **Head follows body** (0 to 150%; 0 = off). The worker measures how the
body clip moves up and down (the highest visible row in a narrow strip around the
neck, per frame, lightly smoothed, relative to the middle of the clip) and moves
the head by that amount times the strength, in the Head Rig preview and in the
bake, from the same numbers (`worker/python/compositor/body_motion.py`, saved
beside the body clip as `body_motion.json`). Set the head's height at a moment
when the body is in the middle of its bob; **Same for all heads** copies the
amount to every head clip. It follows up and down only (not sideways), and the
neck strip is measured at the head's horizontal position in steps of 5%. If the
body clip has other things moving in that strip (an arm across the neck) the
measurement can wobble; lower the amount or turn it off for that clip.
`GET /api/projects/:name/characters/:characterId/shots/:shotId/body-motion?x=0.5`
returns `{ "offsets": [...] }` (fractions of the body frame's height per source
frame); head segments store `followBody`.

**Dialogue audio in the Head Rig.** In a character's Head Rig, **Dialogue audio…**
(left sidebar) does the same job without going to the Stage. Import the real
recording (mp3/wav; nothing is generated), or pick one already imported for
that character. Drag across the waveform to pick each line (drag a line's edge
or type its times to adjust; lines never overlap), type the words said in it
(or tick the ElevenLabs box to have them read for you; that is the only thing
that uses ElevenLabs), then **Make talking head…** opens the usual Grok / LTX
dialog for just that stretch. Pick as many separate lines as you need. When a
batch is ready, **At audio time** (next to **Place**) puts it on the head track
at the time its audio sits in the recording (frame = seconds x fps, moved to
the nearest free slot), so two lines taken from one recording keep the gap
between them, and their audio lands on the Dialogue lane at the same place.
Typed words are spread evenly over the line, so they stand in for a transcript
(`text`, `textInSec`, `textDurationSec` on the talking-head `plan` / `start` bodies).

## Starting Engine Studio

You do not need a terminal. After the computer has been set up once
(see [README setup](../README.md#setup)), start it like any other app.

**Open Studio**

Double-click `start-studio.bat` in the engine folder. A minimised window
starts the engine (port `4100`, `STUDIO_ORIGIN=http://localhost:3001`)
and Studio together, restarts either if it stops, and opens the browser
at `http://localhost:3001`. That is `node launcher.js` under the hood:
it runs `next build` when Studio source (or git HEAD) changed since the
last build, then `next start` on port `3001`. Set `STUDIO_DEV=1` to keep
the old `next dev` path.

**Desktop shortcut**

Double-click `install-studio-shortcut.bat`. It puts **Engine Studio** on
the desktop. After that, start from the shortcut.

**Start with Windows**

Double-click `install-studio-startup.bat`. Windows will start Engine
Studio (minimised) when you sign in.

**If the page opens but the engine is not ready yet**

The header shows a small worker status dot. Green means the engine on
port `4100` is up. Press **Restart worker** if preview is stuck on
**Buffering preview** — Studio stops the old engine (if it can) and
starts it again. If the dot is red, **Start engine** asks Studio to
start it on this PC (no terminal). If that cannot, it says so in plain
English; try the desktop shortcut again.

A second double-click of the shortcut reuses the engine and Studio if
they are already running, then opens the browser. It does not start a
second copy on those ports. The launcher restarts the engine if it
stops. Port `3000` is left alone.

The browser talks to `http://localhost:4100` (or `NEXT_PUBLIC_WORKER_URL`)
directly. The Studio UI never shows shell commands.

### Developers

`node launcher.js` from the repo root is the same supervisor (one worker,
one Studio, self-healing restart). It serves the production Next build by
default. `STUDIO_DEV=1` (or `ENGINE_STUDIO_DEV=1`) opts back into
`next dev`. One-time machine setup (Node, packages, Python venv, FFmpeg)
stays in the [README](../README.md#setup).

## Config

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `WORKER_PORT` | repo-root `.env` | `4100` | Port the worker listens on (`127.0.0.1` only). |
| `STUDIO_ORIGIN` | repo-root `.env` | unset | Extra CORS origin, for a future Vercel URL. `http://localhost:3000`, `http://127.0.0.1:3000`, and the same pair on port `3001` are always allowed. |
| `NEXT_PUBLIC_WORKER_URL` | `studio/.env.local` (see `studio/.env.example`) | `http://localhost:4100` | Worker URL the browser uses. Change this if `WORKER_PORT` is not 4100. |
| `STUDIO_DEV` | process env / repo-root `.env` | unset | `1` or `true` keeps Studio on `next dev` instead of `next build` + `next start`. |
| `XAI_API_KEY` | repo-root `.env` | unset | Bearer key for Studio **Generate** (`POST /api/generate-image`). Studio Settings writes this same field (masked, never shown back). |
| `XAI_IMAGE_MODEL` | repo-root `.env` | `grok-imagine-image-2.0` | xAI Grok Imagine image model id. |

Copy `studio/.env.example` to `studio/.env.local` only if you need to
override the worker URL.

## What it does

The default route `/` is a **home screen**: slim **Show** cards, an
**Experiments** bucket of ungrouped flat projects, **+ New show**, and
**+ New project**. Show cards list episode count and a cached thumbnail.
Experiment cards are the same as before (first-frame preview if the worker
can compose it, otherwise a cached ~480px JPEG of the first used
background; name; length; last render time). Card length is the latest
render's real duration (MP4 `mvhd` header, then cached `ffprobe`). If there
is no render yet, it uses parsed timeline frames/fps — not a dialogue-text
guess. New project creates an empty folder under `projects/` from a small
text template (`script.txt` + `library.json`) — no art is copied. New show
creates `shows/<id>/show.json` plus empty `characters/`, `backgrounds/`,
`props/`, `episodes/`, and `final/`. Click a show to open `/s/<id>`; click
an experiment to open `/p/<name>`. The home list is fetched on load, when
the window is focused, and after create/rename/duplicate/delete/restore.
While the page stays open it only polls `GET /health` so a down engine can
come back; it does not re-walk every project every few seconds.

Existing flat folders under `projects/` stay valid experiments. **Move
into a show** renames the folder to `shows/<id>/episodes/<name>` (no copy,
no delete). **Move to Experiments** on an episode reverses that. Shared
art in `projects/_global_assets` is never touched.

Each card has an actions menu: **Duplicate** (copy the folder to
`<name>-copy`, then `<name>-copy-2`, …), **Rename** (folder rename, same
name rules as create), **Download** (zip of the project or show folder),
and **Delete**. Delete asks you to type the name after listing what will
go (script files, audio, renders, local assets, sizes). It **moves** the
folder to `projects/_trash/<name>-<timestamp>` — never a hard delete, and
it never touches `projects/_global_assets`. A **Trash** section on the
home screen can **Restore** an item or **Empty trash** (that step is
permanent and has its own confirm).

Open a show for **Episodes** (cards with the same cached thumbs and real
durations), shared **Assets**, and **Final cut**. **+ New episode** is a
blank project folder or a duplicate of an existing episode. Episode
Studio is `/s/<show>/e/<episode>`: the same **Assets / Stage / Script /
Edit / Deliver** tabs, with a **Show › Episode** breadcrumb back to the
show.

Inside an episode (or a flat experiment) the default tab is **Stage**
(Resolve-style workspace). Top tabs stay **Assets**, **Stage**,
**Script**, **Edit**, **Deliver** for the full pages, with a back link,
the project name, and the **active script as plain read-only text**.
Pick and edit scripts only on the **Script** page: a left-hand list
(current scripts at the top, older files under a collapsed **tests**
group, and **+ New**). Stage, Edit, and Render always use the script
last opened on that page. That choice is remembered per project across
refreshes (`localStorage` and `studio.json` `activeScript`). **Edit**
and **Deliver** open a slim **Lip sync** settings popover (smoothing,
head bob, blinks, loud threshold) that writes project `studio.json`.
Stage preview uses the same compositor path. A project may hold several
`script*.txt` files (`script.txt`, `script_mcd.txt`, …). The orange
**Render** button parses that script (temp files only) and writes
`renders/<script-name>.mp4` so two scripts never overwrite each other's
movie. Equivalent CLI:

```bash
node src/cli.js render ../projects/sample --from-script --script script_mcd.txt --output ../projects/sample/renders/script_mcd.mp4
```

Studio Render passes the same `--script` choice through the parser, then
feeds the compositor a **temp** timeline plus `--output` so it does not
clobber the project's `timeline.json`.

- **Assets** — Resolve-style factory page: a left library tree
  (Characters, Props, Backgrounds, Actions, Sounds), each with a slim
  **+ New** (Imagine / ingest for image types; Import audio for Sounds;
  Library if there is no character yet), a main view of the selected
  character with **Front / L 3/4 / R 3/4 / Side L / Side R / Back** tabs
  and slot rows of real thumbnails, and a right inspector (cropped piece,
  on the head for eyes/mouth, bounds, used-by, history, **Approve** /
  **Redo**). Status dots and header pills (`ticked` / `locked` / `draft` /
  `missing`) come from `characters/<id>/status.json` plus the standard rig
  (present with no review is draft; missing = expected, no file). View tabs
  show present-file counts. Slot rows are grouped Head / Eyes / Mouth /
  Torso / Overlays / Arms / Legs — torso and body share Torso; shirt, shorts,
  and cape sit under Overlays; Arm rig / Arm rig L / Hands are one **Arms**
  row of whole-arm drawings with an L/R badge. After whole arms, **shirt / shorts /
  cape overlays stay** (they dress the armless torso). `torso_rig` can go once
  nothing parents split arm pieces to it. **Validate** lints the current script;
  **Open folder** opens the character folder. Factory thumbs are
  `GET .../asset?factory=1` (alpha crop + pad; `over=` composites a face
  overlay on that view's head_base). When nothing is selected the inspector
  shows a character summary, not the green-screen reference. Thumbnail grids of Characters, Backgrounds, and Props **this
  project uses** still load from the same sources: characters named in `[Cast:]` (any of its scripts) or
  sitting in a project-local `characters/` folder or listed in
  `library.json`; backgrounds from `[Location:]` / local `backgrounds/`;
  props from those locations' `staging.json`. **Library** opens a drawer of
  global characters from `projects/_global_assets` and **Add copies** the
  character folder into this project (and writes `character.json`) so the
  shared library is never referenced. The Assets header has
  **Independent: never read shared library** (on by default for new and
  existing projects) and **Make independent**, which copies every global
  asset the project currently uses (characters, locations/backgrounds,
  props, `staging_defaults.json`) into the project and turns the fallback
  off. Studio lists only project-local drawings and lets you delete any
  of them.   Click a character to see
  its slots (mouth, eyes, hands, …), drawings, named cycles, an optional
  **full-body reference** (drop/paste, stored as-is under
  `characters/<id>/_reference/`), and **Align head** (overlay the current
  head/mouth on the body or reference, then save slot offset/scale/rotation
  into a project-local `character.json`). Double-click a factory drawing to
  open the existing slot editor. On Stage, the left Assets tree
  opens the same viewer without leaving the Stage: click a **slot**
  (`mouth`, `face`, `eyes`, `right_hand`, `mic_arm`, `body`, …) for a
  labelled grid. The Assets right-hand panel lists every slot as one
  horizontally scrolling thumbnail row (slot name + count on the header,
  slim Resolve-style scrollbar, small labels under thumbs). Mouth views
  are separate rows (`Front`, `Left 3/4`, `Left side`, …) with a count and a
  **default** tag on the set `drawings_dir` points at. Confirming a Grok
  Imagine mouth-view sheet writes `mouth_<view>/` (e.g. `mouth_left_34/`)
  and the panel reloads without a refresh. Click / double-click a drawing for a large preview on
  a checkerboard (or a chosen background) with name, size, slot, offset,
  scale, and which script/cycle uses it. Prev/next arrows and the arrow
  keys step through that slot. Zoom/pan the preview. Mouth grids label
  each Rhubarb shape (X, A–H) with the plain-English sound, flag
  byte-identical duplicates, list missing shapes, and show view-set
  folders (`mouth_front/`, `mouth_left_side/`, …) plus loud variants when those files
  exist. With no `view=` the compositor and Assets grid resolve
  `mouth_front/` first when it exists, then `mouth/`. Generate/ingest of
  a front head sheet writes `mouth_front/` and points the slot at it.
  **Use this set as default** promotes the open view (old files stay in
  `_replaced/`).   **Re-align to default** crops each drawing to the head-only region
  (above the collar / shoulder flare, or the old default's head bbox),
  then matches hat-top / chin / neck to the previous default canvas,
  with a before/after overlay and x/y/scale nudge. The drawing viewer
  has **Crop to head** and a draggable collar-line handle. Scale is
  0.25×–4× on a log slider with a number input beside it, and the faint
  default overlay live-updates as you drag. **Save** / **Revert** persist
  or restore that drawing's Scale/Nudge in project-local `character.json`
  (`slots.<slot>.drawings.<name>.align`); the compositor applies that
  Scale/Nudge on top of the slot offset/scale (centre-anchored) so a
  Save shows in Stage preview and renders. An **unsaved** tag shows when
  the sliders differ from the last save. Reopening the drawing reloads
  the saved values. **Auto-fit to default** fills the sliders so the
  cropped head matches the default hat-top / chin / centre. **Apply to
  all in this slot** asks for confirmation (`Apply to N drawings`) with
  a before/after preview, then normalises every drawing to the **same**
  default drawing (same head height and anchor) without multiplying the
  current sliders. Running it twice does not compound. The Align
  head tool fits the full body plus the head overlay so handles stay
  on-screen.   **Play sample** animates the head through a chosen sample
  sentence (or a project take that already has Rhubarb cues). **Exclude
  from lip sync** (drawing viewer) keeps a mouth drawing in the slot for
  manual face/expression pins but automatic lip sync — including natural
  lipsync — skips it and falls back to a neighbour (H → C or D, or the
  previous shape). The mouth grid tags those cells **manual only**. Drop or
  paste an image onto a drawing/cell to replace it through the green-screen
  cut-out + trim pipeline (before/after, Accept/Cancel); the old file is
  copied to `characters/<id>/_replaced/<timestamp>/`, never deleted.
  **Flip horizontally** writes a mirrored PNG the same way (undoable). A
  small **L/R** tag can be set per drawing so mixed arm sheets can be
  sorted.
  **+** adds a named drawing the same way.   **Open Factory for this
  slot** opens the Factory dock for that character.
  Rename updates `character.json` cycle lists. Delete asks once, then
  moves the file to `characters/<id>/_trash/<timestamp>/`; if a script
  uses the drawing, Studio lists those lines and refuses until you
  confirm. Only project-local drawings are shown, and any of them can be
  deleted. Character thumbnails use
  `object-fit: contain` so the whole figure is visible. Character body and
  prop cards in the Assets lists use the same cached ~480px JPEG as
  background cards (`?thumb=1&v=<mtime>`).
  **Factory** lives in a bottom dock (hidden by default): open it with
  the **Factory** tab on the bottom edge, or the same-named button on
  the Assets page. Drag the dock's top splitter to resize (persisted in
  `localStorage` as `engine.studio.imagineDock.v1`); double-click to reset;
  Close or the tab again hides it so the asset grids stay fully visible
  above. Type a plain prompt (e.g. `Rodney walking long stride`), pick
  8 / 12 / 16 frames, and press **Generate**. The dock already knows the
  current project and character. Locked style, reference pictures, flat
  `#00FF00`, and rig rules (one head; eyes/mouths never full heads; never
  squash) are added silently — open **Advanced** only if you want to edit
  that pack. Results show a looping clip with **Tick** (save into the
  character library + Action Shots) and **Redo**. Nothing is wired until
  Tick. The old set dropdown / style notes / variants / cost line are
  gone. See [Image assets](#image-assets-grok-imagine)
  below.
- **Stage** — the main workspace. A large frame preview from
  `POST /api/projects/:name/preview-frame?script=`, a thin transport bar under
  the viewer (centred rewind / play / stop as small flat monochrome icon
  buttons, ~24px; play uses a small accent on the icon only; timecode on
  the left; **Import audio** then `frame N · fps · script` on the right),
  and **editable timeline lanes** at the bottom. The shot-driven workflow
  shows **Props, Action Shots, Audio, SFX, Camera** (Body/Move, Face, Dialogue,
  Mouth and Inserts are hidden; their script lines still run). Action Shots are
  baked clips placed with `[Clip:]`. The older lane set is described below.
  The old single Action lane is split so overlapping motion is visible:
  `[Move:]` / `[Swing:]` / `[Pose:]` / `[Do:]` / `body=` cycles on Body/Move,
  `face=` / `eyes=` expression pins on Face, synced mouth cues on Mouth
  (directly under Dialogue), `[Prop:]` on Props, and
  `[Camera:]` stays on Camera. `[Insert: image=…]` stills sit on
  Inserts (a PNG held for a start/end frame range; drop a drawing onto
  that lane to place one). The ruler shows the current frame under the
  playhead while you drag; line audio reseeks on scrub and resumes when
  the drag ends. Occupied lanes default to ~30px per stacked
  sub-row with the label vertically centred in a fixed-width left column;
  empty category lanes stay thin with a readable label that does not
  overlap its neighbours. A **Lanes** height slider (`+` / `−`) in the
  timeline header scales every lane between compact and tall and persists
  in `localStorage` (`engine.studio.laneHeight.v1`). Two blocks that overlap
  in the same lane stack in sub-rows instead of covering each other.
  Timed `wait=false` actions
  use their real `over=` / `for=` start and end, not just script order.
  Dialogue and audio lanes are unchanged. Space toggles
  play. Stop returns to frame 0; rewind does the same.   Play uses, in
  order: (a) an up-to-date `renders/<script-stem>.mp4` or leftover
  `output.mp4` (mtime ≥ the script) in the viewport with sound and a
  synced playhead / lane highlight — line audio is stopped so the
  video's own soundtrack is the only sound; (b) otherwise the next ~25 s
  as a client-side canvas from the preview graph (timeline + drawing
  pieces, downscaled cached textures, same placement math as the CLI).
  Play starts at the playhead in real time — it does not wait on a 25 s
  encode. If the graph cannot load, Stage falls back to cached 480p
  worker frames from the playhead, prefetching a couple of seconds
  ahead so playback continues as frames fill. The old 960×540 proxy
  segment path remains as a last resort at 854×480. Line audio is held
  until that picture is actually playing and is paused again if Stage
  has to buffer — it does not run ahead of the mouth. There is no
  120 s cap — a 9-minute shot plays from any start the same way. Line
  audio is streamed with
  `HTMLAudioElement` (range requests from `/media`) so a long WAV never
  decodes on the main thread; timeline edits never wait on audio.
  Pause, stop, rewind, and effect cleanup cancel any pending start so
  only one WAV copy can play. A seek before Play does not restart
  audio on the first tick. The audio clock follows the proxy video
  (reseek if it drifts). Dragging the playhead reseeks line audio (a
  short preview tick while dragging; resume or seek-paused on release)
  and shows the current frame number live under the handle. Scrub still
  uses `preview-frame` (preview resolution, persisted asset cache). The
  orange playhead handle sits on the time ruler; one vertical line
  continues down through every lane.
  Click or drag the empty ruler area to seek. Pointer-down on a block
  selects it and starts a drag; Shift/Ctrl-click adds to the selection;
  drag a rubber-band on empty lane area selects several; Esc clears.
  Drag a selected block (or several) left/right to change its start:
  Studio writes `at_time=` on every moved line in one pass, updates the
  lane chips immediately, and saves the script without waiting for a
  re-parse (`/lanes` on a 146-block shot can take ~10 s). One
  background parse follows. The script stays human-readable and the
  single source of truth. Instant tags with no time concept show a
  not-allowed cursor. Snap to the playhead, other block edges, whole
  seconds, and frame boundaries (hold Alt to disable); a vertical guide
  and a start-time tooltip show while dragging. Hover a block's left or
  right edge for a thin resize handle (no bulky icons). Dragging the edge
  trims the clip: timed tags rewrite `over=` / `for=` (start-edge trim
  also writes `at_time=` so the end stays put); held face/body pins write
  `hold=` (or keep an existing `over=`) for a fixed hold length so a drag
  never silently stretches them to the next pin; dialogue and `[Audio:]` write
  `trim_in=` / `trim_out=` in the source file (the married mouth track
  and Audio lane follow). Snap applies to the dragged trim edge (Alt
  disables). A tooltip shows the new in / out / duration timecodes.
  Trims cannot go below 1 frame or past the source length (not-allowed
  cursor). **S** or the header **Split** button splits the selected
  block(s) at the playhead into two script lines (timed tags keep
  durations; audio/dialogue become two clips with matching
  `at_time=` / `trim_in=` / `trim_out=`; word timings stay on the
  source). The chips update immediately (one batched rewrite +
  optimistic lanes, `PUT /script?parse=0`); a sentence that spans the
  cut stays on the left half so split pieces do not stack as duplicate
  Dialogue rows. Ctrl+Z / Ctrl+Y (and
  Ctrl+Shift+Z) undo/redo as script-text snapshots; the timeline header
  has the same buttons.
  Right-click a block for a slim menu: **Copy**, **Cut**, **Paste** (at
  the playhead), **Duplicate**, **Delete**, **Ripple delete**, and on
  Dialogue **Sync** / **Redo sync**. On a Mouth block the menu is
  **Clear lip sync** and **Redo sync** (Delete / Backspace does the same
  clear). Keyboard: Ctrl+C / Ctrl+X / Ctrl+V /
  Ctrl+D, Delete, Shift+Delete = ripple. Multi-select applies to all of
  those. Delete of Dialogue or Audio asks **Delete line, audio and
  mouth?** (Enter confirms, Esc cancels) and then removes the married
  script line(s). Undo (Ctrl+Z) still brings them back. Selecting a Mouth
  block and pressing Delete only clears that line's Rhubarb cues so it
  goes back to **not synced** — Dialogue and Audio stay. Before a line
  delete, Studio writes `at_time=`
  on later sequential lines in that scene so they keep their current
  starts (a gap stays). Ripple delete then subtracts the deleted span
  from later `at_time=` values on every lane in the same scene. Other
  scenes are unchanged. Paste of audio/dialogue copies that married set
  (mouth cues come back on re-parse); paste into another lane only when
  the block type fits (speech → Dialogue / Audio / Mouth / Face, face pins →
  Face, body → Body/Move, props → Props, camera → Camera).
  Dialogue owns its lip-sync: dragging a Dialogue block moves its audio,
  Rhubarb mouth cues, and the red Mouth block together. Synced
  (or stale) lines get exactly one Mouth block with the same
  start/end as the blue Dialogue chip (duplicates from imported-audio
  sentences plus a wrapping line are dropped); not-synced lines have no
  mouth block. Mouth blocks never sit on Face and never stack on each
  other. The mouth block is not independently draggable — click the slim
  chevron to expand and pin/swap individual mouth-shape cues (the
  tongue-out gag). Only one mouth strip is expanded at a time; the Mouth
  lane grows to fit, and cue letters stay inside that block's bounds.
  Face is expression pins only (`face=` / wink / `eyes=`). A pin with no
  `hold=` / `over=` draws a 2 s default hold (or until the next pin /
  dialogue), marked with a gold trailing edge — it does not stretch to
  the end of the shot. If the pin is a talking cycle such as
  `face=yap` (it would replace lip-sync mouths), the chip shows a small
  amber **!** with the tooltip `face=yap replaces lip-sync mouths here`.
  Cue strips are
  painted on a canvas so a 9-minute take stays one block. Chips off-screen
  are not mounted. Each Dialogue chip shows a small
  status dot (grey = not synced, green = synced, amber = stale) and a
  14px sync icon on hover or when selected — Sync this line, or Redo
  sync when it is already green. Redo on any Dialogue chip (not only
  the first) slices that line's window out of a shared long WAV, runs
  Rhubarb on the slice, and merges cues at the source offset — it does
  not re-parse the script or wipe the rest of the file. The thin header has **Sync all**, play
  selection, loop selection, and an Auto/Manual lip-sync mode (Manual
  skips Rhubarb after ElevenLabs / Import audio; write `studio.json`
  `{ "lipSync": "manual" }` or use the header toggle). **Sync all**
  walks every Dialogue chip (progress `n/N`), splits a long take into
  8 s windows so the last line (~8:40) is synced, retries a failed
  window once, and merges cues so it cannot wipe later lines.
  A selected
  Dialogue block also gets a small **View** dropdown
  (`front` / `left_34` / `left_side` / `right_34` / `right_side` / `up` /
  `down` / `back`) that writes `view=` on that script line only — it does not
  delete, invalidate, or re-run lip-sync cues, and it does not reload
  `/lanes` (that reload was wiping in-memory mouths).
  The timeline zooms like Resolve: `+` / `−` and a
  slider, Ctrl+wheel centred on the cursor, **Fit** for the whole shot,
  horizontal scroll (wheel / drag / scrollbar) when zoomed in, a ruler
  whose ticks step from frames to seconds to minutes, and the playhead
  scrolls into view during playback. Lanes, blocks, and the playhead
  share one pixel-per-frame scale. Zoom persists per project in
  `localStorage` (`engine.studio.timelineZoom.v1`).   The timeline panel
  defaults tall enough to show all eight category lanes; drag its top
  splitter to resize (persisted in `engine.studio.stageLayout.v1`;
  double-click resets). If stacked or taller lanes still overflow, the
  lane area scrolls vertically — labels scroll with the lanes and the
  time ruler stays fixed at the top. The horizontal scrollbar is a
  separate bar pinned to the very bottom edge of the timeline panel
  (always visible, never over the lanes), independent of panel height.
  **Assets / Media / Effects** are a left icon-rail dock (collapsible,
  resizable, width and last-open rail remembered in
  `engine.studio.stageLayout.v1` / `engine.studio.stageLeftPool.v1`).
  **Assets** is a slim tree of this project's characters (slots /
  drawings / cycles), props, backgrounds, imported and generated audio,
  and a placeholder **SFX / Music** group. Click a slot or drawing to
  open the viewer/grid overlay on the Stage preview (see Assets above).
  **Media** filters to
  backgrounds + audio; **Effects** is the SFX/Music placeholder. Search
  filters the tree. Drag a drawing onto Face / Body-Move / Props at a
  time to insert the matching script line (`[Action: Name face=…]`,
  `body=<cycle>`, `right_hand=<drawing>`, `[Prop: … show]`); an imported
  audio file inserts `[Audio: Name file=<label>]`; a background rewrites
  that scene's `[Location:]`. The tag is inserted in the scene that owns
  the drop time, not a selected line from another scene. Generated line
  WAVs and mouth drawings are listed but not droppable (mouths stay
  dialogue-driven). Drop a character
  or prop onto the Stage preview to place it (`[Action: Name at=<nearest
  mark>]` or `[Prop: name at=x,y]`) at the playhead; skip if the format
  has no mark or position. The right icon rail opens **Marks**, **Layers**, **Script**
  (read-only, playhead line highlighted, plus **Import audio**), and
  **Camera** drawers; they are closed by default so the stage and
  timeline keep their space.
  Camera lists `[Camera:]` moves for the shot and an **Add camera move**
  form (zoom, pan, tilt, to, reset, over, ease) that inserts the tag
  through the existing script save path. Splitters between the left
  pool, stage, right drawer, and timeline are draggable; sizes persist
  in `localStorage` (`engine.studio.stageLayout.v1`); double-click a
  splitter to reset. The playhead, scrubber, lane clicks, and
  `preview-frame` requests are clamped to `[0, total_frames-1]`; Stage
  uses the compositor's `total_frames` (via `X-Engine-Total-Frames`) so
  lanes and preview share one length even when a lane block extends a
  couple of frames past the movie. Horizontal scroll (wheel / middle-drag
  / the pinned scrollbar) and lane-height controls are unchanged.
- **Script** — full-page line-numbered editor for the selected `script*.txt` with
  Save (Ctrl/Cmd+S) and Lint. Lint names the script line for a missing
  slot drawing (`right_hand=` or an unknown name) instead of a raw
  `timeline.json` schema path. Stage preview uses the same wording.
  Insert Action buttons drop real tag templates
  from [script-format.md](script-format.md) at the cursor, using character
  names from the project cast. **Import audio (mp3/wav)** (also **Import
  audio** on the Stage transport bar and Script drawer) is a drop zone / file picker: pick a character (defaults to
  the first project character), optional label, then a dry-run summary
  (length, that speech-to-text uses ElevenLabs credits, estimated cost when
  the worker sends one) with Import / Cancel and **Skip transcription**.
  Progress lists converting, mouth shapes, and transcribing; errors such as a
  missing API key or Rhubarb are in plain words. On success, **Insert into
  script** drops `[Audio: Name file=<label>]` at the cursor (Stage: at the
  playhead line, else the end of the shot) through the same Insert Action
  path, saves, and refreshes the lanes so Audio and Dialogue show the take.
  The Stage Script drawer is the read-only counterpart; other edits still
  happen here.
  Every Studio write of a script file first saves a timestamped snapshot
  under `projects/<name>/.history/<script>/<ISO-timestamp>.txt` (colons
  in the stamp become `-` so the name is safe on Windows). Identical
  content is not written twice. Studio keeps the newest ~200 snapshots
  and drops anything older than 14 days. The Script tab header has a
  slim **History** dropdown listing those snapshots; **Restore** snapshots
  the current file first, then writes the chosen one back. Ctrl+Z on
  Stage is still the in-session undo; History is the on-disk safety net.

## Worker API (`127.0.0.1:4100`)

Parse / preview / lanes / lint / Render endpoints accept `?script=`
(`script.txt` by default; only `script.txt` or `script_<name>.txt` in the
project root). Those paths parse to **temp** files and never write
`timeline.json`. `/lanes`, `/stage`, `/playback`, and `/preview-frame`
share one in-memory parse cache (fingerprint of the script, character /
staging / library JSON, and audio files; in-flight parses are
de-duplicated) and skip the Python timeline validator. Save, lint, and
Render still validate. WAV duration is read from the RIFF header;
other media durations are cached by path + mtime + size.

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/api/projects` | Folders under `projects/`, excluding `_global_assets` and `_trash` (the Experiments bucket). Each item has `name`, `scripts`, `thumbRel`, `thumbMtime`, `durationSeconds`, `sceneCount`, `lastRenderAt`. Summaries are cached per project by a shallow directory fingerprint and built in parallel. `durationSeconds` is the latest render length, else parsed timeline frames/fps. |
| `POST` | `/api/projects` | Create an empty experiment from the template. JSON `{ "name": "episode_01" }`. |
| `POST` | `/api/projects/:name/move-to-show` | Rename `projects/<name>` to `shows/<showId>/episodes/<name>`. JSON `{ "showId", "create?", "displayName?" }`. Reversible. |
| `GET` | `/api/shows` | Shows under `shows/` that have `show.json`. |
| `POST` | `/api/shows` | Create `shows/<id>/` from `{ "name": "Sunny Banks" }` (id is slugified). |
| `GET` | `/api/shows/:showId` | Show summary, episodes, shared assets, final-cut JSON. |
| `POST` | `/api/shows/:showId/episodes` | Blank episode or `{ "name", "duplicateFrom" }`. |
| `POST` | `/api/shows/:showId/episodes/:episodeId/move-to-experiments` | Rename the episode folder back to `projects/<episodeId>`. |
| `GET`/`PUT` | `/api/shows/:showId/final-cut` | Ordered items (`episode` or `scene`) with `trimIn` / `trimOut`, plus `gapSeconds` / `fadeSeconds`. |
| `GET` | `/api/shows/:showId/final-cut/plan` | What will re-render, missing sources, duration, time/cost note (no ElevenLabs). |
| `POST` | `/api/shows/:showId/final-cut/render` | Re-render stale episode mp4s, then ffmpeg-concat to `shows/<id>/final/<name>.mp4`. |
| `GET` | `/api/projects/:name/contents` | What Delete will list: script files, audio/renders/local-asset file counts and bytes. |
| `POST` | `/api/projects/:name/trash` | Move the folder to `projects/_trash/<name>-<timestamp>`. JSON `{ "confirmName": "<name>" }` must match. Never deletes `_global_assets` or `_trash`. |
| `POST` | `/api/projects/:name/rename` | Rename the folder. JSON `{ "name": "new_name" }`. |
| `POST` | `/api/projects/:name/duplicate` | Copy the folder to `<name>-copy` (then `-copy-2`, …). Skips `node_modules` / `venv` / temp. |
| `GET` | `/api/projects/:name/download` | Stream a zip of the project folder (scripts, audio, renders, local assets, `library.json`, …). Excludes `node_modules`, `venv`, temp. |
| `GET` | `/api/trash` | Soft-deleted folders under `projects/_trash`. |
| `POST` | `/api/trash/:id/restore` | Move that trash folder back to `projects/<originalName>`. 409 if that name exists. |
| `POST` | `/api/trash/empty` | Permanently delete everything in `_trash`. JSON `{ "confirm": "empty" }`. |
| `GET` | `/api/projects/:name/scripts` | `script*.txt` files in that folder. |
| `POST` | `/api/projects/:name/scripts` | Create a new `script_*.txt` (`{ "name": "walk" }` → `script_walk.txt`). 409 if it exists. |
| `GET` | `/api/projects/:name/characters` | Characters **this project uses** (script cast + local + `library.json`), with slots (including `offset` / `scale` / `rotation`, `drawingsDir`, per-view `views[]`, and optional `canvas`), **project-local** drawings, cycles, thumbnail paths, `style`, `reference` / `referenceRel`, `default_scale`, `groups`, and `children` (rig pieces). |
| `GET` | `/api/projects/:name/characters/:id/status` | Factory Assets payload for one character. Query `?view=` (`front`, `left_34`, `right_34`, `left_side`, `right_side`, `back`) and optional `?key=` for the inspector. Rows are `character.json` slots + children, padded with standard-rig drawings. Each drawing has `key` (`<slot>/<drawing>`, usually the drawings folder + name), `rel` when a file exists, and `badge` `ticked` / `locked` / `draft` / `missing`. `missing` is computed (expected by the standard, no file) and is never stored. Also returns `status`, `redos`, `counts`, `canvas`, and `inspector` (pivot, anchor, path). |
| `PUT` | `/api/projects/:name/characters/:id/status` | Writes project-local `characters/<id>/status.json`. JSON `{ "key": "eyes_front/surprised", "state": "ticked" }` (Approve) or `{ "key", "redo": "wider lids" }` (stores the note under `_redos` and sets `draft`). Values on the file are only `ticked` / `locked` / `draft`. Never writes `_global_assets`. Returns the same factory payload as GET. |
| `GET` | `/api/projects/:name/asset?rel=&factory=1&over=` | Factory thumbnail: crop the PNG to its opaque bounds (plus padding). `over=` is an optional same-canvas head_base to composite first (eyes/mouth). |
| `POST` | `/api/projects/:name/open-folder` | Opens a project-relative folder in the desktop file manager. JSON `{ "rel": "characters/rodney" }`. |
| `GET` | `/api/projects/:name/actions` | Action JSON files: `shared/<id>` from a top-level `actions/` folder, plus `characters/<id>/actions/*.json` as `<character>/<action>`. |
| `GET` | `/api/projects/:name/actions/:characterId/:actionId/preview` | Cached looping MP4 of that action, cropped to the character (no location props). |
| `POST` | `/api/projects/:name/factory` | Factory v1. JSON `{ "mode"?: "character"\|"slot"\|"new-character"\|"prop"\|"background", "characterId"?, "slot"?, "view"?, "name"?, "prompt", "frames"?: 8\|12\|16, "advancedPrompt"?, "imageBase64"?, "dryRun?" }`. Character mode is the action sheet (locked style, project-local references, `#00FF00`). Slot mode saves one overlay/pose as a **draft** on Tick. New-character / prop / background modes skip existing character references; Tick writes a character folder, prop tile, or 16:9 background in this project only. |
| `GET` | `/api/projects/:name/factory/:characterId/:jobId` | Draft job (drawings as data URLs, warnings, ticked). |
| `GET` | `/api/projects/:name/factory/:characterId/:jobId/preview` | Looping preview MP4 for that draft. |
| `POST` | `/api/projects/:name/factory/:characterId/:jobId/tick` | Save draft drawings into the character slots (`draft`→`ticked`) and write the Action Shot JSON. |
| `POST` | `/api/projects/:name/factory/:characterId/:jobId/redo` | Drop the draft and generate again. |
| `GET` | `/api/projects/:name/library` | Global characters from `_global_assets` plus `added` ids already referenced. Library thumbs may use `?library=1` on `/asset` so the catalog still previews while Independent is on. |
| `POST` | `/api/projects/:name/library` | JSON `{ "characterId": "hicks" }`. Copies the character folder from `_global_assets` into the project, writes project-local `character.json`, and appends to `library.json`. Does not touch `_global_assets`. |
| `POST` | `/api/projects/:name/make-independent` | Copies every global character, location/background, prop, and `staging_defaults.json` the project currently uses into the project (skips files already in `_trash/` / `_replaced/`), then sets `studio.json` `independent: true`. |
| `PUT` | `/api/projects/:name/characters/:id` | JSON `{ "style": "painted semi-real" }`. Writes a project-local `character.json` (copied from global if needed) with that free-text style field. Does not touch `_global_assets`. |
| `POST` | `/api/projects/:name/characters/:id/reference` | JSON `{ "imageBase64", "filename?" }`. Stores the original image under `characters/<id>/_reference/full.<ext>` (no cut-out) and sets `reference` on a project-local `character.json`. |
| `PUT` | `/api/projects/:name/characters/:id/slots/:slot` | JSON `{ "offset"?: {x,y}, "scale"?: number, "rotation"?: number }`. Copy-on-write into project-local `character.json`. Used by **Align head**. |
| `GET` | `/api/projects/:name/characters/:id/slots/:slot` | Slot editor payload: **project-local** drawings only (size, hash, source), view folders (`?view=`), offset/scale, cycles, mouth-shape labels, duplicates, missing Rhubarb shapes. No `view=` resolves `mouth_front/` first when it exists. Parser lookup is episode → show, then global only if Independent is off (`?show=` for episodes). |
| `POST` | `/api/projects/:name/characters/:id/slots/:slot/promote-view` | JSON `{ "view" }`. Point the slot `drawings_dir` at that set; copy the previous default files to `_replaced/<timestamp>/`. |
| `POST` | `/api/projects/:name/characters/:id/slots/:slot/realign` | JSON `{ "view"?, "drawing"?, "nudge"?, "cropToHead"?, "collarY?", "normalize?" }`. Crop to the head-only region (default on; `collarY` is 0–1 of image height, or pixel Y), then align to a reference canvas (hat / chin / neck). Omit `drawing` or pass `"normalize": true` to fit every drawing in the open set to the **same** default drawing (identity nudge — does not multiply the current sliders; a second run is a no-op). A single `drawing` still uses that drawing's residual nudge. Writes identity `align` on each written drawing so Studio reloads at 1×. |
| `GET` | `/api/projects/:name/characters/:id/slots/:slot/drawings/:drawing` | Drawing viewer payload plus script/cycle usages and prev/next names in that view. |
| `GET` | `/api/projects/:name/characters/:id/slots/:slot/lipsync-preview` | Builtin sample cue tracks plus project audio that already has `.rhubarb.json`. Mouth slots only. |
| `POST` | `/api/projects/:name/characters/:id/slots/:slot/drawings/:drawing/replace` | JSON `{ "imageBase64", "filename?", "view?" }`. Green-screen cut-out + trim preview (before/after). |
| `POST` | `…/replace/confirm` | JSON `{ "sessionId" }`. Writes the new PNG as a project-local file; copies the previous file to `_replaced/<timestamp>/`. |
| `POST` | `…/replace/cancel` | JSON `{ "sessionId" }`. Drops the preview session. |
| `POST` | `/api/projects/:name/characters/:id/slots/:slot/drawings` | Add-drawing preview. JSON `{ "imageBase64", "filename?", "name?", "view?" }`. |
| `POST` | `…/drawings/confirm` | JSON `{ "sessionId", "name" }`. Writes `characters/<id>/<drawings_dir>/<name>.png`. |
| `POST` | `…/drawings/cancel` | JSON `{ "sessionId" }`. |
| `POST` | `…/drawings/:drawing/flags` | JSON `{ "excludeFromLipSync"?, "hand"?: "L"\|"R"\|null, "align"?: {x,y,scale}\|null, "view?" }`. Persist a per-drawing lip-sync skip, L/R tag, and/or Scale/Nudge in project-local `character.json` (`slots.<slot>.drawings.<name>.excludeFromLipSync` / `.hand` / `.align`). |
| `POST` | `…/drawings/:drawing/flip` | Mirror the PNG horizontally. Copies the previous file to `_replaced/<timestamp>/`. Returns `{ replaced }` for undo. |
| `POST` | `…/drawings/:drawing/restore` | JSON `{ "replaced" }`. Copy that `_replaced/` file back over the drawing (undo flip). |
| `POST` | `…/drawings/:drawing/rename` | JSON `{ "name", "view?" }`. Project-local files only; updates cycle lists and `default_drawing`. |
| `POST` | `…/drawings/:drawing/delete` | JSON `{ "confirm": true, "force?", "view?" }`. Moves a project-local file to `_trash/<timestamp>/`. If a script uses it and `force` is not set, returns **409** with `{ used, usages }`. |
| `POST` | `/api/projects/:name/characters/:id/ingest` | Drop-zone preview. JSON `{ "needId", "imageBase64?", "filename?", "frames?", "sessionId?", "grid?", "dest?" }`. Saves the original under `characters/<id>/_library/`, runs the Python cut-out pipeline (key `#00FF00` + despill + trim + split), returns a session plus cell PNGs as data URLs. A 13-mouth set always splits as a regular grid (default 5×3) on the green gutters, not connected components, and normalises each head to the same canvas. Pass `sessionId` + `grid: { cols, rows }` to re-cut the saved sheet in place. `needId: "custom"` plus `grid` and `dest` (target slot) cut a pasted sheet into that folder. Response includes `warnings` when cells are empty or much larger/smaller than the others. |
| `POST` | `/api/projects/:name/characters/:id/ingest/confirm` | JSON `{ "sessionId", "assignments": [{ "index", "name" }], "flipAll?" }`. Writes cells to slot folders (mouth `X,A,B,…`; numbered walk frames). Never overwrites: a name that already exists gets `_b`, `_c`, …. `flipAll` mirrors every cell first. Merges new slots/cycles into project-local `character.json` without deleting other entries (cycle lists append). |
| `POST` | `/api/projects/:name/characters/:id/ingest/cancel` | JSON `{ "sessionId" }`. Deletes the preview session dir. |
| `GET` | `/api/engine/settings` | `{ "xaiKeyConfigured", "xaiImageModel" }`. Never returns the key. |
| `PUT` | `/api/engine/settings` | JSON `{ "xaiApiKey" }`. Writes `XAI_API_KEY` into the repo-root `.env` and `process.env`. Never echoes the key. |
| `GET` | `/api/prompt-packs` | Built-in Imagine packs. `?character=` returns the matching pack summary. |
| `POST` | `/api/generate-image` | JSON `{ "project", "characterId", "needId", "n?", "prompt?", "frames?", "dryRun?" }`. `prompt` is the edited Imagine textarea (required for `needId: "custom"`). Dry-run returns a credit note (published xAI prices when known, else “uses xAI credits”) and writes nothing. Otherwise calls `https://api.x.ai/v1/images/generations` or `/images/edits` (Bearer `XAI_API_KEY`, model `XAI_IMAGE_MODEL` / `grok-imagine-image-2.0`) with `n` variants, auto-attaches the character full-body reference and body when present, saves each raw sheet under `characters/<id>/_library/`, and returns image URLs/base64. Plain-language errors for a missing key, rate limits, and content refusals. Never logs the key. |
| `GET` | `/api/projects/:name/staging` | Backgrounds, props, and marks for locations this project uses. |
| `GET` | `/api/projects/:name/audio` | WAV files under `audio/`: imported `audio/<label>/001_<character>.wav` and generated `audio/<scene>/<nnn>_<character>.wav`, with `kind`, `label`, `characterId`, `durationSeconds`. |
| `GET` | `/api/projects/:name/asset?rel=` | Serve a library-relative image (`characters/hicks/body.png`) using the project's Independent setting (episode → show; global skipped when Independent is on). `?library=1` still serves a shared-library preview for the Library drawer. `?thumb=1` returns a cached ~480px JPEG (mtime-invalidated) for Assets-list character / background / prop cards. `?preview=1` returns a cached PNG (max ~512px, alpha kept) for the Stage canvas. Pass `?v=<mtime>` (Studio does this) for `Cache-Control: public, max-age=31536000, immutable`. |
| `GET` | `/api/projects/:name/script?script=` | Raw selected script file. |
| `PUT` | `/api/projects/:name/script?script=` | Snapshot the previous file into `.history/<script>/`, write that file, then lint via a **temp** parse. Does **not** write `timeline.json`. Body is `text/plain` or JSON `{ "text": "..." }`. Returns `{ ok, saved, lint }`. |
| `GET` | `/api/projects/:name/script-history?script=` | List on-disk snapshots `{ id, createdAt, bytes, preview }` newest first. |
| `POST` | `/api/projects/:name/script-history/restore?script=` | JSON `{ "id" }`. Snapshots the current file first, writes the chosen snapshot, then lints. Returns `{ ok, saved, restored, id, text, lint }`. |
| `POST` | `/api/projects/:name/lint?script=` | Parse + lint without writing project files. JSON `{ "text": "..." }` lints the buffer; omit `text` to lint the file on disk. Warns when a script resolves any path from `_global_assets`. |
| `GET` | `/api/projects/:name/lanes?script=` | Temp-parse the selected script; return lane blocks (`startFrame`, `endFrame`, `label`, `lane`, `scriptLine`, `rel`, `row`, `tag`, `sourceStartFrame`, `timing`, `movable`, `cues`, `view`, `marriedId`, `trim`, `sourceDurationFrames`, `words`, `sync`, `audioRel`, `cuesRel`, `role`, `implicitHold`, `faceOverridesMouth`). `timing` says which attribute holds the event (`over=`, `for=`, `hold=`, `at_time=` / `start=`, or a pin / `[Audio:]` / dialogue placement). `sync` on Dialogue is `not_synced` / `synced` / `stale`. Synced Dialogue also emits one Mouth `role=mouth` block of the same start/end (duplicates collapsed). Face pins with no `hold=` / `over=` set `implicitHold` and cap at 2 s (or the next pin/dialogue). `face=yap`-style talking cycles set `faceOverridesMouth`. `trim` is `{ inFrames, outFrames }` in the source file (0 / source length when untrimmed). Audio blocks include `rel` (`audio/<scene>/<file>.wav`). Overlapping blocks in one lane get distinct `row` indexes (Mouth stays a single slim row). Does **not** write `timeline.json`. |
| `PUT` | `/api/projects/:name/cues` | Patch one mouth cue in an existing `audio/<scene>/<file>.wav.rhubarb.json`. JSON `{ "rel", "start", "end", "value"?, "pinned"? }`. `start`/`end` are seconds in the source file. |
| `GET` | `/api/projects/:name/settings` | Project `studio.json`. `{ "lipSync": "auto" \| "manual", "independent": true, "lipsync": { "smoothing", "head_bob", "blinks", "loud_threshold" } }`. Defaults: auto, Independent on, light, subtle, blinks on, loud 0.75. Missing `independent` is treated as `true`. |
| `PUT` | `/api/projects/:name/settings` | JSON `{ "lipSync"?, "lipsync"?, "independent"? }`. Writes `studio.json`. `independent: true` means never read `_global_assets` (episode → show still allowed). `lipsync.smoothing` is `off`/`light`/`medium`; `head_bob` is `off`/`subtle`/`strong`; `blinks` is a boolean; `loud_threshold` is a 0–1 percentile. |
| `POST` | `/api/projects/:name/lipsync?script=` | Run Rhubarb for Dialogue lines. JSON `{ "scriptLine": N }`, `{ "scriptLines": [N] }`, or `{ "all": true }`. `{ "force": true }` redoes a synced line. `{ "clear": true }` deletes that line's `<wav>.rhubarb.json` so sync returns to `not_synced` (Dialogue and Audio stay). Writes `<wav>.rhubarb.json` plus an `engine` text fingerprint when syncing. Returns `{ ok, results }`. |
| `GET` | `/api/projects/:name/stage?script=` | Parse the selected script in a temp timeline; return canvas/fps, scene layers, marks. Does **not** write `timeline.json`. |
| `GET` | `/api/projects/:name/playback?script=` | Render/proxy freshness (`renders/<stem>.mp4` or `output.mp4`, plus `<stem>_preview.mp4`) vs the script mtime, and audio-lane clips with `exists` and RIFF `durationSeconds`. Temp parse only. |
| `GET` | `/api/projects/:name/media?rel=` | Stream a project-local line WAV (`audio/<scene>/<file>.wav` only). Supports HTTP range requests. |
| `GET` | `/api/projects/:name/preview-graph?script=` | Temp-parse the selected script and return the Stage canvas graph (placements, slot drawings, sizes). Same loaded Timeline the CLI uses, including lip-sync. Does not write `timeline.json`. |
| `POST`/`GET` | `/api/projects/:name/preview-segment?script=` | Render or poll a ~25 s 854×480 H.264 play window from `{ startFrame, durationSec?, frames? }`. Starts at the requested playhead. Cached by script/asset fingerprint. Does not block the UI or write `timeline.json`. Stage prefers the canvas graph and only uses this as a last resort. |
| `GET` | `/api/projects/:name/preview-segments/:file` | Stream a cached preview segment (`<sha1>.mp4`). |
| `POST` | `/api/projects/:name/preview-frame?script=` | Parse the selected script to a temp timeline (shared cache), compose **one** frame (`{ "frame": N }` or `{ "time": seconds }`) with the same compositor as CLI `render` (full canvas, then `scale_frame` if the request asks for a size; JPEG defaults to 854×480). JPEG quality 85 for scrubbing. `{ "format": "png" }` keeps exact pixels. Frames are cached on disk/memory by script fingerprint + asset mtimes + frame. `Cache-Control: private, max-age=3600`. Metadata is in `X-Engine-*` headers. Never overwrites the project's `timeline.json`. A persistent Python compositor process stays warm so numpy/cv2 are not re-imported per frame. |
| `POST` | `/api/projects/:name/render?script=` | Parse the selected script to a temp timeline (never `timeline.json`), run the compositor with `--output renders/<script-stem>.mp4`. Same `--script` choice as the CLI. One render at a time. |
| `POST` | `/api/projects/:name/preview-render?script=` | Same temp parse as Render, but writes a 960×540 H.264 proxy to `renders/<script-stem>_preview.mp4` for Stage playback. Shares the one-at-a-time render lock. |
| `POST` | `/api/projects/:name/import-audio` | Import a pre-recorded mp3/wav for lip-sync (same as `node src/cli.js import-audio`). Studio **Import audio** sends multipart (`file` + `character` + optional `name` / `dryRun` / `noTranscribe` / `splitLong`); JSON `{ "path", "character", "name?", "dryRun?", "noTranscribe?", "splitLong?" }` still works. Copies into `audio/<label>/`, converts to the engine WAV, runs Rhubarb, and transcribes with ElevenLabs STT unless `noTranscribe`. Takes longer than 60 s are split into 30–60 s clips at silences (default; `splitLong=false` keeps one file). Dry-run returns length + the STT credit note and writes nothing. |
| `POST` | `/api/projects/:name/characters/:characterId/talking-head/plan` | Body `{ audioRel, inSec, durationSec }`. Reads the slice's `words.json` and returns `{ transcript, windows[{ index, start, end, duration, clipSec, text }], refRel, hasReference, hasWords, defaultPrompt }`. No Grok call. |
| `POST` | `/api/projects/:name/characters/:characterId/talking-head/start` | Body `{ audioRel, inSec, durationSec, prompt? }`. Creates one queued head shot per window (each with its `audio.wav` slice and `talk` metadata) and runs the Grok chain in the background. Returns `{ group, shotIds, windows }`. |
| `POST` | `/api/projects/:name/characters/:characterId/talking-head/:group/resume` | Continue a stopped chain from its first window that is not ready. |
| `POST` | `/api/projects/:name/split-audio` | Split an existing `audio/<label>/<file>.wav` over 60 s into 30–60 s chunks at word/Rhubarb silences. Reuses `.words.json` / `.rhubarb.json` (no ElevenLabs). Returns `{ chunks, tags }`. Studio rewrites the script line(s). |
| `GET` | `/api/projects/:name/renders/:file` | Stream a render (`script.mp4`, `script_mcd.mp4`, `script_preview.mp4`, or a leftover `output.mp4`). |
| `POST` | `/render` | Original CLI-oriented contract: `{ "projectDir": "..." }`. |

`:name` is validated against path traversal. `_global_assets` and `_trash`
are reserved and cannot be created, renamed to, duplicated as, or deleted.
`rel` cannot contain `..`. `?script=` cannot contain `/` or `..`. Episode
routes reuse `/api/projects/:name/…` with `?show=<showId>` so Stage /
Assets / Script / Render stay the same inside an episode.

Lane `lane` values are `body` (`[Move:]`, `[Swing:]`, `[Pose:]`, `[Do:]`,
`body=` cycles, character `at=` / `flip` / layer-z), `face` (`face=` /
`eyes=` expression pins only), `mouth` (one red lip-sync block per
synced Dialogue line), `props` (`[Prop:]` and prop layer-z), `dialogue`
(spoken lines with text), `audio` (the recorded line wavs), `sfx` (only
if the parsed scene has bed audio), and `camera` (from `[Camera:]`
keyframes). Instant body/prop pins hold until the next instant pin in the
same lane and subject (or the scene end). Face pins without `hold=` /
`over=` cap at 2 seconds or the next pin/dialogue, whichever is sooner;
`hold=` / `over=` still locks a
fixed length; duration-bearing `wait=false`
moves keep their `over=` / `for=` end frame so they can overlap a walk
cycle or a face change. Frames are global (concatenated scenes),
matching the Stage scrubber. Each block also carries `scriptLine`,
`sourceStartFrame` (the tag's placement — for `[Audio:]` sentence
blocks this is the file start, not the sentence start), and `timing`
(`kind` is `over` / `for` / `pin` / `audio` / `dialogue`; `attr` is
`over`, `for`, `at_time`, `start`, or null). Studio move-in-time always
writes `at_time=` on that line. Dialogue and its married audio share
`marriedId` (`line:<scene>:<scriptLine>`); the Mouth block for a
synced line joins that group, but Face expression pins never do. `sync`
is set on Dialogue and copied onto its mouth block. `role` is `mouth`
on that Mouth block and `pin` on a Face expression. `trim` is
`{ inFrames, outFrames }` in the source file; untrimmed clips use
`0` / `sourceDurationFrames`. Playback clips also carry `trimInSec` /
`trimOutSec` so Stage Web Audio starts inside the file.

## Image assets (Grok Imagine)

Studio **Generate** calls the xAI image API from the worker on this PC so
you do not copy prompts into the browser. The drop zone is still there if
you generate a PNG yourself.

1. Open the **Grok Imagine** dock (bottom-edge tab, or the button on
   **Assets**) and pick a character plus a set. Rodney uses the built-in
   Prompt Pack in [docs/prompt-packs/rodney.md](prompt-packs/rodney.md)
   (`rodney.json` is what Studio reads): a character-parametric **style
   block** plus complete prompts for armless body, lip-sync mouths,
   comedy expressions, eyes, hands-to-face, arm poses, head/body turns,
   walk cycles, and the speaker prop / slapstick sheets. Other characters
   fall back to `studio/lib/assetNeeds.json` (full-body reference, body
   without head, mouth sheet, expression heads, arm/hand pieces, walk
   cycle, prop, background). Paste an xAI key once in **Settings**
   (stored as `XAI_API_KEY` in the engine `.env`, masked, never shown
   back) or set it in env.
2. The prompt is prefilled from the pack (or the generic template).
   **Generate** asks how many variants (`n`, 1 / 2 / 4), shows a dry-run
   credit note first (published xAI prices when known, otherwise “uses
   xAI credits”), then calls `POST /api/generate-image`. The worker
   attaches the character’s full-body reference and body when those files
   exist (`/v1/images/edits`, otherwise `/v1/images/generations`). Raw
   sheets land in `characters/<id>/_library/`. Thumbnails come back in
   the dock; pick one and it goes through the same green-screen cut-out
   preview as a drop. Confirm adds that sheet; pick the other variant
   and confirm again to keep both. **Copy prompt** and the drop zone stay for the
   manual path. **Attach reference to prompt** still applies to copied
   generic prompts.
3. Style notes on characters without a pack come from `character.json`
   `style` (free text, e.g. `painted semi-real` or `flat cartoon`). Save
   writes a **project-local** `character.json`; shared `_global_assets`
   is never modified. The same copy-on-write path stores `reference` and
   slot `offset` / `scale` / `rotation` from the character panel.
4. Character/prop prompts always ask for a plain `#00FF00` green
   background, the same size/position in each cell, no watermark text,
   and no cropped body parts. Background plates skip the green screen
   (and skip chroma key) so the plate stays opaque. Rodney prompts never
   ask for slanted eyes or a mocking ethnic eye gesture. The Imagine
   prompt box is a normal textarea: edit, paste, or clear it, then
   **Generate** sends that text. **Reset to pack prompt** restores the
   set’s filled prompt. **Custom** is an empty box that still prepends
   the character style block; pick grid cols × rows and a target slot
   for the cut-out.
5. Drop, paste, or pick a generated PNG. The worker saves the original to
  `projects/<name>/characters/<id>/_library/`, then
  `python -m compositor.cutout` keys `#00FF00` with despill, trims, and
  splits by the template grid (or connected components). A 13-mouth sheet
  always uses the grid (5×3 unless you override), finds rows and columns
  from the green gaps so touching heads stay in their own cells, and
  normalises each head to the same size.
6. The preview grid lets you rename / reassign a cell (mouth cells map in
   order `X,A,B,…`) before **Confirm**. Empty cells and cells much larger
   or smaller than the others show a warning; **Re-cut as grid N cols × M
   rows** runs the cutter again on the saved sheet. Confirm **adds** the
   cut-out drawings to the slot folder (`mouth_<view>/` for a view set)
   and never overwrites an existing file: if `X.png` is already there, the
   new cell is written as `X_b.png` (then `_c`, …). The Assets side panel
   refreshes the view groups without a page reload. You can confirm both
   Generate variants one after the other; confirmed sheets stay marked in
   the dock. **Flip all in this sheet** mirrors every cell before it is
   written (arm sheets often mix left and right). Global library files
   are not overwritten; a local file at the same relative path is an
   override, same as [docs/assets.md](assets.md#overrides).
7. In the Assets drawing viewer, **Flip horizontally** writes a mirrored
   PNG and keeps the original in `characters/<id>/_replaced/<timestamp>/`
   (Undo flip restores that copy). A small **L/R** tag on each drawing
   (stored on project-local `character.json` as
   `slots.<slot>.drawings.<name>.hand`) marks which side an arm/hand
   belongs to so a `right_hand` slot can be cleaned of left arms.

Walk-cycle ingest adds `slots.body.cycles` (`walk_side`, `walk_front`,
`walk_back`) on the project-local `character.json`. That is the
body-as-a-slot pattern in [docs/assets.md](assets.md#the-body-as-a-slot)
— a transparent root `asset` is still something you set by hand if the
character currently uses an opaque `body.png`.

**Align head** (character detail panel) overlays the current mouth/head
drawing on the body drawing or the full-body reference. The viewport
fits the full body plus the head (including a head that sits above the
body top) so move/scale handles stay on-screen. Drag to move, corner
handles or the slider to scale around the head center, and a rotation
slider for clockwise degrees. A dropdown previews each mouth drawing.
Save writes the slot into project-local `character.json` and
re-renders a preview frame to confirm. Slot `scale` / `rotation` are
optional on the timeline slot and are applied around the attachment
point (see [docs/timeline-schema.md](timeline-schema.md)).
