# engine

A standalone 2D "cut-out" animation engine, built for exact artistic
control over Stuart's cartoon series (**Sunny Banks** -- an adult cartoon --
plus **Skidmarks**, **Shorts**, and music videos).

This is a deliberate rejection of "hope the generative model gets it right."
Layout, timing, staging and lip-sync are **deterministic**: a JSON timeline
describes exactly where every layer is, when it's visible, and which mouth
shape it shows on which frame, and the renderer reproduces that exactly
every time -- more like Moho / Toon Boom than a diffusion model. AI still has
a place (e.g. ElevenLabs for voices), it's just not in the rendering path.

This repo is completely separate from the older `comfybear71/deck` repo;
nothing here is derived from it.

## Architecture

```
          writes/edits                reads + validates
  Studio ───────────────► timeline.json ───────────────► Render worker
 (Next.js,                (shared contract,              (Node orchestrator
  on Vercel,               schema/timeline.schema.json)    + Python compositor)
  built later)
```

- **Studio** (`studio/`, not built in this PR): a Next.js app on Vercel that
  writes scripts and edits `timeline.json`. A future piece of work parses
  `script.txt` into `timeline.json`; `docs/timeline-schema.md` exists so
  that parser has a clear target to write.
- **Render worker** (`worker/`): runs on Stuart's PC or a GPU host later.
  - Node.js (`worker/src/`) is a **thin orchestrator only**: an Express
    server and a CLI that validate a project path and spawn the Python
    compositor as a child process, plus an optional file watcher. It does
    **no** image or video processing itself.
  - Python (`worker/python/`) does all the actual image and video work,
    using `opencv-python` + `numpy` for compositing and `FFmpeg` (via
    subprocess) for encoding. There is intentionally no native Node OpenCV
    binding (`opencv4nodejs`) anywhere in this repo.
- **Shared contract**: `timeline.json`, validated against
  `schema/timeline.schema.json` by the worker before every render.

## Repo layout

```
engine/
├── schema/
│   └── timeline.schema.json     # JSON Schema (draft-07) for timeline.json
├── docs/
│   └── timeline-schema.md       # Field-by-field reference, with examples
├── worker/                      # The render worker
│   ├── package.json
│   ├── src/                     # Node orchestrator (thin)
│   │   ├── cli.js               # `node src/cli.js <projectDir> [--codec] [--watch]`
│   │   ├── server.js            # Express server: POST /render
│   │   ├── render.js            # Spawns the Python compositor
│   │   ├── watcher.js           # chokidar: re-render on timeline.json change
│   │   └── pythonRuntime.js     # Picks the right python (prefers worker/python/venv)
│   └── python/                  # The actual compositor
│       ├── requirements.txt
│       ├── pytest.ini
│       ├── compositor/
│       │   ├── __main__.py      # `python -m compositor <projectDir>`
│       │   ├── timeline_loader.py
│       │   ├── schema_validate.py
│       │   ├── asset_cache.py   # load-once, cache scaled/flipped variants
│       │   ├── transform.py     # anchor/placement/clipping math (pure)
│       │   ├── blend.py         # vectorised alpha compositing
│       │   ├── background.py    # fit background to canvas (cover/contain)
│       │   ├── camera.py        # pan/zoom/shake post-process
│       │   ├── slots.py         # drawing-swap slots (mouths, blinks, hand poses)
│       │   ├── lipsync.py       # Rhubarb integration + cue-to-shape mapping
│       │   ├── media_probe.py   # ffprobe wrapper (audio duration)
│       │   ├── ffmpeg_writer.py # streams frames into an ffmpeg subprocess
│       │   └── compositor.py    # the main per-frame render loop
│       ├── scripts/
│       │   └── generate_sample_assets.py
│       └── tests/               # pytest
├── projects/
│   └── sample/                  # A tiny end-to-end sample project
│       ├── timeline.json
│       └── assets/
│           ├── backgrounds/, characters/, mouths/, audio/, cues/
├── studio/                      # Placeholder for the future Next.js app
├── .env.example
└── .gitignore
```

## The `timeline.json` contract

Full reference: **[docs/timeline-schema.md](docs/timeline-schema.md)**.
Machine-readable schema: **[schema/timeline.schema.json](schema/timeline.schema.json)**.
Working example: **[projects/sample/timeline.json](projects/sample/timeline.json)**.

Highlights:

- A fixed output **canvas** (default 1920x1080) declared in the file. Layer
  positions are in canvas space, independent of any background's native
  resolution -- the background is fitted (scaled) to the canvas.
- Each **layer** has an id/character_id, an asset path, an explicit `z`
  (draw order), a `transform` (x, y, scale, anchor, flip_x, rotation,
  opacity), optional start/end timing, and an optional dialogue audio path.
- **Scene and layer timing can be derived from audio duration** (via
  `ffprobe`) instead of only a hand-typed frame count -- hand-set frames are
  still fully supported.
- **Drawing-swap slots** (Toon Boom/Moho style): a layer (or rig child) can
  carry named slots -- `mouth`, `eyes`, `right_hand`, anything -- each
  showing one named drawing at a time, held until changed. A slot is driven
  either by hand-authored keyframes (a blink, a hand pose change) or by
  Rhubarb lip-sync cues (a mouth is just a cue-driven slot) -- one unified
  mechanism for all of it, with a safe, non-fatal fallback if Rhubarb isn't
  installed -- see below.
- **Cut-out rig nesting**: a layer can have `children` (head, arm, hand,
  ...) with their own offset/pivot/z relative to the parent root. The
  parent's position/scale/flip apply to every child automatically, so
  flips and off-screen walk-ons keep all the parts aligned and clipped
  together.
- `frame_step` on a scene (default `1`; `2` = animate "on 2s", etc.): the
  compositor holds and re-sends the previous frame's pixels on in-between
  frames instead of recomposing, for a punchy cut-out cadence. Audio always
  stays at full, continuous rate.
- An optional, minimal **camera** (pan/zoom keyframes + shake), kept
  deliberately simple so it can grow.
- All asset paths are **relative to the project folder** (the directory
  containing `timeline.json`), never to the process's working directory.

## Known fixes vs. the original draft

An earlier draft compositor had several correctness/perf problems this
implementation specifically fixes:

| Problem | Fix |
|---|---|
| Layers partly off-screen were skipped entirely | Clipped via a vectorised bounding-box intersection (`transform.compute_placement`), so walk-ons/partial characters render their visible portion |
| Every PNG re-read from disk every frame | `asset_cache.AssetCache` loads each asset once and caches every distinct (scale, flip, rotation) variant |
| No explicit z-order | Layers are sorted by their required `z` field before compositing |
| Positions tied to background's native pixel size | Positions are in a fixed, declared canvas; the background is fitted to it |
| `mp4v` output (poor browser/Resolve compatibility), no audio | Frames are piped into an FFmpeg subprocess (`pipe:0`, written frame-by-frame, never buffered as a list or temp files); encodes H.264 (yuv420p) or ProRes 4444, with dialogue/ambience audio mixed in at the correct start times |
| `total_frames` hand-typed only | Scene/layer duration can be derived from an audio file's duration |

## Setup

### Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.10+
- **FFmpeg** (includes `ffprobe`) on `PATH`
- **Rhubarb Lip Sync** -- optional; only needed to generate *new* lip-sync
  cues from audio. Rendering with a committed cues JSON (like the sample
  project uses) needs zero Rhubarb install.

#### Linux (Debian/Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3-venv python3-pip
```

#### Windows (Stuart's PC)

1. Install [Node.js](https://nodejs.org/) (LTS).
2. Install [Python 3](https://www.python.org/downloads/windows/) (check
   "Add python.exe to PATH" during install).
3. Install [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) (a "full" or
   "essentials" static build) and add its `bin/` folder to your `PATH`.
4. (Optional, for generating new lip-sync cues) Download Rhubarb Lip Sync
   below.

### Rhubarb Lip Sync (optional)

Only needed if you want to run Rhubarb on new audio instead of using a
committed cues JSON.

1. Download a release for your OS from
   [DanielSWolf/rhubarb-lip-sync releases](https://github.com/DanielSWolf/rhubarb-lip-sync/releases).
2. Unzip it and put the `rhubarb` (or `rhubarb.exe`) binary on your `PATH`
   (or set `PYTHON_BIN`/pass `--rhubarb-bin` style overrides as this grows).
3. If it's not installed, renders that reference `mouth.lipsync.audio` (with
   no existing `cues` file yet) still complete: the worker prints a warning
   and that mouth falls back to its idle shape for its whole duration.

### Install dependencies

```bash
# From the repo root:

# Python (the compositor)
cd worker/python
python3 -m venv venv              # Windows: python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Node (the orchestrator)
cd ..                             # worker/
npm install
cd ..                             # back to repo root
```

### Secrets

Copy `.env.example` to `.env` and fill in real values locally. `.env` is
gitignored -- **this repo is public, never commit real secrets.**

```bash
cp .env.example .env
```

## Running the sample render

The sample project (`projects/sample/`) has two overlapping characters (one
partly off-screen), a lip-synced mouth slot driven by a committed Rhubarb
cues JSON, a blinking eyes slot driven by plain keyframes, a nested rig arm
child with its own hand-pose slot, a short dialogue audio clip, and
`frame_step: 2` ("on 2s" cadence). Its sample assets are generated
programmatically rather than committed as hand-made art:

```bash
# From the repo root, with the venv above active:
worker/python/venv/bin/python worker/python/scripts/generate_sample_assets.py
```

Then render it, either directly with Python (the compositor is a package
rooted at `worker/python/`, so run it from there):

```bash
cd worker/python
venv/bin/python -m compositor ../../projects/sample \
  --codec h264 \
  --output ../../projects/sample/renders/output.mp4
cd ../..
```

...or via the Node orchestrator, which just spawns the above (and already
knows to run it from the right directory, so project paths here are relative
to `worker/` instead):

```bash
cd worker
node src/cli.js ../projects/sample --codec h264 --output ../projects/sample/renders/output.mp4
```

For a DaVinci Resolve-friendly master instead:

```bash
node src/cli.js ../projects/sample --codec prores4444 --output ../projects/sample/renders/output.mov
```

To re-render automatically whenever `timeline.json` changes:

```bash
node src/cli.js ../projects/sample --watch
```

Verify the output has both a video and an audio stream:

```bash
ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 projects/sample/renders/output.mp4
```

## Running the tests

```bash
cd worker/python
source venv/bin/activate   # Windows: venv\Scripts\activate
pytest -q
```

This includes unit tests for off-screen clipping, z-order, anchor/flip math,
cue-to-mouth frame mapping, audio-derived duration, and the Rhubarb
missing-binary fallback, plus an end-to-end test that renders the sample
project and checks (via `ffprobe`) that the output has both a video and an
audio stream.

## Running the worker's HTTP server

For when the future Studio wants to trigger a render remotely instead of via
the CLI:

```bash
cd worker
npm start
# POST http://localhost:4100/render  { "projectDir": "../projects/sample" }
```
