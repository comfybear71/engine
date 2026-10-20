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

## Run on Windows

Open a terminal in the repo folder. Replace the Blender path with where you
unzipped it.

```
"C:\Blender\blender-5.2.2-windows-x64\blender.exe" -b -P tools\blender\smoke_room.py -- --out renders\smoke_room.png
"C:\Blender\blender-5.2.2-windows-x64\blender.exe" -b -P tools\blender\house_flythrough.py -- --out renders\house --frames 72
```

`-b` means no window. Everything after `--` goes to the script. The renders
folder is created by Blender if it is missing. Do not commit renders.

## Known limits

- Colours are flat and outlines are faint. This is a blockout, not a final
  look.
- The camera path is a fixed list in the script, not yet driven by the
  Engine.
