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

## Why "several characters talking in one shot" was hard (old LTX limit only)

**Settled by the user (2026-10-21):** the "one character per speaking shot"
rule was only a limit of the old LTX video route. LTX could handle one person
on screen at a time and its lip-sync would swap characters and get buggy. It
is not a rule of the show. With Blender cut-outs each character has their own
mouth sheet, so several people can be in one shot and any of them can talk.
Do not carry the old rule into new work.

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

## Conflicts to settle with the user

1. **EP06 name.** The plan log says "The Great Outback Bake-Off". The bible's
   suggested roadmap says "The Inspection".
2. **Look.** The bible and style lock say flat 2D cel with thick outlines.
   The user said they want "more of a realistic cartoon". These are
   different looks and change what we build in Blender.
3. **Ranger name.** Plan log says Ranger Dan, bible and deck say Bazza.
   (The bible wins.)
4. **Unit 4s colour.** Plan log says green, bible and the deck pictures are
   purple.
5. **Nuggets.** Plan log gives an age of 14, the bible and the picture show
   a grown adult.

## Note for the user

`/api/skidmarks/session` returns the whole app state to anyone, without
login. That includes scripts and picture links. If that is not intended, it
is worth asking whoever maintains the deck app to put a login on it. (Not
changed by us; we only read it.)
