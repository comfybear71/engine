# Two characters talking (Dazza, then Nan)

**Question:** can more than one character talk in the same shot?
**Short answer:** yes, in this first version they take turns (one speaks, the
other stands and breathes). Rendered on the user's PC (960x540, about 4 min
for 6.5 s); first test videos are in `pc-test/`.

## How it works

- Every speaker has their own picture with the mouth painted out, their own
  sheet of nine mouths and their own Rhubarb cues file.
- `tools/blender/dialogue_scene.py` reads a list of lines (who, audio, cues,
  optional start time), swaps each speaker's mouth on cue, pushes the camera in
  on whoever is talking, and mixes all the audio into one track with ffmpeg.
- The default run uses two short test lines made with the user's own
  ElevenLabs voices (the locked "Dazza" and "Sunny Banks Nan" voices; the
  cloud assistant's ElevenLabs key can read the voice list and make speech):
  Dazza: "Gday Nan. Reckon I've finally fixed your tap." Nan: "You've fixed
  nothing, Dazza. There's water in me slippers." They are invented for the test,
  not from a script. Audio and text are in `tools/blender/assets/sunnybanks/`
  (`dazza_tap`, `nan_tap`), with Rhubarb cues made from the text.

## Nan's mouths

Dazza had a big grin to squash into other shapes. Nan has a thin, closed,
grumpy mouth, so her open mouths are drawn (`tools/blender/make_nan_mouths.py`):
a lens shape along her own mouth line (same tilt and frown), a thin lip
outline, pale lip band, dentures and tongue. X is her own mouth line cut out
of her picture, and A is the same line with lips pressed together.

![Nan's nine mouths](images/nan-mouth-set.jpg)

Hand-fixing works the same as for Dazza: edit a square in
`tools/blender/assets/sunnybanks/nan-mouths.png` and do not re-run the script.

## Run it (Windows)

```
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P tools\blender\dialogue_scene.py -- --out renders\dialogue --width 640 --height 360 --samples 8
```

Other lines: make a small lines file (see the top of `dialogue_scene.py`), run
Rhubarb on each wav with the line text as `--dialogFile`, and pass `--lines`.

## Known limits

- Turn-taking only. The listener does not react yet.
- Nan's drawn mouths are simpler than Dazza's (his are his own teeth). Her chin
  does not drop when she opens up.
- The old "one character per speaking shot" rule in the deck came from LTX
  limits (one person on screen, lip-sync swapping characters). The user has
  confirmed it does not apply here.
