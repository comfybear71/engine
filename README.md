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

- **Studio** (`studio/`, not built yet): a future Next.js app on Vercel that
  will write scripts and edit `timeline.json` visually.
- **Script parser** (`worker/src/parser/`): turns a plain-text
  `script.txt` into a validated `timeline.json`, resolving characters,
  drawing-swap slots, and stage positions against a shared
  [asset library](docs/assets.md). This is how real episodes get written
  today, ahead of the Studio existing -- see
  [docs/script-format.md](docs/script-format.md).
- **Render worker** (`worker/`): runs on Stuart's PC or a GPU host later.
  - Node.js (`worker/src/`) is a **thin orchestrator only**: a CLI (parse /
    lint / voices / render / watch), an Express server, and the script parser above.
    It does **no** image or video processing itself.
  - Python (`worker/python/`) does all the actual image and video work,
    using `opencv-python` + `numpy` for compositing and `FFmpeg` (via
    subprocess) for encoding. There is intentionally no native Node OpenCV
    binding (`opencv4nodejs`) anywhere in this repo.
- **Shared contract**: `timeline.json`, validated against
  `schema/timeline.schema.json` before every render (and after every parse).

## Repo layout

```
engine/
├── schema/
│   └── timeline.schema.json     # JSON Schema (draft-07) for timeline.json
├── docs/
│   ├── timeline-schema.md       # Field-by-field schema reference, with examples
│   ├── script-format.md         # script.txt tag reference, with a full example
│   ├── assets.md                # Shared asset library layout, staging, overrides
│   └── voices.md                # ElevenLabs voices command (never called by watch)
├── worker/                      # The render worker
│   ├── package.json
│   ├── test/                    # node:test unit + end-to-end tests
│   ├── src/                     # Node orchestrator (thin)
│   │   ├── cli.js               # `node src/cli.js parse|lint|voices|render|watch <projectDir> ...`
│   │   ├── server.js            # Express server: POST /render
│   │   ├── render.js            # Spawns the Python compositor
│   │   ├── watcher.js           # chokidar: re-parse (if --from-script) + re-render; never ElevenLabs
│   │   ├── pythonRuntime.js     # Picks the right python (prefers worker/python/venv)
│   │   ├── voices/              # ElevenLabs TTS + credit-guard sidecars + Rhubarb
│   │   └── parser/              # script.txt -> timeline.json
│   │       ├── tokenizer.js     # lexes script.txt into kind-tagged lines
│   │       ├── actionTag.js     # parses [Action: ...] key=value + Cast/Pause bodies
│   │       ├── assetLibrary.js  # resolves characters/slots/drawings/staging, with overrides
│   │       ├── scriptParser.js  # the stateful walk: timing, marks, layers, slots
│   │       ├── ffprobeDuration.js
│   │       ├── validateTimelineFile.js  # spawns the Python validator
│   │       └── index.js         # parseProject / parseProjectToFiles
│   └── python/                  # The actual compositor
│       ├── requirements.txt
│       ├── pytest.ini
│       ├── compositor/
│       │   ├── __main__.py      # `python -m compositor <projectDir>`
│       │   ├── validate_cli.py  # `python -m compositor.validate_cli <timeline.json>`
│       │   ├── timeline_loader.py
│       │   ├── schema_validate.py
│       │   ├── asset_cache.py   # load-once, cache scaled/flipped variants
│       │   ├── transform.py     # anchor/placement/clipping math (pure)
│       │   ├── blend.py         # vectorised alpha compositing
│       │   ├── background.py    # fit background to canvas (cover/contain)
│       │   ├── camera.py        # pan/zoom/shake post-process
│       │   ├── slots.py         # drawing-swap slots (mouths, blinks, hand poses, dialogue-driven mouths)
│       │   ├── lipsync.py       # Rhubarb integration + cue-to-shape mapping
│       │   ├── media_probe.py   # ffprobe wrapper (audio duration)
│       │   ├── ffmpeg_writer.py # streams frames into an ffmpeg subprocess
│       │   └── compositor.py    # the main per-frame render loop
│       ├── scripts/
│       │   ├── generate_global_assets.py  # builds projects/_global_assets
│       │   └── generate_sample_audio.py   # placeholder tone WAVs + cues for projects/sample
│       └── tests/               # pytest
├── projects/
│   ├── _global_assets/          # shared character/background library (see docs/assets.md)
│   │   ├── staging_defaults.json
│   │   ├── backgrounds/<location>/{bg.png, staging.json}
│   │   └── characters/<id>/{character.json, body.png, parts/, <slot>/...}
│   └── sample/                  # A script-driven end-to-end sample project
│       ├── script.txt           # the authored source
│       ├── timeline.json        # generated: `node src/cli.js parse`
│       ├── lines.json           # generated alongside it
│       └── audio/<scene_id>/<nnn>_<character>.wav(.rhubarb.json)
├── studio/                      # Placeholder for the future Next.js app
├── .env.example
└── .gitignore
```

## The `timeline.json` contract

Full reference: **[docs/timeline-schema.md](docs/timeline-schema.md)**.
Machine-readable schema: **[schema/timeline.schema.json](schema/timeline.schema.json)**.
Working example: **[projects/sample/timeline.json](projects/sample/timeline.json)**
(generated by the [script parser](docs/script-format.md) from
[`projects/sample/script.txt`](projects/sample/script.txt)).

Highlights:

- A fixed output **canvas** (default 1920x1080) declared in the file. Layer
  positions are in canvas space, independent of any background's native
  resolution -- the background is fitted (scaled) to the canvas.
- Each **layer** has an id/character_id, an asset path, an explicit `z`
  (draw order), a `transform` (x, y, scale, anchor, flip_x, rotation,
  opacity), and optional start/end timing.
- **Multi-line dialogue per character**: a layer carries a *list* of
  dialogue clips (`dialogue: [{ audio, start_frame, text }, ...]`), each
  with its own audio and its own lip-sync cues -- not just one `audio`
  field. A `mouth` slot with `lipsync.source: "dialogue"` shows each
  clip's cues within that clip's window and the idle shape between lines.
- **Silent previews for missing dialogue audio**: a line with no WAV yet
  still renders at the estimated length already stored on the clip (or in
  `lines.json`). Those clips are marked `estimated` in `timeline.json`,
  the mouth stays on the rest shape (`X`), and the mix is silence for
  that line. Every render always has one audio stream covering the full
  scene length (generated silence if needed) so drafts and finished cuts
  line up the same way in DaVinci Resolve. The compositor prints
  `N of M lines are estimated/silent` at render time.
- **Scene duration can be derived from audio** -- a single file
  (`from_audio`), or the sum/sequence of every layer's dialogue clips
  (`from_dialogue`, what the script parser emits) -- instead of only a
  hand-typed frame count, which is still fully supported.
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
| `total_frames` hand-typed only | Scene/layer duration can be derived from an audio file's duration, or from a whole scene's dialogue clips |

An early script parser draft had its own, separate known bugs this one
specifically fixes: schema-mismatched field names, an `ffprobe` typo that
made every line come out 1 second, a duplicate layer per dialogue line,
ignored `[Action: ...]` tags, frame-number-based (rather than line-order)
audio filenames, and hard-coded stage positions. See
[docs/script-format.md](docs/script-format.md) for how this parser avoids
each of those.

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
3. If it's not installed, a render or parse that needs it (because a line's
   `cues` file doesn't exist yet) still completes: the worker prints a
   warning and that line's mouth falls back to its idle shape.

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
`ELEVENLABS_API_KEY` / `ELEVENLABS_MODEL_ID` are only used by
`node src/cli.js voices` -- see [docs/voices.md](docs/voices.md).

```bash
cp .env.example .env
```

## Running the sample render

The sample project (`projects/sample/script.txt`) is a real, if short,
script: two characters (Hicks, Dana) across two scenes in two different
locations (a small bedroom, then a big corridor), back-and-forth dialogue
(3+ lines each in the first scene), `[Action: ...]` tags changing stage
marks and eye/hand drawings, and a `[Pause: ...]`. `timeline.json` and
`lines.json` are *generated* from it, and are already committed along with
placeholder tone-WAV audio + cues for every line, so the steps below (other
than the first two, which only matter if you're regenerating the library
from scratch) aren't required just to render it.

```bash
# Only needed if you want to regenerate the asset library / sample audio from
# scratch -- the generated output is already committed.
worker/python/venv/bin/python worker/python/scripts/generate_global_assets.py
worker/python/venv/bin/python worker/python/scripts/generate_sample_audio.py

# Parse script.txt -> timeline.json + lines.json (also validates the result):
cd worker
node src/cli.js parse ../projects/sample

# Render it:
node src/cli.js render ../projects/sample --codec h264 --output ../projects/sample/renders/output.mp4

# ...or parse-then-render in one step:
node src/cli.js render ../projects/sample --from-script --codec h264 --output ../projects/sample/renders/output.mp4
```

For a DaVinci Resolve-friendly master instead:

```bash
node src/cli.js render ../projects/sample --codec prores4444 --output ../projects/sample/renders/output.mov
```

Check a script for errors without rendering (every error cites its
script.txt line number):

```bash
node src/cli.js lint ../projects/sample
```

Record (or dry-run) ElevenLabs dialogue -- see [docs/voices.md](docs/voices.md).
`watch` never does this:

```bash
node src/cli.js voices ../projects/sample --dry-run
```

To re-parse and re-render automatically whenever `script.txt` changes:

```bash
node src/cli.js watch ../projects/sample --from-script
```

Verify the output has both a video and an audio stream:

```bash
ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 ../projects/sample/renders/output.mp4
```

## Running the tests

```bash
# Python (compositor): off-screen clipping, z-order, anchor/flip math,
# cue-to-mouth frame mapping, multi-line dialogue, audio-derived duration,
# silent/estimated missing-audio previews, the Rhubarb missing-binary
# fallback, frame_step, rig nesting, and two full end-to-end renders of
# the sample project verified via ffprobe.
cd worker/python
source venv/bin/activate   # Windows: venv\Scripts\activate
pytest -q

# Node (script parser + voices): tag parsing, one-layer-per-character, sequential
# timing (real + estimated durations), mark resolution order, slot keyframes
# from Action tags, line-numbered errors, the lines.json manifest, schema
# validity of parser output, an end-to-end parse+render+ffprobe check,
# WAV header / credit-guard skip logic, and voices --dry-run (mocked fetch).
cd ../../worker
npm test
```

## Running the worker's HTTP server

For when the future Studio wants to trigger a render remotely instead of via
the CLI:

```bash
cd worker
npm start
# POST http://localhost:4100/render  { "projectDir": "../projects/sample" }
```
