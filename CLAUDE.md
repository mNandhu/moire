# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Moiré is a pnpm monorepo for organizing AI-generated images. FastAPI backend (Python 3.11+, embedded SQLite for metadata via SQLAlchemy Core, local filesystem for thumbnail + original storage, WD ONNX model for AI tagging) + Vite/React/TypeScript frontend. Frontend talks to backend via REST; every backend route lives under `/api/v1` (`API_PREFIX` in `main.py`; root `/health` kept for probes) and the Vite dev server proxies `/api/*` → `http://127.0.0.1:8000` unchanged. **No external running dependencies**: no database server, no object store.

## Commands

Run from repo root unless noted.

```bash
pnpm install                 # install frontend deps (backend uses uv, see below)
pnpm dev                     # backend (uvicorn :8000, --reload) + frontend (vite :5173) together
pnpm perf                    # backend perf benchmark

# Backend (Python via uv; never call `python` directly)
uv --directory packages/backend sync                # install deps
uv --directory packages/backend run moire run --reload   # backend only (serves a built UI too)
uv --directory packages/backend run pytest          # all backend tests
uv --directory packages/backend run pytest tests/test_scanner.py::test_name   # single test

# Frontend (from packages/frontend)
pnpm test                    # vitest run (one-shot)
pnpm test:watch              # vitest watch
pnpm -C packages/frontend test src/lib/fuzzy.test.ts   # single test file
pnpm -C packages/frontend build   # tsc -b && vite build
```

The backend's import package is `moire` (`packages/backend/src/moire`, PyPI name `moire-studio`, command `moire`). Backend env is optional: `SQLITE_PATH` (defaults to `<MOIRE_HOME>/data/moire.db`) and `THUMB_ROOT` (defaults to `<MOIRE_HOME>/data/thumbs`); `MOIRE_HOME` is the repo root in a checkout and the OS app-data folder for an installed copy. Settings load from `<MOIRE_HOME>/.env` then (checkout only) `packages/backend/.env` (`src/moire/core/config.py`). The SQLite schema is created on startup (`ensure_schema` in `main.py` lifespan); there is no schema migration step. One-off *data* migrations run right after it (`services/tag_migrations.py` `run_pending`, recorded in the `app_settings` row "migrations"). Backend tests now include router-level **integration tests** (`tests/test_*_integration.py`) that run against a temp-file SQLite DB via the `client`/`seed` fixtures in `tests/conftest.py`.

## Domain model

**Read `CONTEXT.md` first**: it is the authoritative glossary for Library, Image, the three tag kinds, Tag-state, Rating, Scan, AI Job, Tagger. Key invariants that constrain edits:

- **Image `_id` is `{library_id}:{relative/path}`.** ID lookups normalize `/` vs `\` (`services/image_tags.py` `find_image`).
- **One `tags[]` array holds three tag kinds:** AI tags unprefixed (`1girl`), manual tags `manual:`-prefixed, prompt tags `prompt:`-prefixed. AI and prompt tags may overlap and are never deduped against each other.
- **Tag names are stored with underscores** (`blue_eyes`, Danbooru style); `services/tag_names.py` `canonical_name` is the one spelling rule. Every writer and every route/filter that takes a tag from the user canonicalizes (`image_tags.canonical_tag`), so `blue eyes` = `blue_eyes`. Spaces are display only (`lib/tags.ts` `formatTag`); `toPromptText` builds paste-into-ComfyUI text (parens escaped).
- **`services/image_tags.py` is the ONLY place that mutates `tags` and recomputes the summary flags** (`has_tags`, `has_ai_tags`, `has_prompt_tags`, `rating`). It writes the ordered `tags` JSON array, the flags, and the derived `image_tags(image_id, tag, base)` join rows **in one transaction** so they never drift. `normalize_rating` is the single rating normalizer.
- **`tags` is a JSON-array column on `images` (ordered, authoritative); `image_tags` + `image_gen_terms` are derived join tables** rebuilt transactionally from it/`gen.prompt_terms` to serve `GROUP BY`/`$in`/`$all` queries. `gen.*` scalars filtered in the feed are promoted to indexed `gen_*` columns; the full `gen` subdoc stays JSON.
- **The SQLite schema (tables + indexes) is defined once in `database/schema.py`** as a SQLAlchemy `MetaData`. `database/db.py` owns the async (app) and sync (scanner) engines, sets `WAL`/`busy_timeout` PRAGMAs, and creates the schema via `ensure_schema` on startup. **Writer discipline:** SQLite is single-writer. Keep scanner write-transactions small (they batch + commit often); the file lock + `busy_timeout` is the real cross-process serializer, not the per-side Python locks.
- **`_id` columns are `COLLATE BINARY`** (`_id` is the feed's final tie-break: cursor paging compares `(sort keys…, _id)` row values and must match the old byte-order sort).

## Backend layout

`src/moire/api/` routers (libraries, images, tags, ai, rules) mounted in `main.py` under `/api/v1/<name>`. `src/moire/services/` holds the logic: `scanner.py` (multithreaded walk → write thumb to FS → upsert + library progress), `storage_fs.py` (thumbnail FS keys/paths under `THUMB_ROOT`, atomic writes, traversal guard, `delete_by_prefix`), `ai_jobs.py` (queued cancellable batch tagging worker, started in lifespan), `ai_tagger.py` (WD ONNX model lifecycle vs pure `select_tags` inference), `ai_settings.py`, `reproject.py` (prompt-tag extraction), `image_tags.py`, `blurhash.py`.

**Media delivery** streams everything from the local filesystem through the API: thumbnails via `FileResponse` from `THUMB_ROOT` (`?size=small` serves a ~256px copy made beside the thumbnail on first ask, `storage_fs.small_thumb_path`; use it for postage-stamp previews via `lib/media.ts` `smallThumb`, never for face crops), originals via `FileResponse` from their on-disk library path. Thumbnail URLs are versioned (`?v=`, a hash of the thumbnail file's own mtime and size; `put_thumb` skips identical bytes so a rescan doesn't churn it) and served `immutable`; build them only through `services/thumb_version.py` (lists carry `thumb_url`; a page holding only an id uses `useThumbUrl`), since an unversioned URL is revalidated on every load. Originals support Range requests; both thumb and original have HEAD endpoints. New media endpoints should serve from the FS with a HEAD counterpart. A single exposed port covers remote access; front with nginx for TLS/static offload (see `deploy/nginx.conf.example`).

## Frontend layout

- **`lib/imageFilter.ts`** (`parseFilters`/`serializeFilters`) is the single source of truth for the gallery filter ⇄ URL round-trip; keep URL and query key in sync through it.
- **`hooks/useImageFeed.ts`**: one shared TanStack `useInfiniteQuery` keyed by the filter; `AllImagesPage` and `ImageView` read the same cache, so paging in one is visible in the other. The feed is newest first by file `mtime` (or oldest / top rated via `sort`), keyset-paged on `(sort keys…, _id)`; `services/image_feed.py` `SORTS` and `lib/imageFilter.ts` `nextCursorOf` must agree on the cursor shape, and each order has a matching expression index in `schema.py`.
- **`lib/media.ts`** lazily resolves a media URL; with FS-backed thumbnails it is effectively a passthrough (the HEAD probe detects a plain image response and returns the endpoint as-is). Kept for future modes that need a per-tile resolve.
- Pure logic lives in `lib/` with colocated `*.test.ts` (fuzzy, gen, gridNav, masonryLayout, imageFilter, ai). Prefer adding pure functions there with tests over logic inside components.
- `components/VirtualizedGrid.tsx` + `masonryLayout.ts` compute row spans from width/height for a stable, reflow-free grid.
- **No native browser menus.** Never use `<select>`, `<datalist>` or other browser-drawn pickers and menus: use `components/ui/Picker.tsx` (fuzzy search on long lists, groups, custom trigger) or `DropdownMenu`, and `TagSuggestList` for autocomplete. Native controls only where nothing else can do the job (a file picker).

## Gotchas

- Use the engine helpers from `database/db.py` (`async_conn`/`async_tx` async, `sync_conn`/`sync_tx` for scanner/reproject threads) with the table objects in `database/schema.py` (imported as `t`); don't open connections ad hoc. All writes go through the `*_tx` helpers.
- Keep list responses minimal via column `select(...)` projections; return full rows only when needed.
- `tags` GET aggregation is cached (`services/tag_index.py`, ~30s TTL). **Invalidation is structural. Don't clear it from call sites.** Async tag writes dirty it via `image_tags`' transaction owners; the sync path leaves it to whoever owns the transaction (`reproject._flush_batch`, once per batch). A new writer that owns its own transaction must call `tag_index.invalidate()` *after* it commits.
- In `content-visibility:auto` is a known paint-gap hazard in the virtualized grid (see project memory); avoid reintroducing it.
