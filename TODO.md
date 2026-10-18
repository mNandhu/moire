# TODO

What's next for Moiré. Priorities: **P0** now, **P1** next, **P2** later.
Last rewritten 2026-10-19. Done work lives in git history, not here.

## P0: Now

- Nothing open. Next up is the top of P1.

## P1: Next

- UI fixes
  - "Set as tag thumbnail" sits in an odd place in ImageView; move it
  - Overscroll bounce (rubber-banding) at the top of a page drags the sticky
    header down with the content; the header should stay put
    (`overscroll-behavior` on the main scroll container, or bounce only the
    content below the header)
- Tags page rework
  - Rethink the page as a whole (browsing, counts, thumbnails, sources)
  - Boilerplate tags: a configurable list in Settings (`masterpiece`,
    `best quality`, `absurdres`...) that is hidden or sorted last in tag
    lists, suggestions and the Tags page

- Direct ComfyUI integration
  - Select an image and re-run it on ComfyUI with the same workflow (must be
    mapped), straight from Moiré
  - ComfyUI URL in Settings (local or remote/VPS), queue via its `/prompt`
    API, progress over its websocket; outputs land back through the watched
    library
  - Tweak before sending: seed (re-roll), prompt edits, batch size; remember
    which image a generation came from
- New user / setup onboarding
  - First run: add libraries, wait for the first scan, import workflow files
    and name workflows, optionally start AI tagging
  - Overview empty states double as the checklist ("2 of 4 done")
- Gallery
  - Day headers in the grid, then generation sessions (runs of images with no
    long gap)
  - Score filter, so "Unrated" and "4+ stars" become real views
  - Saved views: name any filter + sort and pin it to the sidebar
- Triage
  - Compare view for a batch: variations side by side, keep some, quarantine
    the rest in one go
  - Batch manual tags: add/remove a tag on a selection (today the selection
    only offers AI tagging and quarantine)

## P2: Later

- Prompts and workflows
  - Prompt diff between two images or two workflow versions
  - Per-workflow stats: images, average score, last used
- Library hygiene
  - Near-duplicate detection (perceptual hash) to collapse re-saves and copies
  - Tag rename / merge
  - Cancel a running scan
- Curation and output
  - Collections / albums for hand-picked sets, independent of tags
  - Export a selection (copy files or zip), optionally stripping metadata
- Ops
  - Backup / restore of `data/moire.db` and thumbnails
  - Docker Compose for API + frontend behind nginx (`deploy/nginx.conf.example`)

## Known issues

- Intermittent test flakes: one backend test (didn't reproduce in ~24 runs)
  and the LibrariesPage test under heavy load
- 11 longstanding ESLint warnings (mostly `no-explicit-any`)
- Feed order uses file mtime as generation time; copying or moving files can
  reset it
