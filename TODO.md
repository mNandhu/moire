# TODO

A living checklist of work items for Moiré. Priorities: P0 (now), P1 (next), P2 (later).

## Status snapshot

- Core: Monorepo scaffolded (frontend + backend) [Done]
- Backend: FastAPI app with CORS, /health, Mongo wired, scanning service, tags API (incl. AI placeholder), thumbnails served [Done]
- Frontend: Vite + React + TS + Tailwind scaffolded, basic health check view [Done]
- Dev UX: pnpm configured, concurrently one-command dev [Done]

## P0 — Short-term deliverables

- Libraries UI
  - Add library form (path, name) and list existing libraries [Done]
  - Trigger rescan, show indexed count and live progress bar [Done]
  - Edit and delete libraries (delete removes thumbnails) [Done]
- Gallery views
  - All Images grid (virtualized), show thumbnails from `/thumbs` [Grid + lazy-load: Done; Full virtualization: Pending]
  - Per-library image view [Done via filters + library dropdown and ImageView route]
- Image details & tags
  - Full-page image view with toggleable info panel [Done]
  - Add/remove tags on image [Done]
  - AI tagging button in image view [Done]
  - Batch selection and batch tag add/remove [Selection UX: Done; Batch apply: Pending endpoint/UI]
- Search & filters
  - Search bar with tag chips; AND/OR logic [AND/OR + search input: Done]
  - Library filter + URL-preserved filters [Done]
  - “No tags” filter [Pending]
- Scanner robustness
  - Handle inaccessible paths and corrupt images gracefully [Pending]
  - Option to skip very large images or unsupported formats [Pending]
  - Background async scanning with progress (non-blocking) [Done]
- Basic auth/config
  - Configuration page for AI_TAGGING_URL and MONGO settings (read-only if env-based) [Pending]

## P1 — Next improvements

- Async/background scanning
  - Move scanning to background jobs; add progress endpoints [Done]
  - UI progress bar [Done]
  - Cancel/resume control [Pending]
- AI tagging workflow
  - Preview suggested tags > accept/reject before apply [Frontend]
  - Batch AI tagging (selected images) [Frontend/Backend]
- Tag management
  - Tags browser (top tags with counts) and drill-down [Done: basic; Next: card visuals and multi-select]
  - Rename/merge tags (migration) [Backend]
- Thumbnail pipeline
  - On-demand thumb regeneration and size presets [Backend]
  - Blurhash or low-quality placeholder while loading [Frontend]
- Error handling & UX
  - Global toasts, retry flows, nicer error pages [Frontend]
  - Structured error responses [Backend]

## P2 — Later / nice-to-have

- Workflow data parsing (ComfyUI metadata extraction) [Backend]
- Drag & drop image import / link external folders [Frontend]
- User accounts and roles (local) [Full stack]
- Export/import database (backup/restore) [Backend]
- Dark/light themes + polished UI library adoption (shadcn) [Frontend]
- Packaging: Docker Compose for Mongo + API + Frontend [Infra]

## Technical debt & chores

- Tests
  - Backend: unit tests for scanner, tags, images, routers
  - Frontend: component tests for gallery, tags, search
- Lint/format tooling
  - Backend: Ruff + mypy (optional)
  - Frontend: ESLint + Prettier
- CI
  - Lint + test on PRs; build previews
- Docs
  - API reference (OpenAPI is available via FastAPI docs)

## Acceptance notes / definitions of done

- Scanning: can index a directory with 10k images without crashing; metadata visible and searchable; thumbnails generated and served.
- Tagging: can add/remove tags individually and in batch; AI suggestions can be previewed and applied.
- Gallery: smooth scroll with virtualization; search returns results < 200ms on indexed set (local).

Testing note

- Filters: Defer full verification of tag-based filters until a UI to add tags exists; add sample tags via API or UI before testing combinations (AND/OR, library filter, and no-tags).

## Open questions / decisions pending

- Where to store user preferences (localStorage vs DB)?
- Pagination strategy for images (offset vs cursor) and server response shape.

## Suggestions / next steps

- Libraries
  - Inline modal for editing name/path with validation; suggest rescan on path change; show indexed_count and last_scanned on cards. [Done]
  - Add cancel/resume scan controls; show error state if scan fails. [Pending]
- Gallery
  - Move to react-window for virtualized masonry; preload next page while scrolling; skeleton placeholders.
  - Add keyboard shortcuts for selection mode (S to toggle) and batch actions.
- Image View
  - Add zoom/pan (wheel/drag) with original/orient EXIF respect; previous/next preload for smooth nav.
  - Share/deep-link copy button preserving filters in URL.
- Routing & State
  - Persist filters and selection in URL and localStorage; restore on load.
- Batch actions
  - Implement backend batch tag add/remove endpoint; UI multi-select flow with confirmation and toasts.

## Performance improvements

- Frontend
  - Switch GalleryGrid to react-window virtualized masonry; window up to ~2 screens above/below viewport.
  - Debounce filter changes and coalesce requests; cancel in-flight fetches when filters update. [Partially applied; revisit after virtualization]
  - Use Suspense-friendly data layer with SWR/React Query for caching and background refresh.
  - Lazy-load non-critical routes (Tags, Settings) via code-splitting; prefetch on hover.
  - Use content-visibility: auto on offscreen sections; apply will-change cautiously.
  - Prefer CSS contain and transform-only animations to keep paint costs low.
- Backend
  - Add indexes on images: tags (multikey), library_id, and compound (library_id, tags) if needed.
  - Paginate with stable sort (e.g., \_id) and consider cursor-based pagination for large collections.
  - Stream original files efficiently; apply conditional GET with ETag/Last-Modified.
  - Cache tag aggregations; maintain precomputed counts per library for faster Tags page.

## Recent changes snapshot

- ImageView polished (overlay controls, slide-in info panel, distinct surface, image fade-in; back returns to gallery; hides indexed count while scanning).
- Libraries page shows indexed_count and last_scanned; progress bar with polling; edit modal with optional rescan.
- Backend scanning moved to background threads with per-library progress fields and progress endpoint.
