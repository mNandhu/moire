# SQLite Migration Plan

**Status:** Draft. Run *after* the MinIO-removal worktree lands (blobs → local FS).
**Goal:** Replace MongoDB with embedded SQLite so the app has **zero external running
dependencies**: `git clone && pnpm install && run`, no Docker, no daemon.

Do **not** start this concurrently with the MinIO work, both touch the storage/data
layer and will collide. Branch off `main` *after* MinIO removal merges.

---

## 1. Why SQLite, not JSON

The weight is the *server process*, not the query engine. JSON files force you to
hand-build indexes, aggregation, crash-safe writes, and concurrency control, i.e. a
worse database. SQLite gives a single file with indexes, `GROUP BY`, window functions,
transactions/WAL, and ships in the Python stdlib's reach (via `aiosqlite`). It scales
far past a single-user image organizer's ceiling, so the "use Mongo if large" fork is
unnecessary.

---

## 2. ORM choice: SQLAlchemy **Core** (+ aiosqlite), not the full ORM

**Add to `pyproject.toml`:** `sqlalchemy>=2.0`, `aiosqlite`. **Drop:** `pymongo`, `motor`.

**Use Core (Table / MetaData / select / insert / update), not the declarative ORM.**
Reasons:
- The feed filter is *dynamically assembled* (N tag clauses with AND/OR fan-out, `any:`
  expansion, range/equality/`$ne` siblings). Core's expression builder composes that
  cleanly and parametrized, no string concatenation, no injection surface. A full ORM
  identity-map buys nothing here; the data is set-oriented, not an object graph.
- Raw `aiosqlite` is lighter but makes you rebuild a safe dynamic-query builder by hand.
  Core earns its place specifically at `_build_feed_query`.

**Engines (two, one file, fine under WAL):**
- App (FastAPI, async): `create_async_engine("sqlite+aiosqlite:///<path>")`.
- Scanner (sync worker threads): `create_engine("sqlite:///<path>")`.

**Connect-time PRAGMAs** (via a SQLAlchemy `connect` event on both engines):
```
PRAGMA journal_mode=WAL;     -- concurrent reads during a write
PRAGMA busy_timeout=5000;    -- wait, don't error, on contention
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;   -- WAL-safe, faster
```

**Writer discipline (new invariant, document it):** SQLite is single-writer. The
**actual** serializer across the app process and the scanner threads is SQLite's own
file-level write lock + `busy_timeout`, *not* Python locks. An `asyncio.Lock` (app) and
a `threading.Lock` (scanner) are independent; they do **not** serialize the app against
the scanner, so on their own they don't prevent `SQLITE_BUSY` ("database is locked") when
a long scanner transaction starves an incoming tag-edit. Two valid designs: pick one and
state it as the invariant:

- **(Recommended, lighter)** Lean on the file lock + `busy_timeout`, and make
  **"small scanner batches, commit often"** an explicit rule (not incidental) so no write
  transaction holds the lock long enough to exhaust `busy_timeout`. Per-process Python
  locks still help avoid self-contention within each process.
- **(Heavier, literally "serialize all writes")** Route *every* write (app and scanner)
  through one shared single-writer queue/connection. Strongest guarantee, more plumbing.

WAL lets reads proceed throughout either way. This mirrors the existing "`image_tags.py`
is the only mutator" rule. Add a sibling **writer-discipline** rule in CLAUDE.md.

---

## 3. Schema (SQLite tables)

Normalize the two multikey arrays into join tables (that's what served Mongo's
multikey `$in`/`$all` and `$unwind`+`$group`). Keep denormalized flag columns so the
existing index strategy carries over.

```
images(
  _id            TEXT PRIMARY KEY COLLATE BINARY,  -- "{library_id}:{relpath}", unchanged.
                                       -- BINARY is mandatory: cursor paging is `_id < cursor`
                                       -- and must match Mongo's byte-order sort. NOCASE would
                                       -- silently diverge pagination.
  library_id     TEXT NOT NULL,
  path           TEXT,
  width          INTEGER,
  height         INTEGER,
  thumb_key      TEXT,
  blurhash       TEXT,
  score          REAL,
  rating         TEXT,
  quarantined    INTEGER DEFAULT 0,
  has_tags       INTEGER DEFAULT 0,     -- derived, recomputed on every tag write
  has_ai_tags    INTEGER DEFAULT 0,
  has_prompt_tags INTEGER DEFAULT 0,
  gen_model      TEXT,                  -- promoted gen.* scalars for indexed filters
  gen_workflow_sig TEXT,
  gen_group_id   TEXT,
  gen_prompt     TEXT,
  gen            TEXT,                  -- full gen subdoc as JSON (workflow endpoint, reproject)
  created_at     TEXT, updated_at TEXT
)

image_tags(
  image_id TEXT NOT NULL REFERENCES images(_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,              -- full tag incl. prefix: "1girl" | "manual:x" | "prompt:y"
  base     TEXT NOT NULL,              -- prefix stripped, for the any:<base> merged count
  PRIMARY KEY (image_id, tag)
)

image_gen_terms(
  image_id TEXT NOT NULL REFERENCES images(_id) ON DELETE CASCADE,
  term     TEXT NOT NULL,              -- gen.prompt_terms[]
  PRIMARY KEY (image_id, term)
)

libraries(_id TEXT PRIMARY KEY, path TEXT, name TEXT, <progress fields...>)
image_gen_raw(_id TEXT PRIMARY KEY, library_id TEXT, workflow_sig TEXT, raw TEXT /*JSON*/)
tag_meta(tag TEXT PRIMARY KEY, thumb_image_id TEXT, updated_at TEXT)
gen_rulesets(sig TEXT PRIMARY KEY, doc TEXT /*JSON*/)
ai_settings(_id TEXT PRIMARY KEY, doc TEXT /*JSON*/)   -- single "ai" row
```

**Indexes** (mirror `schema.image_indexes()`):
```
images(library_id, _id DESC)
images(library_id, has_tags, _id DESC)
images(library_id, has_ai_tags, _id DESC)
images(gen_model, _id DESC)
images(gen_workflow_sig)        images(gen_group_id)
image_tags(tag)                 image_tags(base)
image_gen_terms(term)
image_gen_raw(library_id, workflow_sig)   image_gen_raw(workflow_sig)
```

**`libraries._id`:** drop `ObjectId`. Generate a `uuid4().hex` string on insert. Treated
as opaque everywhere (incl. frontend), so format change is safe, but *verify* no
frontend code parses the 24-hex shape.

---

## 4. Query translations (the 7 pipelines + cursor paging)

| Current (Mongo) | SQLite |
|---|---|
| Feed filter `_build_feed_query` (`images.py:38`) | Core `select(...).where(...)` built from the same conditions; tag AND/OR → join/EXISTS clauses, `any:` → `base` match |
| Cursor page: `find(q).sort(_id desc).limit` + `_id < cursor` (`images.py:193`) | `WHERE ... AND _id < :cursor ORDER BY _id DESC LIMIT :n` |
| Tag cloud `$unwind`+`$group count`+`$max` (`tags.py`) | `SELECT tag, COUNT(*), MAX(image_id) FROM image_tags [WHERE base/prefix filter] GROUP BY tag ORDER BY 2 DESC` |
| Merged `any:` distinct-image counts (`merged_tag_counts_pipeline`) | `SELECT base, COUNT(DISTINCT image_id) FROM image_tags GROUP BY base` |
| Per-tag `$sample` thumbnails (`tags.py`) | `SELECT ... JOIN image_tags WHERE tag=? ORDER BY RANDOM() LIMIT n`; full scan+sort of matching rows, but fine: the endpoint is TTL-cached and per-tag match sets are small |
| Group/collapse by `gen.group_id`, rep=newest (`images.py:323`) | window: `ROW_NUMBER() OVER (PARTITION BY COALESCE(gen_group_id,_id) ORDER BY _id DESC)` pick `rn=1`, count via `COUNT(*) OVER (same partition)` |
| AI progress group-by-library (`ai.py:195`) | `SELECT library_id, COUNT(*), SUM(has_ai_tags) FROM images GROUP BY library_id` |
| Model list count (`images.py:307`) | `SELECT gen_model, COUNT(*) GROUP BY gen_model ORDER BY 2 DESC` |
| Rules sig aggregation (`rules.py:62`) | `GROUP BY workflow_sig` over `image_gen_raw` |
| `pterms` `$in`/`$all` | `$in` → `EXISTS (... term IN (...))`; `$all` → join + `GROUP BY HAVING COUNT(DISTINCT term)=N` |

**Tag-mutation pipelines** (`apply_manual` / `remove_tags` / `replace_ai` /
`replace_prompt` / `clear_ai` in `image_tags.py`), the atomic mutate+recompute, become
one **transaction**: DELETE/INSERT into `image_tags` (and `image_gen_terms` for prompt),
then `UPDATE images SET has_tags=EXISTS(...), has_ai_tags=EXISTS(...),
has_prompt_tags=EXISTS(...)`. The flag logic moves out of Mongo pipeline stages into a
single SQL/Python recompute helper. **This shrinks `image_tags.py` substantially**:
the five `*_pipeline()` builders disappear; the pure prefix helpers
(`is_manual`/`to_prompt`/`ANY_PREFIX`/`expand_search_tag`/`normalize_rating`) stay
unchanged.

**Scanner upsert** (`$set` + `$setOnInsert`, `scanner.py:160`) →
`INSERT INTO images (...) VALUES (...) ON CONFLICT(_id) DO UPDATE SET
<file-meta cols only>`, leaving tag-state columns untouched on conflict reproduces
`$setOnInsert`.

---

## 5. Files to update

**Core / DB layer**
- `core/config.py`: drop `mongo_*`; add `sqlite_path` (default under a `data/` dir),
  keep `.env` loading.
- `database/schema.py`: rewrite: SQLAlchemy `MetaData` + `Table` defs + index defs +
  DDL helper. Replaces `mongo_uri`/`client_kwargs`/`*_indexes`.
- `database/motor.py` → `database/db.py`: async engine + `ensure_schema()`; replace
  `acol`/`get_async_db`/`ensure_indexes_async`.
- `database/mongo.py`: sync engine + the serialized writer for scanner threads.

**Lifespan / startup**
- `main.py`: replace `ensure_indexes_async` + the two flag-backfill `update_many`s
  (lines 31/36) with `ensure_schema()` (DDL is declarative; no backfill needed for a
  fresh DB, existing data handled by the importer in §7).

**Routers / services (read + write paths)**
- `services/image_tags.py`: replace the 5 `*_pipeline()` + their `update_one` callers
  (424/428/436/442) with transactional repo writes + flag recompute. Keep pure helpers.
- `api/images.py`: `_build_feed_query` → Core where-clause; feed/cursor paging;
  `list_groups` window query; `list_models` group-by; rating/score/quarantine/purge
  `update_one`/`delete_one` → `UPDATE`/`DELETE`.
- `api/tags.py`: 3 aggregations → SQL; `tag_meta` find/update/delete.
- `api/ai.py`: progress aggregation → `GROUP BY`.
- `api/libraries.py`: `ObjectId` → `uuid4().hex`; insert/delete/update; cascade deletes
  (images + gen_raw) via SQL or FK `ON DELETE CASCADE`.
- `api/rules.py`: aggregate + `replace_one`/`delete_one` on `gen_rulesets`.
- `services/reproject.py`: `bulk_write(UpdateOne + replace_prompt_pipeline)` → batched
  `UPDATE` + `image_gen_terms` rewrite in a transaction.
- `services/scanner.py`: **biggest change.** `bulk_write` upserts → `INSERT ... ON
  CONFLICT` batches through the serialized writer; `reconcile` `delete_many`; library
  progress `update_one`. Pure helpers (`reconcile_stale`, doc-building) unchanged.
- `services/ai_jobs.py`: find-untagged query + per-doc update → SQL.
- `services/ai_settings.py`: settings doc get/insert/update → single-row table.
- `api/_utils.py`: remove `parse_object_id`.

**Deps / infra / docs**
- `pyproject.toml`: swap deps (§2).
- `docker-compose.dev.yml` / `docker-compose.ci.yml`: remove the Mongo service; CI no
  longer needs DB containers (combined with MinIO removal → may drop compose entirely).
- `CLAUDE.md` / `CONTEXT.md`: update the DB section, the "only mutator" invariant, add
  the **writer-discipline** invariant, drop Mongo index/connection notes.

**Frontend:** expected **untouched** if `_id` stays an opaque string everywhere. Verify
no component parses library-id format. (Action: verify, not change.)

---

## 6. New tests: the payoff

Today `tests/` is **pure-logic only** (`test_image_tags`, `test_scanner`, `test_blurhash`,
`test_gen_metadata`, `test_schema`) and there are **no DB integration tests**, because
standing up Mongo in a test is painful and CI has no unit-test step (it curls a live
stack). SQLite removes that barrier: a temp-file or `:memory:` DB spins up with zero
infra, so router-level integration tests become cheap and CI can finally run them.

**Harness (`conftest.py`):** fixture creates a temp SQLite file, runs `ensure_schema()`,
overrides the DB dependency, and yields an `httpx` `ASGITransport` client against the
FastAPI app. Per-test DB = full isolation.

**New integration test files:**
- `test_images_feed.py`: every filter combo: tags AND/OR, `any:` fan-out, width/height
  ranges, `no_tags`, `no_ai_tags`, `quarantined` hidden-by-default, `pterms` `$in`/`$all`,
  `model`, `group_id`. **Cursor pagination:** full walk yields each image once, stable
  across page boundaries, `_id desc` order.
- `test_tags_api.py`: tag-cloud counts; `browse_exclude` (manual/prompt inclusion
  toggles); merged `any:` counts distinct images (no double-count); `$sample` stays
  within-tag; `tag_meta` pin leads the mosaic.
- `test_groups.py`: batch collapse: rep = newest member, count correct, ungrouped images
  stand alone, grouping spans page boundaries.
- `test_tag_mutations.py`: `apply_manual` / `remove` / `replace_ai` / `replace_prompt` /
  `clear_ai`: assert both the `image_tags` rows **and** the three recomputed flags. This
  pins the invariant that used to live inside Mongo pipeline stages. Round-trip cases.
- `test_scanner_db.py`: upsert seeds tag-state only on insert (`$setOnInsert` behavior),
  refreshes file-meta on update; `reconcile_stale` deletes; a concurrent-writer smoke
  test proves the WAL/lock discipline doesn't raise "database is locked".
- `test_ai_progress.py`: per-library totals + `ai_tagged` counts.
- `test_reproject_db.py`: `replace_prompt` rewrites `image_gen_terms` + flags.
- `test_migration.py`: (if shipping the importer) seed source rows → import → row parity.

Keep all existing pure-logic tests unchanged.

---

## 7. Data migration (existing users)

Originals on disk are the source of truth, so images/thumbs are re-derivable by a rescan.
**Manual tags, ratings, scores, quarantine, tag_meta pins, gen_rulesets are NOT**. They
only live in the DB. So ship a one-off importer to preserve curation:

`scripts/migrate_mongo_to_sqlite.py`: connect to the old Mongo (temporarily keep
`pymongo` available, or read a dump), stream each collection into the new tables, splitting
`tags[]` → `image_tags` and `gen.prompt_terms` → `image_gen_terms`, recomputing flags.
Verify with a row-count + spot-check pass (`test_migration.py`).

Document a fallback: fresh installs / users who don't mind re-curating can just rescan.

---

## 8. Suggested sequencing

0. **Rebase onto the merged post-MinIO tree and re-verify §5.** Every `file:line` reference
   in this doc is a *pre-MinIO* snapshot. MinIO removal will edit several of the same files
   (`scanner.py` thumb upload, `images.py`/`tags.py` `_attach_thumb_url`/presign,
   `config.py` `MINIO_*`), so line numbers will shift. **Treat function/symbol names as the
   anchor, not line numbers.** Confirm the file list still holds before starting.
1. Deps + `schema.py` (tables/DDL) + `db.py` engine + PRAGMAs + writer discipline + config.
2. Thin **repository** modules (`database/repo/*` or `database/queries.py`) so SQL stays
   out of routers and gets one place to test. (~85 call sites across 13 files collapse
   into a handful of repo functions.)
3. Port **read** paths (feed, tags, groups, progress, models) → integration tests green.
4. Port **write** paths (tag mutations, scanner, reproject, libraries, ai_jobs, settings)
   through the serialized writer → write-path tests green.
5. Importer + `test_migration.py`.
6. Delete `motor.py`/`mongo.py` Mongo code, drop deps, remove the Mongo compose service,
   update CLAUDE.md/CONTEXT.md.

---

## 9. Risks / watch-items

- **Writer serialization** is the highest-risk change (scanner is multithreaded). Get WAL
  + `busy_timeout` + the single-writer route right early; the concurrent-writer smoke test
  guards it.
- **Atomic flag recompute** must stay inside the same transaction as the tag write, or the
  summary flags drift (same invariant as today, new mechanism).
- **`$all` / `any:` fan-out** SQL is the fiddliest read query: cover it heavily in
  `test_images_feed.py`.
- **Library id format change** (ObjectId → uuid hex): verify frontend opacity before
  merging.
