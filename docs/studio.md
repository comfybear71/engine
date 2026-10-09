# Studio

The Studio is a local Next.js app in `studio/`. It is built so it can be
deployed to Vercel later, but it **never** reads or writes project files
itself. The browser talks to the worker Express server running on the
user's PC (`WORKER_PORT`, default `4100` from the repo-root `.env`). That
server is bound to `127.0.0.1` only.

No Vercel Blob, no database, no auth. Voices / ElevenLabs stay on the
CLI (`node src/cli.js voices`); the Studio server API does not call them.

The **script is the source of truth**. Stage lanes are a read-only view of
a temp parse; dragging/resizing clips comes later. Save and lint never
write `timeline.json` — only **Render** parses the script into the project's
`timeline.json` and runs the compositor.

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

Top tabs: **Assets**, **Stage**, **Script**, **Edit**, **Deliver**. Assets,
Stage, and Script are functional. The orange **Render** button (top right)
parses the project's `script.txt`, writes `timeline.json` from that script,
runs the existing compositor, and shows the result video.

- **Assets** — thumbnail grids of Characters, Backgrounds, and Props.
  Characters come from `projects/_global_assets/characters` plus any
  project-local `characters/` folder. Click a character to see its slots
  (mouth, eyes, hands, …), drawings, and named cycles. Backgrounds, props,
  and marks come from each location's `staging.json`.
- **Stage** — project picker (in the top bar), a large frame preview from
  `POST /api/projects/:name/preview-frame`, a time scrubber, the current
  location's marks (click one to overlay it on the preview), a read-only
  layer list in z order, and **read-only timeline lanes** at the bottom
  (Action, Dialogue, Audio, SFX, Camera). The playhead follows the
  scrubber. Click a block to seek the preview and highlight that script
  line. Lane editing by drag is a later PR.
- **Script** — line-numbered `script.txt` editor with Save (Ctrl/Cmd+S)
  and Lint. Insert Action buttons drop real tag templates from
  [script-format.md](script-format.md) at the cursor, using character
  names from the project cast.

## Worker API (`127.0.0.1:4100`)

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/api/projects` | Folders under `projects/`, excluding `_global_assets`. |
| `GET` | `/api/projects/:name/characters` | Characters with slots, drawings, cycles, thumbnail paths. |
| `GET` | `/api/projects/:name/staging` | Backgrounds, props, and marks from `staging.json`. |
| `GET` | `/api/projects/:name/asset?rel=` | Serve a library-relative image (`characters/hicks/body.png`). |
| `GET` | `/api/projects/:name/script` | Raw `script.txt`. |
| `PUT` | `/api/projects/:name/script` | Write `script.txt`, then lint via a **temp** parse. Does **not** write `timeline.json`. Body is `text/plain` or JSON `{ "text": "..." }`. Returns `{ ok, saved, lint }`. |
| `POST` | `/api/projects/:name/lint` | Parse + lint without writing project files. JSON `{ "text": "..." }` lints the buffer; omit `text` to lint the file on disk. |
| `GET` | `/api/projects/:name/lanes` | Temp-parse the script; return lane blocks (`startFrame`, `endFrame`, `label`, `lane`, `scriptLine`). Does **not** write `timeline.json`. |
| `GET` | `/api/projects/:name/stage` | Parse the script in a temp timeline; return canvas/fps, scene layers, marks. Does **not** write `timeline.json`. |
| `POST` | `/api/projects/:name/preview-frame` | Parse the script to a temp timeline, compose **one** frame (`{ "frame": N }` or `{ "time": seconds }`), return a PNG. Metadata is in `X-Engine-*` headers. Never overwrites the project's `timeline.json`. |
| `POST` | `/api/projects/:name/render` | Parse the script (writes `timeline.json` from the script only), run the existing render, return the mp4 `outputPath` and `url`. One render at a time. |
| `GET` | `/api/projects/:name/renders/output.mp4` | Stream the latest render. |
| `POST` | `/render` | Original CLI-oriented contract: `{ "projectDir": "..." }`. |

`:name` is validated against path traversal. `rel` cannot contain `..`.

Lane `lane` values are `action` (character actions, moves, poses, layer /
prop changes), `dialogue` (spoken lines with text), `audio` (the recorded
line wavs), `sfx` (only if the parsed scene has bed audio), and `camera`
(from `[Camera:]` keyframes). Frames are global (concatenated scenes),
matching the Stage scrubber.
