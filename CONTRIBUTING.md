# Contributing to Moiré

Moiré is a pnpm monorepo: a FastAPI backend (`packages/backend`, Python package `moire`) and a Vite + React + TypeScript frontend (`packages/frontend`). There are no external services: metadata is in an embedded SQLite file, thumbnails and originals are on the local filesystem.

[CONTEXT.md](CONTEXT.md) is the glossary (Library, Image, the three tag kinds, Scan, AI Job, Generator and so on). Read it before changing anything that touches tags or images.

## Setup

You need Node.js 18+ with [pnpm](https://pnpm.io/installation), and [uv](https://docs.astral.sh/uv/getting-started/installation/) (it brings Python 3.11+).

```bash
git clone https://github.com/mNandhu/moire.git
cd moire
pnpm install
uv --directory packages/backend sync
pnpm dev          # backend on :8000 (reload) + Vite on :5173
```

Open http://localhost:5173. Vite proxies `/api/*` to the backend. A checkout keeps its data in `<repo>/data` (database, thumbnails, logs) and tagger models in `<repo>/.cache/moire/models`. To change settings, copy `packages/backend/.env.example` to `packages/backend/.env`.

Always run Python through uv (`uv --directory packages/backend run ...`), never a bare `python`.

### One port, like an install

```bash
pnpm build                                              # writes the UI into packages/backend/src/moire/web
uv --directory packages/backend run moire run --open    # http://localhost:8000
```

A stale build there doesn't affect `pnpm dev`. To try the wheel before a release: `uv --directory packages/backend build`, then `uv tool install "moire-studio[cpu] @ file:///path/to/moire_studio-X.Y.Z-py3-none-any.whl"`.

### GPU tagging in a checkout

The `gpu` dependency group swaps `onnxruntime` for `onnxruntime-gpu` and pulls CUDA 12 and cuDNN 9 from pip (about 2 GB). No system CUDA toolkit is needed. Linux and Windows only.

```bash
export UV_NO_GROUP=cpu      # keep it set, or the next `uv run` reinstalls the CPU build
uv --directory packages/backend sync --group gpu
```

Put the `export` in your shell profile (PowerShell: `$env:UV_NO_GROUP = "cpu"`). If the CPU build slipped back in, the backend log warns that both are installed; repair with `UV_NO_GROUP=cpu uv --directory packages/backend sync --group gpu --reinstall-package onnxruntime-gpu`. The log line `Tagger session providers: [...]` shows which device the tagger got.

## Tests and checks

```bash
uv --directory packages/backend run pytest                     # backend, incl. router integration tests
uv --directory packages/backend run pytest tests/test_scanner.py::test_name
uv --directory packages/backend run ruff check
uv --directory packages/backend run ruff format --check
pnpm -C packages/frontend test                                 # vitest
pnpm -C packages/frontend build                                # tsc -b + vite build
pnpm perf                                                      # backend perf benchmark
pnpm version:check                                             # one version across all manifests
./scripts/test-docker.sh                                       # Docker smoke test over ./test_images
```

A husky pre-commit hook runs ruff and eslint on staged files. Generate-related tests use a fake ComfyUI (`packages/backend/tests/fake_comfy.py`); never point tests at a real server.

`test_images/` holds a few small PNGs made with Moiré's Generate page, with their ComfyUI prompt metadata, in one subfolder per character. CI indexes them and checks thumbnails and originals are served.

## Layout

```
packages/
  backend/
    src/moire/
      api/          routers, all under /api/v1 (libraries, images, tags, ai, rules, generate)
      services/     the logic: scanner, image_tags (the only tag writer), ai_jobs, ai_tagger,
                    gen_metadata, characters, outfits, generation_*, comfy_*
      database/     schema.py (the whole SQLite schema) and db.py (engines, transactions)
      core/         settings
      cli.py        the `moire` command
    tests/
  frontend/
    src/
      pages/        one component per route
      components/
      hooks/        useImageFeed (the shared gallery query) and friends
      lib/          pure logic with colocated *.test.ts
docs/               guides and design notes
test_images/        CI fixtures
```

## How it works

- **Storage.** SQLite (`SQLITE_PATH`, default `data/moire.db`) holds images, tags, libraries, characters, generations. The schema is created on startup; there are no schema migrations, only one-off data migrations (`services/tag_migrations.py`). Thumbnails are WebP files under `THUMB_ROOT`. Originals are read from the library folders and never modified.
- **Media.** Thumbnails and originals are streamed from the filesystem through the API (`/api/v1/images/{id}/thumb`, `/file`, both with HEAD; originals support Range). Thumbnail URLs carry a `?v=` version and are served `immutable`. One port is enough for remote access; put nginx in front for TLS (`deploy/nginx.conf.example`).
- **Tags.** One ordered `tags` array per image holds AI tags (unprefixed), manual tags (`manual:`) and prompt tags (`prompt:`). Names are stored Danbooru-style with underscores. `services/image_tags.py` is the only writer.
- **Feed.** Keyset paging on `(sort keys..., _id)`; the server returns the next cursor in `X-Next-Cursor`.

### Generation metadata and rules

During a scan Moiré stores each image's raw generation data (ComfyUI `prompt` graph, A1111 `parameters`) verbatim and derives `gen.*` fields (prompt, negative, seed, model, sampler, steps, CFG, weights) and prompt tags from it, so fields can be re-derived without reading the disk again.

Each ComfyUI image gets a `workflow_sig`: a hash of its node kinds, ignoring ids and values. Standard graphs are parsed by walking the sampler's links. For graphs that break that, a **rule** per signature pins dot-paths into the raw graph (`prompt.32.inputs.text0` for the prompt, say). The order is pinned, then structural, then by class, so a pin only fills or corrects. Saving a rule reprojects every image with that signature.

## Configuration

Settings come from environment variables or `.env` (see `packages/backend/.env.example`):

- `SQLITE_PATH`, `THUMB_ROOT`, `MODEL_CACHE_DIR`, `LOG_DIR`: where data goes (relative paths resolve against `MOIRE_HOME`)
- `THUMB_MAX_SIZE` (768), `SCANNER_MAX_WORKERS` (0 = CPU count), `SCANNER_MAX_CONCURRENT_SCANS` (2)
- `LOG_LEVEL` (`INFO`), `LOG_TO_FILE` (`true`)
- `WATCH_ENABLED_DEFAULT`, `WATCH_RECONCILE_INTERVAL_S`: folder watching and the periodic rescan

## Pull requests

- Keep changes focused, with tests for new behaviour. Pure frontend logic goes in `lib/` with a test.
- No native browser menus (`<select>`, `<datalist>`): use `components/ui/Picker.tsx` or `DropdownMenu`.
- UI copy: short, no helper captions under controls, no em dashes.
- When reporting a bug, include steps to reproduce, what you expected, your OS and how you run Moiré, and the log (`moire paths` shows where it is, or `docker compose logs`).
