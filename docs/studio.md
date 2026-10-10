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
Speech-to-Text + Rhubarb). You never need the command line for that.

The **script is the source of truth**. Stage lanes are a view of a temp
parse. Timeline edits (select, move, trim, split, delete, ripple,
copy/paste, asset drops) rewrite the matching script line(s) with
`at_time=` / duration / `trim_in=` / `trim_out=`, then re-parse; they
never write `timeline.json`. Save, lint, preview, lanes, and Render
still parse the selected script to a temp timeline (the same `--script`
option as the CLI). Render writes `renders/<script-stem>.mp4`.

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

Studio shows **Engine is starting…** and checks again every 2 seconds.
Press **Start engine** if it stays that way — that asks Studio to start
the engine on this PC (no terminal). If that cannot, it says so in
plain English; try the desktop shortcut again.

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

The default route `/` is a **home screen**: a grid of project cards
(thumbnail = first-frame preview if the worker can compose it, otherwise
a cached ~480px JPEG of the first used background; name; length; last
render time) plus a **New project** card. Card length is the latest
render's real duration (MP4 `mvhd` header, then cached `ffprobe`). If there
is no render yet, it uses parsed timeline frames/fps — not a dialogue-text
guess. New project creates an empty folder under `projects/` from a small
text template (`script.txt` + `library.json`) — no art is copied. Click a
card to open `/p/<name>`. The home list is fetched on load, when the
window is focused, and after create/rename/duplicate/delete/restore. While
the page stays open it only polls `GET /health` so a down engine can come
back; it does not re-walk every project every few seconds.

Each card has an actions menu: **Duplicate** (copy the folder to
`<name>-copy`, then `<name>-copy-2`, …), **Rename** (folder rename, same
name rules as create), **Download** (zip of the project folder), and
**Delete**. Delete asks you to type the project name after listing what
will go (script files, audio, renders, local assets, sizes). It **moves**
the folder to `projects/_trash/<name>-<timestamp>` — never a hard delete,
and it never touches `projects/_global_assets`. A **Trash** section on the
home screen can **Restore** an item or **Empty trash** (that step is
permanent and has its own confirm).

Inside a project the default tab is **Stage** (Resolve-style workspace).
Top tabs stay **Assets**, **Stage**, **Script**, **Edit**, **Deliver** for
the full pages, with a back-to-home link, the project name, and a
**script picker**. A project may hold several `script*.txt` files
(`script.txt`, `script_mcd.txt`, …). Stage, lanes, the Script page,
preview, and Render all use the selected file. The orange **Render**
button parses that script (temp files only) and writes
`renders/<script-name>.mp4` so two scripts never overwrite each other's
movie. Equivalent CLI:

```bash
node src/cli.js render ../projects/sample --from-script --script script_mcd.txt --output ../projects/sample/renders/script_mcd.mp4
```

Studio Render passes the same `--script` choice through the parser, then
feeds the compositor a **temp** timeline plus `--output` so it does not
clobber the project's `timeline.json`.

- **Assets** — thumbnail grids of Characters, Backgrounds, and Props **this
  project uses**: characters named in `[Cast:]` (any of its scripts) or
  sitting in a project-local `characters/` folder or listed in
  `library.json`; backgrounds from `[Location:]` / local `backgrounds/`;
  props from those locations' `staging.json`. **Library** opens a drawer of
  global characters from `projects/_global_assets` and **Add** records a
  reference in `library.json` without copying art. Click a character to see
  its slots (mouth, eyes, hands, …), drawings, named cycles, an optional
  **full-body reference** (drop/paste, stored as-is under
  `characters/<id>/_reference/`), and **Align head** (overlay the current
  head/mouth on the body or reference, then save slot offset/scale/rotation
  into a project-local `character.json`). Character thumbnails use
  `object-fit: contain` so the whole figure is visible. Character body and
  prop cards in the Assets lists use the same cached ~480px JPEG as
  background cards (`?thumb=1&v=<mtime>`).
  **Grok Imagine** lives in a bottom dock (hidden by default): open it with
  the **Grok Imagine** tab on the bottom edge, or the same-named button on
  the Assets page. Drag the dock's top splitter to resize (persisted in
  `localStorage` as `engine.studio.imagineDock.v1`); double-click to reset;
  Close or the tab again hides it so the asset grids stay fully visible
  above. The dock prefills a prompt per character and set (built-in Prompt
  Pack for Rodney in `docs/prompt-packs/`; generic templates in
  `studio/lib/assetNeeds.json`), then **Generate** calls xAI from the
  worker so you do not copy the prompt out. The drop zone still ingests a
  PNG you made in the browser. See [Image assets](#image-assets-grok-imagine)
  below.
- **Stage** — the main workspace. A large frame preview from
  `POST /api/projects/:name/preview-frame?script=`, a thin transport bar under
  the viewer (centred rewind / play / stop as small flat monochrome icon
  buttons, ~24px; play uses a small accent on the icon only; timecode on
  the left; **Import audio** then `frame N · fps · script` on the right),
  and **editable timeline lanes** at the bottom (Body/Move, Face, Props,
  Dialogue, Audio, SFX, Camera).
  The old single Action lane is split so overlapping motion is visible:
  `[Move:]` / `[Swing:]` / `[Pose:]` / `body=` cycles on Body/Move,
  `face=` / `eyes=` / mouth pins on Face, `[Prop:]` on Props, and
  `[Camera:]` stays on Camera. Occupied lanes default to ~30px per stacked
  sub-row with the label vertically centred in a fixed-width left column;
  empty category lanes stay thin with a readable label that does not
  overlap its neighbours. A **Lanes** height slider (`+` / `−`) in the
  timeline header scales every lane between compact and tall and persists
  in `localStorage` (`engine.studio.laneHeight.v1`). Two blocks that overlap
  in the same lane stack in sub-rows instead of covering each other.
  Timed `wait=false` actions
  use their real `over=` / `for=` start and end, not just script order.
  Dialogue and audio lanes are unchanged. Space toggles
  play. Stop returns to frame 0; rewind does the same. Play uses, in
  order: (a) an up-to-date `renders/<script-stem>.mp4` or leftover
  `output.mp4` (mtime ≥ the script) in the viewport with sound and a
  synced playhead / lane highlight — Web Audio is stopped so the
  video's own soundtrack is the only sound; (b) otherwise stepping
  `preview-frame` with prefetch/cache plus the audio-lane WAVs through
  Web Audio at their frame offsets, clamped to `total_frames`. Line
  WAVs are fetched and decoded when the clips load, not on first Play;
  Stage shows **Loading audio…** until that finishes. Pause, stop,
  rewind, and effect cleanup cancel any pending start so only one WAV
  copy can play. A seek before Play does not restart audio on the first
  tick. (c) if the shot is two minutes or shorter and stepping cannot
  keep real time, a 960×540 proxy render to
  `renders/<script-stem>_preview.mp4` with a **Rendering preview…**
  state, then that video plays. Shots longer than two minutes stay on
  stepped preview with line audio; they do not auto-kick a proxy from
  the first slow frame. The orange playhead handle sits on the
  time ruler; one vertical line continues down through every lane.
  Click or drag the empty ruler area to seek. Pointer-down on a block
  selects it and starts a drag; Shift/Ctrl-click adds to the selection;
  drag a rubber-band on empty lane area selects several; Esc clears.
  Drag a selected block (or several) left/right to change its start:
  Studio writes `at_time=` on the matching script line(s), saves
  (debounced), and re-parses so the script stays human-readable and the
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
  source). Ctrl+Z / Ctrl+Y (and
  Ctrl+Shift+Z) undo/redo as script-text snapshots; the timeline header
  has the same buttons.
  Right-click a block for a slim menu: **Copy**, **Cut**, **Paste** (at
  the playhead), **Duplicate**, **Delete**, **Ripple delete**, and on
  Dialogue **Sync** / **Redo sync**. Keyboard: Ctrl+C / Ctrl+X / Ctrl+V /
  Ctrl+D, Delete, Shift+Delete = ripple. Multi-select applies to all of
  those. Delete removes the block's script line(s). Married
  Dialogue+Audio+mouth share a line, so they go together; a mouth block
  cannot be removed on its own. Before delete, Studio writes `at_time=`
  on later sequential lines in that scene so they keep their current
  starts (a gap stays). Ripple delete then subtracts the deleted span
  from later `at_time=` values on every lane in the same scene. Other
  scenes are unchanged. Paste of audio/dialogue copies that married set
  (mouth cues come back on re-parse); paste into another lane only when
  the block type fits (speech → Dialogue / Audio / Face, face pins →
  Face, body → Body/Move, props → Props, camera → Camera).
  Dialogue owns its lip-sync: dragging a Dialogue block moves its audio,
  Rhubarb mouth cues, and the red Face **mouth** block together. Synced
  (or stale) lines get exactly one Face mouth block with the same
  start/end as the blue Dialogue chip; not-synced lines have no red mouth
  block. The mouth block is not independently draggable — click the slim
  chevron to expand and pin/swap individual mouth-shape cues (the
  tongue-out gag). Face expression pins (`face=` / wink / `eyes=`) stay
  independent on the same lane (stacked if they overlap). Cue strips are
  painted on a canvas so a 9-minute take stays one block. Chips off-screen
  are not mounted. Each Dialogue chip shows a small
  status dot (grey = not synced, green = synced, amber = stale) and a
  14px sync icon on hover or when selected — Sync this line, or Redo
  sync when it is already green. The thin header has **Sync all**, play
  selection, loop selection, and an Auto/Manual lip-sync mode (Manual
  skips Rhubarb after ElevenLabs / Import audio; write `studio.json`
  `{ "lipSync": "manual" }` or use the header toggle). A selected
  Dialogue block also gets a small **View** dropdown
  (`front` / `left_34` / `left_side` / `right_34` / `right_side` / `up` /
  `down`) that writes `view=` on that script line.
  The timeline zooms like Resolve: `+` / `−` and a
  slider, Ctrl+wheel centred on the cursor, **Fit** for the whole shot,
  horizontal scroll (wheel / drag / scrollbar) when zoomed in, a ruler
  whose ticks step from frames to seconds to minutes, and the playhead
  scrolls into view during playback. Lanes, blocks, and the playhead
  share one pixel-per-frame scale. Zoom persists per project in
  `localStorage` (`engine.studio.timelineZoom.v1`). The timeline panel
  defaults tall enough to show all seven category lanes; drag its top
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
  and a placeholder **SFX / Music** group. **Media** filters to
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
  Save (Ctrl/Cmd+S) and Lint. Insert Action buttons drop real tag templates
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
| `GET` | `/api/projects` | Folders under `projects/`, excluding `_global_assets` and `_trash`. Each item has `name`, `scripts`, `thumbRel`, `thumbMtime`, `durationSeconds`, `sceneCount`, `lastRenderAt`. Summaries are cached per project by a shallow directory fingerprint and built in parallel. `durationSeconds` is the latest render length, else parsed timeline frames/fps. |
| `POST` | `/api/projects` | Create an empty project from the template. JSON `{ "name": "episode_01" }`. |
| `GET` | `/api/projects/:name/contents` | What Delete will list: script files, audio/renders/local-asset file counts and bytes. |
| `POST` | `/api/projects/:name/trash` | Move the folder to `projects/_trash/<name>-<timestamp>`. JSON `{ "confirmName": "<name>" }` must match. Never deletes `_global_assets` or `_trash`. |
| `POST` | `/api/projects/:name/rename` | Rename the folder. JSON `{ "name": "new_name" }`. |
| `POST` | `/api/projects/:name/duplicate` | Copy the folder to `<name>-copy` (then `-copy-2`, …). Skips `node_modules` / `venv` / temp. |
| `GET` | `/api/projects/:name/download` | Stream a zip of the project folder (scripts, audio, renders, local assets, `library.json`, …). Excludes `node_modules`, `venv`, temp. |
| `GET` | `/api/trash` | Soft-deleted folders under `projects/_trash`. |
| `POST` | `/api/trash/:id/restore` | Move that trash folder back to `projects/<originalName>`. 409 if that name exists. |
| `POST` | `/api/trash/empty` | Permanently delete everything in `_trash`. JSON `{ "confirm": "empty" }`. |
| `GET` | `/api/projects/:name/scripts` | `script*.txt` files in that folder. |
| `GET` | `/api/projects/:name/characters` | Characters **this project uses** (script cast + local + `library.json`), with slots (including `offset` / `scale` / `rotation`), drawings, cycles, thumbnail paths, `style`, and `reference` / `referenceRel`. |
| `GET` | `/api/projects/:name/library` | Global characters from `_global_assets` plus `added` ids already referenced. |
| `POST` | `/api/projects/:name/library` | JSON `{ "characterId": "hicks" }`. Appends to `library.json`; does not copy art. |
| `PUT` | `/api/projects/:name/characters/:id` | JSON `{ "style": "painted semi-real" }`. Writes a project-local `character.json` (copied from global if needed) with that free-text style field. Does not touch `_global_assets`. |
| `POST` | `/api/projects/:name/characters/:id/reference` | JSON `{ "imageBase64", "filename?" }`. Stores the original image under `characters/<id>/_reference/full.<ext>` (no cut-out) and sets `reference` on a project-local `character.json`. |
| `PUT` | `/api/projects/:name/characters/:id/slots/:slot` | JSON `{ "offset"?: {x,y}, "scale"?: number, "rotation"?: number }`. Copy-on-write into project-local `character.json`. Used by **Align head**. |
| `POST` | `/api/projects/:name/characters/:id/ingest` | Drop-zone preview. JSON `{ "needId", "imageBase64", "filename?", "frames?" }`. Saves the original under `characters/<id>/_library/`, runs the Python cut-out pipeline (key `#00FF00` + despill + trim + split), returns a session plus cell PNGs as data URLs. |
| `POST` | `/api/projects/:name/characters/:id/ingest/confirm` | JSON `{ "sessionId", "assignments": [{ "index", "name" }] }`. Writes cells to slot folders (mouth `X,A,B,…`; numbered walk frames), backs up overwritten **local** files to `_backup/<timestamp>/`, merges new slots/cycles into project-local `character.json` without deleting other entries. |
| `POST` | `/api/projects/:name/characters/:id/ingest/cancel` | JSON `{ "sessionId" }`. Deletes the preview session dir. |
| `GET` | `/api/engine/settings` | `{ "xaiKeyConfigured", "xaiImageModel" }`. Never returns the key. |
| `PUT` | `/api/engine/settings` | JSON `{ "xaiApiKey" }`. Writes `XAI_API_KEY` into the repo-root `.env` and `process.env`. Never echoes the key. |
| `GET` | `/api/prompt-packs` | Built-in Imagine packs. `?character=` returns the matching pack summary. |
| `POST` | `/api/generate-image` | JSON `{ "project", "characterId", "needId", "n?", "prompt?", "frames?", "dryRun?" }`. Dry-run returns a credit note (published xAI prices when known, else “uses xAI credits”) and writes nothing. Otherwise calls `https://api.x.ai/v1/images/generations` or `/images/edits` (Bearer `XAI_API_KEY`, model `XAI_IMAGE_MODEL` / `grok-imagine-image-2.0`) with `n` variants, auto-attaches the character full-body reference and body when present, saves each raw sheet under `characters/<id>/_library/`, and returns image URLs/base64. Plain-language errors for a missing key, rate limits, and content refusals. Never logs the key. |
| `GET` | `/api/projects/:name/staging` | Backgrounds, props, and marks for locations this project uses. |
| `GET` | `/api/projects/:name/audio` | WAV files under `audio/`: imported `audio/<label>/001_<character>.wav` and generated `audio/<scene>/<nnn>_<character>.wav`, with `kind`, `label`, `characterId`, `durationSeconds`. |
| `GET` | `/api/projects/:name/asset?rel=` | Serve a library-relative image (`characters/hicks/body.png`). `?thumb=1` returns a cached ~480px JPEG (mtime-invalidated) for Assets-list character / background / prop cards. Pass `?v=<mtime>` (Studio does this) for `Cache-Control: public, max-age=31536000, immutable`. |
| `GET` | `/api/projects/:name/script?script=` | Raw selected script file. |
| `PUT` | `/api/projects/:name/script?script=` | Write that file, then lint via a **temp** parse. Does **not** write `timeline.json`. Body is `text/plain` or JSON `{ "text": "..." }`. Returns `{ ok, saved, lint }`. |
| `POST` | `/api/projects/:name/lint?script=` | Parse + lint without writing project files. JSON `{ "text": "..." }` lints the buffer; omit `text` to lint the file on disk. |
| `GET` | `/api/projects/:name/lanes?script=` | Temp-parse the selected script; return lane blocks (`startFrame`, `endFrame`, `label`, `lane`, `scriptLine`, `rel`, `row`, `tag`, `sourceStartFrame`, `timing`, `movable`, `cues`, `view`, `marriedId`, `trim`, `sourceDurationFrames`, `words`, `sync`, `audioRel`, `cuesRel`, `role`). `timing` says which attribute holds the event (`over=`, `for=`, `hold=`, `at_time=` / `start=`, or a pin / `[Audio:]` / dialogue placement). `sync` on Dialogue is `not_synced` / `synced` / `stale`. Synced Dialogue also emits a Face `role=mouth` block of the same start/end. `trim` is `{ inFrames, outFrames }` in the source file (0 / source length when untrimmed). Audio blocks include `rel` (`audio/<scene>/<file>.wav`). Overlapping blocks in one lane get distinct `row` indexes. Does **not** write `timeline.json`. |
| `PUT` | `/api/projects/:name/cues` | Patch one mouth cue in an existing `audio/<scene>/<file>.wav.rhubarb.json`. JSON `{ "rel", "start", "end", "value"?, "pinned"? }`. `start`/`end` are seconds in the source file. |
| `GET` | `/api/projects/:name/settings` | Project `studio.json`. `{ "lipSync": "auto" \| "manual" }` (default auto). |
| `PUT` | `/api/projects/:name/settings` | JSON `{ "lipSync": "auto" \| "manual" }`. Writes `studio.json`. |
| `POST` | `/api/projects/:name/lipsync?script=` | Run Rhubarb for Dialogue lines. JSON `{ "scriptLine": N }`, `{ "scriptLines": [N] }`, or `{ "all": true }`. `{ "force": true }` redoes a synced line. Writes `<wav>.rhubarb.json` plus an `engine` text fingerprint. Returns `{ ok, results }`. |
| `GET` | `/api/projects/:name/stage?script=` | Parse the selected script in a temp timeline; return canvas/fps, scene layers, marks. Does **not** write `timeline.json`. |
| `GET` | `/api/projects/:name/playback?script=` | Render/proxy freshness (`renders/<stem>.mp4` or `output.mp4`, plus `<stem>_preview.mp4`) vs the script mtime, and audio-lane clips with `exists`. Temp parse only. |
| `GET` | `/api/projects/:name/media?rel=` | Stream a project-local line WAV (`audio/<scene>/<file>.wav` only). |
| `POST` | `/api/projects/:name/preview-frame?script=` | Parse the selected script to a temp timeline (shared cache), compose **one** frame (`{ "frame": N }` or `{ "time": seconds }`), return a JPEG (quality 85) for scrubbing. `{ "format": "png" }` keeps exact pixels. Frames are cached on disk/memory by script fingerprint + asset mtimes + frame. `Cache-Control: private, max-age=3600`. Metadata is in `X-Engine-*` headers. Never overwrites the project's `timeline.json`. A persistent Python compositor process stays warm so numpy/cv2 are not re-imported per frame. |
| `POST` | `/api/projects/:name/render?script=` | Parse the selected script to a temp timeline (never `timeline.json`), run the compositor with `--output renders/<script-stem>.mp4`. Same `--script` choice as the CLI. One render at a time. |
| `POST` | `/api/projects/:name/preview-render?script=` | Same temp parse as Render, but writes a 960×540 H.264 proxy to `renders/<script-stem>_preview.mp4` for Stage playback. Shares the one-at-a-time render lock. |
| `POST` | `/api/projects/:name/import-audio` | Import a pre-recorded mp3/wav for lip-sync (same as `node src/cli.js import-audio`). Studio **Import audio** sends multipart (`file` + `character` + optional `name` / `dryRun` / `noTranscribe`); JSON `{ "path", "character", "name?", "dryRun?", "noTranscribe?" }` still works. Copies into `audio/<label>/`, converts to the engine WAV, runs Rhubarb, and transcribes with ElevenLabs STT unless `noTranscribe`. Dry-run returns length + the STT credit note and writes nothing. |
| `GET` | `/api/projects/:name/renders/:file` | Stream a render (`script.mp4`, `script_mcd.mp4`, `script_preview.mp4`, or a leftover `output.mp4`). |
| `POST` | `/render` | Original CLI-oriented contract: `{ "projectDir": "..." }`. |

`:name` is validated against path traversal. `_global_assets` and `_trash`
are reserved and cannot be created, renamed to, duplicated as, or deleted.
`rel` cannot contain `..`. `?script=` cannot contain `/` or `..`.

Lane `lane` values are `body` (`[Move:]`, `[Swing:]`, `[Pose:]`,
`body=` cycles, character `at=` / `flip` / layer-z), `face` (`face=` /
`eyes=` / mouth pins), `props` (`[Prop:]` and prop layer-z), `dialogue`
(spoken lines with text), `audio` (the recorded line wavs), `sfx` (only
if the parsed scene has bed audio), and `camera` (from `[Camera:]`
keyframes). Instant pins hold until the next instant pin in the same
lane and subject (or the scene end), unless `hold=` / `over=` locks a
fixed length; duration-bearing `wait=false`
moves keep their `over=` / `for=` end frame so they can overlap a walk
cycle or a face change. Frames are global (concatenated scenes),
matching the Stage scrubber. Each block also carries `scriptLine`,
`sourceStartFrame` (the tag's placement — for `[Audio:]` sentence
blocks this is the file start, not the sentence start), and `timing`
(`kind` is `over` / `for` / `pin` / `audio` / `dialogue`; `attr` is
`over`, `for`, `at_time`, `start`, or null). Studio move-in-time always
writes `at_time=` on that line. Dialogue and its married audio share
`marriedId` (`line:<scene>:<scriptLine>`); the Face **mouth** block for a
synced line joins that group, but Face expression pins never do. `sync`
is set on Dialogue and copied onto its mouth block. `role` is `mouth`
on that Face mouth block. `trim` is
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
   preview as a drop. **Copy prompt** and the drop zone stay for the
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
   ask for slanted eyes or a mocking ethnic eye gesture.
5. Drop, paste, or pick a generated PNG. The worker saves the original to
   `projects/<name>/characters/<id>/_library/`, then
   `python -m compositor.cutout` keys `#00FF00` with despill, trims, and
   splits by the template grid (or connected components).
6. The preview grid lets you rename / reassign a cell (mouth cells map in
   order `X,A,B,…`) before **Confirm**. Confirm writes
   `mouth/<shape>.png`, numbered cycle frames, `parts/`, `props/`, or
   `backgrounds/<name>/bg.png`. Existing **project-local** files are copied
   to `characters/<id>/_backup/<timestamp>/` first. Global library files
   are not overwritten; a local file at the same relative path is an
   override, same as [docs/assets.md](assets.md#overrides).

Walk-cycle ingest adds `slots.body.cycles` (`walk_side`, `walk_front`,
`walk_back`) on the project-local `character.json`. That is the
body-as-a-slot pattern in [docs/assets.md](assets.md#the-body-as-a-slot)
— a transparent root `asset` is still something you set by hand if the
character currently uses an opaque `body.png`.

**Align head** (character detail panel) overlays the current mouth/head
drawing on the body drawing or the full-body reference. Drag to move,
corner handles or the slider to scale around the head center, and a
rotation slider for clockwise degrees. A dropdown previews each mouth
drawing. Save writes the slot into project-local `character.json` and
re-renders a preview frame to confirm. Slot `scale` / `rotation` are
optional on the timeline slot and are applied around the attachment
point (see [docs/timeline-schema.md](timeline-schema.md)).
