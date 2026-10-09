# Studio

The Studio is a local Next.js app in `studio/`. It is built so it can be
deployed to Vercel later, but it **never** reads or writes project files
itself. The browser talks to the worker Express server running on the
user's PC (`WORKER_PORT`, default `4100` from the repo-root `.env`). That
server is bound to `127.0.0.1` only.

No Vercel Blob, no database, no auth. Voices / ElevenLabs stay on the
CLI (`node src/cli.js voices`); the Studio server API does not call them.

v1 is read-only plus preview: browse the asset library, scrub one
composited frame, and kick off the existing render. Script editing, drag
staging, and the Edit/Deliver tabs come later.

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

Open `http://localhost:3000`. The page calls
`http://localhost:4100` (or `NEXT_PUBLIC_WORKER_URL`) directly.

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
| `STUDIO_ORIGIN` | repo-root `.env` | unset | Extra CORS origin, for a future Vercel URL. `http://localhost:3000` and `http://127.0.0.1:3000` are always allowed. |
| `NEXT_PUBLIC_WORKER_URL` | `studio/.env.local` (see `studio/.env.example`) | `http://localhost:4100` | Worker URL the browser uses. Change this if `WORKER_PORT` is not 4100. |

Copy `studio/.env.example` to `studio/.env.local` only if you need to
override the worker URL.

## What it does

Top tabs: **Assets**, **Stage**, **Script**, **Edit**, **Deliver**. Only
Assets and Stage are functional. The orange **Render** button (top right)
parses the project's `script.txt` and runs the existing compositor.

- **Assets** — thumbnail grids of Characters, Backgrounds, and Props.
  Characters come from `projects/_global_assets/characters` plus any
  project-local `characters/` folder. Click a character to see its slots
  (mouth, eyes, hands, …), drawings, and named cycles. Backgrounds, props,
  and marks come from each location's `staging.json`.
- **Stage** — project picker (in the top bar), a large frame preview from
  `POST /api/projects/:name/preview-frame`, a time scrubber, the current
  location's marks (click one to overlay it on the preview), and a
  read-only layer list in z order. Dragging layers is a later PR.

## Worker API (`127.0.0.1:4100`)

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/api/projects` | Folders under `projects/`, excluding `_global_assets`. |
| `GET` | `/api/projects/:name/characters` | Characters with slots, drawings, cycles, thumbnail paths. |
| `GET` | `/api/projects/:name/staging` | Backgrounds, props, and marks from `staging.json`. |
| `GET` | `/api/projects/:name/asset?rel=` | Serve a library-relative image (`characters/hicks/body.png`). |
| `GET` | `/api/projects/:name/stage` | Parse the script; return canvas/fps, scene layers, marks. |
| `POST` | `/api/projects/:name/preview-frame` | Parse the script, compose **one** frame (`{ "frame": N }` or `{ "time": seconds }`), return a PNG. Metadata is in `X-Engine-*` headers. |
| `POST` | `/api/projects/:name/render` | Parse the script, run the existing render, return the mp4 `outputPath` and `url`. One render at a time. |
| `GET` | `/api/projects/:name/renders/output.mp4` | Stream the latest render. |
| `POST` | `/render` | Original CLI-oriented contract: `{ "projectDir": "..." }`. |

`:name` is validated against path traversal. `rel` cannot contain `..`.
