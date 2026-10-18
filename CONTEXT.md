# Moiré: Domain Context

Glossary of the core domain concepts and the modules that own them. Keep names
here in sync with the code; when a module is named after a concept, the concept
belongs in this file.

## Concepts

- **Library**: a root directory of images registered for indexing. Owns scan
  progress state. (`api/libraries.py`, `models/library.py`)
- **Image**: one indexed file. Id is `{library_id}:{path-relative-to-root}`.
- **Tag**: a label on an image. Three kinds share one `tags` array:
  - **AI tag**: produced by the tagger, stored unprefixed (`1girl`).
  - **Manual tag**: user-applied, stored with a `manual:` prefix.
  - **Prompt tag**: extracted from generation prompts by reprojection, stored
    with a `prompt:` prefix (`prompt:masterpiece`). Owned by reprojection, not the
    user; mirrors `gen.prompt_terms` (which stays the fast search field). AI and
    prompt tags may overlap (e.g. `1girl` and `prompt:1girl` coexist); they are
    distinct kinds and are never deduped against each other.
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
  entry counting distinct images) and the per-tag **mosaic samples** (a pinned
  `tag_meta` thumbnail first, then random fill). Both are memoized with a short
  TTL. **Invalidation belongs to the index, not its callers**
  (`services/tag_index.py`): tag writers dirty it once their transaction has
  committed, so a new writer cannot forget to. A cached entry is valid only
  within its TTL *and* its generation, which also means a read that started
  before a write cannot store its stale result afterwards. The mirror of the
  Tag-state single-owner rule, one level up.
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
- **Scan**: discovering a library's files, indexing them, and **reconciling**
  away images that vanished from disk. (`services/scanner.py`;
  `reconcile_stale` is the pure deletion-decision step.) The scan's batched
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
- **Ruleset edit session**: the loaded-vs-edited state of one signature's
  extraction Ruleset: one definition of dirty, and the load/save/delete
  transitions that reset the baseline (`hooks/useRulesetSession.ts`). The exits
  a page can't intercept itself (tab close, in-app navigation) are guarded off
  the same flag by `hooks/useUnsavedChangesGuard.ts`.
- **Image feed**: the cursor-paged stream of Images matching an Image filter.
  One shared query (`hooks/useImageFeed.ts`, TanStack `useInfiniteQuery` keyed
  by the filter); the gallery (`AllImagesPage`) and `ImageView` read the same
  cache, so paging done in one is visible to the other.

## Persistence

- Embedded SQLite (via SQLAlchemy Core), one file, no external database server.
  The schema (tables + indexes) is defined once as a `MetaData` in
  `database/schema.py`; `database/db.py` owns the async (app) and sync (scanner)
  engines and creates the schema on startup. `tags` is an ordered JSON array on
  `images`; `image_tags` / `image_gen_terms` are derived join tables rebuilt
  transactionally to serve grouped/`$in`/`$all` queries.
