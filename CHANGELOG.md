# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Single-port mode: `pnpm build` writes the UI into the backend, which then serves it, so Moiré runs as one process on one port (http://localhost:8000).
- `moire` command: install with `uv tool install "moire-studio[cpu]"` (or `[gpu]`), then `moire run` starts Moiré and `moire paths` shows where its data lives. An installed copy keeps its data in the OS app-data folder; set `MOIRE_HOME` to move it. A source checkout still uses `<repo>/data`.
- Release tooling: one version across `pyproject.toml`, `uv.lock` and both `package.json` files (`pnpm version:set`, `pnpm version:check`), and a release workflow that builds the app wheel for a `vX.Y.Z` tag. The workflow stays off until the `RELEASE_ENABLED` repository variable is `true`.

### Changed

- The backend's Python package is now `moire` (`packages/backend/src/moire`), so run it with `uvicorn moire.main:app` or `moire run` instead of `uvicorn src.main:app`. The distribution is `moire-studio`.
- Renamed the project from Tagify to Moiré. Code identifiers, paths and settings use `moire`: the database defaults to `data/moire.db`, the model cache to `.cache/moire/models`, logs to `moire.log`, the Docker volume is `moire_data`, and environment variables are `MOIRE_*` (formerly `TAGIFY_*`). There is no automatic migration; move an existing `tagify.db` (with its `-wal`/`-shm` files) to the new name by hand.
- New design tokens and a polish pass over the gallery and image view; new Moiré logo and favicon.

## [0.1.1] - 2025-08-13

### Fixed

- Backend: Full page image view 404 with image IDs containing slashes/backslashes. Routes now use `{image_id:path}` and lookups normalize separators to resolve both `foo/bar` and `foo\\bar` forms.

### Added

- Phase 0 performance improvements (backend):
  - Mongo indexes ensured on startup (images: `(library_id, _id desc)`, `tags`).
  - Tag aggregation TTL cache (30s) with invalidation on tag changes.
  - HTTP Range support for originals with correct `206 Partial Content`, `Content-Range`, and `Accept-Ranges: bytes`.
  - Scanner concurrency cap via `SCANNER_MAX_WORKERS`.
  - Phase 1 (start): Configurable pre-signed media delivery via `MEDIA_PRESIGNED_MODE` = off|redirect|url and `MEDIA_PRESIGNED_EXPIRES` for expiry. Frontend updated to handle `url` mode seamlessly; backend default set to `redirect` to offload media.
  - Phase 2 (start): Cursor-based pagination for images using `_id` cursor. Backend supports `cursor` param; frontend infinite scroll switched from `offset` to `cursor` and preserves it in deep-links.

### Notes

- Pre-signed URL mode and cursor-based pagination are planned next.

## [0.1.0] - 2025-08-13

### Added

- Image View
  - Full-screen image view refinements: icon-only overlays (Back, Info), slide-in info panel, distinct surface, image fade-in, and neighbor preloading.
  - Back action returns to gallery with filters preserved.
  - Info toggle shows as overlay when closed and as X inside the panel when open.
- Libraries
  - Shows indexed_count and last_scanned in cards.
  - Rescan now runs in background (non-blocking) with per-library progress tracking and a new progress endpoint.
  - Frontend polls progress only while scanning and displays a progress bar; hides “n indexed” while scanning.
  - Inline edit modal for name/path with optional rescan.
- Backend
  - Multithreaded scanner with ThreadPoolExecutor; progress fields: scanning, scan_total, scan_done, scan_error, last_scanned, indexed_count.
  - New GET /libraries/{id}/progress for UI polling.
  - Phase 0 performance groundwork: Mongo indexes on images (library_id + \_id, tags), tag list TTL cache, Range requests for originals, scanner worker cap via SCANNER_MAX_WORKERS.

### Changed

- Avoids excessive polling by limiting to scanning libraries and stopping when complete.
- Images API: fixed routing for image IDs containing slashes by using path converters; ensures /file and /thumb work for nested IDs.
  - Also normalizes lookup to tolerate forward/backward slashes in stored IDs to handle Windows paths.

### Notes

- Virtualized masonry for the gallery is planned next.

### Added

- Monorepo structure using pnpm workspaces: `packages/frontend`, `packages/backend`.
- Root configuration: `.gitignore`, `pnpm-workspace.yaml`, root `package.json` scripts for backend dev.
- Backend (FastAPI + uv):
  - `pyproject.toml` with dependencies: `fastapi[standard]`, `uvicorn`, `pymongo`, `pillow`, `python-dotenv`.
  - FastAPI app with CORS for Vite, `/health` endpoint. Images are streamed via API backed by MinIO buckets.
  - Placeholder API routers: `libraries`, `images`, `tags`.
  - `.env.example` and config loader (`src/core/config.py`).
- Frontend (Vite + React + TypeScript + Tailwind):
  - Vite config with proxy from `/api` to backend.
  - Strict `tsconfig.json`, Tailwind and PostCSS configs, scaffolded React app that pings `/api/health`.
  - `.env.local.example`.

### Notes

- Backend verified locally: `/health` returns `{ "status": "ok" }`.
- Frontend requires pnpm to install and run dev server.

[0.1.0]: https://example.com/moire/releases/0.1.0
