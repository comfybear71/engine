# Dazza talks (step 2)

Question: can one character talk inside the Blender cut-out scene, with the
mouth following the audio? Yes, in a first rough version.

Video: [dazza-talks.mp4](video/dazza-talks.mp4) (2.6 seconds, with sound).
Dazza says his EP01 line "These are pants, Shaz. They cover the essentials."
The audio is from the deck's own render of that line (Act I, beat 19).

![Four frames](images/dazza-talks-sheet.jpg)

## How it works (Confirmed, we ran it)

1. **Audio to mouth shapes.** Rhubarb Lip Sync (v1.14.0, free) listened to the
   audio and gave a list of mouth shapes with times (A to H, and X for rest).
   The line used 7 of the 9 shapes. The list is `dazza_pants_cues.json`.
2. **Dazza without his grin.** His approved picture has a big open grin, so
   `tools/blender/make_dazza_mouths.py` paints it out (`dazza-nomouth.png`).
3. **Nine drawn mouths.** The same script draws one mouth per Rhubarb shape
   with gap teeth, a tongue and a dark inside, in a 3x3 sheet
   (`dazza-mouths.png`, shown below).
4. **Swap on cue.** `tools/blender/talk_scene.py` puts the mouth sheet on a
   small card just in front of his face and, at each cue time, moves it to the
   right square. Nan and Shazza stand and breathe as before.
5. **Sound.** ffmpeg joins the audio to the frames.

![The nine mouths](images/dazza-mouth-set.jpg)

Order: A B C, D E F, G H X.

Run (needs the audio and cues, both in `tools/blender/assets/sunnybanks/`):
`blender -b -P tools/blender/talk_scene.py -- --out renders/talk`
About 2.5 minutes on four cores. To use another line, get its cues with
Rhubarb (`rhubarb -f json -o cues.json --dialogFile line.txt line.wav`) and
pass `--audio` and `--cues`.

## What is wrong or unproven

- The drawn mouths are plain shapes made with code, not art by a person. They
  look flatter and cleaner than his shaded face. A real set (drawn or made with
  Grok image edit from his picture) would look better.
- His head does not move, tilt or nod while talking, and his eyes do not blink.
  Talking looks stiff.
- Only one angle: the mouths fit his face as drawn (slightly turned). A big
  camera turn would show the trick.
- The patch where his grin was painted out is a little blurry up close.
- Only Dazza has a mouth set. Each new character needs their own.
- Rhubarb mouth timing is rough. Check it by eye and fix cue times by hand.
- Several characters talking at once is possible (each has their own card and
  their own cues) but not tested.
- Rhubarb is not part of the repo; the Engine runs it if installed (see
  `worker/python/compositor/lipsync.py`).
