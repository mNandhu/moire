# Plan: Moiré AI Art Enhancements (v2, post-grill)

Supersedes `plan-aiArtEnchancements.md`. This version reflects the current
codebase (not the state the original plan assumed) and the design decisions
resolved in the grilling session.

## What changed from the original plan

- **Step 5 (Thumbs-Only / local-mount) is already shipped.** `scanner._process_image`
  uploads only thumbnails to MinIO; originals are served from local disk via
  `GET /api/images/{id}/file` (`api/images.py`). The original TL;DR premise
  ("copying originals to MinIO doubles storage") is stale. **Dropped.**
- **Original "Further Consideration 2" (MinIO mirror vs local) is moot**.
  local-only already won.
- **Step 3's "rating" renamed to `score`.** A `rating` field already exists and
  means the booru **content-safety** axis (`-/general/sensitive/questionable/
  explicit`, written by the WD tagger; see `image_tags.RATINGS`). Quality triage
  gets a **separate `score: 0-5`** field. No collision.

## Domain additions (update CONTEXT.md alongside)

- **Generation metadata (`gen`)**: generation parameters extracted from an
  image's embedded data (A1111 param string, ComfyUI node graph). Lives as small
  structured fields on the `images` doc; the bulky source is stored separately.
- **Workflow signature (`workflow_sig`)**: a hash of the *kinds* of nodes in a
  ComfyUI graph, used to bind extraction rules to a workflow shape.
- **Extraction ruleset**: per-signature, ordered, user-overridable rules that map
  raw generation data to structured `gen.*` fields.
- **Reproject**: the pass that (re)computes structured `gen.*` from stored raw
  using current rulesets. Decoupled from disk scanning.
- **Score**: a 0-5 quality rating for triage. Distinct from `rating`.
- **Quarantine**: a DB-only flag hiding an image from the default feed. Never
  touches the file on disk.

---

## Architecture spine (everything hangs off this)

### Storage split

| Collection | Holds | Why |
|---|---|---|
| `images` (existing, hot) | small structured `gen.*`, `gen.workflow_sig`, `gen.group_id`, `gen.prompt_terms[]`, `score`, `quarantined` | projected into the feed, searched, indexed, must stay lean |
| `image_gen_raw` (new, cold) | `{_id: image_id, source, raw}`: A1111 param string OR both ComfyUI chunks (`workflow` + `prompt`) | 50-200KB/img; read only by reproject + copy-workflow. 200KB ≪ 16MB doc limit, so a sibling collection beats GridFS |

`gen.raw` is **always** stored at scan time and never discarded. Extraction
becomes re-runnable against stored raw with no disk rescan.

**Raw lifecycle (must be wired or raw docs orphan):**
- `reconcile_stale` currently deletes from `images` + MinIO thumbs only. Extend
  the scan-end cleanup to also `delete_many` the stale ids from `image_gen_raw`.
- Library delete (TODO: "delete removes thumbnails") must also drop that
  library's `image_gen_raw` docs.
- **Batch the raw writes.** The scanner bulk-writes `images` at `batch_size 200`;
  write `image_gen_raw` via the same batched `bulk_write`, not per-image (100k
  round trips otherwise).

### Two-pass pipeline

1. **Scan pass** (extend `scanner._process_image`):
   - Read embedded data from the **same image open** that produces the thumbnail.
     `_make_thumb_bytes` currently owns the only open and returns
     `(thumb, blurhash, w, h)`; **extend its return tuple** to also yield the raw
     metadata read from `img.info`; otherwise the file is opened twice.
     PNG text chunks via `img.info` (`parameters` for A1111; `workflow` + `prompt`
     for ComfyUI); EXIF `UserComment` via `img.getexif()` for JPEG/WebP A1111
     outputs. Read `img.info` **before** `img.thumbnail()` mutates the object
     (confirm chunks survive on a real ComfyUI file).
   - Write `{_id, source, raw}` to `image_gen_raw` (batched; see Raw lifecycle).
   - Compute `workflow_sig` (ComfyUI only) from the **`prompt` (API) JSON's
     `class_type` values**, not the `workflow`/UI JSON, and `$set` it on the
     `images` doc.
   - **No structured extraction here.** Scan stays raw-only.

2. **Reproject pass** (new `services/reproject_jobs.py`, modeled on
   `services/ai_jobs.py`):
   - Idempotent. Reads raw from `image_gen_raw`, applies the matching ruleset,
     writes structured `gen.*` + `gen.prompt_terms[]` + `gen.group_id` onto the
     `images` doc.
   - Cancellable async job queue with progress + `_in_flight` dedupe, same
     lifecycle/status vocabulary as `AIJob`
     (`queued|running|cancelling|cancelled|done|error`).

### Workflow signature

`workflow_sig = hash(sorted multiset of node class_types)`.
- Ignores node ids, widget values, and edges.
- Stable across id renumbering and value tweaks; changes only when node *kinds*
  are added/removed.
- Coarse by design: two genuinely different graphs with identical node kinds
  collide (rare; the structural fallback below still extracts correctly).

### Extraction rules

- All paths and the structural walk operate on the ComfyUI **`prompt` (API)
  JSON** (the same JSON the signature is hashed from). The `workflow`/UI JSON is
  reserved for canvas-paste in copy-workflow.
- A ruleset is **per `workflow_sig`**. Each target field
  (`positive`, `negative`, `seed`, `model`, `sampler`, `steps`, `cfg`) maps to an
  **ordered fallback chain; first non-null wins**:
  1. **Pinned path**: e.g. `prompt.32.inputs.text0` (fast, exact).
  2. **Structural**: from a sampler-like node, follow the `positive`/`negative`
     input edge back to its source text node. Survives id renumber (follows
     edges, not ids); disambiguates positive vs negative.
  3. **Class heuristic**: first/Nth `CLIPTextEncode.inputs.text`, etc.
- **Built-in parsers ship for A1111 + ComfyUI-default** so common cases need zero
  config. User rules only exist for custom workflows.
- Unknown signature → built-in best-effort runs + image flagged **"needs
  mapping"**. This flag is **derived, not stored**: an image needs mapping when
  `gen.workflow_sig != null` (ComfyUI) **and** reproject failed to extract a
  positive prompt (`gen.prompt == null`). It clears automatically the moment a
  later reproject extracts a prompt. No flag to reset.
- **Ruleset persistence (v2):** user rulesets live in a new `gen_rulesets`
  collection keyed by `workflow_sig` (one doc per signature). Named here so v1's
  signature work doesn't paint into a corner; no v1 reads/writes it.

### Reproject triggers (Risk 1: resolved)

- **v1:** auto-enqueue on **scan completion** (reproject the just-scanned
  library) + a **manual** "reproject library / all" button. No rule-save trigger
  exists in v1 because rule-authoring is v2.
- **v2:** ruleset save → enqueue reproject scoped to the **affected
  `workflow_sig` only** (indexed query on `gen.workflow_sig`).
- Reuses the `ai_jobs` cancellable-batch pattern; never runs inside the scan
  thread.

---

## Structured schema (`images` doc)

```
gen: {
  source: "a1111" | "comfyui" | "comfyui-default" | null,
  workflow_sig: str | null,
  prompt: str | null,
  negative: str | null,
  seed: int | null,
  model: str | null,        // checkpoint
  sampler: str | null,
  steps: int | null,
  cfg: float | null,
  prompt_terms: [str],      // tokenized for search
  group_id: str | null,
}
score: int        // 0-5, 0 = unrated
quarantined: bool // default false
```

`width`/`height` already exist on the doc, reused for dimension filters.

**Seeding & the missing-field footgun:** existing docs (and any not seeded) lack
`quarantined`/`score`, and `q["quarantined"] = False` would exclude every doc
missing the field, i.e. the whole existing library vanishes from the feed. So:
- Add `quarantined: False` and `score: 0` to
  `image_tags.initial_tag_fields()` (the `$setOnInsert` payload).
- Default-feed filter must use `{"quarantined": {"$ne": True}}`, never
  `== False`, to tolerate pre-existing docs. Same care if sorting by `score`.

### Indexes (add to `schema.image_indexes()`)

- `gen.prompt_terms` multikey + `_id` desc (mirrors the existing `tags__id`
  index; powers term search with `$in`/`$all`).
- `gen.model` (+ `library_id`, `_id` desc) for checkpoint equality/`$in`.
- `gen.workflow_sig` for scoped reproject + "needs mapping" queries.
- `quarantined` folded into the default-feed filter (exclude `quarantined:true`).
- Dimensions: reuse `width`/`height`; add an index only if profiling demands.
- Defer indexes on `seed`/`sampler`/`steps`/`cfg` until actually filtered on.

---

## Features

### 1. Metadata parsing: **v1**
Scan stores raw + sig; reproject fills `gen.*`; built-in A1111/ComfyUI parsers.
Surface `gen.*` in `ImageView` info panel.

### 2. Search & filters: **deferred (v2)**
`gen.prompt_terms[]` tokenized at reproject (split on commas **and** whitespace,
lowercased; preserve lora/danbooru tokens). Query via `$in`/`$all`, reusing the
tag-search infra in `imageFilter.ts` / `useImageFeed.ts`. `gen.model` dropdown
from distinct values; dimension range filters on `width`/`height`.

### 3. Curation (score + quarantine): **v1**
- `POST /api/images/{id}/score` ({0-5}); `POST /api/images/{id}/quarantine`
  ({bool}).
- `quarantined` is DB-only. `upsert_image_op` only `$set`s file metadata, so a
  rescan won't clobber it; `reconcile_stale` only deletes images whose file
  truly vanished, so the flag is reconcile-safe with no extra code. Default feed
  query excludes quarantined via `{"$ne": True}`; add a dedicated "Quarantined"
  view to **review / restore / purge**.
- **Restore** = clear the flag. Cheap, reversible.
- **Purge: must delete the file from disk.** A DB-only delete is *broken*: the
  file stays on disk → next scan rediscovers it → re-indexed as a fresh,
  **non-quarantined** image (resurrection). So purge `os.unlink`s the original,
  then deletes the `images` + `image_gen_raw` docs + MinIO thumb. This is the
  only path that reclaims disk on a local-mount library (quarantine alone frees
  nothing). Irreversible: gate behind an explicit typed/double confirm; never a
  bare keyboard shortcut. (Alternative if file-delete is unacceptable: a
  persistent exclusion/tombstone list the scanner skips, but no such concept
  exists today and it complicates reconcile; deferred unless requested.)
- Keyboard shortcuts: `1-5` set score, `X`/`Del` quarantine. **Gallery-primary**
  (acts on focused/hovered tile, needs a grid keyboard-focus model) **and**
  ImageView.

### 4. Copy-workflow: **v1**
Format-aware: ComfyUI → the `workflow` graph JSON (drops onto the canvas);
A1111 → the `parameters` string. Secondary "copy params" (seed/model/cfg as
text). Reads `image_gen_raw` on demand.

### 5. ~~Storage optimization~~: **already shipped. Dropped.**

### 6. Grouping (variations): **backend key v1, UI deferred**
`gen.group_id = hash(workflow_sig + positive prompt)`, computed at reproject.
Null/empty prompt → no group (stands alone, never a giant "null" pile). Seed
excluded so re-roll batches still group. Feed can collapse/sort by `group_id`
across page boundaries. Stacking UI deferred until real batch-size data exists.

### Rule-authoring UI: **deferred (v2)**
Settings: pick a sample image of an unmapped signature → raw graph rendered as a
collapsible tree → click a node/field to pin its path → live extracted-value
preview. Built-in parsers mean this is only needed for custom workflows.

---

## v1 cut (ship first)

Spine (`image_gen_raw` + `workflow_sig` + reproject job) · built-in A1111/ComfyUI
parsers · `gen.*` in ImageView · copy-workflow · score + quarantine + shortcuts ·
`gen.group_id` computed (no stacking UI yet).

**Deferred to v2:** rule-authoring UI · `prompt_terms` search + param filters ·
grouping stacking UI.

## Verification

1. Scan a folder of real A1111 + ComfyUI images → `image_gen_raw` populated;
   reproject fills `gen.*`; ImageView shows prompt/seed/model.
2. Copy-workflow on a ComfyUI image → pasting into ComfyUI canvas reconstructs
   the graph.
3. Score/quarantine via shortcuts in gallery; quarantined images leave the
   default feed and survive a rescan.
4. (v2) Term search "masterpiece" returns images with it in the embedded prompt.
5. Edit a ruleset for one signature → only that signature's images reproject.

## Open / lower-priority

- Grid keyboard-focus model for gallery shortcuts (needed by feature 3), first
  real new frontend primitive; spike it early.
- A1111 EXIF `UserComment` decoding for JPEG/WebP (PNG text chunks are the easy
  path; EXIF needs `img.getexif()` + UNICODE prefix handling).
- ComfyUI WebP outputs embed metadata in EXIF/XMP, not PNG chunks; confirm the
  reader covers them.

## Prompt terms as a third tag kind (BUILT)

**Status:** implemented. Backend tag-state gained the third axis (`has_prompt_tags`,
AI redefined as "no `manual:` and no `prompt:`"); reproject writes `prompt:` tags
via `replace_prompt_pipeline` as a *separate* bulk op from the classic `gen` `$set`
(so stored prompt text is never re-evaluated as an aggregation expression); `/tags`
gained `include_prompt`; the frontend renders a third (sky) chip kind and the Tags
browser has a "Show prompt tags" toggle.

**`has_tags` semantics (consequence not in the original spec):** redefined from
"array non-empty" to "has a non-`prompt:` tag". Otherwise reproject writing prompt
tags would flip `has_tags` true on fresh AI art and silently empty the "Untagged"
tile. Prompt tags are reproject-owned, not curation, so prompt-only images stay
untagged. Restores `Untagged ⊂ AI-Untagged`; `lib_id_has_tags__id` still serves it.

**Overlap decision (answers open-question 4):** AI and prompt tags coexist as
distinct prefixed entries and are **never deduped** against each other. Deduping
would force reproject to read each doc's current AI tags, coupling it to the AI
pipeline and breaking its independence (reproject runs off cold raw alone).



**Goal:** surface extracted prompt terms in the `/tags` browser, but kept
*separate* from AI tags and manual tags, a third prefixed kind in the same
`tags` array. Today extraction only writes `gen.prompt_terms` (search-only,
invisible to `/tags`).

**Decision (user):** write them into `tags` with their own prefix, separated the
same way `manual:` is separated from AI tags. Not a separate collection/browser.

### Design

- **New prefix `prompt:`** (parallel to `MANUAL_PREFIX` in
  `services/image_tags.py`). A tag is now one of three kinds: AI (unprefixed),
  `manual:`, `prompt:`.

- **Tag-state flags must gain a third axis.** Current invariant: `has_tags` (any)
  + `has_ai_tags` (any non-manual). That breaks here: `prompt:` tags are
  non-manual, so the current regex would wrongly flip `has_ai_tags` true.
  - Redefine `has_ai_tags` = "has a tag that is neither `manual:` nor `prompt:`".
  - Add `has_prompt_tags` (any `prompt:` tag).
  - Update `_recompute_flags_stage`, `exclude_manual_match`, and the
    `_MANUAL_REGEX` classification so AI = "no `manual:` AND no `prompt:`".
  - Seed `has_prompt_tags: false` in `initial_tag_fields()` (mind the
    `{$ne:true}`-style missing-field footgun on any new filter).

- **Reproject owns writing them.** `tags` is mutated only through
  `services/image_tags.py`. Add a `replace_prompt_pipeline` (mirror of
  `replace_ai_pipeline`): replace existing `prompt:` tags, preserve AI + manual.
  Reproject (`services/reproject.py`) calls it alongside writing `gen.*`, deriving
  `prompt:<term>` from the same tokenization as `gen.prompt_terms`
  (`gen_metadata.tokenize_prompt`). Re-runnable (replace, not append).

- **`/tags` browser:** default still AI-only. Add an opt-in like the existing
  `include_manual` → `include_prompt` (query param + UI toggle), so prompt tags
  don't bury curated tags by default. The `list_tags` aggregation `$match` needs
  to exclude `prompt:` unless opted in.

- **Frontend tag rendering** (`ImageView`, tag chips, `TagSearchInput`): handle a
  third kind; `formatTag` strips `prompt:` too; give it a distinct chip color
  (AI neutral, manual green, prompt = e.g. blue). Tag search over `tags`
  (`$all`/`$in`) then filters prompt tags for free.

- **CONTEXT.md:** update the Tag glossary: three kinds now, and the tag-state
  invariant gains `has_prompt_tags`.

### Open questions

- **Redundancy with `gen.prompt_terms`:** once `prompt:` tags exist in `tags`,
  the dedicated `gen.prompt_terms` index + the "Prompt contains" search overlap.
  Keep both (tokenized field for fast search, `prompt:` tags for browse), or
  unify on tag search? Lean: keep `gen.prompt_terms` for search, add `prompt:`
  tags for browse. Decide before building to avoid two sources of truth.
- **Volume:** prompt vocabularies are huge and long-tail; the Tags mosaic may
  need a min-count threshold or pagination when `include_prompt` is on.
- **Migration:** existing libraries need a reproject pass to backfill `prompt:`
  tags (the by-sig/library reproject already exists; a full reproject covers it).
- One more thing, the tags added by AI and extracted from Prompt will definitely have
  some overlap. How do we want to handle that? 