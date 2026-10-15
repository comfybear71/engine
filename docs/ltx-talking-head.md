# LTX talking heads: what works and what does not

Verified on Comfy Cloud with `LTX_2.3_IA2V_Cloud.json` and a head-on-black start image of Rodney. Every row was measured on a real job, same image, audio and seeds unless noted. "Ratio" is mouth movement divided by cheek movement (about 1.0 to 2.3 when lips sync, 0.1 to 0.6 when they do not); "side brightness" is the average brightness of the left/right edge strips (about 0 when clean, about 19 when ghost faces appear).

## The recipe the engine sends (worker/src/talkingHead.js `buildLtxPrompt`, worker/src/comfyCloud.js)

- Start image: black-padded 1280x720 PNG (non-16:9 images are padded, never cropped).
- Audio: sent as **MP3** (192k), not WAV. The Sunnybanks and music-video flows send MP3.
- Prompt, one per clip; only the words in the quotes change between clips:

  `Use the provided start image as the first frame. <Name>, <short look> is prominent, mouth and head move naturally while speaking, subtle gesture. Props and background stay exactly as the start image, nothing new enters frame. <Name> says: "<words>". Only one person in the frame, plain black background. Static medium close-up shot. Fixed camera frame, zero camera movement. Same person and objects as the start image.`

- Workflow settings: refine strength 1, prompt enhance off, random seeds, duration = the clip's audio length.
- The "who is on screen" text (name, then a short look) is required in the dialog.

## What each change did

| Change | Result |
|---|---|
| Sending the audio as WAV instead of MP3, with a "head only, no neck, no zoom" prompt | No lip sync on seeds that lip-sync with MP3 and the Sunnybanks wording (ratio 0.60 vs 2.34) |
| Camera-lock sentence `Camera stays completely still ... no zoom, no movement.` | Ghost faces and no lip sync on the second audio (ratio 0.41, side 19.0) |
| `Static medium close-up shot ... stable background.` alone | Same failure (ratio 0.39, side 19.4) |
| Extra-faces **negative prompt** alone | No effect at all: output identical to the failing clip (0.41, 19.0). Do not rely on it |
| `Only one person in the frame, plain black background.` plus the static-shot sentences | Clean frame and lip sync (1.23, 0.0). **This sentence is what removes the ghost faces** |

Without it, LTX fills the empty black left and right of a head-only 1280x704 frame with blurry copies of the subject.

## Things to remember

- Results vary with the seed. The same settings can lip-sync on one seed and not on another. Same seeds give the same clip.
- Press **Redo** on a bad clip (new seed) instead of regenerating the whole talking head. **Undo** brings the previous version back.
- Prompt enhance on, or a refine strength below 1, also gave worse clips earlier.
- The head size is held per talking head: clip 1 sets `headSizeTarget`, later clips and their start frames are rescaled to it (`worker/python/compositor/head_size.py`).
- The head keyer (`key_head_on_black`) opens the backdrop; it must not use a convex hull (leaves black polygon corners) or a large close (leaves a black stem under the chin).
- Before changing the prompt, test one change at a time on the same seeds and measure it. Several earlier conclusions here were wrong because two things changed at once.
