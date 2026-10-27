# Moiré: Domain Context

Glossary of the core domain concepts and the modules that own them. Keep names
here in sync with the code; when a module is named after a concept, the concept
belongs in this file.

## Concepts

- **Library**: a root directory of images registered for indexing. Owns scan
  progress state. (`api/libraries.py`, lifecycle in `services/library_ops.py`,
  `models/library.py`)
- **Image**: one indexed file. Id is `{library_id}:{path-relative-to-root}`.
- **Tag**: a label on an image. Three kinds share one `tags` array:
  - **AI tag**: produced by the tagger, stored unprefixed (`1girl`).
  - **Manual tag**: user-applied, stored with a `manual:` prefix.
  - **Prompt tag**: extracted from generation prompts by reprojection, stored
    with a `prompt:` prefix (`prompt:masterpiece`). Owned by reprojection, not the
    user; mirrors `gen.prompt_terms` (which stays the fast search field). AI and
    prompt tags may overlap (e.g. `1girl` and `prompt:1girl` coexist); they are
    distinct kinds and are never deduped against each other.
  - **Tag name**: every kind is stored in one canonical spelling, words joined
    by underscores (`blue_eyes`, `hu_tao_(genshin_impact)`), the WD tagger's
    own vocabulary. `blue eyes` and `blue_eyes` are the same tag. Owned by
    `services/tag_names.py` (`canonical_name`); `image_tags.canonical_tag`
    applies it to a prefixed tag. The UI shows underscores as spaces
    (`lib/tags.ts` `formatTag`), and kaomoji (`^_^`) keep theirs.
- **Tag rename / merge**: renaming a tag onto a new name, or onto an existing
  one (a merge). The kind is kept. AI tags are never renamed (fixed,
  deterministic vocabulary). Manual tags are rewritten once
  (`image_tags.rename_manual`). Prompt tags are rebuilt by reprojection, so a
  merge is stored as a **Merge rule** (`tag_rules`, `from -> [to]`, kept one
  hop) that reprojection applies to the extracted terms. A **Split rule** is
  the same row with several targets (`long_white_hair` -> `long_hair`,
  `white_hair`). Owned by `services/tag_rename.py` (writes) and
  `services/tag_rules.py` (reads, `apply_rules`); `/tags/rules` in the API,
  `useTagRules` in the frontend. Code never calls these *aliases* (that word
  is a Danbooru alias or a character's bare name). Not to be confused with a
  **Ruleset**: what the Rules page (`/rules`, `gen_rulesets`) edits, one
  workflow signature's extraction rules saying where its prompt and fields
  are. Merge rules live on the Tags page.
- **Suggested merge**: a merge or split rule for a prompt tag that isn't a
  Danbooru tag, read from Danbooru's list: its alias, a respelling, colour
  plus thing as one tag, a split per describing word, or the colour dropped.
  Only suggested; the user accepts them on the Tags page.
  (`services/tag_canon.py`)
- **Tag-state**: the invariant binding `tags` to its summary flags:
  `has_tags` (any *curatable* tag, meaning a non-`prompt:` tag, so prompt-only images
  stay "Untagged"), `has_ai_tags` (any tag that is *neither* `manual:` nor
  `prompt:`), and `has_prompt_tags` (any `prompt:` tag), plus `rating`.
  Owned by `services/image_tags.py`, the single place that mutates tags and
  recomputes the flags, so they can never drift. Its two transaction owners also
  dirty the **Tag index**; the sync path (`replace_prompt_sync`) leaves that to the
  caller that owns the transaction, i.e. `reproject._flush_batch`, once per batch.
- **Tag index**: the aggregated views *derived* from Tag-state: the grouped tag
  counts (per stored tag, or collapsed across sources into one `any:<base>`
  entry counting distinct images), the per-tag **mosaic samples** (a pinned
  `tag_meta` thumbnail first, then a fixed per-tag shuffle), and the Tags
  page's own views: `browse` (one entry per tag name, sources merged,
  optionally one source) and a per-tag `detail` (counts by source, use over
  time, loras, workflows, related tags). Samples, `browse` and `detail` leave
  quarantined images out, like the feed (`image_tags.not_quarantined`), so a
  count matches its gallery link. A **pinned cover** belongs to the tag name,
  not to a source (`tag_index.pin_key`). All are memoized with a short TTL
  except `detail`. **Invalidation belongs to the index, not its callers**
  (`services/tag_index.py`): tag writers dirty it once their transaction has
  committed, so a new writer cannot forget to. A cached entry is valid only
  within its TTL *and* its generation, which also means a read that started
  before a write cannot store its stale result afterwards. The mirror of the
  Tag-state single-owner rule, one level up.
- **Tag category**: character or general, from the tagger's word list
  (`selected_tags.csv`, category 4 = character). A prompt tag spelled like a
  listed character counts as one too. A bare name without its series
  (`furina` for `furina_(genshin_impact)`) counts only when the library backs
  it: most of its visible images also carry the series tag or the full name,
  so ordinary words that happen to be characters (`sunny`, `white_rabbit`)
  don't. No downloaded model, no characters. The user's say on a character
  page (`characters.kind`) beats the list both ways. (`services/tag_categories.py`;
  the library check and the one "is a character" rule are
  `services/character_names.py`)
- **Character page**: one character at `/characters/:tag`, any of its names
  leading there. A bare name folds into its full name when both are in the
  library (an *alias*, counted as one). Its colour comes from hair and eye
  tags (solo images when there are enough), never pixels, unless the user
  picks one; its signature tags are the tagger's general tags common on its
  images and rare elsewhere, read from its solo images when there are
  enough of them, trusted only when the share holds up for that many images (so a
  one-off tag on a 3-image character is dropped), and keeping one hair and
  one eye colour (two with `multicolored_hair` / `heterochromia`). The page
  shows only the look and outfit ones (body, animal traits like `cat_girl`
  and `tail`, and what they wear): scene, framing, pose, expression
  (`@_@`, `closed_eyes`), props and tags the groups can't place, common to a
  few images of one set, aren't a look.
  Few images shows a "may be off" note. The avatar is the tag's cover pin; the
  `characters` table holds only overrides. (`services/characters.py`; the
  look statistics in `services/character_look.py`)
- **Face detection**: an optional anime face model (YOLOv8 nano, ONNX,
  downloaded from Settings > Characters) that finds the face in each
  character's avatar, in a background worker, kept in `image_faces`. Avatars
  crop to it; a centre the user sets wins. Several faces: the largest
  confident one, so a hand-set centre fixes shared images.
  (`services/face_detect.py`, `lib/character.ts` `avatarCrop`)
- **Rating**: one of `-`, `general`, `sensitive`, `questionable`, `explicit`.
  Normalized in one place (`image_tags.normalize_rating`) and written only
  through `image_tags.set_rating` (with `set_score` / `set_quarantine` for the
  other per-image scalars), so the single-owner rule holds; routers never
  assemble the UPDATE.
- **Generation metadata**: the AI-art data embedded in an image file by the
  tool that made it. `services/gen_metadata.py` owns both halves: `read_gen_raw`
  **captures** the raw doc from an open image (the only PIL-touching step; the
  scanner calls it at open time so the ordering can't be got wrong), and
  `extract` **derives** the structured `gen.*` fields from that stored raw, so
  reprojection never touches disk again. All format knowledge, ComfyUI's two
  PNG text chunks, A1111's `parameters` chunk, and A1111's EXIF `UserComment`
  with its charset prefixes, sits behind the pure `gen_raw_from_embedded`,
  which takes the embedded sources as plain values so every branch is reachable
  from a table test.
- **Runtime-built prompt**: a prompt assembled while the workflow runs (a
  captioner's output joined to fixed text), so the graph never holds it. The
  extractor walks upstream from the sampler (`comfy_text.resolve_text`):
  literal text, then the text computed from the graph's string nodes
  (`services/text_eval.py`: literals, find/replace, regex extraction, joins;
  exact or nothing), then text a display node (pysssss ShowText and kin)
  recorded for that node (`display_cache`, from the graph's `text_0` or the
  editor workflow's widget value), then links, SDXL `text_g`/`text_l`, string
  widgets, and concat nodes joining whatever parts resolve. A display node's
  record is written when the prompt is *queued*, so it holds the previous
  run's text; computed text beats it everywhere, pins on a display path
  included (`gen_metadata.pin_value`).
- **Guessed prompt**: a ComfyUI prompt or negative that neither the sampler
  walk nor the user's pins found (remote queues, custom-node pipelines), picked
  from the graph's texts by keyword match (`services/prompt_guess.py`). Each
  text is scored by the positive/negative keyword lists (Settings › Prompt
  Guessing, `app_settings` row "extraction"); a side needs more hits than the
  other, and shown text beats static widgets, then more hits, then longer.
  `gen.guessed` names the guessed fields; the UI labels them "Guessed". A
  guess only ever fills an empty field.
- **LoRA**: an add-on network an image was generated with, recorded as
  structured data (`gen.loras = [{name, strength}]`), never as a tag. From
  ComfyUI lora-loader nodes (LoraLoader, rgthree Power Lora Loader, stackers;
  zero-strength or switched-off entries skipped) and A1111 `<lora:name:w>`
  prompt tokens. `name` is the file name without folders or extension. The
  derived `image_loras` rows serve the LoRA feed filter and its counts.
  (`gen_metadata.comfy_loras` / `prompt_loras`)
- **Embedding**: a textual inversion a prompt names, ComfyUI's
  `embedding:name` (or `<embedding:name>`), recorded as structured data
  (`gen.embeddings = [{name, negative}]`, from both prompts), never as a tag.
  `name` drops folders and extension and keeps its case. The derived
  `image_embeddings` rows serve the embedding feed filter and its counts.
  Bare A1111 embedding names read as ordinary words.
  (`gen_metadata.prompt_embeddings`)
- **Prompt parsing**: turning prompt text into prompt tags, best effort. Prompts
  are hand-written and often malformed, so `services/prompt_parse.py` never
  rejects input: it reads emphasis groups the way ComfyUI does, cuts pieces at
  separators and group edges, and classifies each as **tag**, **prose** (a
  sentence fragment: stays in the prompt, never a tag) or **noise** (leaked
  settings, joiners, stray weights). The raw prompt is never changed, so a
  parser improvement reaches existing images by reprojection (a named
  `tag_migrations` step).
- **Prompt weight**: how strongly the prompt asked for a prompt tag, read from
  its emphasis by the rule of the tool that made the image (`gen.source`):
  ComfyUI weighs only a closed `(...)`, x1.1, and an explicit `(...:w)`
  replaces the weight around it; A1111 multiplies every `(` (x1.1 or its
  `:w`) and divides by 1.1 per `[`. `{...}` and a bare `smile:1.05` are text
  to both. Stored beside the tag, never in it: `gen.prompt_weights`
  (`{term: weight}`, positive prompt only, terms not at 1, through merge
  rules) and the `weight` column of `image_gen_terms`.
  (`prompt_parse.Piece.weight`, `gen_metadata.prompt_weights`; the frontend's
  `promptOutline` reads Generate's prompt with the ComfyUI rule.)
- **Scan**: discovering a library's files, indexing them, and **reconciling**
  away images that vanished from disk. (`services/scanner.py`, with
  `thumbnailer.py` and the watcher's `scan_incremental.py`;
  `scan_reconcile.reconcile_stale` is the pure deletion-decision step.) The scan's batched
  transactional writer is `services/scan_writer.py` (`ScanWriter`: accumulate,
  flush every N, flush the remainder); the bounded-concurrency worker loop is
  `services/batch_pool.py`.
- **Thumbnail**: a WebP render of an image stored on the local filesystem under
  `THUMB_ROOT`. (`services/storage_fs.py`)
- **AI Job**: a queued, cancellable batch tagging unit. (`services/ai_jobs.py`)
- **Tagger / Model**: the WD ONNX model. Load/idle-unload lifecycle and the pure
  inference step `select_tags` live in `services/ai_tagger.py`; model **download**
  (HuggingFace fetch, progress, cancel) is its own dependency-free module
  `services/ai_tagger_download.py` (also home to `model_target`, the one place the
  `(model_repo, cache_dir)` default is resolved). The API's combined model status
  is assembled once by `ai_tagger.model_status_view` so routes don't reach into
  the managers' internals.
- **AI Settings**: persisted tagger knobs; validation is pure
  (`ai_settings.clean_settings_patch`). (`services/ai_settings.py`)
- **Image feed (backend)**: how an Image filter becomes SQL. A `FeedFilter`
  validates its own inputs on construction (`FeedFilterError` → HTTP 422);
  `feed_where` builds the WHERE clause; `list_feed` / `list_groups` run the
  cursor-paged feed and the batch-collapsed grouped view. The feed and grouped
  view share one builder so they can never drift. (`services/image_feed.py`)
- **Attire tag**: a general tag naming something worn (`serafuku`,
  `thighhighs`), from a list built from Danbooru's attire tag groups and
  limited to the tagger's vocabulary. Each carries its group (headwear,
  legwear, ...). The list is a slice of the **tag-group list**
  (`data/tag_groups.json`, built from the whole `tag_groups` wiki hub by
  `scripts/build_tag_groups.py`): every tag keeps its category (body, sex,
  ...), its most specific group and its other places. Attire is a set of
  groups, not one category. (`services/attire.py`)
- **Prompt board**: Generate's Prompt read as a board under its text: each
  tag in the part of the scene it sets (subject, hair, eyes, expression, body,
  attire, pose, framing, background, lighting, style, other, quality), so a
  tag that pulls a picture the wrong way, or a part left unsaid, shows. Each
  box suggests and takes its own tags; the text stays the one source. A tag's
  section comes from the tag-group list (through the facets) and from
  **Danbooru's tag list**: every Danbooru tag with 20+ posts, its category,
  post count and aliases (`blowjob` is `fellatio`), downloaded on first use
  into the model cache and refreshed quarterly (`services/danbooru_tags.py`).
  A name in neither list is **unknown**. The aliases serve the board only:
  library tags never go through them. (`services/prompt_board.py`,
  `lib/promptOutline.ts`, `components/generate/PromptBoard.tsx`)
- **Outfit**: a named set of attire tags saved from an image (that image is
  its thumbnail), for the character it was saved under, or shared with all
  characters. User-made; suggested groupings come later.
- **Character recipe**: what picking a character puts in a prompt: the
  character tag (full name), its **identity tags** (signature tags that are
  body features, not attire, expressions or passing eye states), a default outfit (its attire signature tags, swappable
  for a saved Outfit), and a LoRA with strength (the one most used where the
  character was prompted *and* the tagger confirmed it, weighted by score).
  Computed from the library; the user's edits (drop a tag, force a LoRA) are
  stored on top and win. A recipe is **weak** when the tagger seldom confirms
  the character on images that prompted it; the rate is shown with and
  without the LoRA.
- **Prompt blocks**: how the composer holds a prompt: Base (the Generator's
  own text), Character (a recipe), Outfit, and Extra (free tags), joined in
  that order when queued. Swapping a character or outfit swaps only its block.
  The negative has Base and Extra. LoRAs sit beside the blocks, not in the
  text: the **character LoRA** belongs to the recipe and swaps with it;
  **style LoRAs** are picked by the user and stay when the character changes.
- **Generator**: what Moiré queues on ComfyUI: a ComfyUI graph plus slots
  (positive, negative, seed, LoRA insertion point, ...) naming where each
  value is written. Its default Base is the positive text of the image it was
  made from, minus character and outfit tags. Either
  the built-in one or made from a workflow family. A family-made Generator is a
  snapshot: it never follows newer images of the family on its own, only when
  the user updates it. A Generator is **ready** only after a test run whose
  image reached the library. The UI calls it a **workflow** (one that is set
  up to run in Generate): the same ComfyUI workflow the extraction rules and
  the gallery filter list, at a later stage. "Generator" stays the code and
  API name. In code, `workflow_family` / `lib/workflows.ts` are the families
  (editor graph ids); `lib/generatorRunBar.ts` is the Generators' run bar.
- **ComfyUI connection**: the one ComfyUI server Moiré queues on. Its
  installed LoRAs are matched to an image's LoRA names by file name, folders
  and extension ignored, so a recipe can say when a LoRA isn't installed.
  Assumed to run on the same machine: its output folder is a Library, so
  generated images arrive by the ordinary scan.
- **Generation batch**: one press of Queue: N jobs from one Generator with
  one set of slot values, plus the character, outfit and recipe picked.
  Kept permanently and re-queueable. Its images join the library like any
  other; reviewing them is keep (the default), reject (quarantine) or score.
  Records what was *asked*, which an image's own metadata can't (the picked
  character, outfit, recipe). Named "Character, Outfit" (or "Generator, first
  Extra tags" without a character) until the user names it.

## Frontend

- **Image filter**: the criteria selecting which Images the gallery shows:
  tags + match logic (`and`/`or`), library, and the `no_tags`/`no_ai_tags`
  toggles. Its URL round-trip is pure: `parseFilters` / `serializeFilters`
  (`lib/imageFilter.ts`) are the single source of truth, so the URL and the
  query never drift.
- **Tag kinds (frontend)**: the `manual:` / `prompt:` / `any:` prefixes and the
  predicates over them live once in `lib/tags.ts` (`isManual`, `isPrompt`,
  `isAiTag`, `partitionTags`, `formatTag`, `formatSearchTag`), mirroring the
  backend's `image_tags` helpers. They were hardcoded in five components.
- **Per-image mutations**: every write the UI can make to one Image (rating,
  score, quarantine, purge, apply/remove tags, tag thumbnail) goes through
  `lib/imageMutations.ts` over the shared `lib/api` client, the client-side
  mirror of `services/image_tags.py`. Their feed-cache consequences live in
  `lib/feedCache.ts`, which patches *every* cached feed rather than one exact
  key, since an Image can be cached under several filters.
- **Load slot**: a thumbnail's permission to fetch. `hooks/useImageLoadSlot.ts`
  owns the global concurrency limit and the per-tile lifecycle (enqueue-once,
  token-matched release, unmount/stale-src guards). Leaked slots silently stop
  every later thumbnail from loading, so the invariants are code, not comments.
- **Tags page**: one entry per tag name (sources merged; the Source filter
  narrows to one), characters in their own section, grid or list. Clicking a
  tag opens its panel (`components/TagPanel.tsx`): its images (each opens in
  the viewer over the page; a pin sets the cover), use over time, the loras
  and workflows it was made with, and related tags. Characters show as one
  picture, other tags as a 2x2 mosaic. The
  page's sorting, sectioning and gallery links are pure (`lib/tagBrowse.ts`).
- **Ruleset edit session**: the loaded-vs-edited state of one signature's
  extraction Ruleset: one definition of dirty, and the load/save/delete
  transitions that reset the baseline (`hooks/useRulesetSession.ts`). The exits
  a page can't intercept itself (tab close, in-app navigation) are guarded off
  the same flag by `hooks/useUnsavedChangesGuard.ts`.
- **Image feed**: the cursor-paged stream of Images matching an Image filter.
  One shared query (`hooks/useImageFeed.ts`, TanStack `useInfiniteQuery` keyed
  by the filter); the gallery (`AllImagesPage`) and `ImageView` read the same
  cache, so paging done in one is visible to the other. Ordered newest first
  by file mtime (the generation-time proxy; a copy or move can reset it), or
  oldest first / top rated by the filter's `sort`; `_id` breaks ties.

## Persistence

- Embedded SQLite (via SQLAlchemy Core), one file, no external database server.
  The schema (tables + indexes) is defined once as a `MetaData` in
  `database/schema.py`; `database/db.py` owns the async (app) and sync (scanner)
  engines and creates the schema on startup. `tags` is an ordered JSON array on
  `images`; `image_tags` / `image_gen_terms` are derived join tables rebuilt
  transactionally to serve grouped/`$in`/`$all` queries.
