# Moiré – Phase: Functional Features & UX Improvements

Date started: 2026-01-05  
Scope: This phase focuses on functional changes and new features (not primarily refactors), while keeping the existing baseline stable.

## Goals

- Improve browsing ergonomics (sorting, better tag browsing)
- Add manual quality controls (rating + quarantine)
- Reduce operational friction (internal AI tagging; avoid rescans where possible)
- Keep gallery performance strong (thumbnail/derivative strategy)
- Preserve clean APIs and backward compatibility where reasonable

## Guiding principles

- **Small, composable changes**: keep commits reasonably sized and reviewable.
- **Performance-first gallery**: avoid heavy transfers/decodes for grids.
- **Stable pagination**: any new sort/filter must produce deterministic infinite scroll.
- **Deployment flexibility**: support both “single machine” and “server/Docker” usage patterns.

## Notes

- The Settings page exists today but is a **stub**. This phase should turn it into the primary home for feature toggles and configuration (watcher settings, AI tagging, storage/thumbnail modes, etc.).

## Epics / Work items

### 1) Gallery sort options (date-based)

**User need**: Sort gallery based on time (e.g., newest first).

**Backend**

- Support sort modes (tentative):
  - `mtime` (file modified time)
  - `ctime` (file created time; note Windows semantics can vary)
  - optionally `indexed_at` / `added` (when Moiré indexed it)
- Cursor pagination must match sort key and use a stable tiebreaker:
  - recommended cursor: `(sort_value, _id)`
- Add indexes aligned to sort + common filters.

**Frontend**

- Sort dropdown in Gallery View.
- Persist sort mode in URL query params.

**Open decisions**

- Which “date” should be default? `mtime` vs `ctime` vs `indexed_at`.

---

### 2) Rating system + quarantine (manual moderation)

**User need**: Mark glitched/bad images to exclude them from browsing; optionally highlight great images.

**Data model (proposal)**

- On each image document:
  - `rating: int | null` (e.g. 0–5 or 1–5)
  - `status: 'ok' | 'quarantine'` (or boolean `quarantined`)
  - optional `quality_note: string`
  - `updated_at: datetime`

**Backend**

- Endpoints:
  - set/clear rating (single + batch)
  - quarantine/unquarantine (single + batch)
- Filters:
  - include/exclude quarantined (default exclude)
  - min/max rating; unrated only

**Frontend**

- Image detail: rating control + quarantine toggle.
- Gallery: batch actions for selection.
- Filters UI and (optional) keyboard shortcuts.

**Open decisions**

- Default behavior: quarantine hidden everywhere by default (recommended) vs per-view toggles.

---

### 3) Tag thumbnails in “Browse by Tag”

**User need**: Tag buttons/cards should have a thumbnail; default is first image with that tag; user can override.

**Model (recommended)**

- New Mongo collection (e.g. `tag_meta`):
  - `_id: <tag>` (or `{ tag, library_id }` if future per-library)
  - `thumb_image_id: string`
  - `updated_at: datetime`

**Backend**

- Tags listing should return effective thumbnail reference:
  - override if configured
  - otherwise fallback selection rule
- Endpoints:
  - set tag thumbnail to an image
  - clear override

**Frontend**

- Tag view: show thumbnail on tag cards.
- Provide “Change thumbnail” flow (picker limited to images with that tag).
- Shortcut: from ImageView, “Set as thumbnail for tag X”.

**Open decisions**

- Fallback selection rule when no override:
  - first image in tag sort
  - newest image
  - highest-rated image (if rating exists)
- Tag card thumbnail **size/aspect policy**:
  - Fixed aspect ratio (e.g., 1:1 or 16:9) with center-crop?
  - Flexible ratio that adapts per tag thumbnail image (risk: janky grid / layout shifts)?
  - Hybrid: fixed container ratio + "contain" for extreme aspect images + subtle background/blur?

---

### 4) Watch libraries for changes (avoid full rescans)

**User need**: Detect newly added/changed/deleted files without running full rescan.

**Approach (industry standard)**

- Hybrid model:
  1. filesystem watcher (near real-time)
  2. periodic reconciliation scan (covers missed events, network share quirks)

**Backend**

- Optional watcher per library:
  - create/modify/delete events enqueue indexing work
  - debounce/coalesce bursts
  - file readiness check (avoid indexing while still copying)
  - bounded concurrency work queue
- Reconciliation job interval per library.
- Controls/visibility:
  - enable/disable watching
  - show watcher status and errors

**Open decisions**

- Deletion behavior:
  - immediate delete from DB + MinIO
  - or mark “missing” first, cleanup later (safer)

---

### 5) Thumbnail / derivative strategy (gallery performance vs quality)

**User preference**: “Maximum resolution detail” even in gallery.

**Recommendation (hybrid)**

- Keep derivatives (thumbs) for grid performance.
- Serve originals for ImageView/detail.
- Consider larger thumbs (e.g. 1024–1536px long edge) for high quality grid without downloading full originals.

**Potential enhancements**

- Multi-size derivatives:
  - small (tag cards)
  - medium/large (gallery)
- Consider modern formats in future (webp/avif) if worth complexity.

**Open decisions**

- Thumb sizes/quality defaults.
- Whether to support an optional “high quality grid” toggle.

---

### 6) Original storage strategy (MinIO mirroring vs no redundancy)

**Current behavior**: Originals and thumbs are stored in MinIO (duplicates library contents).

**Why store originals in MinIO?**

- Portability and uniform serving (works even if source library path changes/unmounts)
- Easier Docker/server deployments (no need to mount/serve raw filesystem at view-time)
- Works naturally with pre-signed/redirect delivery modes
- Backup/migration can be “self-contained” (MinIO + Mongo)

**Options**

1. **Mirror** (current): originals + thumbs in MinIO
2. **Thumbs-only**: originals served from filesystem; only thumbs/derivatives stored
3. **Mirror + dedup** (advanced): content-addressed originals in MinIO to reduce duplication

**Open decisions**

- Default mode based on target deployment:
  - Single-machine / local browsing → thumbs-only is often best
  - Server/Docker/multi-device → mirror is often best

---

### 7) Internal AI tagging (no external endpoint)

**User need**: Avoid setting up external AI endpoint; run tagging inside Moiré.

**Design**

- Add provider config:
  - `AI_TAGGING_PROVIDER = off | external | internal`
- Internal provider uses ONNX Runtime:
  - CPU package small; model ~350MB
  - expected inference: ~1–2s/image with model cached

**Backend**

- Load model once (process-level cache).
- Run inference via background work queue.
- Apply tags with confidence threshold.
- Expose progress and results (optional “review” workflow later).

**Frontend**

- Controls:
  - run on selection
  - run on library
  - show progress + results

**Open decisions**

- Model download strategy:
  - user-provided path
  - download-on-first-run into cache dir
- Concurrency limits / batching.

---

## Execution order (suggested)

1. Decide storage + thumbnails strategy (impacts several endpoints and scanning)
2. Gallery sort (must keep pagination correct)
3. Rating + quarantine (unblocks better browsing + quality control)
4. Tag thumbnail overrides
5. Library watcher + reconciliation
6. Internal AI tagging
7. Tests, docs, and polish

## Tracking checklist

- [ ] Define sort + filter spec
- [ ] Add rating/quarantine data model
- [ ] Implement image rating APIs
- [ ] Frontend rating & quarantine UX
- [ ] Tag thumbnail override model
- [ ] Implement tag thumbnail APIs
- [ ] Frontend tag thumbnail UI
- [ ] Library filesystem watcher
- [ ] Decide thumbnail/derivative strategy
- [ ] Decide original storage strategy
- [ ] Internal AI tagging design
- [ ] Implement internal ONNX tagging
- [ ] Wire AI tagging UX
- [ ] Tests & docs
