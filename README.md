# Moiré

**AI-generated image management made simple.**

Moiré is purpose-built for organizing and exploring large collections of AI-generated images from ComfyUI and other AI art tools. Use powerful tag-based organization with optional AI autotagging to keep your diffusion models and generated artwork easily discoverable.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/python-3.12-blue)
![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)

> [!NOTE]
> This is a work in progress and not all features are implemented yet.
> See the [ROADMAP](ROADMAP.md) for planned features.
> I'm pretty much working on this in my spare time, so don't expect rapid progress.

## ✨ Features

- **🎨 AI Art Focused**: Optimized for AI-generated image workflows; extracts generation metadata (prompts, model, workflow) from ComfyUI/A1111 PNGs
- **🤖 Built-in Autotagger**: Local WD ONNX tagger (`SmilingWolf/wd-vit-tagger-v3` by default) with a queued, cancellable batch job system; no external service required
- **🏷️ Smart Tagging**: Manual tags, AI tags, and prompt tags (derived from generation prompts)
- **⭐ Rate & Curate**: 0–5 star quality scores, danbooru-style content ratings, and quarantine to hide images from the feed without deleting them
- **📁 Library Management**: Organize images into libraries with automatic background scanning and progress tracking
- **🔍 Powerful Search**: Filter by tags, libraries, untagged, or no-AI-tags with AND/OR logic
- **⚡ Fast Performance**: Cursor-based pagination, virtualized masonry grid, and pre-signed URL delivery
- **🖼️ Gallery Views**: Responsive masonry grid with full-screen image viewer
- **🐳 Docker Ready**: Complete Docker Compose setup for easy deployment

## 📸 Screenshots

### All Images Gallery

![Gallery View](docs/images/AllImagesPage.jpeg)

### Libraries Management

![Libraries Page](docs/images/LibrariesPage.jpeg)

### Image Detail View

![Image Detail](docs/images/ImageDetailView.jpeg)

## 🚀 Quick Start

### Docker Compose (Recommended)

The fastest way to get Moiré running:

```bash
# Clone the repository
git clone https://github.com/mNandhu/moire.git
cd moire

# Copy environment configuration
cp .env.example .env

# Start all services
docker compose up --build
```

> [!WARNING]
>
> The backend can only index folders mounted into it. Add your image directories in `docker-compose.override.yml`, then add libraries in the UI by their in-container path:
>
> ```yaml
> services:
>   backend:
>     volumes:
>       - /absolute/path/to/your/images:/mnt/images:ro
> ```
>
> See [docs/docker-guide.md](docs/docker-guide.md) for data volumes, logs and configuration.

**Access Points:**

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:8000/api/v1
- **Health Check**: http://localhost:8000/health

### Native Development (Recommended for Development)

Moiré has no external services (embedded SQLite, filesystem thumbnails), so for
fast iteration just run both apps locally with hot reload:

```bash
pnpm install
uv --directory packages/backend sync
pnpm dev
```

## 📦 Installation & Setup

### Prerequisites

- **Node.js** 18+ and **pnpm** ([installation guide](https://pnpm.io/installation))
- **Python** 3.12+ and **uv** ([installation guide](https://docs.astral.sh/uv/getting-started/installation/))

### Local Development Setup

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/mNandhu/moire.git
   cd moire
   pnpm install
   ```

2. **Install backend dependencies:**

   ```bash
   uv --directory packages/backend sync
   ```

3. **Configure (optional):** defaults work out of the box. The database lands in `data/moire.db`, thumbnails in `data/thumbs/`, logs in `data/logs/`. To override, copy `packages/backend/.env.example` to `packages/backend/.env` and edit.

4. **Start the application:**
   ```bash
   pnpm dev
   ```

### Running without the dev server

`pnpm build` writes the UI into `packages/backend/src/moire/web`, and the backend then serves it itself. Moiré runs as one process on one port:

```bash
pnpm build
uv --directory packages/backend run moire run --open   # http://localhost:8000
```

### Installing as an app

The wheel is the whole app (backend with the built UI inside). Once a release is published to PyPI, install it with [uv](https://docs.astral.sh/uv/) and run it:

```bash
uv tool install "moire-studio[cpu]"   # or [gpu] for AI tagging on an NVIDIA GPU
moire run --open                       # http://localhost:8000
moire paths                            # where the database, thumbnails and models live
```

An installed Moiré keeps its data in the OS app-data folder (`%LOCALAPPDATA%\Moire`, `~/Library/Application Support/Moire`, or `~/.local/share/moire`), and reads a `.env` there. Set `MOIRE_HOME` to put it elsewhere. A source checkout keeps using `<repo>/data`. `moire run --host 0.0.0.0` serves your LAN. Before the first PyPI release, install a wheel you built (`pnpm build`, then `uv --directory packages/backend build`) with `uv tool install "moire-studio[cpu] @ file:///path/to/moire_studio-X.Y.Z-py3-none-any.whl"`.

`pnpm dev` is unaffected: Vite still serves the UI on :5173 with hot reload. A stale build in `src/moire/web` is harmless in dev; delete it or rebuild after frontend changes if you use the single-port mode.

### Adding Your First Library

1. Navigate to http://localhost:5173/libraries and click **Add libraries**
2. Enter one or more folder paths (e.g., `/path/to/your/images`), one per line. Optionally tick "each subfolder becomes its own library"
3. Click **Preview** to see exactly which libraries will be created, with image counts; untick any you don't want
4. Click **Add**; scanning runs in the background
5. Browse your images at http://localhost:5173

## 🏗 Architecture

- **Backend**: FastAPI app with embedded SQLite for metadata; thumbnails and originals both live on the local filesystem
- **Frontend**: Vite + React + TypeScript with TailwindCSS
- **Storage**:
  - SQLite (`SQLITE_PATH`, default `data/moire.db`): image metadata, tags, library information
  - Original images: served directly from the host filesystem (the library paths you mount)
  - Thumbnails: generated WebP files under `THUMB_ROOT`, served through the API (`/api/v1/images/{id}/thumb`)

## 🤖 AI Autotagger

Moiré ships with a **built-in** autotagger, a WD ONNX model that runs locally via `onnxruntime`. No external service is required. The default model is `SmilingWolf/wd-vit-tagger-v3`, downloaded from HuggingFace on first use and cached locally.

**How it works:**

1. Configure the model and thresholds on the Settings page (or via `POST /api/v1/ai/settings`).
2. Load the model (`POST /api/v1/ai/model/load`). Download and load are tracked, cancellable, and the model idle-unloads to free memory.
3. Tag a single image, or queue a batch (e.g. all untagged images) via the AI job system (`POST /api/v1/ai/tag`, `POST /api/v1/ai/tag-untagged`). Jobs are listed, polled, and cancellable (`GET /api/v1/ai/jobs`, `POST /api/v1/ai/jobs/{id}/cancel`).
4. AI tags are stored alongside manual and prompt tags and become searchable.

**Tag kinds** (all share one `tags` array, see [CONTEXT.md](CONTEXT.md)):

- **AI tags**: produced by the tagger, stored unprefixed (`1girl`).
- **Manual tags**: user-applied, `manual:` prefix.
- **Prompt tags**: extracted from generation prompts by reprojection, `prompt:` prefix.

Tuning knobs (model repo, general/character thresholds, idle-unload timeout, prompt-tag reprojection) live in AI Settings.

### GPU tagging (optional, NVIDIA)

Tagging runs on the CPU by default (~0.9 s an image). With an NVIDIA GPU it is about 9x faster (~0.1 s an image, measured on a GTX 1650). The GPU build is an optional uv dependency group, `gpu`, which swaps `onnxruntime` for `onnxruntime-gpu` and pulls the CUDA 12 and cuDNN 9 runtime libraries from pip (about 2 GB). No system CUDA toolkit is needed, and a different system CUDA version (13, say) doesn't get in the way. Linux and Windows only.

```bash
# Tell uv to leave the CPU build out; keep this set in the shell you run Moiré
# from, or a later `uv run` / `pnpm dev` reinstalls the CPU build.
export UV_NO_GROUP=cpu
uv --directory packages/backend sync --group gpu
```

Put the `export` in your shell profile (`~/.zshrc`, `~/.bashrc`) so every shell has it, including the ones git hooks and editors start. On Windows PowerShell, use `$env:UV_NO_GROUP = "cpu"` (or set it as a user environment variable).

If a `uv run` without it slips through, it installs the CPU build over the GPU one, both being the same `onnxruntime` package on disk. The backend log then warns that both are installed. Repair with `UV_NO_GROUP=cpu uv --directory packages/backend sync --group gpu --reinstall-package onnxruntime-gpu`. The NVIDIA driver must be installed; under WSL2 that's the Windows driver.

When the model loads, the backend log says which device it got: `Tagger session providers: ['CUDAExecutionProvider', 'CPUExecutionProvider']`. If it shows only `CPUExecutionProvider`, the GPU wasn't usable and tagging carries on, on the CPU. To go back to the CPU build, unset `UV_NO_GROUP` and run `uv --directory packages/backend sync`. A warning about `/sys/class/drm/card0/device/vendor` under WSL2 is harmless. The legacy `AI_TAGGING_URL` env var refers to an older external-service path and is not the primary tagging route.

## 🧬 Generation Metadata & Extraction Rules

Moiré reads the generation data embedded in AI-art images (ComfyUI `prompt` node graphs, Automatic1111 `parameters` text) during scanning and stores it **verbatim**. From that stored raw it derives structured `gen.*` fields (positive/negative prompt, seed, model, sampler, steps, CFG) plus searchable prompt tags. Because derivation works off the stored raw, fields can be re-derived any time without touching disk again.

**Workflow signatures.** Each ComfyUI image is fingerprinted by a `workflow_sig`, a hash of its node *kinds* (sorted `class_type` multiset), ignoring node ids and widget values. Images from the same workflow share a signature, so they can be grouped and mapped together.

**Why rules exist.** Standard graphs are parsed structurally (walk the sampler's `positive`/`negative` links back to text nodes, the `model` link to the checkpoint loader). Custom and non-standard workflows (exotic samplers, custom text nodes, pass-through wrappers) break those heuristics, leaving prompt/model/seed empty even though the data is present in the raw.

**Extraction rules (rulesets)** fix that. Per `workflow_sig`, you pin **dot-paths** into the raw doc for specific fields (e.g. `prompt.32.inputs.text0` → `prompt`). A resolving pin overrides the structural baseline; the fallback chain is *pinned → structural → class*, so a pin only ever fills or corrects, never erases a working parse.

Author rules on the **Rules page**: pick a signature (the picker surfaces which still need mapping and a sample image), pin paths, and preview resolution live against that sample before saving (`POST /rules/preview`). Rulesets are **sig-global**: saving one **reprojects every image of that signature across all libraries** from their stored raw (`PUT /rules/{sig}` → background reproject), so one mapping retroactively fixes the whole batch. You can also reproject a single library on demand (`POST /libraries/{id}/reproject`).

## ⚙️ Environment Configuration

Key environment variables (see `.env.example`):

### Storage

- `SQLITE_PATH`: SQLite database file (default: `./data/moire.db`; `/data/moire.db` volume in Docker)
- `THUMB_ROOT`: Filesystem directory for generated WebP thumbnails (default: `./data/thumbs`; `/data/thumbs` volume in Docker). Originals are read from the host library paths, so there is no separate originals store.

Both thumbnails and originals are served straight through the API, so a single exposed port (8000) is enough for remote access; front it with a reverse proxy (e.g. nginx) for TLS and static offload.

### Performance

- `THUMB_MAX_SIZE`: Maximum thumbnail size in pixels (default: 768)
- `SCANNER_MAX_WORKERS`: Scanner thread count (0 = auto-detect CPU cores)
- `SCANNER_MAX_CONCURRENT_SCANS`: Libraries scanning at once; the rest queue (default: 2)

### Logging

- `LOG_LEVEL` (default `INFO`), `LOG_TO_FILE` (default `true`), `LOG_DIR` (default `./data/logs`): console logging plus a rotating `moire.log`

## 📁 Project Structure

```
moire/
├── packages/
│   ├── backend/          # FastAPI application
│   │   ├── src/
│   │   │   ├── api/      # REST API endpoints
│   │   │   ├── services/ # Business logic (scanner, storage)
│   │   │   └── database/ # SQLite schema and engines
│   │   └── .env          # Backend environment variables
│   └── frontend/         # React application
│       ├── src/
│       │   ├── components/ # React components
│       │   ├── pages/      # Page components
│       │   └── lib/        # Utilities and API client
│       └── vite.config.ts  # Vite configuration with /api proxy
├── test_images/          # Sample images for testing
├── docs/                 # Documentation
├── scripts/              # Utility scripts
├── docker-compose.yml    # Docker setup (backend + frontend)
├── docker-compose.ci.yml # CI stack (backend + test_images)
└── README.md            # This file
```

## 🔌 API Overview

See [.github/prompts/tech_guide.md](.github/prompts/tech_guide.md) for detailed architecture documentation.

**Key Endpoints** (all under `/api/v1`, e.g. `GET /api/v1/images`; `GET /health` is also served at the root for container probes):

- `GET /health` - Health check
- `POST /libraries/discover` - Dry run for adding libraries (optionally one per subfolder): candidates, image counts, conflicts
- `GET /images` - List images with filtering and pagination
- `GET /images/{id}/file` - Original image from host filesystem (supports Range requests)
- `GET /images/{id}/thumb` - WebP thumbnail
- `POST /images/{id}/rating` - Set content rating (`general`/`sensitive`/`questionable`/`explicit`/`-`)
- `POST /images/{id}/score` - Set 0–5 star quality score (distinct from content rating)
- `POST /images/{id}/quarantine` - Toggle quarantine flag (DB-only; hides from feed, file untouched)
- `POST /images/{id}/purge` - Permanently delete original from disk + records (`confirm=true` required)
- `GET /tags` - Available tags with counts (30s TTL cache)
- `POST /tags/apply/{id}` / `POST /tags/remove/{id}` - Mutate tags on an image
- `POST /libraries` - Create/scan a library; `POST /libraries/{id}/rescan`, `POST /libraries/{id}/reproject`
- `GET /ai/status`, `POST /ai/model/load`, `POST /ai/tag`, `GET /ai/jobs` - Built-in autotagger + job queue
- `GET /rules`, `GET /rules/signatures`, `PUT /rules/{sig}` - Generation-metadata extraction rules, keyed by workflow signature

**Image Filtering:**

- `tags[]=tag1&tags[]=tag2` - Filter by tags
- `logic=and|or` - Tag filter logic
- `library_id=...` - Filter by library
- `no_tags=1` - Show only untagged images
- `no_ai_tags=1` - Show only images without AI tags
- `pterms[]=term&plogic=and|or` - Filter by prompt tags (generation-prompt terms)
- `quarantined=1` - Show quarantined images (hidden from the default feed)
- `cursor=...` - Cursor-based pagination for stable results

## 📚 Documentation & Links

- **[CHANGELOG.md](CHANGELOG.md)** - Version history and release notes
- **[ROADMAP.md](ROADMAP.md)** - Future features and development plan
- **[TODO.md](TODO.md)** - Current development tasks and priorities
- **[Backend README](packages/backend/README.md)** - Backend-specific documentation
- **[Frontend README](packages/frontend/README.md)** - Frontend-specific documentation
- **[Docker Guide](docs/docker-guide.md)** - Detailed Docker configuration guide
- **[Tech Guide](.github/prompts/tech_guide.md)** - Architecture and technical details

## 🐳 Data Persistence

In Docker, everything the backend writes lives in the `moire_data` volume at `/data`: the SQLite database (`moire.db`), thumbnails (`thumbs/`) and downloaded tagger models (`models/`). Natively, the same files live under `<repo>/data/` (models under `<repo>/.cache/moire/models`).

To back up your data:

```bash
# Stop the backend so the SQLite file is consistent, then copy /data out
docker compose stop backend
docker compose cp backend:/data ./backup
docker compose start backend
```

> Original images live in the host directories you mounted as libraries. Back those up with your normal file-backup tooling. Thumbnails can always be regenerated by rescanning, so only the database and your source images are essential.

## 🔧 Development

### Running Tests

```bash
# Backend tests (when available)
cd packages/backend
uv run pytest

# Frontend tests (when available)
cd packages/frontend
pnpm test
```

### Code Style

- **Backend**: Code formatted with `ruff` (when configured)
- **Frontend**: Code formatted with `prettier` + `eslint` (when configured)

### Performance Testing

```bash
# Run performance benchmark
pnpm perf
```

## 🐛 Troubleshooting

### Common Issues

**Docker build fails with SSL errors:**

Run natively instead (no external services needed):

```bash
pnpm install && uv --directory packages/backend sync && pnpm dev
```

**Services not starting:**

```bash
# Check logs
docker compose logs -f

# Restart services
docker compose restart
```

**Port conflicts:**

- Backend: 8000
- Frontend: 5173

Change ports in `docker-compose.yml` if needed.

**Health check failures:**

- Wait longer for the backend to start (first start creates the database)
- Check container logs: `docker compose logs [service-name]`

### Testing Setup

Validate your installation:

```bash
./scripts/test-docker.sh
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### Development Setup

1. **Fork and clone:**

   ```bash
   git clone https://github.com/your-username/moire.git
   cd moire
   ```

2. **Set up development environment:**

   ```bash
   # Install dependencies
   pnpm install

   uv --directory packages/backend sync

   # Start development servers
   pnpm dev
   ```

3. **Make your changes and test:**

   ```bash
   # Test your changes work end-to-end
   # Add a library, scan images, verify functionality
   ```

4. **Submit a pull request:**
   - Create a feature branch
   - Make focused, minimal changes
   - Include tests if adding new features
   - Update documentation as needed

### Code Guidelines

- **Backend**: Follow FastAPI patterns, use type hints, keep endpoints focused
- **Frontend**: Use TypeScript, follow React best practices, maintain component isolation
- **Commits**: Use conventional commit format when possible
- **Testing**: Ensure your changes don't break existing functionality

### Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Docker version, etc.)
- Relevant logs from `docker compose logs`

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **FastAPI** - Modern, fast web framework for Python
- **React** + **Vite** - Frontend framework and build tool
- **SQLite** + **SQLAlchemy** - Embedded metadata store
- **TailwindCSS** - Utility-first CSS framework

---

**Made for AI artists and diffusion model enthusiasts** 🎨✨
