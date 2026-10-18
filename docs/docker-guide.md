# Docker Guide

Moiré runs as two containers: the FastAPI **backend** (embedded SQLite, thumbnails
on the local filesystem, optional WD ONNX tagger) and the **frontend** (static
build served by nginx, which proxies `/api/*` to the backend). There is no
database or object-store container.

## Configurations

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Full stack: backend + frontend, persistent `moire_data` volume. |
| `docker-compose.override.yml` | Your local additions — mount image folders here (picked up automatically). |
| `docker-compose.ci.yml` | Backend only, with `./test_images` mounted read-only; used by CI and `scripts/test-docker.sh`. |

```bash
cp .env.example .env          # optional tuning
docker compose up --build -d  # or: scripts/docker-setup.sh
```

- Frontend: http://localhost:5173
- API: http://localhost:8000/api/v1 (OpenAPI docs at http://localhost:8000/docs)
- Health: http://localhost:8000/health

## Mounting your image folders

The backend can only index folders it can see. Bind-mount them in
`docker-compose.override.yml` (read-only is fine — Moiré never writes to
library folders, except the explicit "purge" action):

```yaml
services:
  backend:
    volumes:
      - /absolute/path/to/images:/mnt/images:ro
      # Windows (Docker Desktop):
      # - type: bind
      #   source: G:\
      #   target: /mnt/g
      #   read_only: true
```

Then add libraries in the UI using the **in-container** path (`/mnt/images/...`).
The Add Library dialog accepts several folders and can split a parent folder into
one library per subfolder.

## Data and persistence

Everything the backend writes lives in the `moire_data` volume at `/data`:

| Path | Contents | Setting |
| --- | --- | --- |
| `/data/moire.db` | SQLite metadata (WAL mode) | `SQLITE_PATH` |
| `/data/thumbs/` | Generated WebP thumbnails | `THUMB_ROOT` |
| `/data/models/` | Downloaded tagger models | `MODEL_CACHE_DIR` |

Back up by stopping the backend and copying the volume. Removing it
(`docker compose down -v`) resets Moiré; your images are untouched.

## Logs

The backend logs to stdout in the container (`LOG_TO_FILE=false`), so use
`docker compose logs -f backend`. Outside Docker it also writes a rotating
`data/logs/moire.log`.

## Configuration

Set in `.env` (see `.env.example`):

- `THUMB_MAX_SIZE` — longest edge of thumbnails (px)
- `SCANNER_MAX_WORKERS` — threads per scan (0 = auto)
- `SCANNER_MAX_CONCURRENT_SCANS` — libraries scanning at once (others queue)
- `WATCH_ENABLED_DEFAULT`, `WATCH_RECONCILE_INTERVAL_S` — live watching of new
  files. Bind mounts from a Windows/macOS host don't deliver change events to
  Linux, so there the periodic reconcile rescan is what picks up new images.
- `LOG_LEVEL`

## Reverse proxy / TLS

To serve Moiré behind your own nginx (TLS, static offload), see
`deploy/nginx.conf.example`. All API routes are under `/api/v1`, so no path
rewriting is needed.

## Troubleshooting

- **Library shows 0 images** — the path isn't mounted, or you used the host path
  instead of the in-container one. `docker compose exec backend ls /mnt/...`.
- **Backend unhealthy** — `docker compose logs backend`.
- **Permission denied on /data** — the backend runs as uid 999; a bind mount for
  `/data` (instead of the named volume) must be writable by that uid.
