# Moiré Frontend (Vite + React + TS)

Install pnpm first: https://pnpm.io/installation

Then install and run:

- pnpm install
- pnpm dev

The dev server proxies /api to the backend at http://127.0.0.1:8000 unchanged (all backend routes are under /api/v1).

## Features

- Media is streamed by the backend from the local filesystem (`/api/v1/images/{id}/thumb` and `/file`).

- Cursor-based pagination

  - Gallery uses `_id` cursor for stable infinite scroll.
  - The current `cursor` is preserved in deep-links to the image view and back.

- Stable gallery layout
  - Thumbnails reserve space using known width/height to avoid reshuffling during loads.
