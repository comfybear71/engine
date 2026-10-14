# Action Shots: simple version (Stuart's design)

Branch `factory-v2`. Touch ONLY the Action Shots page, the shot maker and the library. Don't touch the timeline, the script or the renderer.
Stuart merges PRs himself. Never print `.env` keys. Never touch port 3000.

## The idea in one line
Make a clip with Grok inside the app (character image + a short prompt). The app saves every frame and keys out the background, and that becomes an Action Shot card. Hovering a card plays it; the card has a horizontal scroll of every frame.

The old system (rig Action Shots, separate eye/mouth/part drawings, the PR #60 Library tab, face extraction, head/body pairing) is **dropped**. Old files are **moved** to a backup folder, never deleted.

## 1. Make a shot (in the app)
"+ New shot" button at the top of the Action Shots page opens a small panel:
- **Reference image**: thumbnails of the character's images (`characters/<id>/_reference/*`, plus any previous shot frame). Click one. You can also drop in your own PNG/JPG.
- **Prompt**: one line, e.g. "walks to the left, side view".
- **Background**: Green / Black (default Green). The app adds to the prompt: `plain solid <green|black> background, character stays fully in frame, same character, no text`.
- **Length**: 6 s (options 4 / 6 / 8 / 10).
- **[Make it]** → the card appears straight away as "Making… 0:35" with a spinner, and fills in when done. Several can run at once.

xAI API (key = `XAI_API_KEY` from `.env`, already loaded by the worker):
```
POST https://api.x.ai/v1/videos/generations
Authorization: Bearer $XAI_API_KEY
{ "model": "grok-imagine-video-1.5", "prompt": "...", "image": { "url": "data:image/png;base64,..." },
  "duration": 6, "resolution": "720p" }
→ { "request_id": "..." }
GET https://api.x.ai/v1/videos/{request_id}  every 5 s → status "done" → video.url ; "failed" → show the error
```
Download the mp4 into the shot folder as `source.mp4`. Put the model name in `engine settings` so it can be changed. On any error (bad key, failed, timeout after 10 min), the card shows a red error line with the message and a Retry button.

**Import MP4** button next to it, for clips made on grok.com: same pipeline from step 2, and the card name = the original file name.

## 2. Capture every frame (Python: `worker/python/compositor/shot_capture.py`)
`python -m compositor.shot_capture --video source.mp4 --out-dir <shotDir>` → JSON on the last stdout line.
1. `ffmpeg -y -i source.mp4 -fps_mode passthrough raw/f_%04d.png`: every frame, nothing skipped.
2. Per frame (frame 1 included; the background can change between frames, e.g. the mic clip's frame 1 is black and the rest are green), detect the background from the median of a 12 px border ring: green or black.
   - Green: HSV key + despill (g = min(g, max(r,b)) on the edges).
   - Black: flood-fill from the border through dark pixels (V < 28) only, so dark hair and beard inside the outline stay. Keep the big blobs, fill holes inside the outline, keep large dark gaps (between the legs), feather 1.5 px.
   - Remove the Grok logo: any blob lying fully inside the bottom-right 110x50 px box.
3. Write `cut/f_0001.png` (RGBA), `thumb/f_0001.jpg` (on black, 160 px tall), `preview.mp4` (on black, 360 px tall, H.264, faststart, no audio), `poster.jpg` (frame 1).
4. Write `shot.json`: `{ id, name, filename, prompt, refImage, background, fps, frameCount, in: 1, out: N, category, createdAt, status }`.

Folder: `projects/<project>/characters/<id>/shots/<shotId>/`. shotId = the slugged name (file name or prompt), with `_2` added on a clash.

## 3. The page (`studio/components/ActionShotsPage.tsx`, replacing ActionShotsSection; remove the character "Library" tab)
Dark, simple, DaVinci-like: bg `#111`, cards `#1a1a1a`, text `#ddd`, accent `#e0a040`.
- Top bar: `[+ New shot] [Import MP4]`, and a character picker on the left if there's more than one character.
- Thin category headers: Expressions, Mouth/Tongue, Walks, Turns, Head moves, Mic, Arms/Gestures, Idle/Stand, Inserts, Other (empty ones hidden). Each card is set from the prompt words; change it in the detail view.
- **Card** (about 240x300): the poster on black; **mouse over = play `preview.mp4` muted, looping, between in and out**; name; badge "N frames". Along the bottom, a **horizontal scroll strip of every frame** (`thumb/` jpgs, lazy-loaded). Clicking a frame shows it big in the card.
- **Click a card → detail**: a big player with a scrub bar and the frame number; **In / Out** handles to trim off the bad end frames (Grok changes the face near the end); rename; category chips; per frame: Delete (moves the file to `_deleted/`) and Save to slot (as a draft); **[Use as Action Shot]** writes `characters/<id>/actions/<shotId>.json` with the in→out cut frames as the drawings (same shape as `tickLibraryClip` in factoryLibrary.js writes today, `hide_children: true`, so only one head shows).
- Fast: the list endpoint reads only the shot.json files; images are cached jpgs; videos use `preload="none"`. Show the poster at once, never "No frames".
- Errors are always shown on screen.

## 4. Worker routes (`worker/src/shots.js` + server.js), under `/api/projects/:name/characters/:characterId/shots`
| GET `/` | list the shots |
| POST `/make` `{refRel or refBase64, prompt, background, duration}` | start a Grok job → `{shotId, status: "making"}` |
| POST `/import` multipart mp4 | import + capture |
| GET `/:shotId` | shot.json + the frame list |
| PATCH `/:shotId` `{name, category, in, out}` | edit |
| DELETE `/:shotId/frames/:n` | move to `_deleted/` |
| POST `/:shotId/frames/:n/save-slot` `{slot, view}` | draft drawing |
| POST `/:shotId/use` | write the action json |
| POST `/:shotId/retry` | retry a failed make |
| GET `/media?rel=` | stream mp4/jpg/png with Range support (`res.sendFile`) and caching |

## 5. Clean-up (once, after a backup)
- Back up `projects\rodney_test` and `projects\_global_assets\characters\rodney` to `C:\Users\Stuie\engine_backup_factoryv2_<stamp>`.
- Move the old rig `actions/*.json`, the `_factory/` jobs, `library/` (PR #60) and the eye/mouth/part drawing folders into `characters/rodney/_old_<stamp>/` with a `MOVED.txt`. Move, never delete.
- Delete `projects\pr60_sandbox`.

## 6. Test
- Cloud: run shot_capture on the 5 Desktop clips (staged with the device tools). Check contact sheets: frame 1 of the mic clip keyed, beard kept, logo gone. Python unit tests on synthetic frames. Studio `npx tsc --noEmit` and tests.
- PC: Stuart pulls, restarts (stop 3001 and 4100, `start-studio.bat`, wait 45 s), makes one shot with "+ New shot" and imports the 5 clips into rodney_test. Screenshot the page and a card's frame strip for Stuart. Open a PR.

## Checklist
- [ ] + New shot makes a Grok clip in-app from the character image + prompt
- [ ] Import MP4 works and keeps the file name
- [ ] Every frame captured, frame 1 keyed, beard kept, logo gone
- [ ] Card: hover plays, horizontal scroll of every frame, N frames badge
- [ ] Detail: scrub, In/Out trim, rename, category, delete/save frame, Use as Action Shot
- [ ] Errors on screen; fast loading
- [ ] Old stuff moved to backup, not deleted
