# Studio

The Studio is a local Next.js app in `studio/`. It is built so it can be
deployed to Vercel later, but it **never** reads or writes project files
itself. The browser talks to the worker Express server running on the
user's Windows PC (`WORKER_PORT`, default `4100` from the repo-root
`.env`). That server is bound to `127.0.0.1` only.

No Vercel Blob, no database, no auth. Voices / ElevenLabs stay on the
CLI (`node src/cli.js voices`); the Studio server API does not call them.

## Two terminals (Windows)

From the repo root, after the usual [README setup](../README.md#setup)
(`npm install` in `worker/`, Python venv, FFmpeg on `PATH`).

**Terminal 1 — worker**

```bat
cd worker
npm start
```

That is `node src/server.js`. It should print:

```
Render worker listening on http://127.0.0.1:4100 (localhost only)
```

**Terminal 2 — Studio**

```bat
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

## Config

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `WORKER_PORT` | repo-root `.env` | `4100` | Port the worker listens on (`127.0.0.1` only). |
| `STUDIO_ORIGIN` | repo-root `.env` | unset | Extra CORS origin, for a future Vercel URL. `http://localhost:3000` and `http://127.0.0.1:3000` are always allowed. |
| `NEXT_PUBLIC_WORKER_URL` | `studio/.env.local` (see `studio/.env.example`) | `http://localhost:4100` | Worker URL the browser uses. Change this if `WORKER_PORT` is not 4100. |

Copy `studio/.env.example` to `studio/.env.local` only if you need to
override the worker URL.

## What it does

- Pick a folder under `projects/` (the shared `_global_assets` library is hidden).
- Edit `script.txt` in the left pane. **Save** or **Ctrl+S** writes the file,
  then runs the same parse + lint the CLI uses, and shows errors/warnings
  with script line numbers.
- The right pane draws a read-only horizontal timeline from `timeline.json`
  (one row per scene, one lane per character, dialogue blocks sized by
  duration; estimated/silent clips are hatched).
- **Render** parses the script, runs the existing compositor, and plays
  `renders/output.mp4` when it finishes. Only one render at a time.

There is no drag-editing, no Acts, no credit widget, and no voice
generation from this UI.
