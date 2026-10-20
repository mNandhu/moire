# Moiré Backend (FastAPI + uv)

## Development

- Manage Python deps with uv.
- Run dev server:

```
uv run uvicorn src.main:app --reload --host 127.0.0.1 --port 8000
```

- Env: copy `.env.example` to `.env` and fill values.

## Build

The backend is an installable package (uv build backend, flat layout; the
importable package is `src`):

```
uv build            # sdist + wheel into dist/
```

## Configuration

Environment variables (see `.env.example`). Relative paths resolve against the
repo root, not the process working directory.

- Storage
  - `SQLITE_PATH` SQLite database file (default: `./data/moire.db`)
  - `SQLITE_BUSY_TIMEOUT_MS` wait for the SQLite write lock (default: 5000)
  - `THUMB_ROOT` thumbnail directory (default: `./data/thumbs`)
  - `MODEL_CACHE_DIR` downloaded tagger models (default: `./.cache/moire/models`)

- Scanner / watcher
  - `SCANNER_MAX_WORKERS` worker threads per scan (0 = auto)
  - `SCANNER_MAX_CONCURRENT_SCANS` libraries scanning at once; others queue (default: 2)
  - `WATCH_ENABLED_DEFAULT`, `WATCH_RECONCILE_INTERVAL_S` filesystem watching of new libraries

- Thumbnails
  - `THUMB_MAX_SIZE` longest edge in px (default: 768), `THUMB_FORMAT` (default: `webp`)

- Logging
  - `LOG_LEVEL` (default: `INFO`)
  - `LOG_TO_FILE` / `LOG_DIR` rotating `moire.log` (default: on, `./data/logs`)
  - `LOG_SLOW_REQUESTS_MS` warn on requests slower than this (default: 1000)

- Ops / safety
  - `RATE_LIMIT_ENABLED`: `true` to enable a simple per-process rate limiter (default: false)
  - `RATE_LIMIT_RESCAN_PER_MINUTE`: max `POST /api/v1/libraries/{id}/rescan` per IP per minute (default: 1)

Media (thumbnails and originals) is streamed from the local filesystem; originals
honor `Range` requests.

## API highlights

All routes are served under `/api/v1` (e.g. `GET /api/v1/images`); `GET /health` is also available at the root.

- `GET /images` list images

  - Filters: `tags[]=...`, `logic=and|or`, `library_id`, `no_tags=1`
  - Pagination: `limit`, `cursor` (string `_id`) for stable paging by `_id` descending
  - Returns minimal fields for grid: `_id`, `path`, `width`, `height`

- `GET /images/{id}/file`: streams the original from disk; supports `Range` (HEAD too)

- `GET /images/{id}/thumb`: streams the WebP thumbnail from `THUMB_ROOT` (HEAD too)

- `GET /tags`
  - Server-side TTL cache for 30s to avoid heavy aggregations on every request
