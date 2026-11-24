# Starter outfits

A built-in set of 60 to 80 general outfits, so a new user's Wears picker isn't empty before they have saved any of their own. Same legend as `refactor-pass/TRACKER.md`: `[ ]` open, `[x]` done (commit hash), `[-]` dropped (reason). Update the line in the same commit as the work.

## Why our own

Checked 2026-11-24 against ComfyUI Anima-Tools (`nregret/Comfyui-Anima-Tools`): its 430 clothing outfits and their preview images come from repos with no license (`1nten/Dressing-doll`, `hayde0096/Kisegaeningyou`), its Qianteng wardrobe was permitted for that extension only, and its per-character tags were scraped from animadex.net. Reduced to attire tags, only 168 of the 430 are general level. So the outfits are written here, and the covers are generated here and ship under the project's license.

## Shape

- `src/moire/data/starter_outfits.json`: per outfit `id` (kebab-case, stable), `name`, `category`, `tags` (attire only, canonical), `wearer` (the cover model: `1girl` or `1boy` plus a few hair/eye tags picked to suit the outfit, varied so the picker isn't repetitive; never a named character) and `backdrop` (simple background plus a color).
- `src/moire/data/starter_outfits/<id>.webp`: the cover, 384 x 576 WebP, about 25 KB.
- Rules, enforced by `tests/test_starter_outfits.py`: tags are attire, every cover prompt is general level (the covers are made on a ComfyUI that may be public), one subject per wearer, no cover without an outfit. No adult tag names anywhere in the file.
- In the app: a read-only Starter section in the Wears picker. Adding one copies it into an ordinary saved outfit (for one character, or shared), so nothing floods the lists. A starter's cover is the shipped image until the library holds an image wearing it; then the best-scored such image takes over (`outfit_wear.wears_most`, the same pick as the Default outfit's cover).

## Covers

`packages/backend/scripts/starter_outfit_covers.py` makes them through a running Moiré's Generate (`check`, `queue`, `status`, `sheet`, `export`; usage in its docstring). The quality tags, negative prompt, checkpoint and size are passed on the command line and never written to the repo. Every prompt is the caller's base, then wearer, outfit tags, `solo, full_body, standing, looking_at_viewer` and the backdrop, at a fixed seed per outfit.

## Tracker

### Data

- [x] **O1** Outfit list drafted and validated: attire-only tags, general level, varied wearers.
- [ ] **O2** Read through the list by hand: names, nothing near-duplicate, each outfit reads as itself.

### Covers

- [x] **O3** Cover script (`scripts/starter_outfit_covers.py`): validate, queue one batch per outfit, status, contact sheet to pick from, export to WebP.
- [ ] **O4** Run it once ComfyUI is reachable: `check`, then `queue --dry-run` to see the prompts, then `queue` with the chosen base and negative.
- [ ] **O5** Review the candidates on the contact sheet. Every pick looked at for sensitivity before export, whatever the prompt said. Redo (`queue --redo id,...`) outfits whose tags didn't come through, and fix their tags in O2 if the model can't draw them.
- [ ] **O6** Export the picks and commit the covers once (git keeps every version, so don't churn them). Check the package size stays reasonable and the wheel carries the WebPs (`uv build`, list the wheel).

### App

- [ ] **O7** Backend: load the starter list (cached, like `tag_groups.json`), a route listing it with tag info, and a cover endpoint with a HEAD counterpart, served from the package data with a versioned `?v=` URL and `immutable` (CLAUDE.md media rules).
- [ ] **O8** Cover takeover: once an image in the library wears a starter outfit, list that image as its cover instead of the shipped one.
- [ ] **O9** Frontend: a Starter section in the Wears picker; adding one opens the save flow prefilled (name, tags, character or shared). Copy reviewed against the no-subtext and no-em-dash rules.
- [ ] **O10** E2E spec for adding a starter outfit, and `docs/dev/e2e-scenarios.md` updated. `CONTEXT.md`: add **Starter outfit** to the glossary.
