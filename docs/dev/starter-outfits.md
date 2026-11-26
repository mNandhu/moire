# Starter outfits

A built-in set of 60 to 80 general outfits, so a new user's Wears picker isn't empty before they have saved any of their own. Same legend as `refactor-pass/TRACKER.md`: `[ ]` open, `[x]` done (commit hash), `[-]` dropped (reason). Update the line in the same commit as the work.

## Why our own

Checked 2026-11-24 against ComfyUI Anima-Tools (`nregret/Comfyui-Anima-Tools`): its 430 clothing outfits and their preview images come from repos with no license (`1nten/Dressing-doll`, `hayde0096/Kisegaeningyou`), its Qianteng wardrobe was permitted for that extension only, and its per-character tags were scraped from animadex.net. Reduced to attire tags, only 168 of the 430 are general level. So the outfits are written here, and the covers are generated here and ship under the project's license.

## Shape

- `src/moire/data/starter_outfits.json`: per outfit `id` (kebab-case, stable), `name`, `category`, `tags` (attire only, canonical), `cover`: who the cover shows and how (`subject` `1girl` or `1boy`; `character`, the Danbooru tag of a known character who suits the outfit, ideally one whose own clothes are that outfit, plus their series when the tag doesn't name it; `moment`, scene, action and angle tags; `avoid`, the character's own signature clothes, sent as negatives so they don't replace the outfit).
- `src/moire/data/starter_outfits/<id>.webp`: the cover, 384 x 576 WebP, about 50 KB.
- Rules, enforced by `tests/test_starter_outfits.py`: tags are attire, every cover prompt is general level (the covers are made on a ComfyUI that may be public), one subject and a different character per cover, moment tags never attire, never a low angle on a skirt or dress, no cover without an outfit. No adult tag names anywhere in the file.
- In the app: a Starter group per category in Generate's Outfit picker and a Starter outfits section on the Outfits page. A starter is worn as it is, by its id `starter:<id>` (the gallery's outfit filter takes it too); "Save as my outfit" (or Save as outfit on the page) copies it into an ordinary saved outfit, for one character or shared, so nothing floods the lists. For a character, a starter's cover is their best image wearing it (`outfit_wear.wears_most`, the same pick as the Default outfit's cover, never a hidden image); elsewhere, and where they have none, the shipped one.

## Covers

`packages/backend/scripts/starter_outfit_covers.py` makes them through a running Moiré's Generate (`check`, `queue`, `status`, `sheet`, `export`; usage in its docstring). The quality and style tags, negative prompt, checkpoint and size are passed on the command line and never written to the repo. Every prompt is the caller's base, then subject, `solo`, character, outfit tags and moment, then the caller's style, written as prompt text (spaces, escaped brackets), at a fixed seed per outfit. A cover is a moment, not a catalogue shot: the first plain full-body pilots read as generic, and the outfit stays recognisable without forcing `full_body`.

## Tracker

### Data

- [x] **O1** Outfit list drafted and validated: attire-only tags, general level.
- [x] **O2** Read through the list by hand: names, nothing near-duplicate, each outfit reads as itself. Done 2026-11-26 against a page of each cover beside its outfit.

### Covers

- [x] **O3** Cover script (`scripts/starter_outfit_covers.py`): validate, queue one batch per outfit, status, contact sheet to pick from, export to WebP.
- [x] **O4** Run it once ComfyUI is reachable: `check`, then `queue --dry-run` to see the prompts, then `queue` with the chosen base, style and negative. Ran 2026-11-25, 4 candidates per outfit, `--per-request 4` (one ComfyUI job per outfit: the GPU time per image is flat, and each job costs Moiré about 10 s of overhead, so 4 per job took 8.4 s an image against about 17 s one at a time).
- [x] **O4a** Covers are moments with known characters (`cover` block), after three pilots: plain full-body shots on simple backdrops read as generic. Camera angles are spread across the set, `from_below` on six outfits at most: with half the moments low and a strong foreshortening style, most covers came out as the same shot, a shoe in the lens. Run with foreshortening and dynamic-angle style tags left out, and `from below, fisheye, foreshortening` in the negative.
- [x] **O5** Review the candidates on the contact sheet. Every pick looked at for sensitivity before export, whatever the prompt said. Redo (`queue --redo id,...`) outfits whose tags didn't come through, and fix their tags in O2 if the model can't draw them. Picked 2026-11-26 by Claude (the maintainer was away), every pick checked at full size: all general level, modest framings chosen for skirts and dresses.
- [x] **O5a** Follow-ups from that review, settled with the maintainer 2026-11-26:
  - Redone: `cheer-uniform` (the camera was too far out: now `cowboy_shot`, arms up, looking at the viewer), `ancient-greek-chiton` (Euryale's own chiton is very short: now Saori Kido with `long_dress`), `sukajan-streetwear` (Denji drew in a t-shirt: `open_jacket` added; the model still leans to a varsity jacket, the pick is the one with an embroidered patch).
  - Looked at and fine: `hooded-ranger`, `police-uniform`, `evening-gown`.
  - Second pass, redone: twelve covers whose backgrounds came out as abstract patterns (mandala, spiral, stained glass) now sit in concrete everyday places at eye level: `gakuran-school-uniform`, `aviator-jacket`, `three-piece-suit`, `techwear`, `biker-jacket`, `festival-happi`, `knight-armor`, `royal-prince`, `track-suit`, `china-dress`, `tangzhuang`, `arabian-outfit`. The pattern came from scenes that were mostly sky, glow or a low camera; the redo also put `abstract background, mandala, kaleidoscope, patterned background` in the run's negative. `sailor-school-uniform` read as a generic girl: now Akebi Komichi.
  - Dropped `halloween-costume`: the cover didn't look good.
- [x] **O6** Export the picks and commit the covers once (git keeps every version, so don't churn them). Check the package size stays reasonable and the wheel carries the WebPs (`uv build`, list the wheel). 78 covers, 3.5 MB (about 44 KB each, not the 25 KB guessed: busy scenes compress worse; quality 75 would save only 20%); the wheel carries them, 5.1 MB in all.

### App

- [x] **O7** Backend: load the starter list (cached, like `tag_groups.json`), a route listing it with tag info, and a cover endpoint with a HEAD counterpart, served from the package data with a versioned `?v=` URL and `immutable` (CLAUDE.md media rules). `services/characters/starters.py`, `GET /generate/outfits/starters`, `GET|HEAD /generate/outfits/starters/{id}/cover` (`?v=` a hash of the cover's bytes: a wheel install resets mtimes); `wear_rule` takes `starter:<id>`.
- [x] **O8** Cover takeover: per character (decided 2026-11-26: library-wide would put any image of a generic outfit on every list). `?character=` on the list gives each starter that character's best visible image wearing it; without it, the shipped covers.
- [x] **O9** Frontend: Starter groups in the Outfit picker, worn as it is (decided 2026-11-26, over opening the save dialog first); "Save as my outfit" in the unfolded character opens the save dialog seeded from the worn tags, then wears the saved copy. The Outfits page lists the starters by category below the saved ones (with All), searched with them; a card saves a copy, and with a character picked, wears it in Generate.
- [x] **O10** E2E spec for adding a starter outfit, and `docs/dev/e2e-scenarios.md` updated. `CONTEXT.md`: add **Starter outfit** to the glossary. `outfits.spec.ts`: wearing one in Generate then saving it, and saving one from the Outfits page.
