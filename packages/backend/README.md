# Moiré Backend (FastAPI + uv)

## Development

- Manage Python deps with uv.
- Run dev server:

```
uv run moire run --reload        # or: uv run uvicorn moire.main:app --reload
```

- Env: copy `.env.example` to `.env` and fill values.
- AI tagging uses the CPU build of onnxruntime (the default `cpu` dependency
  group). For an NVIDIA GPU, swap in the `gpu` group instead:
  `UV_NO_GROUP=cpu uv sync --group gpu`, and keep `UV_NO_GROUP=cpu` set for
  later `uv run`s. See "GPU tagging" in the root README.

## Build

The backend is the installable app: PyPI name `moire-studio`, import package
`moire` (src layout, `src/moire`), command `moire`. Run `pnpm build` first so
the wheel carries the UI (`src/moire/web`, gitignored but included):

```
uv build            # sdist + wheel into dist/
```

The AI tagger's onnxruntime is an extra (`[cpu]` or `[gpu]`) for installs, and
a dependency group of the same name in a checkout. Keep the two lists in step.

## Configuration

Environment variables (see `.env.example`). Relative paths resolve against
`MOIRE_HOME`, not the process working directory: the repo root in a checkout,
the OS app-data folder for an installed copy (`moire paths` shows it).

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
