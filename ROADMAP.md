# Roadmap

A forward-looking plan for Moiré milestones. Dates are tentative and based on weekend/evening availability.

## Vision

An image-centric personal gallery for AI art creators to browse, organize, and search large collections using tags and metadata, with a polished, immersive UI.

## Milestones

### 0.2.0 — Usable alpha (Core flows)

- Libraries UI: add/list/remove libraries; trigger rescan; show index counts
- Gallery: All Images and per-library grid with thumbnails
- Image details: view metadata and tags; add/remove tags
- Search: tag-based with AND/OR; “No tags” filter
- Basic error handling and toasts; loading states
- Docs: Quickstart (Mongo install, add first library)

Success criteria

- Index and browse a real library (1k–5k images) without crashes
- Tagging and search are usable end-to-end

### 0.3.0 — Productivity (Batch & AI)

- Batch selection: add/remove tags to multiple images
- AI tagging preview & confirmation (single + batch)
- Tags browser with counts; click-to-filter
- Scanner moved to background tasks with progress endpoints

Success criteria

- Batch tag workflows save time on a 1k-image set
- AI tagging integrated and reviewable pre-commit

### 0.4.0 — Performance & polish

- Virtualized grids; fast scroll
- Thumbnail presets and regeneration; blurhash placeholders
- Robust error states (empty/no tags/no results)
- Settings page (API base, AI endpoint)

Success criteria

- Gallery scrolls smoothly with 20k+ thumbnails
- Typical interactions feel instant (<100ms UI; <300ms API)

### 0.5.0 — Metadata & search depth

- (Optional) Parse ComfyUI/EXIF metadata and index
- Advanced filters (dimensions, date ranges, file size)
- Saved searches / smart collections

### 0.6.0 — Collaboration & backups

- Export/import DB snapshot
- Optional user accounts (local auth)
- Docker Compose for one-command setup

### 1.0.0 — Stable release

- Full docs and onboarding
- Tests coverage for critical paths
- CI/CD automation; versioned releases

## Risks & mitigations

- Large library performance
  - Mitigate with background scanning, pagination, indexes on tags, and virtualized UI.
- AI endpoint variability
  - Validate response shapes; provide mapping/adapter layer.
- Cross-platform file access
  - Normalize paths; gracefully handle inaccessible files.

## Tech choices & rationale

- Backend: FastAPI + MongoDB for flexible metadata
- Frontend: React + Tailwind for rapid bespoke UI
- Monorepo: pnpm workspaces for simple dev ergonomics

## Tracking & metrics

- Indexing time and throughput (images/sec)
- Thumbnail generation cache hit ratio
- Search latency under different tag counts
- Error rates (scanner, AI calls)
