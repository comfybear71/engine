# Grok restyle test (test 3)

Question: can Grok image edit take one of our Blender room renders and make it
look painted, while keeping the layout (lamps, windows, sofa, cushions) in the
same places? Record the answer in `docs/reference/lessons-learned.md`.

Run from the repo folder on the PC that has the engine `.env` with `XAI_API_KEY`
(the script reads that file, the same way the worker does).

1. Free check of the key (generates nothing, costs nothing):

```
node tools\grok\restyle_room.js --check
```

It prints the key name, the last four characters, and whether the key or its team
is blocked. Team blocked `true` means out of credits or over the spending limit.
The key itself is never printed.

2. Make the room picture if you do not have one:

```
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P tools\blender\glow_room.py -- --out renders\glow --mood evening
```

3. One restyle, about $0.07 (it refuses to send if the check shows a blocked key):

```
node tools\grok\restyle_room.js renders\glow\glow_evening.png
node tools\grok\restyle_room.js renders\glow\glow_day.png --day
```

Results go to `renders\restyle\<name>_grok.png`. Options: `--out <file>`,
`--prompt "<your own text>"`. Do not commit renders.

What to look at: same object positions, no new objects invented, window and
lamp glow kept, painted detail added, nothing odd on the sofa or wall.
