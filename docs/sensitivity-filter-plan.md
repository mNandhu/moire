# Global Sensitivity Filter: plan

Status: done 2026-11-08 (backend, UI, e2e). Per-tag decisions and the build tooling are kept out of the repository
(local tooling); the shipped list is hashed.

## Goal

One app-wide switch, "show up to level X" (General / Sensitive / Questionable /
All), enforced by the server. Images above the level disappear everywhere, and
so do tag names above it (tag lists, autocomplete, Tags page).

## Decisions (user, 2026-11-08)

1. Tags do both: raise an image's level, and are hidden themselves.
2. Images with no level are hidden while the filter is on. AI tagging is the
   way to reveal them: the UI warns and offers to queue them.
3. Server-side, one setting in `app_settings`, quick toggle in the top nav.
   Every device and remote access gets it.
4. A rating set by hand wins over everything else; AI rating and tags can only
   raise the level.
5. Prompt words can raise a level but can't vouch for an image: a prompt-only
   image whose words name nothing listed is unknown until AI-tagged.
6. Levels follow Danbooru's rating scale, the one the WD tagger's rating uses,
   so a tag level and an AI rating mean the same thing.
7. No tag names of the higher levels in the repository: the shipped list is
   keyed by hash, the build tooling and hand decisions stay local.

## Design

### Tag levels

- `data/tag_sensitivity.json`: `hash_tag(name) -> 1|2|3` (sensitive,
  questionable, explicit), non-general tags only; unlisted is general.
  `hash_tag` is the first 16 hex characters of the lower-case name's SHA-256.
  Built offline by local tooling: an LLM's level per tag (descriptions and
  Danbooru tag groups as context, two runs plus a tie-break, the unstable ones
  decided by hand), hand fixes on top, Danbooru aliases listed with their tag.
- This library's own levels live in `tag_levels` (tag, level, source user |
  suggested), over the shipped ones. Editing one recomputes only the images
  carrying that tag.

### Image level

- `images.tag_level` (0 general .. 3 explicit, NULL = no tags): the highest
  level among the tags, by base name, case ignored. Derived with the flags
  (`TAG_STATE_COLUMNS` in `services/tags/image_tags.py`), so every tag writer sets
  it; levels from `services/tags/tag_sensitivity.py`.
- `images.rating_manual`: the rating was picked by hand. AI tagging, clearing
  AI tags and clear-all leave such a rating alone; picking Unrated clears the
  flag and restores the AI tagger's pick (`image_tags.ai_rating_label`).
- The image's level is an SQL expression (`image_visibility.image_level`): the
  manual rating when set, else the higher of the AI rating and `tag_level`,
  where a `tag_level` of 0 counts only with AI or manual tags; NULL (unknown)
  otherwise.
- New columns reach older databases through `ensure_schema` (any column
  declared in `schema.py` that a table lacks is added). The `rating_manual`
  migration marks a stored rating manual when it isn't the AI's pick.
- At startup this library's levels load before anything writes tags; a
  fingerprint of shipped list + table decides whether every image's
  `tag_level` is recomputed.

### Enforcement

- `services/tags/sensitivity_filter.py`: the maximum (or off), kept in memory,
  `GET/POST /api/v1/sensitivity` (with counts by level and unknown).
- `services/images/image_visibility.py`: `visible()` = not quarantined and within the
  filter; the feed, facets, Tags page, characters, recipes, covers and LoRA
  words read it. AI coverage keeps `not_quarantined()` alone, so the unknowns
  stay queued for tagging.
- By-id routes (image document, thumbnail, file, workflow) answer 404 for an
  image the filter hides; quarantine is no bar there.
- Generation outputs the filter hides are listed with `hidden` and no picture.
- Tag names above the maximum are left out of the tag lists, browse,
  descriptions, attire/facet/group maps, board offers, aliases and merge
  suggestions; a hidden tag's pages answer 404. Changing the setting
  invalidates the tag caches.

### UI

- A shield at the right end of every page header (`SensitivityControl`):
  dim while off, green while on; opens the level picker, each choice with
  how many images it hides. Kept out of the sidebar (too prominent there).
- Settings > Sensitivity: the level, images by level, the "hidden until
  AI-tagged" strip whose Tag them queues only the unknown images
  (`/ai/tag-untagged` with `unknown`), and this library's tag levels (add,
  change, remove, Keep a suggestion). While the filter is on, tags above it
  are only counted there.
- The gallery shows the same strip, dismissible for the session.
- A hidden image opened by link says so (the image route answers 403);
  hidden generation outputs show a Hidden tile and stay out of the viewer.

## Open

- A list of the library's tags with no level, to set levels from.
- Tag chips of a visible image are not filtered (only matters when a manual
  rating lowers an image below its tags).
- Violence and gore are out of scope; a separate filter would be new work.
