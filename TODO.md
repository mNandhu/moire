# TODO

What's next for Moiré. Priorities: **P0** now, **P1** next, **P2** later.
Last rewritten 2026-10-19. Done work lives in git history, not here.

## P0: Now

- Nothing open. Next up is the top of P1.

## P1: Next

Order matters: ComfyUI first (primary audience), then onboarding, which reuses
ComfyUI's workflow mapping so it only gets built once.

- Direct ComfyUI integration
  - Select an image and re-run it on ComfyUI with the same workflow, straight
    from Moiré
  - Workflow mapping: which node ids hold seed, positive/negative prompt and
    batch size. One mapping UI, reused later by onboarding's workflow import
  - ComfyUI URL in Settings (local or remote/VPS). The backend proxies
    `/prompt` and the progress websocket (no browser CORS, works through the
    single exposed port); outputs land back through the watched library
  - Tweak before sending: seed (re-roll), prompt edits, batch size; remember
    which image a generation came from
  - Record the real generation time when Moiré queues a job (see Known
    issues: mtime). This is the only reliable source we get
- Auto AI tagging
  - When the watcher indexes a new file, queue it for AI tagging
  - Toggle in Settings > Tags > AI Tagging, next to the other tagger knobs
  - Queue only real inserts, not modifies (`ingest_single_file` already
    knows `existed`); skip when the model isn't downloaded
  - Batch watcher events into one AI job per debounce window, not one job
    per file
  - Decide whether full / reconcile scans also queue new rows (overlaps
    onboarding's "start AI tagging" step)
- New user / setup onboarding (after ComfyUI)
  - First run: add libraries, wait for the first scan, import workflow files
    and name workflows (reusing the ComfyUI mapping UI), optionally start AI
    tagging
  - Cancel a running scan, so adding the wrong folder isn't a long wait.
    Backend `scanner.cancel_scan` exists (used on library delete); needs an
    API route and a button on the scan progress
  - Overview empty states double as the checklist ("2 of 4 done")
- Tags page rework
  - Rethink the page as a whole (browsing, counts, thumbnails, sources)
  - Set a tag's thumbnail here, picking from that tag's images. Remove the
    hover button in ImageView `TagFlow` only once this works
  - Keep the "Show boilerplate" toggle (Settings > Boilerplate)
- Content-rating ceiling (app-wide mode)
  - Show only images up to a chosen rating (general < sensitive <
    questionable < explicit), e.g. "safe for screen-sharing"
  - Global, not a gallery filter: a leak anywhere defeats it. Must cover the
    feed, ImageView prev/next, batch peek, Tags page thumbnails and mosaics,
    Overview previews, compare view
  - Visible indicator in the header while it's on
- Gallery
  - Score filter, so "Unrated" and "4+ stars" become real views
  - Saved views: name any filter + sort and pin it to the sidebar (after the
    score filter; its first presets are "Unrated" and "4+ stars")
  - Day headers in the grid, then generation sessions (runs of images with no
    long gap). Depends on a trustworthy time (Known issues: mtime)
- Triage
  - Compare view for a batch: variations side by side, keep some, quarantine
    the rest in one go (mark "keep" with the selection's Edit tags)

## P2: Later

- Prompts and workflows
  - Prompt diff between two images or two workflow versions
  - Per-workflow stats: images, average score, last used
- Library hygiene
  - Near-duplicate detection (perceptual hash) to collapse re-saves and copies
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
- Feed order uses file mtime as generation time; copying (scp, browser
  download from a VPS, `cp` without `-p`) resets it. Checked 2026-10-19:
  ComfyUI's stock SaveImage embeds no timestamp (only `prompt`/`workflow`
  chunks, no `tIME`, no EXIF), so a lost time can't be recovered from the
  file. Fix going forward: record the time when Moiré queues the generation
  (ComfyUI integration)
