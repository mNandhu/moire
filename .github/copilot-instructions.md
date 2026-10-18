# Moiré – AI agent working guide

Brief: Moiré is a pnpm monorepo with a FastAPI backend (Python, MongoDB, MinIO) and a Vite + React + TypeScript frontend. Frontend talks to backend via REST (dev proxy at /api). Favor small, composable changes.

## Big picture

- packages/backend: FastAPI app exposing libraries, images, tags. MongoDB stores metadata; MinIO stores originals and JPEG thumbnails.
- packages/frontend: React app for browsing/filtering images, image details, and tagging.
- Media delivery supports pre-signed URLs: backend may 307-redirect or return JSON { url }; frontend resolves seamlessly.

## Dev workflow (local)

- Prereqs: MongoDB (mongodb://localhost:27017) and MinIO (127.0.0.1:9000). Backend env in packages/backend/.env (see backend README): MINIO\_\*, MEDIA_PRESIGNED_MODE, etc.
- One-command dev: pnpm install, then pnpm dev. Backend: uvicorn on 127.0.0.1:8000; Frontend: Vite on 5173 with proxy /api -> backend. Health: GET /api/health.
- Backend uses uv (pyproject.toml). Root script runs: uv run uvicorn src.main:app --reload.

## Data model and IDs

- images: \_id="{library_id}:{relative/path}", fields: library_id, path, size, width, height, ctime, mtime, tags[], original_key, thumb_key.
- libraries: path, optional name, plus progress fields during scans: scanning, scan_total, scan_done, indexed_count, last_scanned, scan_error.
- Indexes on startup: (library_id ASC, \_id DESC) and tags multikey (see src/database/mongo.py: ensure_indexes()).

## Backend patterns

- App wiring (src/main.py): CORS for Vite, include routers, ensure_indexes() on startup.
- Images (src/api/images.py):
  - GET /images: filters tags[]=, logic=and|or, library_id, no_tags=1; pagination via limit and cursor (\_id; sort by \_id desc). Use projections to keep payload small.
  - GET /images/{id}/thumb and /file: honor MEDIA_PRESIGNED_MODE: redirect (307), url ({ url }), off (stream). Originals support Range; HEAD endpoints exist.
  - Image ID lookup tolerates / vs \ via \_find_image_doc.
- Libraries (src/api/libraries.py): create triggers scan_library_async; rescan; delete removes Mongo docs and MinIO objects by prefix.
- Tags (src/api/tags.py): GET aggregates with a 30s TTL cache; apply/remove mutate tags; optional AI tagging via AI_TAGGING_URL.
- Storage (src/services/storage*minio.py): Keys "{library_id}/{image_id}.ext"; thumbs are JPEG "...jpg". Use presign*\* for redirect/url modes; delete_by_prefix for cleanup.
- Scanner (src/services/scanner.py): multithreaded walk; uploads original + thumb; upserts image docs; updates library progress; respects SCANNER_MAX_WORKERS.

## Frontend patterns

- Fetch with "/api/..." — vite.config.ts proxies to backend.
- Media URL resolution (src/lib/media.ts): HEAD to detect JSON; if JSON, GET to extract { url }; else use endpoint (browser follows 307 redirects).
- Infinite scroll & filters (pages/AllImagesPage.tsx): cursor-based by \_id; filters synced to URL; shortcuts: S toggle selection, F focus search, N toggle no-tags.
- Stable grid (components/GalleryGrid.tsx): compute row spans from width/height to prevent reflow.

## Conventions & gotchas

- Use DB helpers (src/database/mongo.py: col(), get_db()); indexes via ensure_indexes().
- Keep list responses minimal (projections); return full docs when needed.
- Always honor MEDIA_PRESIGNED_MODE for new media endpoints; implement HEAD consistently.
- Normalize path separators when matching image IDs.

## Concrete examples

- Regenerate thumbnail endpoint:
  - Backend: in images router, read original (get_original), render JPEG, upload via put_thumb, update images.thumb_key; return 200 (optionally include fresh URL when mode=url).
  - Frontend: call POST /api/images/{id}/regenerate-thumb; then reload image src — media.ts handles redirect/url.
- Batch tag apply:
  - Backend: POST /tags/apply-batch with { ids:[], tags:[] } using $addToSet/$each; clear TTL cache; return counts.
  - Frontend: use selection in AllImagesPage; show toast on completion.

## Essential Commands

**[Backend]Always use `uv` for dependency and Python execution:**

```bash
uv sync                    # Install dependencies from pyproject.toml
uv run python file.py      # Run Python files via uv (preferred over `python file.py`)
uv add package_name        # Add dependencies
uv add package_name==version  # Add specific version (>=, <=, etc. supported)
uv remove package_name     # Remove dependencies
```

Note: when in repo root, use `cd` to go to backend package directory or use flag `uv --directory packages/backend/ ...`

## Framework Documentation

When working with frameworks used here (FastAPI,Pydantic), use the Context7 MCP tool to fetch up-to-date docs:

```
Use mcp_upstash_conte_get-library-docs with library IDs like:
- /uv/uv (Python package manager)
- /tiangolo/fastapi (async web framework)
- /pydantic/pydantic (data validation)
```

Reference: packages/backend/src/main.py, api/{images,libraries,tags}.py, services/{scanner,storage_minio}.py; packages/frontend/src/{pages,components,lib}. Also see .github/prompts/tech_guide.md for context, and CHANGELOG.md for recent changes, and .github/prompt/user_requirements.md for user needs.
