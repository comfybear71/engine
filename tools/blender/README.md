# Blender scripts

Small scripts that build simple 3D scenes and render them. They run Blender
with no window, so they can be repeated and kept in git.

Tested with **Blender 5.2.2 LTS**. Other versions may break (Blender's
scripting interface changes between versions). Record the version used in
`docs/reference/lessons-learned.md` if you try another.

## Scripts

| Script | What it does |
|---|---|
| `smoke_room.py` | Box room, bed, table, one camera. Renders one still. Use it to check the install works. |
| `house_flythrough.py` | Bedroom, hall and living room blockout. A camera flies through both doorways. Renders a PNG sequence with flat colours and thin outlines. |
| `style_lab.py` | Renders the same house at three camera positions in four looks (flat, ink, shaded, toon) and tiles them into `style_sheet.png`. One row per style, columns are bedroom, hall, living room. |
| `cartoon_house.py` | A more cartoon house: bold flat colours, painted floor planks and wallpaper stripes, rug rings, trim, rounded furniture, curtains, pictures, thick ink outlines. Renders two palettes (`bold`, `wood`) at three camera positions into `cartoon_sheet.png`. |
| `cutaway_house.py` | Two-storey cutaway dolls house (six rooms, stairs, roof) seen straight on, as one picture for use as an Engine background. Options: `--palette bold|wood`, `--width 3840 --height 2160`. |

## Use the cutaway as an Engine background

1. Render it at 3840x2160 (good up to about 3x camera zoom):
   `... -P tools\blender\cutaway_house.py -- --out renders\cutaway --palette wood --width 3840 --height 2160`
2. In a test project, put the picture at `backgrounds/cutaway/bg.png` and a
   `backgrounds/cutaway/staging.json` with one mark, for example
   `{"marks":{"centre":{"x":960,"y":1080,"scale":1.0}},"auto_order":["centre"]}`.
3. Script (no characters needed). Camera targets are canvas coordinates:

```
[Scene: House Tour]
[Location: cutaway]
[Camera: to=556,752 zoom=2.8 over=2s ease=inout]
[Pause: 1s]
[Camera: pan=1011,752 over=1.5s ease=inout]
[Camera: pan=1415,752 over=1.5s ease=inout]
[Pause: 1s]
[Camera: pan=1415,434 over=1.5s ease=inout]
[Camera: pan=1011,434 over=1.5s ease=inout]
[Camera: pan=556,434 over=1.5s ease=inout]
[Camera: reset over=2s ease=inout]
```

Room centres on a 1920x1080 canvas: living room 556,752; hall (downstairs)
1011,752; kitchen 1415,752; bedroom 556,434; landing 1011,434; bathroom
1415,434. Big sources make rendering slower.

## Run on Windows

Open a terminal in the repo folder. Replace the Blender path with where you
unzipped it.

```
"C:\Blender\blender-5.2.2-windows-x64\blender.exe" -b -P tools\blender\smoke_room.py -- --out renders\smoke_room.png
"C:\Blender\blender-5.2.2-windows-x64\blender.exe" -b -P tools\blender\house_flythrough.py -- --out renders\house --frames 72
```

```
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P tools\blender\style_lab.py -- --out renders\style_lab
```

(In PowerShell start each command with `&`. In Command Prompt leave it off.)

The style lab takes about a minute on a 4-core machine because of the toon row. Use `--styles flat,ink` to render only some looks.

```
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P tools\blender\cartoon_house.py -- --out renders\cartoon
```

The cartoon house takes a few seconds. Open `renders\cartoon\cartoon_sheet.png`: top row is the `bold` palette, bottom row is `wood`. Options: `--palettes bold`, `--thickness 3.5` (outline setting; the drawn width grows with the square of it), `--width 1280 --height 720`.

`-b` means no window. Everything after `--` goes to the script. The renders
folder is created by Blender if it is missing. Do not commit renders.

## Known limits

- Colours are flat and outlines are faint. This is a blockout, not a final
  look.
- The camera path is a fixed list in the script, not yet driven by the
  Engine.
