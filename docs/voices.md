# ElevenLabs `voices` command

Record dialogue WAVs with ElevenLabs and (when installed) generate Rhubarb
lip-sync cues. This is a **manual CLI step** -- `watch` / `render` / `parse`
never call ElevenLabs.

```bash
cd worker
node src/cli.js voices ../projects/sample --dry-run
node src/cli.js voices ../projects/sample
node src/cli.js voices ../projects/sample --force
```

Requires `ELEVENLABS_API_KEY` and (optionally) `ELEVENLABS_MODEL_ID` in the
repo-root `.env` -- see `.env.example`. The default model is
`eleven_multilingual_v2`. Set `ELEVENLABS_OUTPUT_FORMAT` to a `pcm_<rate>`
value (default `pcm_24000`; `pcm_44100` needs ElevenLabs Pro). The key is
sent only as the `xi-api-key` header; it is never printed, logged, or
placed in a shell command.

## Which lines are recorded

The command **re-parses** `script.txt` so every dialogue line is considered,
not only `"status": "missing"` rows in an existing `lines.json`.

Voice ID comes from that character's `character.json` `voice_id`, resolved
through the shared asset library (project override first, then
`_global_assets`). `voice_id` is a public voice identifier, not a secret.

If a character has no `voice_id`, the command prints an error naming the
character and the `character.json` it read, skips that character's lines,
continues with the others, and exits non-zero at the end.

## Credit guard

Next to each WAV the command writes a sidecar
`audio/<scene_id>/<nnn>_<character>.wav.json` containing:

- `sha256` of `text + voice_id + model_id`
- those three fields
- a timestamp

A line is skipped only when the WAV already exists **and** the sidecar hash
still matches. Changed text, voice, or model re-records. `--force`
re-records everything (characters still need a `voice_id`).

## Request and WAV write

`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=…`
with JSON `{ text, model_id }`. The response is headerless 16-bit
little-endian mono PCM at the rate from `ELEVENLABS_OUTPUT_FORMAT`. A
44-byte RIFF/WAV header is prepended in pure JS and the `.wav` is written
atomically (temp file, then rename).

Lines are processed sequentially. HTTP 429 / 5xx are retried up to 3 times
with backoff. 401, 402, quota errors, or 403 `output_format_not_allowed`
stop the run immediately with a clear message (the key is still never printed).

## Rhubarb cues

After each **new** WAV, Rhubarb is run (`rhubarb` on `PATH`, or
`RHUBARB_PATH`) with JSON export (`-f json`) and the line text as a dialog
file (`-d`). Cues are written where the parser and compositor already look:

`audio/<scene_id>/<nnn>_<character>.wav.rhubarb.json`

(the `cues_path` already stored in `lines.json`). If Rhubarb is missing or
fails: a warning is printed, **no fake cues** are written, and recording
continues. The renderer already falls back to the idle mouth shape.

## `--dry-run`

No network calls. Prints each line that would be recorded (`scene`, `nnn`,
`character`, character count) and a summary: total characters of text and
an **estimated** credit count (~1 credit per character on standard models).
This is an estimate, not a price.

## After recording

`parse` is re-run so `timeline.json` timings come from the real WAVs via
`ffprobe`. The command prints `Recorded` / `Skipped` / `Failed` counts.

See [docs/script-format.md](script-format.md) for the script format and
`lines.json` shape, and [docs/assets.md](assets.md) for `character.json`.

## Related: `import-audio`

For a **pre-recorded** mp3/wav (lip-sync + optional word timestamps) use
`node src/cli.js import-audio` instead of `voices`. That command uses the
same `ELEVENLABS_API_KEY` for Speech-to-Text (`scribe_v1`) unless you pass
`--no-transcribe`. It is also never called by `watch`. See
[docs/script-format.md](script-format.md#audio-name-filelabel).
