# Sunny Banks: what we know about the show

Collected 2026-10-20 from three places: the series bible (`.docx`), the
episode plan log (`.md`) the user uploaded, and the live deck app
(`deck.aiglitch.app`, code in `comfybear71/deck`). Where they disagree, that
is written down under "Conflicts". Nothing here has been checked against the
user's PC folders, which a cloud agent cannot see.

## What an agent can pull from the deck app (Confirmed, read-only)

| Thing | Can we get it? | How |
| --- | --- | --- |
| The 9 locked location pictures | Yes | Files in the deck repo: `public/skidmarks/sunnybanks/*.jpg` (1600x900). Copies, shrunk, in `images/sunnybanks/loc-*.jpg`. |
| The 6 main cast pictures (Shazza, Dazza, Nuggets, Nan, Ranger Bazza, Unit 4s) | Yes | Public blob links, `referenceUrl` in the session data (see below). Copies in `images/sunnybanks/cast-*.jpg`. |
| 15 training pictures per character | Yes | `trainingImageUrls` in the same data. Not copied (large). |
| Other cast cards (Hans, Elbow, Bloom, Stuie) | Yes | `rosterExtras["sunny-banks"]` in the session data. |
| EP05 act scripts (God Script text) | Yes | `state.sunnyBanks.live.actScripts` in the session data. Only EP05 is stored there now. |
| Look locks, style lock, voice names and the rules for prompts | Yes | `lib/sunnyBanks.ts`, `lib/sunnyBanksVoices.ts`, `lib/sunnyBanksLocations.ts` in the deck repo. |
| EP06 script or EP01 to EP04 scripts | Not found | The live data holds one workspace (EP05). Older ones may be in the user's local folders or in `lib/sunnyBanksDropBears.fixture.json` (EP02 only). |
| Finished clips and renders | Not checked | Clip routes exist (`clip-renders`, `clip-proxy`, `clips-zip`) but they need clip ids. Not tried. |
| Files on the user's PC (`C:\Users\Stuie\...`) | No | A cloud agent cannot see the PC. Needs an upload or a self-hosted worker (see [pc-control-options.md](pc-control-options.md)). |

How the data was read: `GET https://deck.aiglitch.app/api/skidmarks/session`
returned about 630 KB of JSON with no login. The same app also answers
`/api/skidmarks/archive` (songs) and `/api/skidmarks/playlists`. That means
the app's state is public to anyone with the address. Worth the user knowing
(see the note at the end).

## The show (from the bible, v1.0 draft, 3 Oct 2026)

- Adult animated sitcom, outback caravan park. 5 to 10 minute episodes. 16:9.
- Look in the bible: flat 2D cel, thick black outlines, flat colour,
  sun-bleached ochre and faded teal. The deck's own style lock says the same:
  "rubbery adult cartoon, thick black outlines, flat cel colour, big heads,
  noodly arms ... Not photographic, not soft Pixar, not photorealistic".
- Pipeline today: God Script text, ElevenLabs voices (locked), Grok Imagine
  puts characters into the locked location pictures, LTX 2.3 (Comfy Cloud)
  makes the speaking shots, Grok or MiniMax make silent holds.

### Cast (pictures: [cast-sheet.jpg](images/sunnybanks/cast-sheet.jpg))

| Character | Look lock (short) |
| --- | --- |
| Shazza | Big curly blonde hair, gold hoops, leopard-print singlet, frayed denim shorts. |
| Dazza | Skinny, wild spiky blonde hair, bulging eyes, gap-toothed grin, tattooed forearm, faded-blue singlet, torn brown shorts, barefoot. |
| Nuggets | Skinny adult man, bald, freckles, blue-and-yellow polo, blue shorts, white socks, brown boots. |
| The Unit 4s | Two skinny purple aliens, antennae, teal bucket hats, bare feet. One shared voice ("yup yup... naaah"). |
| Ranger Bazza | Portly, short brown hair, sunglasses, bushy moustache, khaki ranger uniform. |
| Nan | Tiny elderly woman, grey bun, round glasses, purple floral housecoat, pink bunny slippers. |
| Hans | One-episode guest. |

Trevor is a freshwater croc in the billabong.

### The nine locked locations ([locations-sheet.jpg](images/sunnybanks/locations-sheet.jpg))

Main Entrance Sign, Office Storefront, Site Office Booth, Site Laundry
Machines, Tin Shed & Mower, Fibro Caravan Interior, Park Site 4 (the Unit 4s'
rusty caravan and a pink flamingo), Water Tank Dam, Rock Art Outcrop.
Other named places with no locked picture yet: Unit 9, BBQ shelter, amenities
block, Nan's site, ranger's office.

### Season order in the plan log

EP01 The First Fleet, EP02 Drop Bears Dilemma, EP03 Nan's OnlyFans, EP04 The
Golden Nugget, EP05 The Influencer Influx, EP06 The Great Outback Bake-Off,
EP07 The Big Wet, EP08 The Yowie Hunter, EP09 The Gray Nomad Gran Prix, EP10
Close Encounters of the Bogan Kind.

EP06 summary there: the annual baking competition. Nan enters hard-tack
scones. Dazza sneaks an alien ingredient into the batter and the judges get
temporary anti-gravity. (Good fit for depth, floating and several characters.)

## Settled by the user (2026-10-21)

- **Hans was a special guest** in EP01 only. Everyone listed above him in the
  EP01 cast list (Shazza, Dazza, Nuggets, the Unit 4s, Ranger, Nan) is regular
  cast.
- **Nuggets** is a teenager in the story, but the image tools will not draw
  children, so he is drawn as a small, bald, freckled figure. In our own work
  he stays an adult in appearance, as the bible locks him (see the note
  under "Model sheets" below). The script lines that say "14" are the only
  place his age is stated.

## Model sheets the user supplied (2026-10-21)

Six Grok character sheets, each with front, three-quarter, side and back views
plus face expressions. These are the right starting point for building Blender
models (they are what a modeller works from). Copies:

| Character | Sheet | Props drawn into the sheet |
| --- | --- | --- |
| Shazza | [sheet-shazza.jpg](images/sunnybanks/sheet-shazza.jpg) | Cigarette, brown boots |
| Ranger Bazza | [sheet-ranger-bazza.jpg](images/sunnybanks/sheet-ranger-bazza.jpg) | Whistle on a lanyard. No back-of-head problems. Two faces only. |
| The Unit 4s | [sheet-unit-4.jpg](images/sunnybanks/sheet-unit-4.jpg) | One front view only (no side or back yet). Holds teal flip-flops. |
| Nan | [sheet-nan.jpg](images/sunnybanks/sheet-nan.jpg) | Cricket bat on shoulder, teacup |
| Nuggets | [sheet-nuggets.jpg](images/sunnybanks/sheet-nuggets.jpg) | Holds a meat pie |
| Dazza | [sheet-dazza.jpg](images/sunnybanks/sheet-dazza.jpg) | Rocket launcher |

Things to know before using them for 3D:

- The sheets have **held props baked in** (pie, rocket launcher, bat). The
  deck's own notes say this caused a bad render before (Dazza with a rocket
  launcher in a silent hold, Nuggets with a pie). For models the props should
  be separate objects, so we need clean no-prop versions, or we model the
  prop apart and delete it from the figure.
- Dazza's and Nuggets's sheets have no shadow and a different background than
  the others; Shazza's has a title and a Grok mark. Easy to tidy.
- The Unit 4s have no side or back view. A 3D model needs them, so that sheet
  must be redone.
- **Nuggets note.** The sheet shows a very young-looking figure. The bible
  says "skinny adult man in his late twenties". For an adult-rated show we
  keep him an adult in every picture and model we make, and we do not try to
  get round the image tools. Suggested script fix: drop the "14" and write him
  as Shazza and Dazza's grown son who never left home. Needs the user's okay,
  because it changes what the character is.

## Scripts we have (3 different formats)

| Episode | Where | Format |
| --- | --- | --- |
| EP01 The First Fleet | User message 2026-10-21 | Screenplay: 5 acts, scene headings, dialogue with brackets. Not shot by shot. |
| EP02 Drop Bear Dilemma | User message 2026-10-21 | Shot list: 40 shots (no shot 39), each with Title, Place, Cast, Camera, Plate, Name and a line of dialogue or sound. |
| EP05 The Influencer Influx | Deck app | "God Script": `[Location: ...]`, `[Character X: ...]`, `[Action: ...]` tags in 5 acts. This is what the deck pipeline reads. |

EP01 would need converting to the God Script or shot format before the deck
can render it. EP02's shot list is close to what the deck needs, but its
"Place" names ("Unit 4 Porch Steps", "Scrub Line Edge", "Main Deck") are not
the nine locked locations. Several need new location plates.

### New characters and places in EP01 and EP02

- **Bubbles**: a purple cosmic sludge creature, Unit 4s' pet. Glows, mimics
  shapes, eats cables.
- **Gazza**: appears in EP02 shots 16, 18, 29, 35 (and "Foam Monster" with
  Shazza). Not in the bible. Possibly a typo for Shazza or Dazza, or a new
  character. Ask.
- Bush turkeys, caravan park residents (unnamed), the foam monster costume.
- Places not yet locked: Main Deck, Unit 4 Porch Steps, Scrub Line Edge, Bush
  Line (night), Inside Unit 4 caravan, Park garbage bins, Dan's golf cart,
  office entrance sign board.

## Season outline (10 episodes, from the user)

1. The First Fleet: tourist bus breaks down; Shazza sells a "premium" toilet
   experience; Nuggets trades the luggage to the Unit 4s for a glowing cube.
2. Drop Bear Dilemma: Ranger invents a "Mega-Drop Bear"; Dazza traps the Unit
   4s' pet sludge creature (Bubbles) and everyone thinks it is real.
3. Nan's OnlyFans: Nan's plumbing rant goes viral; Unit 4s hijack the signal.
4. The Golden Nugget: "gold" turns out to be a fuel cell from the Unit 4s' ship.
5. The Influencer Influx: influencer made to do manual labour; Ranger stuck in
   every photo.
6. The Great Outback Bake-Off: Nan's hard-tack scones; alien ingredient gives
   the judges anti-gravity.
7. The Big Wet: flood isolates the park; can-raft rescue mission to the pub.
8. The Yowie Hunter: TV crew; Ranger in a fur suit meets the Unit 4s in the dark.
9. The Gray Nomad Gran Prix: retirees' convoy; mobility scooter race.
10. Close Encounters of the Bogan Kind: Unit 4s prefer cold beer to going
    home; hide the ship in a water tank.

## Why "several characters talking in one shot" is hard today

From the deck code comments (they cite the old Skidmarks repo's research):

- The proven set of about 100 speaking shots had zero with two or more named
  people talking. Every multi-person shot was a silent hold.
- A "multi-cast" shot was built on 2026-10-03 (up to four characters on one
  start picture, one speaker, the others "listen silently, mouth closed").
  It was untested against a paid render when written.
- Normal pattern: a scene with two people is a silent hold plus separate
  speaking shots cut back and forth.

So the user's wish ("multiple characters interacting") has a known cheap
route (cut between single speakers, with a wide silent shot) and a real
research route (Blender depth with several characters in one frame, then
drive the mouths one at a time). Which one to pursue is the user's call.

## Conflicts still open

1. **Ranger name.** The user's EP01, EP02 and outline scripts say **Ranger
   Dan**. The bible, the deck and the new model sheet say **Ranger Bazza**.
   Needs one answer; the scripts and the sheet cannot both be right.
2. **EP06 name.** Plan log and the user's outline: "The Great Outback
   Bake-Off". Bible roadmap: "The Inspection". The user's outline is the
   newest, so Bake-Off is the working choice.
3. **Look.** Bible and style lock: flat 2D cel, thick outlines. The user wants
   "more of a realistic cartoon". Still open, and it decides the Blender
   work.
4. **Unit 4s colour.** EP01 script says "green, multi-eyed, small". The bible,
   deck and new sheet show purple, two eyes, tall and thin. (Art wins.)
5. **Dazza's clothes.** EP01 script: flannelette shirt, stubbies. Bible and
   sheet: faded-blue singlet, torn brown shorts. (Art wins.)
6. **Nuggets.** See "Settled by the user" and the Nuggets note above.
7. **Gazza** in EP02: who is he?

Settled: Hans is a one-episode guest.

## Note for the user

`/api/skidmarks/session` returns the whole app state to anyone, without
login. That includes scripts and picture links. If that is not intended, it
is worth asking whoever maintains the deck app to put a login on it. (Not
changed by us; we only read it.)
