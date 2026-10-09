# Studio

The Studio is a local Next.js app in `studio/`. It is built so it can be
deployed to Vercel later, but it **never** reads or writes project files
itself. The browser talks to the worker Express server running on the
user's PC (`WORKER_PORT`, default `4100` from the repo-root `.env`). That
server is bound to `127.0.0.1` only.

No Vercel Blob, no database, no auth. Voices / ElevenLabs stay on the
CLI (`node src/cli.js voices`); the Studio server API does not call them.

The **script is the source of truth**. Stage lanes are a read-only view of
a temp parse; dragging/resizing clips comes later. Save, lint, preview,
lanes, and Render never write `timeline.json` — Render parses the selected
script to a temp timeline (the same `--script` option as the CLI) and
writes `renders/<script-stem>.mp4`.

## Two terminals

From the repo root, after the usual [README setup](../README.md#setup)
(`npm install` in `worker/`, Python venv, FFmpeg on `PATH`).

**Terminal 1 — worker**

```bash
cd worker
npm start
```

That is `node src/server.js`. It should print:

```
Render worker listening on http://127.0.0.1:4100 (localhost only)
```

**Terminal 2 — Studio**

```bash
cd studio
npm install
npm run dev
```

Open `http://localhost:3000` (Next.js uses `3001` if `3000` is already
taken). The page calls `http://localhost:4100` (or `NEXT_PUBLIC_WORKER_URL`)
directly.

If the worker is not running, the Studio shows:

```
Worker is not running. Start it with: cd worker && npm start
```

Same two commands on Windows (`cd worker` then `npm start`, and `cd studio`
then `npm run dev`).

## Config

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `WORKER_PORT` | repo-root `.env` | `4100` | Port the worker listens on (`127.0.0.1` only). |
| `STUDIO_ORIGIN` | repo-root `.env` | unset | Extra CORS origin, for a future Vercel URL. `http://localhost:3000`, `http://127.0.0.1:3000`, and the same pair on port `3001` are always allowed. |
| `NEXT_PUBLIC_WORKER_URL` | `studio/.env.local` (see `studio/.env.example`) | `http://localhost:4100` | Worker URL the browser uses. Change this if `WORKER_PORT` is not 4100. |

Copy `studio/.env.example` to `studio/.env.local` only if you need to
override the worker URL.

## What it does

The default route `/` is a **home screen**: a grid of project cards
(thumbnail = first-frame preview if the worker can compose it, otherwise
a cached ~480px JPEG of the first used background; name; length; last
render time) plus a **New project** card. Card length is the latest
render's real duration (`ffprobe`, then the MP4 `mvhd` header). If there
is no render yet, it uses parsed timeline frames/fps — not a dialogue-text
guess. New project creates an empty folder under `projects/` from a small
text template (`script.txt` + `library.json`) — no art is copied. Click a
card to open `/p/<name>`.

Each card has an actions menu: **Duplicate** (copy the folder to
`<name>-copy`, then `<name>-copy-2`, …), **Rename** (folder rename, same
name rules as create), **Download** (zip of the project folder), and
**Delete**. Delete asks you to type the project name after listing what
will go (script files, audio, renders, local assets, sizes). It **moves**
the folder to `projects/_trash/<name>-<timestamp>` — never a hard delete,
and it never touches `projects/_global_assets`. A **Trash** section on the
home screen can **Restore** an item or **Empty trash** (that step is
permanent and has its own confirm).

Inside a project: **Assets**, **Stage**, **Script**, **Edit**, **Deliver**,
a back-to-home link, the project name, and a **script picker**. A project
may hold several `script*.txt` files (`script.txt`, `script_mcd.txt`, …).
Stage, lanes, the Script page, preview, and Render all use the selected
file. The orange **Render** button parses that script (temp files only)
and writes `renders/<script-name>.mp4` so two scripts never overwrite
each other's movie. Equivalent CLI:

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
  its slots (mouth, eyes, hands, …), drawings, and named cycles. On the
  same page, **Grok Imagine** builds a ready-to-copy prompt per character
  and need (templates in `studio/lib/assetNeeds.json`), then a drop zone
  ingests the PNG you generated in the browser — there is no image-generation
  API. See [Image assets](#image-assets-grok-imagine) below.
- **Stage** — a large frame preview from
  `POST /api/projects/:name/preview-frame?script=`, a time scrubber, the
  current location's marks, a read-only layer list in z order, and
  **read-only timeline lanes** at the bottom (Action, Dialogue, Audio, SFX,
  Camera). The playhead follows the scrubber. Click a block to seek the
  preview and highlight that script line. Lane editing by drag is a later PR.
- **Script** — line-numbered editor for the selected `script*.txt` with
  Save (Ctrl/Cmd+S) and Lint. Insert Action buttons drop real tag templates
  from [script-format.md](script-format.md) at the cursor, using character
  names from the project cast.

## Worker API (`127.0.0.1:4100`)

Parse / preview / lanes / lint / Render endpoints accept `?script=`
(`script.txt` by default; only `script.txt` or `script_<name>.txt` in the
project root). Those paths parse to **temp** files and never write
`timeline.json`.

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/api/projects` | Folders under `projects/`, excluding `_global_assets` and `_trash`. Each item has `name`, `scripts`, `thumbRel`, `durationSeconds`, `sceneCount`, `lastRenderAt`. `durationSeconds` is the latest render length, else parsed timeline frames/fps. |
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
| `GET` | `/api/projects/:name/characters` | Characters **this project uses** (script cast + local + `library.json`), with slots, drawings, cycles, thumbnail paths, and `style`. |
| `GET` | `/api/projects/:name/library` | Global characters from `_global_assets` plus `added` ids already referenced. |
| `POST` | `/api/projects/:name/library` | JSON `{ "characterId": "hicks" }`. Appends to `library.json`; does not copy art. |
| `PUT` | `/api/projects/:name/characters/:id` | JSON `{ "style": "painted semi-real" }`. Writes a project-local `character.json` (copied from global if needed) with that free-text style field. Does not touch `_global_assets`. |
| `POST` | `/api/projects/:name/characters/:id/ingest` | Drop-zone preview. JSON `{ "needId", "imageBase64", "filename?", "frames?" }`. Saves the original under `characters/<id>/_library/`, runs the Python cut-out pipeline (key `#00FF00` + despill + trim + split), returns a session plus cell PNGs as data URLs. |
| `POST` | `/api/projects/:name/characters/:id/ingest/confirm` | JSON `{ "sessionId", "assignments": [{ "index", "name" }] }`. Writes cells to slot folders (mouth `X,A,B,…`; numbered walk frames), backs up overwritten **local** files to `_backup/<timestamp>/`, merges new slots/cycles into project-local `character.json` without deleting other entries. |
| `POST` | `/api/projects/:name/characters/:id/ingest/cancel` | JSON `{ "sessionId" }`. Deletes the preview session dir. |
| `GET` | `/api/projects/:name/staging` | Backgrounds, props, and marks for locations this project uses. |
| `GET` | `/api/projects/:name/asset?rel=` | Serve a library-relative image (`characters/hicks/body.png`). `?thumb=1` returns a cached ~480px JPEG (mtime-invalidated) for background cards. |
| `GET` | `/api/projects/:name/script?script=` | Raw selected script file. |
| `PUT` | `/api/projects/:name/script?script=` | Write that file, then lint via a **temp** parse. Does **not** write `timeline.json`. Body is `text/plain` or JSON `{ "text": "..." }`. Returns `{ ok, saved, lint }`. |
| `POST` | `/api/projects/:name/lint?script=` | Parse + lint without writing project files. JSON `{ "text": "..." }` lints the buffer; omit `text` to lint the file on disk. |
| `GET` | `/api/projects/:name/lanes?script=` | Temp-parse the selected script; return lane blocks (`startFrame`, `endFrame`, `label`, `lane`, `scriptLine`). Does **not** write `timeline.json`. |
| `GET` | `/api/projects/:name/stage?script=` | Parse the selected script in a temp timeline; return canvas/fps, scene layers, marks. Does **not** write `timeline.json`. |
| `POST` | `/api/projects/:name/preview-frame?script=` | Parse the selected script to a temp timeline, compose **one** frame (`{ "frame": N }` or `{ "time": seconds }`), return a PNG. Metadata is in `X-Engine-*` headers. Never overwrites the project's `timeline.json`. |
| `POST` | `/api/projects/:name/render?script=` | Parse the selected script to a temp timeline (never `timeline.json`), run the compositor with `--output renders/<script-stem>.mp4`. Same `--script` choice as the CLI. One render at a time. |
| `GET` | `/api/projects/:name/renders/:file` | Stream a render (`script.mp4`, `script_mcd.mp4`, or a leftover `output.mp4`). |
| `POST` | `/render` | Original CLI-oriented contract: `{ "projectDir": "..." }`. |

`:name` is validated against path traversal. `_global_assets` and `_trash`
are reserved and cannot be created, renamed to, duplicated as, or deleted.
`rel` cannot contain `..`. `?script=` cannot contain `/` or `..`.

Lane `lane` values are `action` (character actions, moves, poses, layer /
prop changes), `dialogue` (spoken lines with text), `audio` (the recorded
line wavs), `sfx` (only if the parsed scene has bed audio), and `camera`
(from `[Camera:]` keyframes). Frames are global (concatenated scenes),
matching the Stage scrubber.

## Image assets (Grok Imagine)

Generation happens in the browser (Grok Imagine). The Studio only builds
the prompt and cuts the resulting PNG.

1. On **Assets**, pick a character. **Grok Imagine** lists needs from
   `studio/lib/assetNeeds.json` (edit that file to change copy or grids):
   full body without head/mouth, mouth/head sheet (3×3 Rhubarb `X,A–H`),
   expression heads, arm/hand pieces, walk cycle sheet (side/front/back,
   N frames), prop on its own, background plate.
2. Style notes come from `character.json` `style` (free text, e.g.
   `painted semi-real` or `flat cartoon`). Save writes a **project-local**
   `character.json`; shared `_global_assets` is never modified.
3. **Copy prompt**, paste into Grok Imagine. Character/prop prompts always
   ask for a plain `#00FF00` green background, the same size/position in
   each cell, no watermark text, and no cropped body parts. Background
   plates skip the green screen (and skip chroma key) so the plate stays
   opaque.
4. Drop or paste the PNG onto the need. The worker saves the original to
   `projects/<name>/characters/<id>/_library/`, then
   `python -m compositor.cutout` keys `#00FF00` with despill, trims, and
   splits by the template grid (or connected components).
5. The preview grid lets you rename / reassign a cell (mouth cells map in
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
