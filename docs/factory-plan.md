# Action Shots Factory: build plan

Branch: `factory-v2`. Scope: the Action Shots page, the factory and the library only. **Don't touch the timeline, the script or the renderer.**
Stuart merges PRs himself. Never print secrets from `.env`. Never touch port 3000.

## 0. What's already proven (keep it)

- **Face landmarks work without mediapipe.** `worker/python/compositor/face_landmarks.py` runs `worker/python/models/face_landmark.tflite` through `cv2.dnn.readNetFromTFLite` (OpenCV 4.10 is already pinned). It returns 468 MediaPipe Face Mesh points. It was tested on `perfect head.mp4` frame 60 (3/4 view, black background) and `mouth_move_3.mp4` frame 100 (green background), and the lips and eyes land exactly. No new pip deps are needed. Don't use the `mediapipe` pip package: v1.x has no `solutions` API, and its Tasks model download is blocked in the cloud.
- **Facts about the test clips** (all 24 fps):

| File | Size | Frames | Background | Contents |
|---|---|---|---|---|
| generated_video_silly_walk.mp4 | 784x1168 | 145 | black | headless body: stand/turn to ~f75, then side walk |
| generated_video_mic.mp4 | 720x1264 | 145 | **frame 0 is BLACK, the rest are GREEN** | headless body raising the mic |
| perfect head.mp4 | 928x976 | 361 | black | head: tongue, surprised, scream |
| tongue_good.mp4 | 928x976 | 361 | black | head |
| mouth_move_3.mp4 | 896x1008 | 361 | green | talking head; only frames 1–137 are good |

  → The background must be detected **per frame** (this is why frame 0 was never keyed). The Grok watermark is a small "Grok" logo in the bottom-right, about 60x30 px.
- Every clip's characters have dark hair, beard and hat on black. A plain luma key eats the beard, so use the flood-fill approach in §2.

## 1. Storage layout (per character, inside the project)

```
projects/rodney_test/characters/rodney/library/<clipId>/
  source.mp4             original upload (kept)
  raw/f_0001.png ...     every frame, untouched (ffmpeg passthrough), 1-based like ffmpeg
  cut/f_0001.png ...     RGBA cutout, same size as raw
  thumb/f_0001.jpg ...   cutout on black, 160 px tall, quality 80 (for strips/fast load)
  preview.mp4            cutout on black, H.264, 360 px tall, 24 fps, muted, faststart (tile hover)
  poster.jpg             middle frame of the clip on black, 360 px tall (tile cover)
  index.json             see below
characters/rodney/library/_face/<view>/mouth_<A..H|X>.png and eyes_<shape>.png (+ faces.json)
characters/rodney/library/_paired/<shotId>/f_0001.png ...  head-on-body composites
characters/rodney/library/categories.json
```

`clipId` = the original file name slugged (`perfect head.mp4` → `perfect_head`); add `_2` and so on only on a clash. Keep `filename` as the exact original name.

index.json:
```json
{ "id": "perfect_head", "filename": "perfect head.mp4", "fps": 24, "width": 928, "height": 976,
  "kind": "head", "background": "black", "trim": {"in": 1, "out": 361}, "frameCount": 361,
  "frames": [ {"n": 1, "bg": "black", "view": "front", "yaw": 0.02, "action": "tongue",
               "mouth": "X", "eyes": "open", "flags": [] } ],
  "shots": [ {"id": "perfect_head_01", "name": "perfect head 1", "in": 1, "out": 40, "view": "front",
              "action": "tongue", "category": "mouth_tongue", "ticked": false, "actionId": null,
              "cover": 20 } ],
  "warnings": [], "createdAt": "..." }
```
Only frames inside the trim are written. `n` keeps the original frame number, so frame numbers match the source.

## 2. Python: `worker/python/compositor/clip_factory.py` (new, CLI with JSON on the last stdout line, like the other factory modules)

Commands:

### `ingest --video X --out-dir D --in N --out M`
1. `ffmpeg -y -i X -fps_mode passthrough D/raw/f_%04d.png` (no `-vf fps`, no skipping). Delete files outside [in, out]. If ffmpeg is too old for `-fps_mode`, retry with `-vsync passthrough`.
2. For each frame: `detect_bg(img)` takes the median of a 12 px border ring. If it's green (H 35–85, S > 80, V > 60), it's `green`; if it's dark (V < 40), it's `black`; anything else is `other`, which falls back to black logic using the border colour.
3. **Green key:** dist = how far the pixel is from the key hue in HSV, plus a soft ramp → alpha. **Despill:** where g > max(r,b), set g = max(r,b) (on edge pixels with alpha < 255, and everywhere a little).
   **Black key (keeps dark hair/beard):** candidate background = V < 28 (tune 20–40). Flood-fill from all border pixels through candidate pixels only, so the background is the region *connected to the border*. Dark hair that touches the subject but sits inside the outline is kept. Then:
   - Morph-open the background mask by 2 px.
   - Alpha = NOT background. Keep only the largest connected component (plus any component > 2% of its area, for separated boots and hands).
   - **Fill holes:** fill every hole inside the outline (`cv2.findContours` RETR_CCOMP → fill the inner contours), except holes > 3% of the subject that are clearly background (mean V < 15 and touching nothing but black). This keeps the gap between the legs open.
   - Feather the edge: Gaussian blur 1.5 px on alpha, then clamp.
4. **Watermark:** zero the alpha in the bottom-right box (x > W-110, y > H-50) for any connected alpha component that lies fully inside that box. Never cut the subject.
5. Write cut/ and thumb/, then `preview.mp4` via ffmpeg from the thumbs (`-c:v libx264 -pix_fmt yuv420p -movflags +faststart -an`) and poster.jpg.
6. **Classify the clip:**
   - head = a face is found by `FaceLandmarker` (score > 0) on ≥ 60% of 8 sampled frames **and** the subject's bounding-box height < 1.6 × its width.
   - body = everything else. Headless bodies never get a face.
   Don't produce "has a head", "upside down" or similar warnings on a heuristic guess. Warn only on hard failures (no subject found, under 2 frames).
7. **Per-frame view:**
   - Head clips use landmarks: `yaw = (nose_tip.x - mid(face edges 234/454).x) / face_width`, plus visibility asymmetry (`|234-1|` vs `|454-1|` distances). front if |yaw| < 0.08, 3/4 if < 0.25, side if more (left/right by sign: subject turning to *their* left = image right → `left_*`; check the sign against perfect head f60, which is a 3/4 turn towards image-left). Frames with no face: back if the hat is visible and there are no skin pixels, else carry the last view forward.
   - Body clips use silhouette: width/height ratio and left-right mass asymmetry of the torso band (rows 15–45% of height), compared with the first frames. `front` when symmetric and wide, `side_left/right` when narrow (< 0.55 × the max width seen in the clip), 3/4 in between. Direction comes from the boot toes (mass of the bottom 8% rows shifted from centre).
   - Smooth views with a 5-frame majority filter.
8. **Actions:**
   - Head clips: per frame `mouth_open = (14-13 dist)/(61-291 dist)`. Tongue = red/pink pixels (H < 10 or > 170, S > 90) inside the inner-lip polygon below lip 14 and > 15% of the mouth box. Scream = open > 0.55. Surprised = open in 0.25–0.55 and the eyes wide (EAR > 1.25 × the clip median). Talk = mouth varying (std over 6 frames > 0.04). Otherwise `neutral`.
   - Body clips: `walk` when the bottom-10% mass centre oscillates (≥ 2 peaks); `turn` when the view changes; `mic` when the filename has "mic"; otherwise `stand`.
9. **Split into shots:** start a new shot when the view or action changes and the new value holds ≥ 8 frames. Merge runs < 8 frames into the neighbour. Each shot gets its name from the file (`perfect head 1`, `perfect head 2` ...), a category from the action (tongue/scream/surprised → `expressions` or `mouth_tongue`; walk → `walks`; turn → `turns`; mic → `mic`; head talk → `head_moves`; stand → `idle_stand`), and a cover = the middle frame of the shot.
10. Print `{"ok":true, ...index}`.

### `faces --library-dir L --out-dir L/_face`
For every head clip and every frame:
- Landmarks → view (as above).
- **Mouth crop:** bounding box of `LIPS_OUTER`, expanded by 35% horizontally and 60% vertically (so the tongue and teeth fit). Alpha mask = the outer-lip polygon dilated by 0.25 × the mouth width, feathered by 4 px. For a tongue, extend the mask down to cover the red tongue blob. Output an RGBA PNG of just the mouth: **never the lower face, never the hat brim.**
- **Classify mouth shape** (Rhubarb/Preston Blair set), using open = inner gap / width and width = mouth width / face width:
  - X rest: open < 0.04, width normal
  - A (M/B/P): closed, lips pressed (open < 0.03, width < clip median)
  - B (K/S/T, teeth): slightly open 0.04–0.15, teeth visible (bright pixels in the inner polygon)
  - C (E): open 0.15–0.3, wide
  - D (A/I): open > 0.3
  - E (O): open 0.15–0.35, narrow (width < 0.85 × median)
  - F (U/W): open < 0.15, narrow (< 0.8 × median), pucker
  - G (F/V): teeth on the lower lip: small open, bright pixels just above lip 14
  - H (L): open 0.15–0.3 with a tongue blob near the top teeth
- **Eyes crop:** a box around both eyes + brows (`LEFT_EYE`, `RIGHT_EYE`, brows), expanded by 25%, with a feathered mask from the eye+brow hull dilated by 0.15 × the eye distance. Eye shapes:
  - EAR per eye = top-bottom / corner-corner, compared with the clip median: open (0.8–1.2), half (0.45–0.8), closed (< 0.45), wide (> 1.25), squint (0.45–0.8 with the brows lowered), wink (one < 0.45 and the other > 0.8)
  - Look left/right/up/down: the darkest-pixel centroid (the pupil) inside the eye polygon, relative to the eye centre, beyond ±18% of the eye width/height
- Score every candidate on sharpness (Laplacian variance), the landmark score and how central it is in its class range. Keep the **best frame per (view, shape)**. Write `_face/<view>/mouth_A.png` etc. and `faces.json` listing `{view, kind, shape, clipId, n, score, rel}`.
- mouth_move_3: honour the trim (only frames 1–137).

### `pair --body-dir L/<bodyClip> --head-dir L/<headClip> --shot <json> --out-dir ...`
For each body frame in the shot:
- Pick the head frame with the closest view/yaw (front for front, and so on; side bodies use side heads, falling back to 3/4).
- **Neck anchor on the body:** the top of the alpha mask, i.e. the collar opening. Take the centre of the topmost 6% rows of the subject; width = the collar width.
- **Head anchor:** the chin/neck bottom. On a head clip that's the lowest point of the alpha below the chin (landmark 152); scale so the head width = 0.62 × the shoulder width (measure the shoulder width at 10% below the collar on the body), or a scale the user stores per character (`library/pair.json`).
- Composite order: body below the collar line → head (neck goes down into the collar) → **re-draw the body pixels above the neck that are in front**: the collar, the mic and the hand. Get these as body-alpha pixels that are within the head's region and above the collar line, plus any non-skin body pixels overlapping the head's lower 25% (mic/hand/collar), and paste them over the head. Only one head ever shows (body clips are headless).
- Write the composites. These become the Action Shot frames.

## 3. Worker (Node): `worker/src/clipFactory.js` (new) + routes in `server.js`

Run Python via `resolvePythonBin()` with cwd `PYTHON_DIR`, like `factoryLibrary.js` does. Endpoints (all under `/api/projects/:name/characters/:characterId/shots`):

| Method | Path | Does |
|---|---|---|
| GET | `/` | `{characters, categories, clips:[{id, filename, kind, frameCount, posterRel, previewRel, shots:[...] }]}`. Read only index.json files (fast) |
| POST | `/probe` (multipart mp4) | store in `library/_incoming/<tmp>.mp4`; ffprobe → `{tmpId, frames, fps, w, h, filmstrip:[rel of 24 jpgs]}` for the trim scrubber (jpgs via `ffmpeg -vf "select=not(mod(n\,K)),scale=-1:120" -fps_mode passthrough`) |
| GET | `/probe/:tmpId/frame/:n` | single raw frame jpg (`ffmpeg -vf "select=eq(n\,N-1)"`), used while scrubbing |
| POST | `/import` `{tmpId, filename, in, out}` | `clip_factory ingest` → index.json; then, if the clip is a head, `faces` for the whole library. Returns the clip. **Errors return `{error}` with a 4xx/5xx status, and the UI must show them.** |
| PATCH | `/:clipId/shots/:shotId` `{name?, category?}` | rename/re-categorise |
| POST | `/:clipId/shots/:shotId/split` `{at}` / `/merge` | optional, nice to have |
| POST | `/:clipId/frames/:n/flag` `{issue: "upside down"\|"wrong arm"\|"mirrored"}` | toggle a flag in index.json |
| DELETE | `/:clipId/frames/:n` | move the cut/raw/thumb files into `library/<clip>/_deleted/` (never hard-delete) and drop the frame from the frames/shots lists |
| POST | `/:clipId/frames/:n/save-slot` `{slot, view, name}` | copy the cutout into the slot dir as a **draft** (reuse `uniqueWriteTarget` + `setDrawingState(...,"draft")` from factoryLibrary.js) |
| POST | `/:clipId/shots/:shotId/tick` | body shot → `pair` with the best head clip (if any), then write the action json exactly like `tickLibraryClip` does today (slot_frames on body/torso, `hide_children: true`, so only one head shows). Head shot → slot `head_base_<view>` action. Sets `ticked/actionId` |
| GET | `/faces` | faces.json (mouths and eyes per view) |
| POST | `/migrate-old` | moves the old rig Action Shots + separate eye/mouth/part drawings into `characters/rodney/_old_rig_<stamp>/` (**move, never delete**). Run it once, after a backup |

Serve images via the existing `/api/projects/:name/asset?rel=...` (add `.mp4` to the allowed types with HTTP Range support, or add a `/media?rel=` route that streams with `res.sendFile`, which handles Range). Send `Cache-Control: max-age=3600` on thumbs so the strips load fast.

Remove from the UI (leave the old routes for now): Extract mouths/eyes buttons, the old Import MP4 in the Library tab, and the FactoryPanel "import mp4" path.

## 4. Studio UI: `studio/components/ActionShotsPage.tsx` (new). It replaces `ActionShotsSection` inside AssetsPanel's `section === "actions"`, and the character page's "Library" tab goes away (the page is the library)

Design: DaVinci Resolve-like. Background `#111`, panels `#1a1a1a`, text `#ddd`, muted `#888`, accent `#e0a040`, 1 px borders `#2a2a2a`, 11–12 px type. No dropdowns under tiles.

Layout:
```
┌───────────┬──────────────────────────────────────────────────────────┐
│ CHARACTERS│ [Import MP4]                       rodney · 14 shots       │
│ ▸ rodney  │ ── EXPRESSIONS ───────────────────────────────────────── │
│           │ [tile][tile][tile]                                        │
│ FACES     │ ── MOUTH/TONGUE ──────────────────────────────────────── │
│  Mouths   │ ...                                                       │
│  Eyes     │ ── WALKS ── TURNS ── HEAD MOVES ── MIC ── ARMS/GESTURES   │
│           │ ── IDLE/STAND ── INSERTS ── OTHER  (hide empty sections)  │
└───────────┴──────────────────────────────────────────────────────────┘
```
- Category header: thin uppercase 10 px, letter-spaced, with a hairline rule. Order: Expressions, Mouth/Tongue, Walks, Turns, Head moves, Mic, Arms/Gestures, Idle/Stand, Inserts, Other. Ids: `expressions, mouth_tongue, walks, turns, head_moves, mic, arms_gestures, idle_stand, inserts, other`. Map the old ids: `turns_looks` → `turns`.
- **Tile** (220x260): black bg; `<img poster>` that swaps to `<video src=preview.mp4 muted loop playsInline>` on hover (seek to the shot's in-frame/fps and loop in→out using `timeupdate`). Name bottom-left; badge top-right `N shots` for a clip, or `still` when 1 frame, plus a small tick ✓ if ticked. Along the bottom: a **horizontal scrolling strip** of 12 thumbs evenly spaced across the shot (`thumb/f_XXXX.jpg`, `loading="lazy"`). Clicking a thumb shows that frame large in the tile (until mouse-leave).
- **Detail view** (click a tile): a big player (canvas or img flipping through `thumb/` at 24 fps preloaded; full-res `cut/` when paused) with play/pause, a scrub bar and the frame number shown as the source frame `n`. Below it, a grid of **every frame numbered**, each with buttons: Save to slot (small popover: slot + view, default from the frame's view), Delete, Flag (upside down / wrong arm / mirrored, toggle chips). The header has the name (click to rename), a category picker (segmented chips, not a dropdown) and a **Tick as Action Shot** button.
  - Show the **first frame immediately** from the poster, and never show "No frames" while loading (use a skeleton). Fetch only that clip's index.
- **Import dialog**: file picker → upload to `/probe` → shows a filmstrip + a big preview + two handles (In/Out) on a scrub bar; dragging fetches `/probe/.../frame/n`. Shows `frames in..out of N`. [Import] → progress text → the new tiles appear. Errors show in a red bar on screen, with the server's message.
- **Faces panel** (left sidebar "Mouths" / "Eyes"): a grid per view (front, 3/4 L, 3/4 R, side L, side R, back) × shapes (A–H, X / open, half, closed, look L/R/U/D, wide, squint, wink). Each cell shows the best crop on a checkerboard; empty cells are dashed.

Keep the page fast: the list endpoint only reads JSON; the images are static jpgs with caching; videos are preload="none".

## 5. Migration (once, on Stuart's PC, after a backup)
1. Backup: copy `projects\rodney_test` and `projects\_global_assets\characters\rodney` to `C:\Users\Stuie\engine_backup_factoryv2_<stamp>`.
2. POST `/migrate-old` moves the old `actions/*.json` that have no `libraryClip`, and the eyes/mouth/part drawing folders that aren't referenced by the new shots, into `_old_rig_<stamp>/`. Write a `MOVED.txt` listing everything.
3. Delete `projects\pr60_sandbox` (throwaway; moving it to the trash is fine).

## 6. Testing

- Cloud: the five test videos can be staged from `C:\Users\Stuie\Desktop` with the device tools. Run `python -m compositor.clip_factory ingest ...` on each, and look at contact sheets of cut/ frames (incl. frame 1 of the mic clip, which is on black!) and at `_face/` crops. Unit tests go in `worker/python/tests/test_clip_factory.py` (synthetic green/black frames: frame 0 keyed, beard pixels kept, watermark removed, holes filled, the gap between the legs kept).
- Studio: `npm test` in studio (vitest) and `npx tsc --noEmit`. Playwright screenshot of the page on a local worker pointed at a copy of rodney_test.
- PC: after Stuart pulls the branch, restart (stop 3001 + 4100, run `start-studio.bat`, wait 45 s), import the five videos into rodney_test (mouth_move_3 with Out = 137), tick shots, and screenshot the page plus the Mouths/Eyes panels for Stuart.

## 7. Acceptance checklist
- [ ] One Action Shots page with the library + factory, no tabs, Import MP4 at the top
- [ ] Every frame saved, with no skipping; frame 1 keyed (mic clip!)
- [ ] Beard/hair kept on black, holes filled, gap between the legs open, watermark gone
- [ ] Original clip names kept
- [ ] In/Out trim with scrub preview
- [ ] Head vs body correct for all 5 clips; no false warnings
- [ ] Views per frame; clips split into shots on view/action changes
- [ ] Mouth crops = mouth only, A–H + X per view; eyes crops = eyes only, all shapes found where present
- [ ] Head paired onto body by angle, with collar/mic/hand over the neck, and only one head
- [ ] Save to slot = draft; Delete moves (never hard-deletes); Flag works
- [ ] Tiles: poster, hover-play, N shots/still badge, thumb strip; detail view with all frames numbered
- [ ] Errors shown on screen; first paint fast, no "No frames"
- [ ] Old rig shots/parts moved to a backup folder, not deleted
