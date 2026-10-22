# Refactor pass catalogue

Every finding from both discovery waves, by unit. IDs (`S2.3` = slice S2, finding 3) are referenced from README.md and bugs.md. Tags: kind, size, leverage 1-5, confidence, test coverage, TW = in the tag-weights path. Unverified: agents' claims, check before acting.

## L4-invariants

*Most CLAUDE.md rules audit clean. I found no write to images.tags, the flags, rating or image_tags rows outside services/image_tags.py. Every tag writer that owns its transaction invalidates tag_index after commit. There are no ad hoc DB connections and no writes under the read-only conn helpers (checked with a script). Thumbnail URLs go only through thumb_version. All media routes have a HEAD twin. Every route is under API_PREFIX. There are no native select/datalist elements, no content-visibility, and no em dash anywhere in packages/ or docs. Rating goes through normalize_rating only. The real problems are one data-loss bug in the scanner (a missing library root wipes the library), two drifts in what is meant to be a single implementation (the tag write path and the feed filter), a hot-path projection that is ignored, and a few smaller rule slips.*

### L4.1 Scan of a library whose root is missing deletes every image and its curation

`bug | S | L5 | conf high | tests no | risk low`

**Problem.** The scan discovers files with os.walk(root_path), which yields nothing for a missing or unmounted root and raises no error. discovered_image_ids is then empty, so reconcile_stale marks every existing row stale. The stale-removal block deletes them all, cascading away image_tags, manual tags, ratings and scores. Only the watcher checks root.is_dir() (library_watch.py:360). The manual POST /rescan, _rescan_libraries_around and update-path scans call scan_library_async with no check. A second hole: image_id_for failures are swallowed with 'except Exception: pass' (scanner.py:560-565), so a file that was ingested but not recorded as discovered is also treated as stale and deleted.

**Proposal.** In scan _run, right after reading the current path (scanner.py:549), fail the scan with scan_error 'library folder not found' if not Path(current).is_dir(), before any walk or delete. Also skip stale removal when discovery produced zero files but the DB holds rows, or when any discovery error occurred (make the id_for failure add the file to a discovered_errors flag that disables reconcile). Add a test in test_scanner_db_integration.py: a library with rows plus a nonexistent root keeps its rows.

**Evidence.** `packages/backend/src/moire/services/scanner.py:549-566`, `packages/backend/src/moire/services/scanner.py:706-725`, `packages/backend/src/moire/services/scanner.py:332-348`, `packages/backend/src/moire/api/libraries.py:174-186`, `packages/backend/src/moire/api/libraries.py:41-55`, `packages/backend/src/moire/services/library_watch.py:360`

### L4.2 Bulk prompt-tag write is a second, hand-synced copy of the tag-state write

`invariant | S | L4 | conf high | tests partial | risk low TW`

**Problem.** _persist_statements claims to be the one place the array, flags and join rows are built, but replace_prompt_many_sync builds its own UPDATE with hard-coded bindparams b_has_tags, b_has_ai_tags and b_has_prompt_tags, plus its own delete and insert. initial_tag_fields hard-codes the same three flags again. Adding a flag, or the planned per-image prompt weights, to recompute_flags and _persist_statements would silently not be written by the reprojection path, which is the path that extracts prompt terms and so would carry the weights.

**Proposal.** Make the three entry points (_persist_statements, replace_prompt_many_sync, initial_tag_fields) all derive their column set from one source: have recompute_flags return a dict whose keys drive the bindparams (values(**{k: bindparam('b_'+k) for k in FLAG_KEYS})) and initial_tag_fields = {k: False for k in FLAG_KEYS}. Before the weights work, give the bulk function a single row-builder (image_id, tags, extras) -> dict so a new prompt_weights column is added once. Add a test asserting bulk and single paths produce identical rows for the same input.

**Evidence.** `packages/backend/src/moire/services/image_tags.py:331-350`, `packages/backend/src/moire/services/image_tags.py:595-621`, `packages/backend/src/moire/services/image_tags.py:43-52`, `packages/backend/src/moire/services/image_tags.py:197-207`, `packages/backend/src/moire/services/reproject.py:65-100`, `docs/tag-weights-plan.md:23-27`

### L4.3 find_image ignores its projection, so every thumb/file request loads the whole image row

`invariant | S | L4 | conf high | tests partial | risk low`

**Problem.** find_image documents 'projection is accepted but ignored' and does select(t.images), pulling tags, gen and ai JSON columns. Six hot callers (GET/HEAD /thumb, /file, /thumb-url, ai_jobs) pass {'thumb_key':1} or {'path':1} expecting a minimal read. The grid fires one thumb request per tile, so each pays a full-row fetch and JSON decode. This breaks the 'column select(...) projections' rule on the hottest read path, and the Mongo-style dict argument is a leftover.

**Proposal.** Change find_image to accept columns: Sequence[str] | None, select only those t.images.c[...] (all columns when None), and update the six call sites; drop the Mongo-style dict. Keep row_to_doc for the full-row case. Optionally add one helper find_image_cols(image_id, *cols) returning a Row so thumb routes skip dict conversion.

**Evidence.** `packages/backend/src/moire/services/image_tags.py:300-313`, `packages/backend/src/moire/api/images.py:163`, `packages/backend/src/moire/api/images.py:265`, `packages/backend/src/moire/api/images.py:297`, `packages/backend/src/moire/api/images.py:313`, `packages/backend/src/moire/services/ai_jobs.py:347`

### L4.4 /images/groups re-declares the feed query parameters that feed_filter exists to share, and drops group_id

`dedupe | S | L3 | conf high | tests yes | risk low`

**Problem.** feed_filter's docstring says one parameter set serves every 'which images match' route so they cannot drift. list_images and /ids use it, but list_groups copies all 23 Query params and the FeedFilter construction by hand. The copy already drifted: group_id is absent, so a group_id filter is silently ignored by the grouped view. Any new filter axis (and the tag-weights filters later) must be added in two places.

**Proposal.** Change list_groups to take f: FeedFilter = Depends(feed_filter) plus offset/limit, and delete the manual construction and the try/except. If ignoring group_id in the grouped view is intended, drop it explicitly with dataclasses.replace(f, group_id=None) and comment why.

**Evidence.** `packages/backend/src/moire/api/images.py:51-103`, `packages/backend/src/moire/api/images.py:455-516`

### L4.5 Image id lookup by hand-rolled id_candidates loops; set_tag_thumbnail skips the slash/backslash tolerance

`invariant | S | L3 | conf med | tests partial | risk low`

**Problem.** CLAUDE.md says ID lookups normalise / vs \\. resolve_image_id(conn, id) is the async resolver, yet images.py:/workflow, rules.py:/preview and scanner.py each re-implement 'for candidate in id_candidates' with their own SELECT. set_tag_thumbnail does not tolerate variants at all: it does t.images.c._id == image_id on the body value and then stores that raw spelling in tag_meta.thumb_image_id, so a variant spelling gives a 404 or a pin that never joins.

**Proposal.** Use image_tags.resolve_image_id(conn, image_id) in set_tag_thumbnail (and store the resolved id), in get_image_workflow and in rules.preview_ruleset (select image_gen_raw by the resolved id; image_gen_raw._id equals images._id). Add a sync twin resolve_image_id_sync for scanner.py:303 so id_candidates is only used inside image_tags.

**Evidence.** `packages/backend/src/moire/api/tags.py:373-380`, `packages/backend/src/moire/api/tags.py:391-393`, `packages/backend/src/moire/api/images.py:527-537`, `packages/backend/src/moire/api/rules.py:358-368`, `packages/backend/src/moire/services/scanner.py:303-312`, `packages/backend/src/moire/services/image_tags.py:283-297`

### L4.6 SORT_KEY / SCORE_KEY are defined twice (image_feed.py and schema.py); CLAUDE.md names a deleted nextCursorOf

`drift | S | L3 | conf high | tests no | risk low`

**Problem.** The feed's order expressions must match the expression indexes character for character for SQLite to use them. They are written once in image_feed.py (SORT_KEY, SCORE_KEY) and again in schema.py (_recent, _score, _newest, _top), kept equal by comment only, and no test checks it. Separately, the frontend no longer has nextCursorOf: the server builds the cursor and the client reads X-Next-Cursor. CLAUDE.md still says SORTS and nextCursorOf must agree, so the documented agreement point is gone and the real invariant (SORTS vs schema indexes) is undocumented.

**Proposal.** Define the key expressions once in database/schema.py (SORT_RECENT, SORT_SCORE) and import them in image_feed.py for SORT_KEY/SCORE_KEY. Add a test that runs EXPLAIN QUERY PLAN on the newest/oldest/top first page and asserts the ix_images_* index is used. Update CLAUDE.md to say the cursor is server-built and the agreement is SORTS vs schema.py.

**Evidence.** `packages/backend/src/moire/services/image_feed.py:70-81`, `packages/backend/src/moire/database/schema.py:499-511`, `packages/frontend/src/lib/imageFilter.ts:236-255`, `CLAUDE.md (Frontend layout, hooks/useImageFeed bullet)`

### L4.7 Unbounded write transactions: scanner stale delete, clear_ai_all, rename_manual

`invariant | M | L3 | conf med | tests partial | risk med`

**Problem.** CLAUDE.md requires small, often-committed write transactions on single-writer SQLite. The scanner's stale removal deletes every stale image (cascading image_tags) in one tx with an IN list of all ids, so a library with more than ~32k stale rows also exceeds SQLite's bound-variable limit and fails. clear_ai_all loads every image row (tags JSON included) and rewrites all of them in one async_tx. rename_manual and bulk_manual (up to 10000 ids) do the same. Each holds the write lock for the whole run and stalls the scanner, AI worker and every other writer, which busy_timeout then turns into 'database is locked'.

**Proposal.** Chunk each by 500: scanner stale removal loops over stale_image_ids[i:i+500] with its own sync_tx; clear_ai_all and rename_manual iterate id chunks (select ids first, then one async_tx per chunk) and call _dirty_tag_index once at the end. Keep bulk_manual atomic but cap or chunk above ~2000. Pass sets to stale delete via chunking only, no new abstraction.

**Evidence.** `packages/backend/src/moire/services/scanner.py:711-722`, `packages/backend/src/moire/services/image_tags.py:531-546`, `packages/backend/src/moire/services/image_tags.py:449-469`, `packages/backend/src/moire/services/image_tags.py:426-443`

### L4.8 Original files are served 'immutable' for a year at an unversioned URL

`invariant | S | L2 | conf med | tests no | risk low`

**Problem.** Thumbnails are versioned with ?v= and only served immutable when v is present, because an unversioned URL must be revalidated. GET /{id}/file sets Cache-Control: public, max-age=31536000, immutable on a URL with no version, built by hand in 5 places in ImageView. If a file on disk is replaced (an edited or overwritten image at the same path, a rescan picking up new bytes), the browser keeps the old original for a year and never revalidates, despite FileResponse providing an ETag.

**Proposal.** Serve originals with the same rule as thumbs: immutable only when a ?v= (size+mtime hash, reuse thumb_version's hashing on the original's stat) is present, otherwise 'no-cache' so the ETag answers with a 304. Add originalUrl(id) in lib/media.ts replacing the 5 inline template strings; the version can come from the item payload or be omitted in the first slice (no-cache with ETag is already cheap).

**Evidence.** `packages/backend/src/moire/api/images.py:156-183`, `packages/backend/src/moire/api/images.py:225-228`, `packages/frontend/src/pages/ImageView.tsx:381`, `packages/frontend/src/pages/ImageView.tsx:451`

### L4.9 Native window.confirm still reachable through useRulesetSession default in ResolvePromptDialog

`invariant | S | L2 | conf high | tests partial | risk low`

**Problem.** CLAUDE.md bans browser-drawn menus and Dialog.tsx notes that native confirm() was replaced. useRulesetSession defaults confirmDiscard to a window.confirm wrapper, and ResolvePromptDialog calls useRulesetSession without passing confirmDiscard (RulesPage passes useConfirm). Discarding unsaved ruleset edits in the resolve dialog therefore shows the native browser dialog. useUnsavedChangesGuard has the same default, but all three callers pass confirm.

**Proposal.** Make confirmDiscard required in useRulesetSession (and confirmLeave in useUnsavedChangesGuard), drop both native fallbacks, and pass useConfirm() from ResolvePromptDialog. The compiler then prevents any future caller from reaching window.confirm.

**Evidence.** `packages/frontend/src/hooks/useRulesetSession.ts:58-59`, `packages/frontend/src/hooks/useRulesetSession.ts:75-78`, `packages/frontend/src/components/ResolvePromptDialog.tsx:43-49`, `packages/frontend/src/hooks/useUnsavedChangesGuard.ts:20-21`, `packages/frontend/src/components/ConfirmDialog.tsx:103-106`

### L4.10 Deprecated POST /tags/ai/{image_id} has no caller

`dead | S | L1 | conf med | tests no | risk low`

**Problem.** The route's own comment says 'Deprecated route retained for convenience; internal AI tagging is implemented under /ai/*'. grep of packages/frontend/src for 'tags/ai/' finds nothing, and the AI jobs router already enqueues the same job. It is a second spelling of an existing operation under the wrong router (a tags router doing ai_jobs work).

**Proposal.** Delete the route and its local import of get_ai_job_manager; if a test references it, point the test at the /ai/ endpoint.

**Evidence.** `packages/backend/src/moire/api/tags.py:515-523`, `packages/frontend/src/lib/queries.ts`, `packages/frontend/src/lib/imageMutations.ts`

**Cross-cutting hints.**

- packages/frontend/src/pages/LibrariesPage.tsx:119 uses a raw fetch('/api/v1/libraries/{id}/progress') in a page instead of lib/queries (the only component-level fetch found; boundary nit).
- packages/backend/src/moire/services/library_nesting.py:180: adopt_nested_copies invalidates tag_index only after all chunks and only if something was dropped; an exception mid-way leaves already-committed chunks without invalidation (bounded by the 30s TTL).
- packages/backend/src/moire/api/tags.py:515 and ai_jobs: ai_tag route enqueues ids without id_candidates resolution (ai_jobs.py:347 does find_image, so it is covered downstream).
- packages/backend/src/moire/services/image_feed.py:176-182: FeedFilter validates tags length but only feed_where canonicalises; any other consumer of f.tags (tag_match_groups callers, _drive_by_rarest at line 353) must canonicalise separately, as it currently does at two sites.
- packages/frontend/src/pages/ImageView.tsx is about 2100 lines and builds /file endpoint URLs inline in 5 places (381, 406, 451, 514, 950); belongs to the frontend size/split lens.
- packages/backend/src/moire/services/tag_focus.py:80-90 and services/face_detect.py:300-312 select images by raw _id without id_candidates; ids there come from DB-sourced values so it is safe, noted only for completeness.

## L1-jobs

*Moire has about eight background-work mechanisms, and most of their differences are real. Scan, reproject and the watcher run on threads, because they are sync SQLite and filesystem work. AI jobs, model downloads, face finding and generation run on asyncio. Scan progress (library columns) and generation (its tables, with ComfyUI as the source of truth) are kept in the database; AI jobs, downloads, faces and the activity registry live only in memory and are lost on restart. A generic Job framework would fail the deletion test, because the queueing, cancellation and persistence rules really differ. The duplication is at the edges: "ended" signalling, progress shapes, download byte sums, spawn helpers and state vocabularies. services/activity.py is the one seam worth deepening. Two real defects turned up: a retag can silently strip AI tags, and async routes block the event loop on thread joins.*

### L1.1 Retag of an image a running AI job already passed wipes its AI tags and reports success

`bug | S | L4 | conf high | tests partial | risk low`

**Problem.** `_in_flight` holds every id of a job until the whole job ends (ai_jobs.py:311-313), not until that image is tagged. `/tag` with `retag` first runs `image_tags.clear_ai` on each id, then calls `enqueue(force=req.force)`. The frontend never sends `force` (lib/ai.ts:270-275). Scenario: a 200-image 'tag untagged' job is at image 150, and the user re-tags image 5, which that job already tagged. clear_ai wipes its AI tags and rating, enqueue counts the id as skipped, and the 0-total job is marked done at once. useAiTagging then toasts 'AI tagging completed', and the image is left with no AI tags. `_in_flight` is also a set, not a refcount. A forced job overlapping another job loses its claim when the first job ends, and cancelling a queued job (ai_jobs.py:226-228) releases ids that another job still holds.

**Proposal.** Two fixes, each small. (1) In `_worker_loop`, discard each id from `_in_flight` right after its `_tag_one` (or its failure), so 'in flight' means 'not yet processed'. Leave only the unprocessed tail to the `finally`. (2) In `api/ai.py` `ai_tag`, pass `force=True` whenever `req.retag` is set, because a retag has already destroyed state and must run. Optionally make `_in_flight` a `collections.Counter` so overlapping forced jobs release correctly.

**Evidence.** `packages/backend/src/moire/api/ai.py:149-156`, `packages/backend/src/moire/services/ai_jobs.py:160-195`, `packages/backend/src/moire/services/ai_jobs.py:306-313`, `packages/backend/src/moire/services/ai_jobs.py:220-229`, `packages/frontend/src/lib/ai.ts:270-275`, `packages/frontend/src/hooks/useAiTagging.ts:76-78`

### L1.2 Reproject has five entry points with different guarantees; only reproject_all is serialized

`invariant | M | L4 | conf med | tests partial | risk med TW`

**Problem.** Four `*_async` spawners (reproject.py:276-356) are near-copies of 'threading.Thread(target=_tracked, ...)'. Only `reproject_all_async` coalesces, and its docstring names the hazard: overlapping runs that read rulesets, aliases and keywords at different moments (reproject.py:165-168) can leave rows derived with older settings. The same hazard applies to the other entry points. `reproject_by_sig_async` spawns a new thread on every ruleset save or delete (rules.py:335-347). Post-scan library runs overlap. `tag_rename` runs `reproject_ids` inline through to_thread (tag_rename.py:237, 293, 397), untracked by activity and not serialized against anything. Example: a merge rule saved while a full reproject is in flight. The full run loaded aliases before the merge, so it can write `prompt:` tags for the merged-away name back onto images after the merge's own reprojection has removed them.

**Proposal.** Add one module-level `threading.Lock` (`_run_lock`) that `_reproject_where` takes before it loads settings and releases after its last `_flush_batch`. Runs then serialize, and each reads the settings that were current when it started. Replace the four spawners with `_spawn(name: str, work, *args, library_id: str | None = None, **kw)`, which starts the daemon thread around `_tracked`. Keep the coalescing loop only for `reproject_all_async`. Route tag_rename's inline calls through `activity.track('reproject')` so a merge shows progress. The tag-weights extraction step can then add weight reading inside `_reproject_where` without touching five call shapes.

**Evidence.** `packages/backend/src/moire/services/reproject.py:165-168`, `packages/backend/src/moire/services/reproject.py:267-356`, `packages/backend/src/moire/services/reproject.py:290-317`, `packages/backend/src/moire/services/tag_rename.py:237`, `packages/backend/src/moire/services/tag_rename.py:291-293`, `packages/backend/src/moire/services/tag_rename.py:397`, `packages/backend/src/moire/api/rules.py:306`, `packages/backend/src/moire/api/rules.py:335-347`, `packages/backend/src/moire/services/scanner.py:767-777`

### L1.3 'Ended' is counted four ways; the activity router reaches into each manager's internals

`deepen | M | L3 | conf high | tests partial | risk low`

**Problem.** activity.py already owns an `_ended` per-kind counter. Next to it are three hand-rolled ones: `scanner._scans_ended`, `AIJobManager.finished` (incremented by hand at three exit paths) and `face_detect.drains`. The router merges all four by hand (api/activity.py:129-134). It also builds each item by reading internals: `job.image_ids()`, `job.throughput()`, `manager.started`, `manager.current`, `face_detect.progress()` and the `drains` global. Downloads have no ended count at all. So CharactersSection keeps its own busy-to-idle effect (49-55) to refresh TAGS_KEY when the face model arrives, duplicating what `useRefreshOnFinish` does centrally for the other kinds.

**Proposal.** Deepen services/activity.py with `note_ended(kind: str) -> None` (thread-safe, same `_ended` dict). Scanner, ai_jobs and face_detect call it instead of keeping their own counters. ModelDownloadManager `_runner` calls it in its `finally` with kind `model_download` or `face_download` (pass the kind through `start`). Delete `_scans_ended`/`scans_ended`, `AIJobManager.finished` and `face_detect.drains`; the router's `ended` becomes `activity.ended()`. Move the per-mechanism item projection beside its state, following the `model_status_view` precedent: `AIJob.activity_item()`, and `face_detect.activity_items(cache_dir)`. Frontend: add `face_download` to the TAGS_KEY kinds in useRefreshOnFinish and delete CharactersSection's wasBusy effect.

**Evidence.** `packages/backend/src/moire/services/activity.py:22-24`, `packages/backend/src/moire/services/activity.py:77-80`, `packages/backend/src/moire/services/scanner.py:360-366`, `packages/backend/src/moire/services/scanner.py:795-796`, `packages/backend/src/moire/services/ai_jobs.py:131-133`, `packages/backend/src/moire/services/ai_jobs.py:194`, `packages/backend/src/moire/services/ai_jobs.py:224`, `packages/backend/src/moire/services/ai_jobs.py:310`, `packages/backend/src/moire/services/face_detect.py:194-195`, `packages/backend/src/moire/services/face_detect.py:283`, `packages/backend/src/moire/api/activity.py:78-94`, `packages/backend/src/moire/api/activity.py:107-134`, `packages/frontend/src/hooks/useBackgroundTasks.ts:50-75`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:49-55`

### L1.4 Async routes block the event loop on scan/watch thread joins

`bug | S | L3 | conf high | tests no | risk low`

**Problem.** `remove_library` is `async def` and calls `cancel_scan` (a `th.join` of up to 0.5 s) and `stop_watch` (a join of up to 1 s) directly on the loop. `create_library` and `update_library` call `start_watch`, which joins the old watch thread while holding `_lock` (library_watch.py:381-384). A scan thread rarely exits within 0.5 s, because run_pool leaves running futures to finish. So deleting a big library mid-scan stalls every request, including thumbnails and the activity poll, for up to 1.5 s. main.py:83-84 deliberately runs `stop_all` off the loop for exactly this reason, so the routes are inconsistent with it.

**Proposal.** In api/libraries.py, wrap these calls in `await anyio.to_thread.run_sync(...)`: `cancel_scan`, `stop_watch`, and `start_watch` (only when replacing an existing watch). The alternative is to give `cancel_scan` and `stop_watch` a signal-only mode (`wait=False`) for async callers. Prefer the to_thread form for delete: it can then wait for the scan thread to actually end (longer join), which also closes the late-batch race noted in the hints.

**Evidence.** `packages/backend/src/moire/api/libraries.py:131-138`, `packages/backend/src/moire/api/libraries.py:126-128`, `packages/backend/src/moire/api/libraries.py:268-276`, `packages/backend/src/moire/services/scanner.py:810-826`, `packages/backend/src/moire/services/library_watch.py:371-395`, `packages/backend/src/moire/services/library_watch.py:405-417`, `packages/backend/src/moire/main.py:83-84`

### L1.5 Model download progress is summed three ways with different rules

`dedupe | S | L3 | conf high | tests partial | risk low`

**Problem.** The activity router's `_download` sums bytes over only the files whose size is known, a rule test_activity_integration pins down. ModelSection and CharactersSection each re-sum all files from `as_dict().files`, counting a null total as 0. They also compute pct by hand rather than with `taskPct`. The tagger and face downloads share one ModelDownloadManager, yet three readers derive progress from its raw per-file list, and the numbers can disagree between the sidebar and the settings page.

**Proposal.** Move `_download`'s rule into `ModelDownloadState.progress() -> tuple[int, int] | None` and emit it from `as_dict()` as top-level `done`/`total`. api/activity.py then just forwards them. Both settings sections read `dl.done`/`dl.total` and use `taskPct` from lib/backgroundTasks.ts (or a `downloadPct` beside it, with a test) instead of their own reduces.

**Evidence.** `packages/backend/src/moire/api/activity.py:30-41`, `packages/frontend/src/pages/settings/sections/ModelSection.tsx:35-38`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:62-65`, `packages/backend/src/moire/services/ai_tagger_download.py:98-117`

### L1.6 scan_library_async._run is a 270-line closure; cancel is a string-matched RuntimeError checked inline four times

`split | M | L3 | conf high | tests partial | risk med`

**Problem.** The leads flag C901 35 and 130 statements. One closure handles slot wait, path refresh, the walk, loading known rows, pool and writer setup, progress throttling, reconcile and delete, the stamp, finalize, nested adoption and the post-scan reproject trigger. Cancellation raises `RuntimeError("cancelled")`, is detected by `str(e) == "cancelled"`, and 'library deleted while queued' reuses the same string. `with _scan_lock: if library_id in _cancel_scans: raise` is written out four times, although `_is_cancel_requested` exists.

**Proposal.** Add `class _Cancelled(Exception)` and `_check_cancel(library_id)`, which uses `_is_cancel_requested`. Extract pure or near-pure steps: `_wait_for_slot(library_id) -> Path` (536-553), `_walk(library_id, root, nested) -> (files, discovered_ids)` (555-571), `_load_known(library_id, stamp) -> Known | None` (582-599), `_reconcile(library_id, discovered, nested)` (689-736), and `_after_scan(library_id, wrote_any: bool)` (753-785). `_run` keeps the counters, `_on_complete` and the try/finally slot bookkeeping. `_walk` and `_reconcile` become directly testable alongside `reconcile_stale`.

**Evidence.** `packages/backend/src/moire/services/scanner.py:502-807`, `packages/backend/src/moire/services/scanner.py:536-543`, `packages/backend/src/moire/services/scanner.py:575-577`, `packages/backend/src/moire/services/scanner.py:681-683`, `packages/backend/src/moire/services/scanner.py:786-791`, `packages/backend/src/moire/services/scanner.py:369-371`

### L1.7 GenerationManager fuses connection, poll state machine, output placement and batch building

`split | L | L3 | conf med | tests yes | risk med`

**Problem.** The file is 1505 lines. `queue_batch` is radon D(24) because it assembles the whole `inputs` doc inline (1109-1174) from pure helpers that live 900 lines above it. Output placement (`held_by`, `root_candidates`, `output_image_id`, `_write_atomic`, `_place_outputs`, `_find_output_root`, `_fetch_missing`) is a self-contained filesystem and library concern that only needs `client.view` and the settings. The ComfyUI connection (configure, check, _up/_down, _set_up, the websocket loop, _on_event) is a third job sharing the same object.

**Proposal.** Make three moves and leave the poll/sync/submit/cancel state machine in place. (1) New `services/generation_inputs.py` with a pure `plan_batch(gen, body, settings) -> BatchPlan(inputs, sizes, seeds, name_words)`, holding lines 1109-1174 plus `batch_shape`, `_parts`, `_resolve`, `characters_of`, `_characters_input`, `_character_input`, `_outfit_input`, `outfit_tags` and `_sampling_input`. `queue_batch` and `requeue` then call it, and generation_batches imports `characters_of` from there. (2) New `services/generation_outputs.py` with `place_outputs(client, files, settings) -> (ids, fetch)` and `fetch_missing(client, library_id, files)`. (3) Optionally, a `ComfyConnection` holding client, connected, error, websocket, progress and started, which the manager composes.

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:474-1490`, `packages/backend/src/moire/services/generation_jobs.py:505-636`, `packages/backend/src/moire/services/generation_jobs.py:86-147`, `packages/backend/src/moire/services/generation_jobs.py:830-940`, `packages/backend/src/moire/services/generation_jobs.py:196-425`, `packages/backend/src/moire/services/generation_jobs.py:1097-1181`

### L1.8 AIJob bookkeeping: jobs never pruned, ids stashed via setattr, tagger idle loop started by the wrong owner, no stop

`simplify | S | L2 | conf high | tests partial | risk low`

**Problem.** `_jobs` only grows. Every one-image 'Tag with AI' and every bulk job stays in memory for the life of the process, along with its full id list, while `list_jobs` shows at most 20. The id list is attached with `setattr(job, "_ids", ...)` and read back with `getattr(job, "_ids", [])` in three places. `public()` filters underscore keys only so that this hack does not leak. `AIJobManager.start()` also starts the *TaggerManager's* `idle_unload_loop` and keeps no reference to the task. `set_idle_unload_s` is synced in two places (main.py:50-55 and ai_jobs.py:251-254). Shutdown stops the watchers and generation but not the AI worker or the idle loop.

**Proposal.** Make `ids: list[str] = field(default_factory=list, repr=False)` a real AIJob field, have `public()` drop it explicitly, and delete `image_ids()`'s getattr. After each job ends, trim `_jobs` to the newest N finished jobs (for example 50) plus all active ones. Move the idle loop's start into `TaggerManager.start(idle_unload_s)`, keep the task on the manager, and call it from the lifespan. Add `AIJobManager.stop()` (cancel the worker task) and call it in the lifespan shutdown beside `get_generation_manager().stop()`.

**Evidence.** `packages/backend/src/moire/services/ai_jobs.py:63-64`, `packages/backend/src/moire/services/ai_jobs.py:83-88`, `packages/backend/src/moire/services/ai_jobs.py:127`, `packages/backend/src/moire/services/ai_jobs.py:181-184`, `packages/backend/src/moire/services/ai_jobs.py:135-139`, `packages/backend/src/moire/services/ai_jobs.py:250-254`, `packages/backend/src/moire/main.py:47-55`, `packages/backend/src/moire/main.py:80-85`

### L1.9 Generation request-state vocabulary spelled five times

`dedupe | S | L2 | conf high | tests yes | risk low`

**Problem.** `UNFINISHED = ("pending", "queued", "running")` exists in generation_jobs. generation_batches redefines it as `_OPEN` and also inlines the same tuple twice, and generation_estimate inlines it too. `("failed", "lost")` also appears twice in generation_batches. A new state (such as the existing `replaced`) has to be added in every spot, or a batch's state, the queue frames and the estimate drift apart.

**Proposal.** Keep `UNFINISHED` and add `FAILED = ("failed", "lost")` in generation_jobs, which generation_batches already imports. Replace `_OPEN` and the inline tuples in generation_batches.py:39, 123 and 405-416 and generation_estimate.py:359 with these constants.

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:61-62`, `packages/backend/src/moire/services/generation_batches.py:39`, `packages/backend/src/moire/services/generation_batches.py:123`, `packages/backend/src/moire/services/generation_batches.py:405-416`, `packages/backend/src/moire/services/generation_estimate.py:359`

### L1.10 Dead helpers: scanner.file_hash and ai_tagger_download._download_if_missing

`dead | S | L1 | conf high | tests no | risk low`

**Problem.** A grep over packages/ and scripts/ finds no caller of `file_hash`; its `hashlib` import at scanner.py:19 has no other use. `_download_if_missing` is a self-described 'back-compat helper' with no caller. It duplicates `_download_one` without progress, atomic rename or cancel, so anyone who reuses it gets a non-atomic download.

**Proposal.** Delete `file_hash` and the `hashlib` import from scanner.py, and delete `_download_if_missing` from ai_tagger_download.py. (`face_detect.idle` and `generation_jobs.reset_for_tests` are flagged by vulture but tests use them; keep them.)

**Evidence.** `packages/backend/src/moire/services/scanner.py:19`, `packages/backend/src/moire/services/scanner.py:141-146`, `packages/backend/src/moire/services/ai_tagger_download.py:59-71`

**Cross-cutting hints.**

- packages/backend/src/moire/api/libraries.py:131-170 + services/scanner.py:615-630: a library deleted mid-scan can get orphan image rows and thumbnails. `images.library_id` has no FK to libraries (schema.py), `cancel_scan` waits only 0.5 s, `_on_complete` can still flush a batch after cancel, and the ThreadPoolExecutor exit waits for running workers that call `put_thumb` after `delete_by_prefix`. `_commit_batch` never checks that the library still exists.
- packages/backend/src/moire/api/libraries.py:131-170: `remove_library` assembles the delete transaction inline in the router (boundary). A `services/libraries.delete_library` would own cancel, stop, delete and invalidate.
- packages/frontend/src/lib/backgroundTasks.ts:10-25: `kind: TaskKind | string` widens to plain string, so the TaskKind union checks nothing (knip also flags TaskKind as unused).
- packages/frontend/src/hooks/useAiTagging.ts:37-44 + hooks/useBackgroundTasks.ts:24-31 + hooks/useAiStatus.ts:12-19: an open image's AI job is polled through /ai/jobs/:id (1.5 s) and /activity (1.5 s), and /ai/status (2 s) when the settings page is open, all carrying the same status, done and total. useAiTagging could read the active job from the activity items and fetch /ai/jobs/:id only once at the end for its error.
- packages/backend/src/moire/api/activity.py:107-127: the 'generate' item appears whenever ComfyUI's whole queue is non-empty (`queue_remaining` includes other clients' prompts), so the sidebar can say 'Generating' when Moire queued nothing.
- packages/backend/src/moire/services/generation_jobs.py:86-91 vs services/storage_fs.py: a second atomic-write helper; check whether storage_fs's can take a dot-prefixed staging name.

## L2-drift

*Tag spelling (canonical_name vs canonicalName, kaomoji, prefixes), shapes (served by /images/sizes), the colour palette, rating (already reported) and compose/split_requests currently agree. Agreement rests on "Mirror of X" comments, not on a shared fixture or generated type. The real divergence is prompt text: promptOutline.ts and prompt_parse.py read the same prompt differently in several concrete ways (found 3 that change what the board shows), and limit constants (steps, cfg, characters, tags, seed) are hand-copied across 2 to 3 files. There is no response_model or generated TS type anywhere, so every API payload type is hand-written.*

### L2.1 promptOutline (board) and prompt_parse (tags) read the same prompt differently; an unclosed bracket makes the board see one term

`bug | M | L5 | conf high | tests partial | risk med TW`

**Problem.** Both sides are meant to produce the same term names (the board matches its terms to the backend's prompt tags via /tags/place and the prompt: tags). Verified differences: (1) FE splitSpans does depth++ on every '(' / '[' and only splits at depth 0, so one unclosed '(' (or the emoticon ';(' / '>:(' that the backend knows whole) swallows every later comma into one piece; backend _scan always cuts at separators whatever the stack holds. (2) Backend also splits on '|', BREAK and AND and treats '{}' as a group and emoticons (:d, ^_^, ;)) as whole tags; FE knows none of these. (3) FE prose = 5+ words with no underscore; backend is_prose needs 9+ words, or 5+ with a sentence end or a pronoun/article/verb marker, so a 5-word spaced tag is 'prose' on the board and a tag in the DB. (4) Backend strips a bare decimal weight ('smile:1.05') and edge punctuation ('smile.'); FE keeps both in the name (the test at promptOutline.test.ts:49 pins the colon case), so the board term name differs from the stored tag. (5) Weight rule: neither side computes it (already reported), so this is the same gap seen from the name side.

**Proposal.** Put one table of cases in packages/backend/tests/fixtures/prompt_terms.json: {text, terms:[{name, kind, weight?}]}. Read it from test_prompt_parse.py (parse_prompt -> names/kinds) and from a promptOutline vitest. Start by listing today's disagreements as the expected output, decide per row which side is right (backend is the one that writes tags, so default to backend), then make promptOutline.splitSpans cut at separators regardless of depth, add '|'/BREAK/AND and the emoticon whole-token rule, and replace PROSE_WORDS with a port of is_prose (or serve it). Merge with the existing 'prompt weight' fixture proposed in docs/tag-weights-plan.md so there is one fixture file with names, kinds and weights. Longer term, expose a POST /tags/parse-prompt and let the board call it instead of a second parser.

**Depends on.** Wave1 'Three more ad-hoc prompt splitters' and 'Decompose prompt_parse._scan'; do together so the fixture covers the new Piece.weight.

**Evidence.** `packages/frontend/src/lib/promptOutline.ts:28-48`, `packages/frontend/src/lib/promptOutline.ts:55-57`, `packages/frontend/src/lib/promptOutline.ts:96-125`, `packages/backend/src/moire/services/prompt_parse.py:40`, `packages/backend/src/moire/services/prompt_parse.py:46`, `packages/backend/src/moire/services/prompt_parse.py:74`, `packages/backend/src/moire/services/prompt_parse.py:160-266`, `packages/backend/src/moire/services/prompt_parse.py:269-285`, `packages/backend/src/moire/services/prompt_parse.py:287-300`, `packages/frontend/src/lib/promptOutline.test.ts:49`

### L2.2 Generation limits are copied into 2 to 3 files each with no link between them

`drift | S | L3 | conf high | tests partial | risk low`

**Problem.** MAX_CHARACTERS = 8 is defined in generation_jobs.py and remix.py (comment: 'the composer's MAX_CHARACTERS') and again in generateForm.ts. MAX_TAGS = 40 (outfits.py) mirrors MAX_OUTFIT_TAGS (outfit.ts). steps 1..200 and cfg 0..30 appear as pydantic bounds (api/generate.py), as a hand check in remix.py and as samplingOf in generateForm.ts. Seed range 2**50 is SEED_MAX on one side and a literal in randomSeed on the other. outfits.WORN_MAX_CHARACTERS = 10 beside 8 elsewhere may or may not be deliberate. If one is raised, the other side silently truncates (backend slices characters[:MAX_CHARACTERS]) or rejects.

**Proposal.** Define the limits once in the backend, e.g. a LIMITS dict in services/generator_graph.py (or a new services/generation_limits.py) used by generation_jobs, remix, outfits and the pydantic Field bounds, and return it from an existing cheap endpoint (GET /generate/generators or a new /generate/limits). Frontend reads it through one useGenerationLimits query with the current numbers as the default. Delete the three local constants. Add a one-line comment on WORN_MAX_CHARACTERS saying why it differs, or unify it.

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:324`, `packages/backend/src/moire/services/remix.py:30`, `packages/frontend/src/lib/generateForm.ts:104`, `packages/backend/src/moire/services/outfits.py:31`, `packages/frontend/src/lib/outfit.ts:10`, `packages/backend/src/moire/services/outfits.py:148`, `packages/backend/src/moire/api/generate.py:107-108`, `packages/backend/src/moire/services/remix.py:105-108`, `packages/frontend/src/lib/generateForm.ts:497-500`, `packages/backend/src/moire/services/generator_graph.py:42`, `packages/frontend/src/lib/requests.ts:59`

### L2.3 No response models or generated types: every payload and closed vocabulary is typed by hand on both sides

`boundary | M | L3 | conf high | tests no | risk low TW`

**Problem.** grep finds zero response_model in the backend; routers return dicts. The frontend ImageDoc is one type for three different payloads: the feed row (exactly FEED_KEYS, no tags/gen/ai), the grouped row (+group_id, group_count) and the single-image row (full row_to_doc output plus ai/gen). A consumer cannot tell which fields exist where, and the tag-weights work will add a fourth axis (weights on detail only). Closed vocabularies are re-listed as TS unions with 'see services/x.py' comments: BoardSection vs prompt_board.SECTIONS, MergeKind vs tag_canon stages, Facet vs attire.FACETS, ThumbSize, FeedSort vs SORTS. Adding a value on the backend compiles fine on the frontend and falls through to a default branch.

**Proposal.** Cheapest step: a backend test that dumps the key set of the three image payloads (FEED_KEYS, groups, row_to_doc) and a vitest that checks FeedItem / ImageDetail TS types against the same JSON snapshot. Next: split ImageDoc into FeedItem (feed + groups) and ImageDetail, and have FEED_KEYS drive the FeedItem field list. Optional later: pydantic response models on the 6 hottest routes and openapi-typescript for those only. For enums, add GET /meta/vocab (sections, merge kinds, facets) or a shared JSON in packages/ consumed by both, so the TS unions derive from data.

**Depends on.** Do the ImageDoc split before adding prompt_weights to the detail payload.

**Evidence.** `packages/backend/src/moire/services/image_feed.py:43-62`, `packages/backend/src/moire/services/image_tags.py:266-277`, `packages/frontend/src/lib/imageFilter.ts:12-46`, `packages/frontend/src/lib/queries.ts:361`, `packages/frontend/src/lib/queries.ts:382-397`, `packages/backend/src/moire/services/prompt_board.py:26-42`, `packages/frontend/src/lib/mergeSuggestions.ts:4`, `packages/frontend/src/lib/tagColour.ts:128-140`

### L2.4 Hair/eye colour palette is copied into tagColour.ts with only a comment tying it to characters.COLOURS

`dedupe | S | L2 | conf high | tests partial | risk low`

**Problem.** 26 colour words with identical hue/sat/lightness, the neutrals list, the multicolour tag set and the 'longest two-word then one-word suffix' lookup (colourWord vs colour_of) exist in both. They agree today (checked entry by entry; FE lifts neutrals deliberately). The character page palette (backend) and the chip outlines (frontend) are meant to match, and adding a colour on one side makes a character's page colour and its tag chips disagree.

**Proposal.** Move the palette and multicolour sets to a single JSON (packages/backend/src/moire/data/hair_eye_colours.json) loaded by characters.py and returned by an existing endpoint (e.g. alongside /tags/groups) so tagColour.ts fetches it once; or generate tagColour's table from the same JSON at build time. Keep the neutral lightening as a frontend-side override map. Minimum viable: a vitest that reads the backend JSON/py-exported table and compares.

**Evidence.** `packages/frontend/src/lib/tagColour.ts:8-58`, `packages/frontend/src/lib/tagColour.ts:61-72`, `packages/backend/src/moire/services/characters.py:29-56`, `packages/backend/src/moire/services/characters.py:126-139`, `packages/backend/src/moire/services/characters.py:72-84`

### L2.5 Mirrored pure functions rely on comments and copy-pasted test cases instead of one fixture

`drift | S | L3 | conf high | tests partial | risk low`

**Problem.** Five pairs are literal ports: compose / composeParts, prompt_terms / promptTerms (the same regex written twice), split_requests / splitRequests, auto_name / batchName, canonical_name / canonicalName, plus the 19-entry KAOMOJIS list. All currently agree. Their only link is a comment saying 'keep the two in step (same cases in compose.test.ts and test_generation_compose.py)', which is enforced by nobody; a case added to one test file does not reach the other. The backend promptterms also mangles escaped parens (already reported), so a fix on one side will drift unless the cases are shared.

**Proposal.** Create packages/backend/tests/fixtures/mirrored/*.json (compose.json, prompt_terms.json, split_requests.json, canonical_name.json, kaomojis.json) and make both test files iterate them (vitest can import the JSON via a relative path or vite alias). Where one side is only a preview (compose, auto-name), consider dropping the frontend port and calling a preview endpoint instead, since the backend is the authority on what gets sent.

**Depends on.** Share the fixture directory with finding 1.

**Evidence.** `packages/backend/src/moire/services/generation_compose.py:1-7`, `packages/frontend/src/lib/compose.ts:1-10`, `packages/backend/src/moire/services/generation_compose.py:68-83`, `packages/frontend/src/lib/compose.ts:54-65`, `packages/frontend/src/lib/requests.ts:1-20`, `packages/backend/src/moire/services/generator_graph.py:444-455`, `packages/frontend/src/lib/batchName.ts:1-5`, `packages/backend/src/moire/services/tag_names.py:23-47`, `packages/frontend/src/lib/tags.ts:36-39`, `packages/frontend/src/lib/tags.ts:262-267`

### L2.6 canonicalName exists on the frontend but five call sites inline their own whitespace-to-underscore rule

`invariant | S | L2 | conf high | tests partial | risk low`

**Problem.** CLAUDE.md says canonical_name is the one spelling rule and lib/tags.ts canonicalName mirrors it, including the lora-token pass-through ('<lora:a b>' is left alone). These five sites write .replace(/\s+/g, '_') themselves, some with trim and some without, none with the '<' exception. A typed '<lora:my style:0.8>' in a chip or new-character field becomes '<lora:my_style:0.8>'. Frontend-only today, so the backend still stores canonical names, but it is exactly the duplication the rule was written to prevent.

**Proposal.** Replace the five inline regexes with canonicalName from lib/tags.ts (promptOutline needs canonicalName(x).toLowerCase()). Add an eslint no-restricted-syntax rule or a grep test banning the literal replace(/\s+/g, "_") outside tags.ts.

**Evidence.** `packages/frontend/src/components/generate/ChipInput.tsx:9-14`, `packages/frontend/src/components/NewCharacterDialog.tsx:20`, `packages/frontend/src/components/generate/CharacterBlock.tsx:243`, `packages/frontend/src/lib/imageFilter.ts:470`, `packages/frontend/src/lib/promptOutline.ts:119`, `packages/frontend/src/lib/tags.ts:262-267`, `packages/backend/src/moire/services/tag_names.py:46-52`

### L2.7 LoRA file-stem rule is implemented three times (gen_metadata.lora_name, generator_graph.lora_stem, two frontend copies)

`dedupe | S | L2 | conf med | tests partial | risk low`

**Problem.** lora_stem's docstring says it is 'the key that matches image_loras.name', but image_loras.name is written by gen_metadata.lora_name, a separate regex implementation (it also .strip()s; lora_stem does not). Frontend stemOf (RunControls) mirrors them, and WorkflowSetupPage:404 strips only '.safetensors'. The extension list (safetensors, ckpt, pt, pth, bin) is spelled in four places. A change in one means LoRA preset lookup, recipe matching and the LoRA feed filter stop agreeing, silently (they just find nothing).

**Proposal.** Make gen_metadata.lora_name call generator_graph.lora_stem (or move lora_stem to tag_names.py/a tiny services/file_names.py both import) after the strip. Frontend: comfy_models already returns 'stem' per model, so use that field where a model object is at hand and keep a single stemOf in lib/ (not a component file) for free-text names; replace WorkflowSetupPage:404 with it. Add a shared fixture row list to the mirrored-fixtures set from finding 5.

**Evidence.** `packages/backend/src/moire/services/gen_metadata.py:588`, `packages/backend/src/moire/services/gen_metadata.py:598-601`, `packages/backend/src/moire/services/generator_graph.py:55-64`, `packages/frontend/src/components/generate/RunControls.tsx:19-23`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:404`, `packages/backend/src/moire/services/comfy_models.py:46-48`

### L2.8 Character name/series split is frontend-only while the backend returns overrides only

`boundary | S | L2 | conf med | tests partial | risk low`

**Problem.** The frontend derives a character's name and series from the tag text with /^(.+?) \((.+)\)$/ on the display string; the backend has its own single-trailing-qualifier regex (_QUALIFIER) for the same concept (name_(series)) and returns name/series only as user overrides (null otherwise). The two regexes differ: 'a_(b)_(c)' is name 'a' series 'b) (c' on the frontend and no match on the backend. Anything that later sorts, searches or groups by series on the backend (tag_categories already needs it) will get different answers from what the UI shows.

**Proposal.** Let tag_categories (or characters.py) expose character_parts(tag) -> (name, series) using the stricter _QUALIFIER rule, include the resolved name/series in /tags/characters and the character page payload (override first, then derived), and delete characterName/displayName's regex in character.ts. Test both with the existing hu_tao_(genshin_impact) style cases plus the nested-paren case.

**Evidence.** `packages/frontend/src/lib/character.ts:76-92`, `packages/backend/src/moire/services/tag_categories.py:37`, `packages/backend/src/moire/services/characters.py:399`, `packages/backend/src/moire/services/characters.py:423`, `packages/backend/src/moire/services/characters.py:520`

**Cross-cutting hints.**

- packages/frontend/src/lib/imageFilter.ts:34 comment cites api/images.list_images for thumb_url; the thumb URLs are built in _attach_thumb_urls (api/images.py:136), a stale pointer worth fixing with the ImageDoc split
- packages/backend/src/moire/services/image_tags.py:300-305 find_image ignores projection (already reported), but feed/detail payload shape depends on it returning the whole row, so any ImageDetail type must be built from row_to_doc
- packages/frontend/src/lib/imageFilter.ts:1-3 and model?: string vs backend feed_filter model: list[str] (api/images.py:64): the frontend only ever sends one model, backend accepts several; harmless but undocumented
- packages/backend/src/moire/services/outfits.py:148 WORN_MAX_CHARACTERS = 10 vs 8 elsewhere: confirm intent
- packages/backend/src/moire/services/workflow_family.py:20-23 reads the '$.moire.family' key as a second family id; the writer of that key (generation placement) and this reader are in different modules with no shared constant

## L3-fe-primitives

*The frontend primitives are in decent shape where someone already did a consolidation pass: Dialog (one focus-trapped, stack-aware dialog used by 15 callers), feedCache, isFormField, api() and Picker are real deep modules. The weak spots are the seams between them. There is no JSON-body variant of api(), no shared error-to-text policy, no shared popover-dismiss or global-hotkey primitive, no safe localStorage wrapper, and no single owner for library scan polling, so each page re-derives them slightly differently. Query keys come in three conventions (constants in queries.ts, GEN_KEY family in generate.ts, bare string literals). Most of what follows is cheap to centralise and each piece has 5+ real callers.*

### L3.1 Library scan state is polled four independent ways, including a hand-rolled fetch loop that duplicates fields the list already carries

`dedupe | M | L4 | conf med | tests partial | risk med`

**Problem.** useLibraries already polls LIBRARIES_KEY every 3s while any library is scanning, and Library already carries scan_total and scan_done. Yet LibrariesPage runs a second useEffect+setTimeout loop that raw-fetches /libraries/{id}/progress per scanning library every 1.5s into a local `progress` state, and does its own scanning->done transition detection (prevScanningRef) to refresh and invalidate the feed. AllImagesPage runs a third loop (api('/libraries'), local setLibs, plus queryClient.setQueryData(LIBRARIES_KEY) to push into the cache) with its own wasScanningRef and lastEventSeenRef transition logic to refetch the feed. WelcomePage's ScanProgress runs a fourth useQuery on the same key with its own 2s interval and a separate queryFn instance. useBackgroundTasks has a fifth notion of 'scan ended' that invalidates libraries and tags. Two loops write the same cache key at different cadences, the transition detectors can disagree, and the only fetch that bypasses the cache (LibrariesPage progress) swallows every error silently.

**Proposal.** Make queries.ts the single owner. Keep useLibraries as the only poller (optionally let callers pass a faster interval via an option rather than a second useQuery). Add `useLibraryScanEvents({ onSettled })` (or fold into useLibraries) that diffs previous vs next data once and calls back on scanning->done and on a changed last_event_at; export a pure `scanTransitions(prev, next)` in lib/ with a test. Then LibrariesPage drops `progress` state and reads l.scan_done/l.scan_total, AllImagesPage replaces its tick() with the callback (`feed.refetch` + nothing else), and WelcomePage reuses useLibraries. Delete the per-library /progress fetch call site (and the endpoint if nothing else uses it).

**Evidence.** `packages/frontend/src/lib/queries.ts:79-90`, `packages/frontend/src/pages/LibrariesPage.tsx:93-160`, `packages/frontend/src/pages/AllImagesPage.tsx:340-400`, `packages/frontend/src/pages/WelcomePage.tsx:370-380`, `packages/frontend/src/hooks/useBackgroundTasks.ts:55-75`, `packages/frontend/src/lib/queries.ts:27-42`

### L3.2 Error toasts show raw JSON in ~25 places: three different error-to-text styles, errorText used only for onboarding/library flows

`bug | M | L4 | conf high | tests partial | risk low`

**Problem.** api() throws new Error(<raw body text>), and FastAPI bodies are {"detail":"..."}. lib/api.ts errorText() exists to unwrap that, but only 13 sites use it (AddLibraryDialog, WelcomePage, onboarding steps). About 25 other toast sites do `${String(e)}` (renders `Couldn't save: Error: {"detail":"..."}` for any api()-backed call) or `toast.push(e.message, 'error')` (renders the bare JSON string). The generate.ts `send` helper alone unwraps detail itself, so the same backend error reads cleanly on the Generate page and as JSON on the Tags page. There is also no QueryClient-level MutationCache onError (main.tsx:20-28), so each of 12 useMutation sites repeats its own `onError: (e) => toast.push(e.message, 'error')` and some (BatchPage cancelAll/retryAll) have none.

**Proposal.** Make api() itself throw an `ApiError extends Error` whose message is already errorText(body) (status and parsed detail kept as fields); keep errorText for non-ApiError. Add `fail(prefix, e)` to useToast (or export `toastError(push, prefix, e)`) that formats `${prefix}: ${errorText(e)}`. Add `mutationCache: new MutationCache({ onError })` in main.tsx that toasts for any mutation without its own onError (meta.silent opt-out), then delete the repeated `onError: toast.push(e.message)` lines. Mechanical sweep of the String(e) sites.

**Evidence.** `packages/frontend/src/lib/api.ts:7-27`, `packages/frontend/src/lib/generate.ts:486-505`, `packages/frontend/src/components/TagEditDialog.tsx:39`, `packages/frontend/src/components/CharacterEditDialog.tsx:98`, `packages/frontend/src/components/TagPanel.tsx:104`, `packages/frontend/src/pages/AllImagesPage.tsx:297`, `packages/frontend/src/pages/AllImagesPage.tsx:615`, `packages/frontend/src/hooks/useAiTagging.ts:101`, `packages/frontend/src/hooks/useRulesetSession.ts:208`, `packages/frontend/src/pages/settings/SettingsContext.tsx:86`, `packages/frontend/src/components/generate/StyleLayer.tsx:82`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:654`

### L3.3 api() has no JSON-body form: 21 hand-written Content-Type/JSON.stringify blocks and 5 private post/send helpers, plus 12 raw fetches with their own !ok handling

`dedupe | M | L4 | conf high | tests partial | risk low`

**Problem.** api.ts was created to be 'the one fetch-JSON helper', but writes still need `{method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(x)}` at every call site. imageMutations.post, ai.postJson, generate.send, and gen.ts getJson/saveRuleset/deleteRuleset/previewRuleset/fetchWorkflow each reimplement it; imageFilter.ts has three raw fetch+!ok+text() fetchers (one needs the response header X-Next-Cursor); lib/generate.ts send has its own 422 node_errors and detail-unwrapping branch. Components (AddLibraryDialog, WelcomePage, LibrariesPage) also embed method/header/body literals. Any change to error handling or auth/headers must be made in ~10 places (see the error-text finding). (Ruleset raw fetches in gen.ts were reported in wave 1; this is the general cause.)

**Proposal.** In api.ts add `apiJson<T>(url, method, body?, init?)` (sets header and stringifies when body !== undefined, otherwise identical to api) and `apiRaw(url, init)` returning the checked Response for the header-reading case. Reimplement imageMutations.post, ai.postJson, generate.send (keeping RejectedError by catching ApiError with status 422 and node_errors) on top of them, delete getJson and the gen.ts/workflows.ts/queries.ts/libraryPlan hand-rolled blocks, and move the three imageFilter fetchers onto api/apiRaw. Add the missing api.test.ts cases for body serialisation.

**Evidence.** `packages/frontend/src/lib/api.ts:1-9`, `packages/frontend/src/lib/imageMutations.ts:17-30`, `packages/frontend/src/lib/imageMutations.ts:83-101`, `packages/frontend/src/lib/ai.ts:260-268`, `packages/frontend/src/lib/generate.ts:486-505`, `packages/frontend/src/lib/generate.ts:593-598`, `packages/frontend/src/lib/queries.ts:264`, `packages/frontend/src/lib/queries.ts:291`, `packages/frontend/src/lib/queries.ts:335`, `packages/frontend/src/lib/queries.ts:356`, `packages/frontend/src/lib/queries.ts:433`, `packages/frontend/src/lib/gen.ts:86-136`, `packages/frontend/src/lib/workflows.ts:237-262`, `packages/frontend/src/lib/imageFilter.ts:249-285`, `packages/frontend/src/lib/libraryPlan.ts:37`, `packages/frontend/src/pages/WelcomePage.tsx:200`, `packages/frontend/src/components/AddLibraryDialog.tsx:129`, `packages/frontend/src/pages/LibrariesPage.tsx:159`

### L3.4 Global keyboard handling is re-implemented in 12 window/document listeners with inconsistent guards; help table is a separate hand-kept copy

`simplify | M | L4 | conf high | tests partial | risk med`

**Problem.** Every handler hand-rolls the same preamble in a different subset: overlayOpen bail, `e.ctrlKey||e.metaKey||e.altKey` bail, isFormField bail, e.defaultPrevented. AllImagesPage's two handlers have the modifier guard, ImageView does not (that is the Ctrl+1..5 / Alt+Arrow hijack in bugs.md), TagsPage checks defaultPrevented but nothing else does, and App.tsx defines a private copy of isFormField (lines 94-104) even though lib/dom.ts says 'this is the one copy'. ShortcutOverlay detects 'a dialog is open' with document.querySelector('[role=dialog][aria-modal=true]'), a DOM-sniff parallel to Dialog's own openStack and to OverlayOpenContext. lib/shortcuts.ts is a second, hand-maintained list of the keys, so help and behaviour drift (the bugs.md entry already cites shortcuts.ts:44-45,63-64 as listing the keys).

**Proposal.** Add `hooks/useHotkeys(bindings, { when, allowInFields })` in hooks/ plus a pure `plainKey(e)` in lib/dom.ts that returns the key only for unmodified, non-composing, non-defaultPrevented events outside form fields. Bindings are `{ keys: ['x','Delete'], run(e) }` objects; the hook owns the single window listener, the overlayOpen bail and cleanup. Convert AllImagesPage (both), ImageView, App scroll keys, TagsPage Escape. Derive the shortcuts.ts help rows from the same binding objects where the page registers them (or at least test that every help key has a binding). Delete App.tsx's local isFormField. This fixes the reported ImageView bug at its root rather than patching the one handler.

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:578-621`, `packages/frontend/src/pages/AllImagesPage.tsx:440-505`, `packages/frontend/src/pages/AllImagesPage.tsx:640-682`, `packages/frontend/src/App.tsx:92-170`, `packages/frontend/src/App.tsx:36-55`, `packages/frontend/src/pages/TagsPage.tsx:156-165`, `packages/frontend/src/components/ShortcutOverlay.tsx:15-36`, `packages/frontend/src/lib/shortcuts.ts:36-70`, `packages/frontend/src/lib/dom.ts:1-16`

### L3.5 localStorage preferences hand-rolled in 14 places, two with no try/catch (gallery render can throw), keys use two naming schemes

`dedupe | M | L3 | conf high | tests partial | risk low`

**Problem.** Each view preference writes its own try/catch read/write pair (about 10 copies of the same 8 lines). Two do not guard at all: App.tsx:19 reads in a useState initialiser and :78 writes in an effect, and useFilters.ts:22/33 reads inside the useMemo that produces the gallery's filters and writes in setFilters. With storage blocked (Safari private mode, cookies disabled, the cases the other 10 sites explicitly handle) the app shell and the whole gallery throw during render. Keys are inconsistent ('sidebar:collapsed' vs 'moire.tags.view'). Wave 1 reported only the useTagMarks vs DETAIL_TAB_KEY pair.

**Proposal.** New lib/storage.ts: `readPref(key, parse, fallback)` / `writePref(key, value)` (both swallow errors) and `usePref<T>(key, {parse, serialize, fallback})` built on useSyncExternalStore with a shared in-memory listener map so two components on one key stay in sync (this subsumes useTagMarks' external-store). Prefix keys with `moire.` in one place with a one-line legacy-key read. Convert the 14 sites; useFilters and App become safe by construction. Unit-test with a throwing localStorage stub.

**Evidence.** `packages/frontend/src/App.tsx:18-20`, `packages/frontend/src/App.tsx:77-79`, `packages/frontend/src/hooks/useFilters.ts:20-35`, `packages/frontend/src/hooks/useDensity.ts:18-50`, `packages/frontend/src/hooks/useTagMarks.ts:18-37`, `packages/frontend/src/components/generate/WornOutfits.tsx:12-28`, `packages/frontend/src/components/generate/PromptBoard.tsx:105-112`, `packages/frontend/src/components/generate/PromptBoard.tsx:520-524`, `packages/frontend/src/pages/TagsPage.tsx:66-118`, `packages/frontend/src/pages/RulesPage.tsx:158-178`, `packages/frontend/src/pages/LibrariesPage.tsx:254-277`, `packages/frontend/src/pages/ImageView.tsx:1055-1104`, `packages/frontend/src/pages/AllImagesPage.tsx:430-436`, `packages/frontend/src/pages/WelcomePage.tsx:52-58`

### L3.6 Query keys and invalidation bundles are scattered: bare-string keys, a duplicate of invalidateFeeds, and the same 2-3 invalidations pasted at 5+ sites

`dedupe | S | L3 | conf high | tests partial | risk low`

**Problem.** (1) LibrariesPage.invalidateImageFeed spells the literals ["images"] and ["image-groups"], a hand copy of feedCache's IMAGE_FEED_PREFIX / unexported IMAGE_GROUPS_PREFIX, so a rename in feedCache silently stops refreshing the gallery after a library change. useBackgroundTasks:67 likewise invalidates ["image"] instead of a constant next to imageDocKey. (2) The generate queue refresh (STATUS_KEY + BATCHES_KEY [+ batchKey(id)]) is pasted in QueueDeck, OutputFeed, BatchPage (twice) and GeneratePage with slight variations, one of which (BatchPage cancelAll, the 'never ran' branch) skips the batch key. (3) 'a character or tag changed' is `invalidateQueries(TAGS_KEY)` at 7 sites, each time after a different set of writes, with no named intent (CharacterEditDialog does not also refresh ['image'] docs that show character avatars). (4) Several keys are bare literals with no exported constant: image-sizes, image-models/loras/embeddings, aiStatus, aiJob, thumb-url, tag-descriptions, and 'rules-signatures' x3 (already reported).

**Proposal.** Export IMAGE_GROUPS_PREFIX and an IMAGE_DOC_PREFIX from feedCache and make LibrariesPage call invalidateFeeds(qc) (it is a superset). Add `invalidateQueue(qc, batchId?)` in lib/generate.ts and `invalidateCharacters(qc)` (TAGS_KEY plus the image doc prefix) in lib/queries.ts, then replace the call sites. Add constants for the bare-literal keys in the module that owns their fetcher. No behaviour change beyond fixing the BatchPage branch.

**Evidence.** `packages/frontend/src/pages/LibrariesPage.tsx:66-74`, `packages/frontend/src/lib/feedCache.ts:23-27`, `packages/frontend/src/lib/feedCache.ts:196-209`, `packages/frontend/src/hooks/useBackgroundTasks.ts:63-72`, `packages/frontend/src/components/generate/QueueDeck.tsx:21-28`, `packages/frontend/src/components/generate/OutputFeed.tsx:16-21`, `packages/frontend/src/pages/BatchPage.tsx:160-166`, `packages/frontend/src/pages/BatchPage.tsx:176-182`, `packages/frontend/src/pages/GeneratePage.tsx:366-370`, `packages/frontend/src/components/CharacterEditDialog.tsx:76`, `packages/frontend/src/components/CharacterEditDialog.tsx:98`, `packages/frontend/src/components/TagEditDialog.tsx:35`, `packages/frontend/src/components/NewCharacterDialog.tsx:106`, `packages/frontend/src/components/TagPanel.tsx:102`, `packages/frontend/src/hooks/usePinCover.ts:25`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:53`, `packages/frontend/src/components/SizeFilter.tsx:21`, `packages/frontend/src/hooks/useAiStatus.ts:14`, `packages/frontend/src/hooks/useAiTagging.ts:38`

### L3.7 Tag autocomplete text input is written five times (active index, moved flag, arrow/Tab/Enter/comma/Escape handling)

`dedupe | M | L3 | conf high | tests no | risk med`

**Problem.** TagSuggestList and useTagMatches share the matching and list rendering, but every caller re-implements the controller around them: `active` + `moved` state, ArrowUp/Down clamping, Tab to accept, Enter/comma to add (taking the highlighted match only if the user arrowed), Escape to clear, reset active on text change. jscpd flags CharacterBlock:252-276 vs Outfit:156-181 as a 25-line identical clone (only the aria-label and noteOf differ), and ChipInput/TagSearchInput/RenameTagDialog share 10-12 line clones of the same handlers. The fix for any keyboard-nav bug (IME composition, Enter while the list is closed) has to land in five files, and the semantics already differ subtly (ChipInput accepts the active match on bare Enter, CharacterBlock/Outfit require `moved`).

**Proposal.** Add `useTagSuggest({ pool, resources?, onCommit, commitKeys })` in TagSuggestList.tsx returning `{ text, setText, matches, active, setActive, inputProps: {value,onChange,onKeyDown}, listProps }`, with the key decision extracted as a pure `suggestKeyAction(key, state) -> {type:'move'|'accept'|'commit'|'clear'|'none'}` in lib/ and unit tested. CharacterBlock and Outfit's TagAdder collapse to a shared `TagAddInput` (props: label, onAdd, noteOf); the other three keep their bespoke surroundings but use the hook.

**Evidence.** `packages/frontend/src/components/generate/CharacterBlock.tsx:236-281`, `packages/frontend/src/components/generate/Outfit.tsx:135-190`, `packages/frontend/src/components/generate/ChipInput.tsx:56-110`, `packages/frontend/src/components/TagSearchInput.tsx:50-110`, `packages/frontend/src/components/NewCharacterDialog.tsx:55-175`, `packages/frontend/src/components/RenameTagDialog.tsx:40-140`, `packages/frontend/src/components/TagSuggestList.tsx:57-110`

### L3.8 Click-outside + Escape popover dismissal reimplemented in 8 components

`dedupe | S | L2 | conf high | tests partial | risk low`

**Problem.** Eight components attach a document `mousedown` listener that closes when the target is outside a ref, and most also add a keydown Escape listener, each in its own useEffect with its own cleanup. jscpd flags ChipInput:72-83 = RunControls:186-195 = TagSearchInput:98-107. They differ in ways that look accidental: Layers and AllImagesPage close on Escape even when a Dialog above already handled it (neither checks defaultPrevented or the dialog stack; Dialog stops propagation only in the capture phase for its own subtree), touchstart is handled only in AllImagesPage, and Layers/ChipInput ignore pointerdown on touch-only devices.

**Proposal.** Add `hooks/useDismiss(ref | refs, open, onDismiss, { escape = true })` that registers pointerdown (covers mouse+touch) and Escape (skipping `e.defaultPrevented`), used by all eight. Picker and DropdownMenu keep their arrow-key logic but drop the dismissal half. Small, mechanical, and removes about 80 lines.

**Evidence.** `packages/frontend/src/components/ui/Picker.tsx:140-170`, `packages/frontend/src/components/ui/DropdownMenu.tsx:60-100`, `packages/frontend/src/components/generate/Layers.tsx:93-105`, `packages/frontend/src/components/generate/RunControls.tsx:185-210`, `packages/frontend/src/components/generate/ChipInput.tsx:72-82`, `packages/frontend/src/components/generate/PromptInput.tsx:222-232`, `packages/frontend/src/components/TagSearchInput.tsx:98-108`, `packages/frontend/src/pages/AllImagesPage.tsx:408-430`, `packages/frontend/src/components/ui/Tooltip.tsx:84-95`

### L3.9 Pending-save handling split between 12 useMutation sites and 14 hand-rolled saving/busy flags; dialog footers and 'Saving…' buttons are copied

`dedupe | M | L2 | conf med | tests partial | risk low`

**Problem.** The same shape appears at least 14 times: `setSaving(true); try { await write(); await qc.invalidateQueries(...); close(); } catch (e) { push("Couldn't save: ...") } finally { setSaving(false) }`, next to 12 modules that already use useMutation (which gives isPending, onError and invalidation for free). The Cancel + `{saving ? 'Saving…' : 'Save'}` footer is pasted in TagEditDialog, CharacterEditDialog, RenameTagDialog and four settings sections; jscpd's TagEditDialog:63-89 / CharacterEditDialog:145-172 clone is the footer plus the cover/focus field block. Flags can also get stuck: CharacterEditDialog.remove sets saving=true and on success never resets it (relies on unmount).

**Proposal.** Standardise on useMutation (with the MutationCache toast from the error-text finding) for dialog and settings saves. Give Button a `pending` prop that swaps the label and disables it, and add `<DialogFooter onCancel onConfirm confirmLabel pending />` in ui/Dialog.tsx for the Cancel/Save pair. Extract the cover Field (FocusPicker + CharacterAvatar preview + reset) shared by TagEditDialog and CharacterEditDialog into `CoverFocusField`. Do this incrementally, dialog by dialog.

**Evidence.** `packages/frontend/src/components/TagEditDialog.tsx:28-60`, `packages/frontend/src/components/CharacterEditDialog.tsx:58-125`, `packages/frontend/src/components/NewCharacterDialog.tsx:88-110`, `packages/frontend/src/components/RenameTagDialog.tsx:58-100`, `packages/frontend/src/components/BulkTagDialog.tsx:44-60`, `packages/frontend/src/pages/settings/SettingsContext.tsx:136-146`, `packages/frontend/src/pages/settings/sections/BoilerplateSection.tsx:77-90`, `packages/frontend/src/pages/settings/sections/PromptGuessSection.tsx:60-70`, `packages/frontend/src/pages/settings/sections/TaggingSection.tsx:170`, `packages/frontend/src/pages/settings/sections/PromptTagsSection.tsx:29`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:134`

**Cross-cutting hints.**

- packages/frontend/src/components/generate/SaveOutfitDialog.tsx:179 wraps <Dialog> in createPortal although Dialog already portals to body (ui/Dialog.tsx:105); redundant, safe to drop.
- packages/frontend/src/components/generate/useLiveQueue.ts:8-14 and QueueDeck.tsx:116 + QueueFrames.tsx:73 both call useLiveQueue, so two 1s interval tickers run for one queue; hoist into a context or share one useNow.
- packages/frontend/src/lib/queries.ts (475 lines) is a catch-all (libraries, tag aggregates, settings, aliases, merge suggestions, board) and lib/imageFilter.ts mixes URL parsing with three fetchers (249-285); lib/generate.ts (828 lines) mixes types, clients and hooks. Candidates to split by domain once the api helpers land.
- packages/frontend/src/components/ShortcutOverlay.tsx:21,28 detect open dialogs via DOM querySelector instead of Dialog's openStack (ui/Dialog.tsx:62) or OverlayOpenContext; expose a `isDialogOpen()` from Dialog.
- knip 'unused export' leads for ErrorPanel, useRemixWorkflow, waitingForScan, framesOf, ChipInput are false positives (used in-file or elsewhere); only the export keyword is unneeded.
- packages/frontend/src/pages/ImageView.tsx:1871 re-invalidates the image doc on fixed 800ms/3000ms window.setTimeouts with no cleanup, a poll-by-guess that outlives unmount; belongs to the S2-imageview reviewer.

## S1-feed

*The feed core is in good shape: FeedFilter validates on construction, the feed and grouped view share one WHERE builder, cursor shape lives in one SORTS table, and the frontend keeps filter/URL round-trip and layout math pure and tested. The weak spots are all at the edges. feed_where (radon F48) and _drive_by_rarest normalize tags and prompt terms separately, api/images.py is a four-job router whose route order is load-bearing, imageFilter.ts mixes codec, API client and search-term logic, and AllImagesPage is a 1338-line page that hand-rolls what hooks and queries already exist. The grouped (batch) view is a second-class citizen of the cache and polling layer, which is the one real bug cluster found.*

### S1.1 Grouped gallery view is not refreshed or patched: flat feed always fetches, poll refetches the wrong query, removals skip groups

`bug | S | L4 | conf med | tests partial | risk low`

**Problem.** useImageFeed(filters) has no `enabled` flag, so in grouped mode (persisted in localStorage, so the default for a user who likes batches) the page fetches both the hidden flat feed and the visible groups. The library poll then does `refetchFeedRef.current = feed.refetch`, i.e. it refetches the hidden flat feed, never `groups`, so a finished scan or watcher event does not update the grouped tiles the user is looking at. removeImagesFromFeeds goes through patchFeeds, which only walks the `images` prefix (feedQueries), so bulk quarantine from selection mode in grouped view, and a purge from ImageView, leave the tile in the groups cache until the later invalidateFeeds lands (bulk: after every request in runBulk finishes). imageFeedKey also embeds `group`, which /images ignores, so toggling Group refetches and splits the flat cache.

**Proposal.** Add `enabled` to useImageFeed and call `useImageFeed(filters, PAGE_LIMIT, !groupMode)`. Replace refetchFeedRef with `activeFeed.refetch`. In feedCache add `groupQueries` handling to patchFeeds (or a sibling `patchGroups`) so removeImagesFromFeeds drops ids from both caches. Build imageFeedKey from `{...filters, group: false}` so the flat cache is shared across the Group toggle. Add a feedCache vitest that removing an id also removes it from an ['image-groups'] query.

**Evidence.** `packages/frontend/src/pages/AllImagesPage.tsx:123-129`, `packages/frontend/src/pages/AllImagesPage.tsx:350-351`, `packages/frontend/src/pages/AllImagesPage.tsx:387-389`, `packages/frontend/src/hooks/useImageFeed.ts:17-19`, `packages/frontend/src/hooks/useImageFeed.ts:26-40`, `packages/frontend/src/lib/feedCache.ts:185-192`, `packages/frontend/src/lib/feedCache.ts:43-46`, `packages/frontend/src/hooks/useFilters.ts:21-31`

### S1.2 AllImagesPage (1338 lines) fuses polling, shortcuts, triage, bulk actions, filter option queries and the whole filter panel

`split | L | L4 | conf high | tests no | risk med`

**Problem.** One component owns eight jobs. The pure-ish ones have no tests because they are closures inside the page: the three-way workflow picker option building (244-271), the n/a/q toggle logic that also rewrites aiTagged (485-492), triage focus clamping (627-628), bulk quarantine/tag orchestration (699-778). The filter panel JSX alone is about 195 lines (1051-1246) and re-implements the same exclusivity rule inline in three onClicks (381, 394).

**Proposal.** Move in this order, each a pure move: (1) components/GalleryFilterPanel.tsx taking {filters,setFilters, options} for lines 1051-1246, with a hook `hooks/useFilterOptions.ts` returning tagOptions, model/lora/embedding options, outfits, resourceSuggestions, knownResources, workflowPickerOptions (198-271); (2) hooks/useGalleryShortcuts.ts for 443-510 and hooks/useTriage.ts for 590-690 (takes items, focusedIndex, filters, density); (3) hooks/useBulkActions.ts for 699-778 returning runBulkQuarantine/runBulkTag/runBulkManualTags; (4) components/GalleryToolbar.tsx for the header JSX 805-1003 (the desktop and phone variants of Sort/Group/Select currently duplicated, 891-959). Put the n/a/q toggles and workflow picker mapping in lib/ as pure functions with vitest. Page shrinks to roughly 300 lines of composition.

**Evidence.** `packages/frontend/src/pages/AllImagesPage.tsx:140-148`, `packages/frontend/src/pages/AllImagesPage.tsx:198-271`, `packages/frontend/src/pages/AllImagesPage.tsx:350-405`, `packages/frontend/src/pages/AllImagesPage.tsx:441-510`, `packages/frontend/src/pages/AllImagesPage.tsx:590-690`, `packages/frontend/src/pages/AllImagesPage.tsx:692-778`, `packages/frontend/src/pages/AllImagesPage.tsx:805-1003`, `packages/frontend/src/pages/AllImagesPage.tsx:1051-1246`

### S1.3 feed_where (radon F48) and _drive_by_rarest each re-derive the same tag groups and prompt-term list

`dedupe | M | L4 | conf high | tests partial | risk low`

**Problem.** The canonical_tag + tag_match_groups step (205-206 vs 354-355) and the `[canonical_name(p.lower()) for p in pterms if p and p.strip()]` normalization (229 vs 358) are written twice. The driver is documented as 'every group is ANDed into the filter, so its images are a superset of the result', which only holds while the two copies agree, so a change to one (say a new tag alias rule, or pterms OR semantics) silently makes the driver prune real matches. `no_ai_tags` is also emitted in both arms of an if/else (209, 214). feed_where itself is one 125-line function with 38 branches mixing tags, gen terms, loras, outfits, sizes and workflow.

**Proposal.** Add two small pure helpers: `_tag_groups(f) -> list[list[str]]` and `_pterms(f) -> list[str]`, used by both feed_where and _drive_by_rarest. Then split feed_where into `_tag_conds(f)`, `_gen_conds(f)` (pterms, model, lora, embedding, workflow, needs_mapping), `_outfit_conds(f)` and `_size_conds(f)`, each returning list[ColumnElement]; feed_where becomes `sa.and_(*_tag_conds(f), *_gen_conds(f), ...)`. Hoist `no_ai_tags` out of the if/else. Cover with the existing test_image_feed/test_feed_integration plus one test asserting driver_ids never changes the result set.

**Evidence.** `packages/backend/src/moire/services/image_feed.py:195-319`, `packages/backend/src/moire/services/image_feed.py:205-207`, `packages/backend/src/moire/services/image_feed.py:229`, `packages/backend/src/moire/services/image_feed.py:343-380`, `packages/backend/src/moire/services/image_feed.py:354-359`, `packages/backend/src/moire/services/image_feed.py:208-214`

### S1.4 imageFilter.ts mixes URL codec, API client and search-term logic; the gallery uses raw api() for tags, ids and a hand-rolled libraries poll

`boundary | M | L3 | conf high | tests partial | risk low`

**Problem.** The file header calls parseFilters/serializeFilters 'pure', but 60 lines of it are fetch wrappers (fetchImagesPage, fetchGroupsPage, fetchImage, which RulesPage and ImageView also import from a filter module) and 80 lines are search-box term mapping (resourceOf, searchTerms, withSearchTerms). In the page, the merged tag-suggestion query, /images/ids and the libraries poll are inline `api(...)` calls. The page also reimplements useLibraries (queries.ts:76) by polling every 1.5s/8s, mirroring the result into useState AND setQueryData; the only extra is the watcher `last_event_at` detection.

**Proposal.** Split into lib/imageFilter.ts (types + codec + chips, pure), lib/imageApi.ts (fetchImagesPage, fetchGroupsPage, fetchImage, fetchImageIds, buildImagesQuery) and lib/searchTerms.ts (RESOURCE_PREFIXES through withSearchTerms, with its existing tests). Add to lib/queries.ts `tagSuggestionsQuery` (merge_sources), `imageSizesQuery` (move useSizePresets out of SizeFilter.tsx, which Generate also imports) and let the page call `useLibraries()` (drop `libs` useState) plus a `useFeedAutoRefresh(libs, refetch)` hook that holds only the scanning/last_event_at transition logic.

**Evidence.** `packages/frontend/src/lib/imageFilter.ts:225-283`, `packages/frontend/src/lib/imageFilter.ts:406-485`, `packages/frontend/src/pages/AllImagesPage.tsx:140-142`, `packages/frontend/src/pages/AllImagesPage.tsx:198-205`, `packages/frontend/src/pages/AllImagesPage.tsx:286-301`, `packages/frontend/src/pages/AllImagesPage.tsx:360-405`, `packages/frontend/src/lib/queries.ts:76-85`, `packages/frontend/src/components/SizeFilter.tsx:19-25`, `packages/frontend/src/pages/RulesPage.tsx:38`

### S1.5 Filter axes are hand-listed in eight places and the aiTagged exclusivity rule is re-applied by each

`simplify | S | L3 | conf med | tests yes | risk low`

**Problem.** Adding a filter axis means touching the Filters type, DEFAULT_FILTERS, parse, serialize, hasActiveFilter, withoutFilters, activeFilterChips and the filter panel; hasActiveFilter and withoutFilters can already disagree (withoutFilters keeps libraryId/groupId, hasActiveFilter counts them). The rule 'aiTagged is ignored beside noTags/noAiTags' is applied in parse (144), serialize (183), chips (375), two hotkeys (487, 492) and two panel buttons, while the backend rejects the combination with 422, so a hand-built URL is silently repaired in the UI. The `workflow` vs `workflowSig` 'one or the other' comment (89-90) is not enforced anywhere on the client, but both are ANDed by the backend.

**Proposal.** Add `normalizeFilters(f): Filters` in imageFilter.ts that enforces aiTagged exclusivity and workflow/workflowSig exclusivity, call it at the end of parseFilters and inside useFilters.setFilters, and delete the per-call-site repairs. Define hasActiveFilter as 'serializeFilters(withoutView(f)) has params' where withoutView drops logic/sort/group/libraryId, so a new axis is picked up by the codec alone. Test: one table-driven vitest that every Filters key round-trips and that a new key without a serialize line fails.

**Evidence.** `packages/frontend/src/lib/imageFilter.ts:52-96`, `packages/frontend/src/lib/imageFilter.ts:98-122`, `packages/frontend/src/lib/imageFilter.ts:134-163`, `packages/frontend/src/lib/imageFilter.ts:176-203`, `packages/frontend/src/lib/imageFilter.ts:286-308`, `packages/frontend/src/lib/imageFilter.ts:315-328`, `packages/frontend/src/lib/imageFilter.ts:357-403`, `packages/frontend/src/pages/AllImagesPage.tsx:485-492`, `packages/frontend/src/pages/AllImagesPage.tsx:1080-1094`, `packages/backend/src/moire/services/image_feed.py:167-170`

### S1.6 api/images.py is four routers in one file and its route order is load-bearing; original-file GET/HEAD repeat path resolution

`split | M | L3 | conf high | tests partial | risk med`

**Problem.** One 644-line router holds the feed (list, ids, groups), media delivery (file/thumb/thumb-url with GET+HEAD, ETag, small-copy limiter), facet lists (models/loras/embeddings/sizes), activity stats, and curation writes (rating/score/quarantine/purge). The fixed paths (/ids, /models, /loras, /embeddings, /sizes, /stats, /groups) only work because they are declared before the `/{image_id:path}` catch-alls; a new route added at the bottom of the file is silently swallowed as an image id. get_image_file and head_image_file (156-209) repeat the lookup, path check, isfile check and mimetype guess.

**Proposal.** Create api/image_media.py (file/thumb/head/thumb-url plus `_original_path(image_id)` shared by GET and HEAD), api/image_facets.py (models, loras, embeddings, sizes, stats), keep feed + curation in images.py. In main.py mount the facets and feed router first and the media/curation routers (which own `/{image_id:path}/...`) last, with a comment and a test that GET /images/stats and /images/sizes are not captured by the catch-all. purge_image should delete the DB rows before unlinking the file so a failed transaction cannot leave a row whose file is gone.

**Evidence.** `packages/backend/src/moire/api/images.py:110-153`, `packages/backend/src/moire/api/images.py:156-209`, `packages/backend/src/moire/api/images.py:254-318`, `packages/backend/src/moire/api/images.py:321-403`, `packages/backend/src/moire/api/images.py:413-452`, `packages/backend/src/moire/api/images.py:558-644`

### S1.7 Model, LoRA and embedding filter counts include quarantined images, Size counts do not; three facet routes are near-copies

`bug | S | L2 | conf med | tests partial | risk low`

**Problem.** CONTEXT.md says counts leave quarantined images out so a count matches its gallery link. /sizes does (`.where(image_tags.not_quarantined())`), but /models, /loras and /embeddings do not, so a dropdown showing 'NahidaXL 120' opens a gallery of fewer images when some are quarantined. The three routes also differ for no reason: loras uses count() while embeddings uses count(distinct image_id), and library scoping is a join in two and a where in the other two.

**Proposal.** One helper `_facet_base(library_id)` returning `select(...).where(not_quarantined())` joined to images when scoped, used by all four routes; use count(distinct image_id) uniformly for the join-table facets. Add an integration test that quarantining an image lowers the model/lora/embedding counts.

**Depends on.** pairs naturally with the api/images.py split

**Evidence.** `packages/backend/src/moire/api/images.py:321-373`, `packages/backend/src/moire/api/images.py:376-403`, `packages/backend/src/moire/services/image_tags.py:517-520`, `packages/backend/src/moire/services/image_feed.py:219-224`

### S1.8 useFilters reads and writes localStorage unguarded, unlike every sibling view-pref hook

`invariant | S | L2 | conf high | tests no | risk low`

**Problem.** useFilters calls localStorage.getItem inside a useMemo during render and setItem on every setFilters, with no try/catch. In a private window or with site data blocked the accessor can throw, which takes down the whole gallery page (and every filter change). useDensity and useScrollRestoration both wrap the same access. The group preference is also a third hand-rolled localStorage store beside density (already noted for tag marks).

**Proposal.** Add lib/prefs.ts with `readPref(key)`/`writePref(key, value)` that swallow storage errors, use them in useFilters, useDensity (also dedupe its clamp, below) and SHORTCUT_HINT_KEY reads. Keep the behaviour otherwise identical.

**Evidence.** `packages/frontend/src/hooks/useFilters.ts:21-31`, `packages/frontend/src/hooks/useDensity.ts:18-28`, `packages/frontend/src/hooks/useScrollRestoration.ts:23-33`

### S1.9 Per-tile preResolved/resolveMediaUrl branch in the load slot is dead for the gallery; density clamp written four times

`dead | S | L2 | conf med | tests yes | risk low`

**Problem.** urls_for_rows sets thumb_url on every feed and groups row (falling back to the key derived from the id), and ThumbnailTile always passes preResolved={!!item.thumb_url}, so the `resolveMediaUrl(srcAtEnqueue)` path, its catch fallback and the `preResolved` prop are only reachable from a unit test; if thumb_url were ever missing, src is '' and resolveMediaUrl('') HEADs the page's own URL. CLAUDE.md keeps lib/media.ts 'for future modes', so lib/media itself stays (ImageView still uses it), but the tile path does not need it. Separately `Math.max(0, Math.min(DENSITY_STEPS.length - 1, Math.round(d)))` appears in targetTileWidth, gridColumns, gapForDensity and useDensity.readStored.

**Proposal.** Remove `preResolved` from useImageLoadSlot and ImageThumbnail so the slot always assigns `src` directly, and drop the resolveMediaUrl mock/test case; render the tile's error state when thumb_url is absent instead of loading ''. Export `clampDensity(d)` from masonryLayout.ts and use it in all four places.

**Evidence.** `packages/frontend/src/hooks/useImageLoadSlot.ts:190-209`, `packages/frontend/src/components/ThumbnailTile.tsx:159`, `packages/frontend/src/components/ImageThumbnail.tsx:58-72`, `packages/backend/src/moire/services/thumb_version.py:46-54`, `packages/frontend/src/lib/masonryLayout.ts:41-44`, `packages/frontend/src/lib/masonryLayout.ts:61`, `packages/frontend/src/lib/masonryLayout.ts:78`, `packages/frontend/src/hooks/useDensity.ts:24`

### S1.10 Grid column count is measured twice, and tile crossfade state machine lives inside ThumbnailTile

`deepen | S | L2 | conf med | tests partial | risk low`

**Problem.** Arrow-key row jumps need the number of packed columns, so the page keeps a second ref (gridWrapRef) just to re-measure the same element and call gridColumns again; the comment at 308-312 documents that any padding mismatch yields a different count. The grid already derives `cols` in one place. In ThumbnailTile, 36 lines of two-layer crossfade state (scrubLayers, scrubFront, lastScrubSrc, a timer and a rAF) sit among the triage-badge markup and are not reusable or testable on their own.

**Proposal.** Give VirtualizedGrid an `onColumns?: (cols:number)=>void` prop (called from the existing useMemo/effect) and have the page store it in a ref used by nextFocusIndex; delete gridWrapRef and the duplicate gridColumns call. Extract the crossfade effect into hooks/useCrossfade.ts returning {layers, front} from a `src` string, and test its sequence (set, swap, clear after SCRUB_CROSSFADE_MS) with fake timers.

**Evidence.** `packages/frontend/src/pages/AllImagesPage.tsx:306-313`, `packages/frontend/src/pages/AllImagesPage.tsx:647-654`, `packages/frontend/src/components/VirtualizedGrid.tsx:83-89`, `packages/frontend/src/components/ThumbnailTile.tsx:94-130`, `packages/frontend/src/components/ThumbnailTile.tsx:35`

**Cross-cutting hints.**

- packages/frontend/src/pages/ImageView.tsx:408,453,515 call resolveMediaUrl, so the gallery-era HEAD mode probe in packages/frontend/src/lib/media.ts:239-244 still runs once per session for original files; worth checking in the S2 review whether the 'url'/'redirect' modes are reachable at all.
- packages/frontend/src/hooks/useBatchScrub.ts and ImageView.tsx:1027 (batchScope) both depend on serializeFiltersForPeek; if the filter codec is split, keep that function beside serializeFilters.
- packages/backend/src/moire/api/images.py:601-642 purge deletes images/image_gen_raw rows but nothing here clears tag_meta cover pins or characters rows that point at the purged image id; check services/tag_index/characters for dangling cover references (S-tags slice).
- packages/frontend/src/components/PinButton.tsx and packages/frontend/src/hooks/usePinCover.ts belong to tag/character covers, not the feed; they are mis-sliced into S1-feed.
- packages/frontend/src/components/SizeFilter.tsx:19-25 exports useSizePresets/ShapeIcon/SIZE_GROUP that the Generate size picker imports (same component-file-as-shared-module pattern as the already-reported character hooks).

## S2-imageview

*The slice is dominated by pages/ImageView.tsx, a 2166-line file with about 15 components and 6 jobs (stage and navigation, preload, phone sheet gestures, tag run, generation panel, batch strip, rating editor) and no test of its own. The small lib/ helpers (sheetSnap, viewportFit, historyNav, rating, countTags) are pure, tested and healthy. Shared pieces (character query hooks, Chip/MonthChart, the optimistic-patch recipe) sit in the wrong files, which causes odd imports and copy-paste. TagFlow, tagDetail and PromptBlock are exactly where tag weights will land, so splitting them first is the cheapest prep.*

### S2.1 Split ImageView.tsx into stage hook, details sheet and panel files

`split | M | L5 | conf high | tests no | risk low TW`

**Problem.** One 2166-line file holds the page (a ~930-line component with about 25 hooks), DetailTabs, TagsSection, AddTags, TagFlow, PromptBlock (ResizeObserver fitting), GenPanel, BatchStrip and RatingEditor. The page body alone fuses commit-on-decode, neighbour preload, feed paging, keyboard, swipe, the phone sheet drag machine and curation. No test touches it, and the tag-weights work (weights on tag runs and the Prompt tab) must edit TagFlow and tagDetail inside this file.

**Proposal.** Cut along existing seams, in this order. (1) Move TagFlow, GroupHeading, KIND_TEXT/KIND_NOUN, tagDetail, UNSURE_*, GROUPS, RUN_TEXT, PANEL_GROUND to components/imageview/TagFlow.tsx (about 280 lines); tag weights edit only this. (2) Move PromptBlock, PanelFit, GuessedBadge, GenPanel, ResourceRow, MetaChip, CopyButton to components/imageview/GenPanel.tsx. (3) Move BatchStrip and RatingEditor to their own files. (4) Extract hooks: useImageStepper(filters, routeId) returning {displayId, pending, index, list, goPrev, goNext, hasMore}, which owns the commit-on-decode effect, preload effect, page-ahead effects and navigateToImage (lines 246-263, 369-574); and useDetailsSheet(phone) returning {infoOpen, setInfoOpen, sheet, setSheet, dragY, sheetDrag, asideRef}, which owns lines 141-215 with snapSheet. ImageView then reads as layout plus wiring at about 450 lines. Pure move, no behaviour change.

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:119-1050`, `packages/frontend/src/pages/ImageView.tsx:1052-1148`, `packages/frontend/src/pages/ImageView.tsx:1477-1653`, `packages/frontend/src/pages/ImageView.tsx:1848-1999`, `packages/frontend/src/pages/ImageView.tsx:2009-2098`, `packages/frontend/src/pages/ImageView.tsx:2100-2166`

### S2.2 Optimistic patch/undo recipe copied three times; hoist into feedCache

`dedupe | S | L4 | conf high | tests partial | risk low`

**Problem.** Score in ImageView (applyScore), rating in RatingEditor, and score in AllImagesPage.triageScore each hand-write the same sequence: cancelQueries on the doc key, patchImageEverywhere, await the API, patch again to beat a racing refetch, undo on failure. The 're-patch on success' trick is only explained in comments, so a fourth writer (e.g. a weight edit) will omit it. Note AllImagesPage's version skips cancelQueries, so the three already differ.

**Proposal.** Add to lib/feedCache.ts (or lib/imageMutations.ts) `async function writeImageField(qc, id, fields: Partial<ImageDoc>, write: () => Promise<unknown>, docId = id): Promise<void>` that does cancelQueries, patchImageEverywhere, await write, re-patch, and on throw calls undo and rethrows. Callers keep only their toast and refresh. One test in feedCache.test.ts covers the race and undo for all three.

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:315-335`, `packages/frontend/src/pages/ImageView.tsx:2117-2135`, `packages/frontend/src/pages/AllImagesPage.tsx:602-619`, `packages/frontend/src/lib/feedCache.ts:144-176`

### S2.3 Character query hooks live in a component file imported by 10 modules

`boundary | S | L3 | conf high | tests partial | risk low`

**Problem.** charactersQuery, useCharacters, usePrefetchCharacters and useCharacterLookup are shared server-state, which lib/queries.ts exists for (its header says so), yet they sit in components/ImageCharacters.tsx. TagPanel, five pages, App and generate/* import a view component to get a hook, creating component-to-component and page-to-component dependencies and pulling the component's heavy imports (SaveOutfitDialog, WornOutfits) into each. ImageCharacters.tsx also imports TAGS_KEY from lib/queries, so the split is half done.

**Proposal.** Move the four exports plus charactersQuery into lib/queries.ts (or lib/characterQueries.ts re-exported from queries), keeping names. Update the 10 import lines. ImageCharacters.tsx keeps only the component and its skeleton. ImageCharacters.test.tsx keeps passing since the component still exports ImageCharacters.

**Evidence.** `packages/frontend/src/components/ImageCharacters.tsx:18-45`, `packages/frontend/src/App.tsx:11`, `packages/frontend/src/components/TagPanel.tsx:17`, `packages/frontend/src/components/SearchPalette.tsx:8`, `packages/frontend/src/components/NewCharacterDialog.tsx:10`, `packages/frontend/src/components/generate/CharacterBlock.tsx:9`, `packages/frontend/src/pages/TagsPage.tsx:51`, `packages/frontend/src/pages/OutfitsPage.tsx:7`, `packages/frontend/src/pages/CharacterPage.tsx:12`, `packages/frontend/src/pages/GeneratePage.tsx:23`

### S2.4 TagPanel doubles as a shared-widget module; image grid and Made-with block cloned in CharacterPage

`dedupe | M | L3 | conf high | tests no | risk low`

**Problem.** jscpd flags TagPanel 360-430 against CharacterPage 288-332: TagImages and CharacterPage.Images are the same pinnable thumbnail grid with open-in-viewer, PendingVeil, PinButton and More button (differing only in columns, page size, noun). The LoRA/Embedding/Workflow ChipRow block is a second parallel copy (TagPanel 230-273 vs CharacterPage 481-535), as is the open-image navigate (TagPanel 396-399 vs CharacterPage useOpenImage). CharacterPage imports Chip, ChipRow and MonthChart from TagPanel, so a panel file is the library for a page. galleryHref is defined three times (TagPanel:40, CharacterPage:46, lib/search.ts:80). knip also flags TagImages as an unused export.

**Proposal.** Create components/tagstats/ with PinnableImageGrid({filters, pinned, noun, onPin(id,unpin), pageSize, cols}) (absorbs TagImages, CharacterPage.Images and useOpenImage, which becomes a hook in hooks/useOpenImage.ts), MadeWithChips({loras, embeddings, workflows, baseFilter, share}) and move Chip, ChipRow, MonthChart there. Put one galleryHref(patch) in lib/imageFilter.ts and use it in all three places. TagPanel and CharacterPage then import from tagstats/. Keep CharacterPage's extra lora tooltip as a render prop or title formatter on the lora entries.

**Evidence.** `packages/frontend/src/components/TagPanel.tsx:230-273`, `packages/frontend/src/components/TagPanel.tsx:301-367`, `packages/frontend/src/components/TagPanel.tsx:374-443`, `packages/frontend/src/pages/CharacterPage.tsx:11`, `packages/frontend/src/pages/CharacterPage.tsx:46`, `packages/frontend/src/pages/CharacterPage.tsx:260-267`, `packages/frontend/src/pages/CharacterPage.tsx:288-340`, `packages/frontend/src/pages/CharacterPage.tsx:481-535`, `docs/refactor-pass/leads.txt:95-96`

### S2.5 countTags re-implements prompt term splitting and weight stripping beside promptOutline

`dedupe | M | L3 | conf med | tests yes | risk med TW`

**Problem.** Two frontend parsers of the same prompt grammar. countTags.terms/groupTracker/normalise splits on commas with its own bracket depth (counts {} and ignores the backslash escape), strips weight with /:[\d.]+$/ and canonicalises; promptOutline.splitSpans/unwrap/readTerm does the same with escape handling, ( and [ only, and a different WEIGHT regex (signed, whitespace). A term like `kafka_\(honkai\)` or a lone escaped paren is read differently by the two, so a count tag can be flagged or skipped on text the board reads as plain. The tag-weights plan already calls out that promptOutline unwrap must be ported to the backend and tested against a shared fixture; countTags is a third copy that will drift when weights change the grammar.

**Proposal.** Rebuild countTags.terms() on promptOutline.promptTerms(): filter kind==='tag' and group-wrapped terms out via a flag, use term.name for normalise (adding the digit-underscore fix `2_girls` to 2girls only), and keep offsets from start/end. Delete groupTracker, normalise's bracket/weight regexes and terms(). Keep fixCountTags/followCast, which only need ranges. Then the shared-fixture test for the weight rule covers both.

**Evidence.** `packages/frontend/src/lib/countTags.ts:44-54`, `packages/frontend/src/lib/countTags.ts:71-97`, `packages/frontend/src/lib/promptOutline.ts:28-60`, `packages/frontend/src/lib/promptOutline.ts:62-135`, `packages/frontend/src/pages/GeneratePage.tsx:70`, `docs/tag-weights-plan.md:21`

### S2.6 Global keydown ignores modifier keys: Ctrl/Cmd+1..5, Alt+Arrow hijacked

`bug | S | L3 | conf med | tests no | risk low`

**Problem.** onKey tests e.key only. Ctrl+1..5 (browser tab switch), Cmd+0 (reset zoom) score the image and call preventDefault; Alt+ArrowLeft/Right (browser back/forward) and Ctrl+ArrowLeft are swallowed as prev/next; Ctrl+X / Cmd+X (cut) quarantines the image while a non-input element is focused. Escape also closes the view even while a Picker or dialog is open if the focus is not in a form field (the rating Picker popup, ConfirmDialog from Re-tag).

**Proposal.** At the top of onKey add `if (e.ctrlKey || e.metaKey || e.altKey) return;` and skip when e.defaultPrevented (so an open Picker/dialog that handled Escape wins). Put the guard in a shared helper in lib/dom.ts (`isPlainKey(e)`) since AllImagesPage's triage handler has the same shape (shortcuts.ts lists the same keys).

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:578-621`, `packages/frontend/src/lib/shortcuts.ts:44-45`, `packages/frontend/src/lib/shortcuts.ts:63-64`

### S2.7 Original-file URL built by hand five times in ImageView

`dedupe | S | L2 | conf high | tests no | risk low`

**Problem.** `/api/v1/images/${encodeURIComponent(id)}/file` is spelled five times, and the resolve-then-set-src-and-decode sequence appears three times (current-image resolve effect at 404-417, commit-on-decode at 451-466, neighbour preload at 514-523). The fifth (download link) already has a different fallback shape. imageMutations has `forImage(id, suffix)` for the same family of URLs but it is private, and lib/queries already hand-builds `/thumb-url` the same way.

**Proposal.** Export `imageFileUrl(id)` (and `imageUrl(id, suffix)` generalising forImage) from lib/media.ts, and add `loadImage(id, {priority}): Promise<{src, img}>` there that resolves, sets src and awaits decode(). The three effects call it; the page keeps only their cancel/timer logic. Folds neatly into the useImageStepper extraction in the split finding.

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:381`, `packages/frontend/src/pages/ImageView.tsx:406`, `packages/frontend/src/pages/ImageView.tsx:451`, `packages/frontend/src/pages/ImageView.tsx:514`, `packages/frontend/src/pages/ImageView.tsx:949-951`

### S2.8 imageMutations holds tag and character writes, contradicting its 'per-image' contract; JSON boilerplate repeated

`naming | S | L2 | conf high | tests no | risk low`

**Problem.** CONTEXT.md defines imageMutations as 'every write the UI can make to one Image', mirroring services/image_tags.py. Half the file is not that: setTagThumbnail, clearTagThumbnail, updateCharacter, setTagFocus, createCharacter, deleteCharacter and bulkManualTags write tag or character state or many images. Also setTagThumbnail has two stacked doc comments (the first is stale), and 5 functions repeat headers+JSON.stringify by hand while only post() factors it out (post can't do PATCH/PUT). The header comment narrates history ('were split three ways').

**Proposal.** Split into lib/imageMutations.ts (rating, score, quarantine, purge, applyTags, removeTags, bulkManualTags) and lib/tagMutations.ts (thumbnail, focus, character CRUD); update 6 or so import sites. Generalise post to `send(method, url, body?)` so the PATCH/PUT/DELETE ones shrink to one line each. Trim the history-style header and the duplicate docstring.

**Evidence.** `packages/frontend/src/lib/imageMutations.ts:1-9`, `packages/frontend/src/lib/imageMutations.ts:61-82`, `packages/frontend/src/lib/imageMutations.ts:98-136`, `packages/frontend/src/lib/imageMutations.ts:12-23`

### S2.9 Rating vocabulary spread over three places; ratingBadgeClass has a phantom 'safe'

`drift | S | L2 | conf high | tests yes | risk low`

**Problem.** CONTEXT.md says a Rating is one of -, general, sensitive, questionable, explicit, normalised in one place on the backend. The frontend lists the set at the end of ImageView (RATING_OPTIONS), again as switch cases in rating.ts (which also accepts a non-existent 'safe'), and again as RATING_ORDER in CharacterPage. A new rating or a rename needs three edits and the type is plain string everywhere.

**Proposal.** In lib/rating.ts define `export const RATINGS = ['general','sensitive','questionable','explicit'] as const; type Rating`, a RATING_OPTIONS derived from it (with the '-' => Unrated option), and a single `RATING_STYLE: Record<Rating,{badge,dot}>` replacing the two switch functions (ratingBadgeClass/ratingDotClass become lookups). Drop 'safe'. CharacterPage imports RATINGS for its order. rating.test.ts already covers the pure part.

**Evidence.** `packages/frontend/src/pages/ImageView.tsx:2160-2166`, `packages/frontend/src/lib/rating.ts:32-57`, `packages/frontend/src/pages/CharacterPage.tsx:44`

### S2.10 Two hand-rolled localStorage external stores for view prefs (useTagMarks vs DETAIL_TAB_KEY)

`dedupe | S | L2 | conf low | tests partial | risk low`

**Problem.** useTagMarks implements read/write/subscribe/storage-event sync with try/catch around localStorage; DetailTabs repeats the try/catch read/write by hand with useState (so it does not sync across tabs and a second consumer would diverge), and useDensity (S1) is a likely third. Each copy re-solves the private-mode failure case.

**Proposal.** Add hooks/useLocalPref.ts: `createLocalPref<T>(key, parse, default)` returning {use(), set()} built on useSyncExternalStore with the storage listener, and port useTagMarks (keeping its exported setTagMarks and test) and DetailTabs' tab choice to it. Only worth doing if useDensity confirms a third caller; verify before starting.

**Evidence.** `packages/frontend/src/hooks/useTagMarks.ts:329-376`, `packages/frontend/src/pages/ImageView.tsx:1052-1061`, `packages/frontend/src/pages/ImageView.tsx:1096-1106`, `packages/frontend/src/hooks/useDensity.ts`

**Cross-cutting hints.**

- packages/frontend/src/pages/AllImagesPage.tsx:602-619 repeats the optimistic score recipe and has a global-keydown handler with the same missing modifier guard (S1 should check).
- packages/frontend/src/lib/queries.ts:69 hand-builds an /api/v1/images/:id/ URL like ImageView does; an imageUrl(id, suffix) helper could serve both.
- packages/frontend/src/hooks/useDensity.ts: check whether it is a third localStorage external-store copy next to useTagMarks.
- packages/frontend/src/pages/CharacterPage.tsx:44 RATING_ORDER and :46 galleryHref duplicate lib-level concepts (rating set, gallery link builder).
- packages/frontend/src/lib/countTags.ts is a Generate-page concern living in an ImageView slice; S-slice for GeneratePage should own its test review.
- packages/frontend/src/components/ImageCharacters.tsx:70-74 filters characters by tag names in the component; same name-matching rule probably exists in lib/character.ts and services/characters.py (S3/S4 could check for drift).
- packages/frontend/src/pages/ImageView.tsx:1413 hardcodes PANEL_GROUND #15141c, a copy of the tailwind surface token; lib/tagColour.tagMarkStyle takes it as a parameter so any theme change breaks outline colours silently.

## S3-tagcore

*The tag core is in decent shape: image_tags is a genuine single owner, tag_names/tag_canon/tag_categories are small pure modules, and invalidation really is structural. The weak spots are structural: tag_index (786 lines) fuses cache primitives, cover pins, mosaic samples, browse, character classification and the 8-query detail panel; cover pins and focus (tag_meta/tag_focus) are written from five modules including the router; and 'is this tag a character' has two implementations that disagree. The image_tags/tag_index import cycle (broken by a lazy import) is also the shape problem the tag-weights write path will land in. Already-reported items touching this slice (find_image projection, id_candidates loops, bulk prompt write twin, clear_ai_all unbounded tx, deprecated POST /tags/ai, app_settings JSON helper copies) are not repeated.*

### S3.1 Renaming a source-specific tag moves the cover, focus and character settings of the shared base name

`bug | S | L4 | conf med | tests partial | risk low`

**Problem.** Pins, focus and `characters` rows are keyed by base name (`pin_key` strips the kind prefix). `_move_thumbnail` and `_move_character` run `pin_key` on both sides, so renaming only `manual:foo` to `manual:bar`, or writing a prompt rule `foo -> bar`, relocates the pinned cover, its framing and the whole `characters` row of base `foo` to `bar` even though the AI tag `foo` (or other sources) still exists and still owns that page. With a merge onto an existing target the old pin is simply deleted. A user who renames a manual duplicate of a character tag can lose the character page's avatar, colour and kind override.

**Proposal.** Only carry pin/focus/character state when no other source of the old base remains after the operation: add `_base_survives(conn, old_base)` (an EXISTS on `image_tags.base == old_base` excluding the tag being renamed) and skip `_move_thumbnail`/`_move_character` when true. Add a test in test_tag_rename_integration.py: AI tag `foo` pinned, rename `manual:foo` to `manual:bar`, assert the `foo` pin is untouched.

**Evidence.** `packages/backend/src/moire/services/tag_rename.py:62-94`, `packages/backend/src/moire/services/tag_rename.py:370-381`, `packages/backend/src/moire/services/tag_rename.py:494-497`, `packages/backend/src/moire/services/tag_rename.py:475-481`, `packages/backend/src/moire/services/tag_index.py:190-196`

### S3.2 Two diverging definitions of 'is a character': tag_rename._character_names vs tag_index._characters

`dedupe | M | L4 | conf high | tests partial | risk med`

**Problem.** The Tags page decides character-ness in `tag_index._characters` (listed names, plus bare-name candidates the library backs via `_listed_characters`, then `characters.kind` overrides, treating kind NULL as no override). The rename/split guard and merge-suggestions filter use `tag_rename._character_names`, which takes only `vocab.names`, ignores library-backed bare candidates (`furina`), and treats a kind-NULL `characters` row as a character (the else branch). So a bare-name character the Tags page shows as a character can still be split by a rule ('is a character, so it can't be split' is not raised), and suggestions are offered for it. CONTEXT.md says the library check lives in tag_index but the vocabulary concept belongs with tag_categories.

**Proposal.** Move `_characters`, `_listed_characters` and `_may_be_characters` out of tag_index into one `services/character_names.py` (or tag_categories) exposing `async def character_names(conn, vocab, bases: set[str] | None) -> frozenset[str]` (bases None = every library base, using the cheap candidate walk). tag_index._browse, tag_rename (`_write_rule`, `merge_suggestions`) and characters.py call it. Delete `tag_rename._character_names`. Decide the kind-NULL semantics once (tag_index's: no override).

**Evidence.** `packages/backend/src/moire/services/tag_rename.py:418-431`, `packages/backend/src/moire/services/tag_index.py:554-578`, `packages/backend/src/moire/services/tag_index.py:581-588`, `packages/backend/src/moire/services/tag_index.py:591-637`, `packages/backend/src/moire/services/tag_categories.py:410-411`

### S3.3 Split tag_index.py: cache primitives, cover pins, browse, character classification and the detail panel are fused

`split | L | L4 | conf high | tests yes | risk med TW`

**Problem.** One 786-line module owns six jobs. `detail` alone is a 128-line function issuing 8 queries (span, kinds, months, loras, embeddings, sigs, related, pin) that repeats the same 'row's image is not quarantined' EXISTS that `image_ids` and `_listed_characters` also build. characters.py reaches into the private `tag_index._pins`. The tag-weights spread aggregate (plan step 4) would add a ninth query to `detail`.

**Proposal.** Keep tag_index.py as the cache owner only (invalidate, generation, read/store view/derived, ~90 lines, imported by writers). Move: (1) `pin_key`, `_pins`, `_seed*`, `_shuffled`, `samples_for_tag` to `tag_covers.py` (public `pins(conn, bases)` replaces characters.py's private reach-in); (2) `_browse`, `browse`, `character_rows`, `list_tags` to `tag_browse.py`; (3) `detail` plus `image_ids` to `tag_detail.py`, one small private function per panel section (`_months`, `_loras`, `_embeddings`, `_workflows`, `_related`) and a single `_visible_tag_rows()` fragment shared with `image_ids`; (4) character classification per the previous finding. Pure move first, no behaviour change; the existing test_tag_index.py/test_tags_page_integration.py pin it.

**Evidence.** `packages/backend/src/moire/services/tag_index.py:57-140`, `packages/backend/src/moire/services/tag_index.py:142-210`, `packages/backend/src/moire/services/tag_index.py:285-395`, `packages/backend/src/moire/services/tag_index.py:417-551`, `packages/backend/src/moire/services/tag_index.py:554-637`, `packages/backend/src/moire/services/tag_index.py:659-786`, `packages/backend/src/moire/services/characters.py:537`

### S3.4 Cover pins and focus (tag_meta, tag_focus) are written from five modules including the router

`boundary | M | L3 | conf high | tests partial | risk low`

**Problem.** set_tag_thumbnail / clear_tag_thumbnail build a `sqlite_insert(t.tag_meta)` upsert, an image-carries-tag EXISTS and the `tag_index.invalidate()` call inside the router (a router doing SQL, and a call-site invalidate, which CLAUDE.md says to avoid). The same table is also touched by tag_rename (move), tag_migrations (rekey) and library_nesting (repoint), while its read side (`_pins`, `pin_key`) is in tag_index and its sibling table tag_focus is in tag_focus.py. There is no single owner for a tag's cover.

**Proposal.** Create `services/tag_covers.py` owning both tables: `pin_key`, `pins(conn, bases)`, `async set_pin(tag_key, names, image_id) -> bool` (does the carries-tag check, upsert and invalidate, returns False for the 404), `clear_pin(tag_key)`, `move(conn, old, new)` (today's `_move_thumbnail` focus+pin half), and the focus functions from tag_focus.py (`clean`, `put`, `get`, `all_focus`, `for_cover`). The two thumbnail routes shrink to validate, call, map to HTTP; the face_detect call stays in the router or characters.

**Evidence.** `packages/backend/src/moire/api/tags.py:362-415`, `packages/backend/src/moire/services/tag_rename.py:62-94`, `packages/backend/src/moire/services/tag_migrations.py:111-136`, `packages/backend/src/moire/services/library_nesting.py:257`, `packages/backend/src/moire/services/tag_focus.py:556-600`, `packages/backend/src/moire/services/tag_index.py:199-209`

### S3.5 PUT /tags/focus runs the full 8-query detail aggregate just to learn the pin and existence

`simplify | S | L3 | conf high | tests partial | risk low`

**Problem.** `set_tag_focus` calls `tag_index.detail(base, 'all')` (months, loras, embeddings, workflows, related, characters) and uses only `got['thumb_image_id']` (the pin) and `is None` (existence). Each focus nudge in the picker pays the whole panel cost. `tag_detail` then recomputes the same cover with `_cover_of`.

**Proposal.** Add `tag_covers.cover_of(base) -> str | None` (pin if present and visible, else the mosaic lead via `samples_for_tag('any:'+base, 1)`; None when no visible image carries the base) and use it in set_tag_focus (404 when None) and tag_detail (which already has the pin from `detail`). Delete the router-level `_cover_of`.

**Evidence.** `packages/backend/src/moire/api/tags.py:346-359`, `packages/backend/src/moire/api/tags.py:338-343`, `packages/backend/src/moire/services/tag_index.py:659-786`

### S3.6 api/tags.py builds service-level caches and repeats a library-bases query

`boundary | M | L3 | conf high | tests partial | risk low`

**Problem.** `_tag_maps`, `_library_bases`, `board_offers` and `place_tags` assemble derived caches (generation capture, `read_derived`/`store_derived`, `asyncio.to_thread`, a module-global asyncio.Lock) and run SQL in the router. `_tag_maps` and `_library_bases` both run `SELECT DISTINCT image_tags.base` and cache separately, so a tag write triggers the scan twice. The idiom `tag_index.pin_key(validate_tags([tag])[0])` appears 8 times.

**Proposal.** Move `library_bases()`, `tag_maps()` and `board_offers()` into a `services/tag_views.py` (they are derived views over the tag index with the same invalidation rule); `tag_maps` takes its `library` from `library_bases()`. In the router add one dependency `def _base(tag: str = Query(...)) -> str` returning `pin_key(validate_tags([tag])[0])` for character/detail/focus/thumbnail routes. Router keeps only HTTP mapping.

**Evidence.** `packages/backend/src/moire/api/tags.py:56-87`, `packages/backend/src/moire/api/tags.py:136-171`, `packages/backend/src/moire/api/tags.py:260`, `packages/backend/src/moire/api/tags.py:297`, `packages/backend/src/moire/api/tags.py:322`, `packages/backend/src/moire/api/tags.py:350`, `packages/backend/src/moire/api/tags.py:366`

### S3.7 Rule changes reproject synchronously in two of three paths while add_rules has a background threshold

`invariant | S | L3 | conf high | tests partial | risk low`

**Problem.** `add_rules` reprojects inline up to 500 images, otherwise `reproject_ids_async`. `rename_tag` (prompt branch) and `delete_alias` always run `reproject_ids` inline via `anyio.to_thread`, with no cap and no activity task, so merging or deleting a rule on a tag used by tens of thousands of images holds the HTTP request (and the single SQLite writer in 500-id chunks) for minutes, then returns a count the UI treats as done. The three paths also differ on who invalidates the tag index (inline: caller; async: reproject).

**Proposal.** Extract `async def _apply(affected: list[str]) -> bool` in tag_rename.py: sorted ids, inline up to `_SYNC_REPROJECT` (then `tag_index.invalidate()`), else `reproject_ids_async`; returns `background`. Use it in rename_tag, add_rules and delete_alias, and add `background` to the rename/delete responses (frontend already reads it for add_rules).

**Evidence.** `packages/backend/src/moire/services/tag_rename.py:512-514`, `packages/backend/src/moire/services/tag_rename.py:525-570`, `packages/backend/src/moire/services/tag_rename.py:670-674`, `packages/backend/src/moire/services/reproject.py:237-249`, `packages/backend/src/moire/services/reproject.py:339-345`

### S3.8 Split image_tags into a pure tag-kinds vocabulary and the writer; this removes the tag_index import cycle

`deepen | M | L3 | conf med | tests yes | risk med TW`

**Problem.** image_tags.py mixes four layers: pure tag-kind vocabulary (prefixes, canonical_tag, any: expansion, tag_match_groups, excluded_prefixes, base_of), rating normalization, image-id variants/row_to_doc, and the transactional writers. tag_index imports image_tags only for prefix helpers and `not_quarantined`, which forces image_tags to import tag_index lazily inside `_dirty_tag_index` ('keeping the import local is what breaks the cycle'). The tag-weights work will add weight handling into `_persist_statements` and the bulk twin, both in the 621-line module.

**Proposal.** Extract `services/tag_kinds.py` (no DB imports): MANUAL_PREFIX/PROMPT_PREFIX/ANY_PREFIX, is_*/to_*/base_of, canonical_tag, any_variants/expand_search_tag/tag_match_groups, excluded_prefixes, recompute_flags, plus `not_quarantined` into a tiny `image_filters` or schema helper. tag_index and every reader import tag_kinds; image_tags imports tag_index at module scope and re-exports nothing (update ~25 callers, mechanical). Keep `normalize_rating`, writers and scalar setters in image_tags.

**Depends on.** Do before adding prompt weights to _persist_statements

**Evidence.** `packages/backend/src/moire/services/image_tags.py:55-165`, `packages/backend/src/moire/services/image_tags.py:318-329`, `packages/backend/src/moire/services/image_tags.py:517-520`, `packages/backend/src/moire/services/tag_index.py:42`, `packages/backend/src/moire/services/tag_names.py:1-13`

### S3.9 GET /tags (non-merged) computes thumbnails and pins nothing reads

`dead | S | L2 | conf med | tests partial | risk low`

**Problem.** The frontend's only two callers are `useTagAggregate` (type `{_id, count}`, used by OverviewPage for `tags.length`) and the gallery autocomplete with `merge_sources=1`. The per-tag branch still selects `MAX(image_id)` as `sample_image_id`, queries `tag_meta` pins and returns `thumb_image_id` per tag; that value can be a quarantined image and nothing consumes it. It is an extra join plus a payload field per tag on a library with tens of thousands of tags.

**Proposal.** Drop `sample_image_id`, the `_pins` call and `thumb_image_id` from the non-merge branch of `list_tags` (return `{_id, count}`), update test_tags_integration.py expectations if they assert it. Optionally give Overview a dedicated count instead of the whole list.

**Evidence.** `packages/backend/src/moire/services/tag_index.py:249-282`, `packages/backend/src/moire/api/tags.py:36-49`, `packages/frontend/src/lib/queries.ts:105-129`, `packages/frontend/src/pages/OverviewPage.tsx:27-35`, `packages/frontend/src/pages/AllImagesPage.tsx:192-202`

### S3.10 'alias' names three different things; the user's merge rules are still called aliases in code and routes

`naming | S | L2 | conf high | tests yes | risk low TW`

**Problem.** CONTEXT.md calls the user's rewrites Merge/Split rules (`tag_rules`), but the code says `apply_aliases` (tag_names), `_load_aliases` (reproject), `list_aliases`/`delete_alias` (tag_rename), `/tags/aliases` routes, while `danbooru_tags.TagList.aliases`, `tag_descriptions.with_aliases` and `characters` 'aliases' (bare names) mean other things. Reproject also keeps its own sync `tag_rules` reader beside tag_rename._load_rules, and `apply_aliases` lives in tag_names though it is rule application, so weight-carrying merges will have to touch an oddly placed function.

**Proposal.** Rename `apply_aliases` to `apply_rules` and move it beside the rule reader (a small `tag_rules.py` holding `load_rules_sync`, `async load_rules`, `apply_rules`, used by tag_rename and reproject); rename `list_aliases`/`delete_alias`/`add_aliases` to `*_rules`. Keep the `/aliases` URL for now (frontend contract) or alias it in the same pass. Leave Danbooru and character 'aliases' as they are.

**Evidence.** `packages/backend/src/moire/services/tag_names.py:59-66`, `packages/backend/src/moire/services/tag_rename.py:644-657`, `packages/backend/src/moire/services/reproject.py:44-52`, `packages/backend/src/moire/services/reproject.py:206`, `packages/backend/src/moire/api/tags.py:479-512`, `packages/backend/src/moire/services/danbooru_tags.py:54-63`

**Cross-cutting hints.**

- packages/backend/src/moire/services/characters.py:537 calls the private tag_index._pins; characters.py:446-450 uses tag_index.read_view/store_view as a side cache (only caller), so a split of tag_index must keep those two seams.
- packages/backend/src/moire/services/tag_names.py:21 KAOMOJIS is the only non-name content of tag_names and is consumed by prompt_parse.py:38; consider living in prompt_parse or a shared vocab since tag_names should stay the one spelling rule.
- packages/backend/src/moire/services/reproject.py:44-52 and 206 read tag_rules with a second sync loader (see tag_rules.py proposal); the extraction-config finding in docs/tag-weights-plan.md should include it.
- packages/backend/src/moire/services/tag_migrations.py:44-60 is another hand-written app_settings JSON row read/upsert (part of the already reported 8-module duplication); tag_settings.py:496-522 is a ninth.

## S4-tagsui-rules

*The slice is in decent shape: the pure tag logic (tags.ts, tagBrowse.ts, mergeSuggestions.ts, tagGroups.ts, fuzzy.ts) is already in lib/ with colocated tests, and useRulesetSession is a well-reasoned deep module. The weight is in two oversized pages (TagsPage 844 lines, RulesPage 867) that mix data fetching, mutation copy and markup, and in api/rules.py, which is a service layer written inside a router. Duplication clusters around three concepts: the tags/samples fetch (3 hand-rolled copies), suggestion-list keyboard nav (about 8 copies), and workflow-family naming (rules.py vs generator_setup.py). One small real bug in RenameTagDialog. Already reported elsewhere and not repeated: signatures query inlined in components, native window.confirm default in useRulesetSession, hand-rolled localStorage stores.*

### S4.1 api/rules.py is a service layer inside a router: 170-line list_signatures, route calling route, no rulesets/workflow-names module

`boundary | M | L4 | conf high | tests partial | risk low`

**Problem.** list_signatures builds the signature index, samples, family ids, names, file matches and node-type descriptions inline (SQL, json parsing, two closures). import_workflow_files then calls list_signatures() (a route handler, full signature scan with sample graph parsing) just to learn which workflow ids are known. put_workflow_name and import_workflow_files hold their upserts in the router. gen_rulesets is read in three modules (rules.py, reproject._load_rulesets, generator_setup) but only written here, with no owner. put/delete_ruleset re-import reproject_by_sig_async inline although `reproject` is already imported at the top (line 22). preview_ruleset repeats the id_candidates raw lookup that api/images.py:528-542 also has (jscpd clone).

**Proposal.** Create services/workflow_signatures.py with `async def list_signatures() -> list[dict]` (the current body, split into `_sample_rows(conn, sigs)`, `_family_labels(conn, family_ids)`) and `async def known_workflow_ids(conn, ids)` (one cheap query, so import no longer calls a route). Create services/rulesets.py owning gen_rulesets: `get/list/put/delete` plus the reproject trigger, and move workflow_names/workflow_files upserts next to them (or into workflow_family.py). Add `image_tags.gen_raw_for(conn, image_id)` (or services/gen_raw.py) returning the raw doc via id_candidates and use it in rules.preview_ruleset and images.get_image_workflow. The router then only parses bodies and maps errors. Drop the inline imports.

**Evidence.** `packages/backend/src/moire/api/rules.py:57-214`, `packages/backend/src/moire/api/rules.py:287`, `packages/backend/src/moire/api/rules.py:335-347`, `packages/backend/src/moire/api/rules.py:221-290`, `packages/backend/src/moire/api/rules.py:351-381`, `packages/backend/src/moire/services/reproject.py:36-41`, `packages/backend/src/moire/services/generator_setup.py:138-143`

### S4.2 Workflow family id/name/file-match resolved twice with different code (rules._family vs generator_setup.load_image_source)

`dedupe | S | L3 | conf high | tests partial | risk low`

**Problem.** workflow_family.WORKFLOW_ID is the SQL definition of a family key (workflow.id, else moire.family). generator_setup re-derives the same key in Python by hand (isinstance chains), then repeats the name lookup, the unnamed-family file fallback (workflow_files + editor_node_types + match_workflow_file) that rules._family does. The module docstring promises that the Rules page and the gallery 'can never disagree about what a family holds', but the Generator setup path is a third reader with its own copy; a change to the family key or the fallback order (e.g. a new moire.* key) must be made in three places.

**Proposal.** Add to services/workflow_family.py a pure `family_id_of(raw: dict) -> str | None` (mirror of WORKFLOW_ID, with a test that SQL and Python agree on a table of raw docs) and `async def label_for(conn, family_id, ui_nodes) -> {name, file_name, file_match}` implementing 'saved name, else best imported file'. rules.list_signatures batches over many families, so give it `labels_for(conn, {family_id: ui_nodes})` and have label_for call it with one entry. Use from both rules.py and generator_setup.py.

**Evidence.** `packages/backend/src/moire/api/rules.py:169-186`, `packages/backend/src/moire/api/rules.py:120-147`, `packages/backend/src/moire/services/generator_setup.py:103-135`, `packages/backend/src/moire/services/workflow_family.py:18-27`

### S4.3 /tags/samples fetched by hand in three places; Sample type lives in a component file

`dedupe | M | L3 | conf high | tests no | risk med`

**Problem.** TagsPage.TagGrid keeps its own request cache (a `requested` ref, `samples` state, an `epoch` prop to reset it, manual retry-on-fail), TagPanel and PromptBoard each build the same URL with raw `api()` inside a useQuery with different keys (`[...TAGS_KEY,'samples',id]` vs `[...TAGS_KEY,'samples',id,4]`) and different staleTime. The TagsPage copy can race: a stale batch resolving after the epoch reset repopulates `samples`. The same card therefore fetches its mosaic three ways, and a pinned-cover change invalidates them inconsistently. CLAUDE says components should go through lib/queries, not raw fetch.

**Proposal.** In lib/queries.ts add `fetchTagSamples(ids: string[], per=4, signal)` and `useTagSamples(id: string | null)` (single id, key `[...TAGS_KEY,'samples',id]`, staleTime 60s), plus `Sample` type moved there (TagMosaic imports it). Use it in TagPanel and PromptBoard directly. For the grid, each NumeralCard calls `useTagSamples` and a small batching layer (a microtask-coalesced queryFn via `queryClient.fetchQuery` with a shared pending set, or `useQueries` over the visible ids with one multi-id fetch) replaces the ref/epoch machinery; invalidating TAGS_KEY then refreshes mosaics for free.

**Evidence.** `packages/frontend/src/pages/TagsPage.tsx:583-608`, `packages/frontend/src/components/TagPanel.tsx:88-96`, `packages/frontend/src/components/generate/PromptBoard.tsx:147-155`, `packages/frontend/src/components/TagMosaic.tsx:7`

### S4.4 RulesPage is one 760-line component doing picker, import, rename, collapse, rule editor, preview and graph search

`split | M | L3 | conf high | tests partial | risk low`

**Problem.** About 20 hooks and four independent jobs share one closure. Pure logic is trapped in it: the picker's search filter (137-151), the guessed-path derivation (`guessPath`, `guessMarks`, 341-353), and the import summary string building (200-231). The pin+toast action is written twice (pinPath 281-287 and the inline version 773-776). The page re-exports JsonTree/matchesQuery/collectMatches (line 52) only so RulesPage.test.tsx can import them, which is a test seam through a page (and breaks react-refresh).

**Proposal.** Split along existing comment boundaries into components/rules/: `WorkflowPicker.tsx` (families list, search, rename, collapse state, drag-drop and Import menu; props: families, selected, onSelect, onChanged), `RuleEditor.tsx` (action bar, field cards with pin chips; props: session, preview, activeField), `GraphPanel.tsx` (graphQuery, matches, revealPath, JsonTree). Move to lib/workflows.ts with tests: `filterFamilies(families, q)`, `importSummary({imported, known, skipped})`; to lib/gen.ts: `guessedPaths(gen, fields)` returning guessPath and the marks map. Make one `pin(field, path)` handler in the page. Point the test at GraphTree directly and drop the re-export.

**Evidence.** `packages/frontend/src/pages/RulesPage.tsx:109-376`, `packages/frontend/src/pages/RulesPage.tsx:408-635`, `packages/frontend/src/pages/RulesPage.tsx:647-782`, `packages/frontend/src/pages/RulesPage.tsx:784-859`, `packages/frontend/src/pages/RulesPage.tsx:281-287`, `packages/frontend/src/pages/RulesPage.tsx:773-776`, `packages/frontend/src/pages/RulesPage.tsx:137-151`, `packages/frontend/src/pages/RulesPage.tsx:52`

### S4.5 TagsPage (844 lines) mixes rule/rename mutations with toast copy, five card components and a sheet layout

`split | M | L3 | conf high | tests partial | risk low`

**Problem.** onRename, onUndoRule and onAcceptSuggestions (cache invalidation, selection change and the multi-clause toast message including the 'skipped N more' formatting) live inside the page component, so none of the toast text or the post-write invalidation set is testable. The merge-rules list (346-365) is inline markup next to MergeSuggestions, which is a component. TagSection, TagGrid, SpineCard, NumeralCard, TagRow, Described, LoadingGrid and SpecialTile are module-private in the page file. madeRows' useMemo omits `group` from its deps (works only because TagGroupPage remounts via key).

**Proposal.** Extract `hooks/useTagRuleActions.ts` returning {rename, undoRule, acceptSuggestions} that owns afterTagWrite (invalidateFeeds + TAG_ALIASES_KEY + MERGE_SUGGESTIONS_KEY) and calls pure message builders `renameMessage(res)`, `acceptMessage(res)` in lib/tagBrowse.ts (with tests for the skipped-list truncation). Move the card/row/section components to components/tags/TagCards.tsx and the rules list to components/MergeRules.tsx, leaving the page as filter bar + layout. Fix the dep array.

**Evidence.** `packages/frontend/src/pages/TagsPage.tsx:167-230`, `packages/frontend/src/pages/TagsPage.tsx:346-365`, `packages/frontend/src/pages/TagsPage.tsx:513-810`, `packages/frontend/src/pages/TagsPage.tsx:241-256`, `packages/frontend/src/pages/TagsPage.tsx:60-74`

### S4.6 Suggestion-list keyboard nav and ranking copied across about 8 inputs; rankSuggestions/resourceLabel live in a component file

`deepen | M | L3 | conf high | tests partial | risk low`

**Problem.** Every TagSuggestList consumer re-implements the same active-index state, ArrowUp/ArrowDown clamping, Enter-picks-highlight, reset-on-text-change and the `showList` rule, in slightly different forms (RenameTagDialog even adds 'hide when the only match equals the text'). The pure ranking (rankSuggestions, TYPED_KIND parsing, resourceLabel) is a lib function stuck in a .tsx file with its test in components/, and resourceLabel re-decodes what lib/imageFilter.resourceOf already parses.

**Proposal.** Move rankSuggestions, resourceLabel, TagSuggestion and MAX_SUGGESTIONS to lib/tagSuggest.ts (test moves with it). Add `hooks/useSuggestNav(matches, {onPick})` returning `{active, setActive, onKeyDown(e): boolean, reset}` where onKeyDown handles Up/Down/Enter and returns true when it consumed the key; consumers keep only their own extras (comma, Backspace, Escape). Convert RenameTagDialog and TagSearchInput first, then the generate/* inputs.

**Evidence.** `packages/frontend/src/components/RenameTagDialog.tsx:44-52`, `packages/frontend/src/components/RenameTagDialog.tsx:115-128`, `packages/frontend/src/components/TagSearchInput.tsx:49-86`, `packages/frontend/src/components/TagSuggestList.tsx:28-65`, `packages/frontend/src/components/TagSuggestList.tsx:111-117`, `packages/frontend/src/components/NewCharacterDialog.tsx:157-159`, `packages/frontend/src/components/generate/Outfit.tsx:164-167`, `packages/frontend/src/components/generate/CharacterBlock.tsx:260-263`, `packages/frontend/src/components/generate/PromptInput.tsx:252-255`, `packages/frontend/src/components/generate/ChipInput.tsx:84`

### S4.7 RenameTagDialog offers AI tags as merge targets when renaming a manual tag

`bug | S | L2 | conf med | tests no | risk low`

**Problem.** `options = known.filter(t => t._id !== raw && isPrompt(t._id) === prompt)`. For a manual tag `prompt` is false, so the pool is every non-prompt entry: AI tags (unprefixed) and manual ones. The comment says 'same-kind names'. Picking an AI suggestion (say `1girl`) sets the field to 1girl, but planRename targets `manual:1girl`, which is not in `known` unless the user has that manual tag, so the preview says 'Renames on N images' instead of a merge. The dropdown shows tags that can never be a target. Reachable: open Rename on any manual tag and type a common AI tag.

**Proposal.** Filter by kind exactly: `const kindOf = prompt ? isPrompt : isManual; known.filter(t => t._id !== raw && kindOf(t._id))`. Add a planRename/option-pool test in tags.test.ts (extract `renameOptions(raw, known)` into lib/tags.ts next to planRename so the rule has one home).

**Evidence.** `packages/frontend/src/components/RenameTagDialog.tsx:36-42`, `packages/frontend/src/lib/tags.ts:216-230`

### S4.8 tagFlow hides the prompt twin of an AI tag and toPromptText strips weights: both sit in the weights path

`deepen | S | L4 | conf med | tests yes | risk low TW`

**Problem.** The plan shows weights next to the prompt tag in the image view's tag run. tagFlow lists each name once: when an AI tag (or a manual tag) has the same name, the prompt entry is dropped and only recorded as `also: ['prompt']`, so the prompt weight has no FlowTag to attach to for the commonest case (a tag both prompted and seen). FlowTag has no weight field, and toPromptText (copy tags for ComfyUI) dedupes by name and would emit `smile` for a `(smile:1.4)` prompt. TagDetail has no weight spread field either. Adding weights straight onto this shape will force ad-hoc patches in adherenceGroups, TagFlow and the panel.

**Proposal.** Before the weights session decide the shape in lib/tags.ts: `tagFlow(tags, ai, weights?: Record<string, number>)` sets `FlowTag.weight` from the prompt tag's weight whether the entry is listed as `prompt` or folded into `also` (so the label shows the weight on the AI tag too), and `toPromptText(tags, weights?)` writes `(name:w)` when a weight exists, escaping parens inside the name only. Add the cases to tags.test.ts first. Reserve `weights?: {min, max, mode}` on TagDetail in tagBrowse.ts.

**Depends on.** Storage choice in docs/tag-weights-plan.md step 2

**Evidence.** `packages/frontend/src/lib/tags.ts:108-150`, `packages/frontend/src/lib/tags.ts:41-46`, `packages/frontend/src/lib/tags.ts:89-99`, `packages/frontend/src/lib/tagBrowse.ts:28-52`, `docs/tag-weights-plan.md`

### S4.9 Merge rules are called 'aliases' in the frontend (useTagAliases, TAG_ALIASES_KEY, /tags/aliases) but 'Merge rule' in CONTEXT.md

`naming | S | L2 | conf high | tests partial | risk low`

**Problem.** CONTEXT.md defines a Merge rule / Split rule (table tag_rules, `from -> [to]`) and reserves 'alias' for a Danbooru alias and a character's folded bare name. The frontend names the same rows TagAlias, useTagAliases, deleteTagAlias, TAG_ALIASES_KEY and the route /tags/aliases, while the same page labels them 'Merge rules' and the sibling hook is `addTagRules`. The Rules page (extraction Rulesets, /rules) adds a second meaning of 'rules'.

**Proposal.** Rename the query layer to TagRule / useTagRules / deleteTagRule / TAG_RULES_KEY (mechanical; keep the URL, or alias /tags/rules and drop /tags/aliases in the same change). In the UI and CONTEXT.md call the Rules page's objects 'Rulesets' (or 'Extraction rules') so 'Merge rules' and 'Rules' stop colliding.

**Evidence.** `packages/frontend/src/pages/TagsPage.tsx:172`, `packages/frontend/src/pages/TagsPage.tsx:201-209`, `packages/frontend/src/lib/queries.ts:310-356`, `packages/frontend/src/pages/TagsPage.tsx:331-338`

### S4.10 Cross-language mirrored vocabularies have no parity check (COLOURS, KAOMOJIS, canonicalName, Facet, merge KIND_ORDER)

`drift | S | L2 | conf med | tests no | risk low`

**Problem.** Five tables or rules are hand-copied between Python and TypeScript with only a comment saying 'mirror of'. The colour table must match so a character page and its tags agree; the kaomoji set and canonical spelling decide whether a tag counts as the same name on both sides. Nothing fails if one side gains a colour, a kaomoji or a facet.

**Proposal.** Put the data in one JSON file both read, e.g. packages/backend/src/moire/data/tag_vocab.json (colours, neutrals, kaomojis, facets, merge kinds) served at build by Vite import (json) and loaded by Python. If that is too much plumbing, add a backend test that regex-parses the TS tables from the frontend source and asserts equality, matching the shared-fixture approach already planned for prompt weights.

**Evidence.** `packages/frontend/src/lib/tagColour.ts:17-52`, `packages/backend/src/moire/services/characters.py:29-59`, `packages/frontend/src/lib/tags.ts:34-37`, `packages/backend/src/moire/services/tag_names.py:21`, `packages/frontend/src/lib/tags.ts:193-198`, `packages/frontend/src/lib/tagColour.ts:99-117`, `packages/frontend/src/lib/mergeSuggestions.ts:4-5`

**Cross-cutting hints.**

- packages/backend/src/moire/api/images.py:528-542 repeats the image_gen_raw lookup via id_candidates (clone of rules.py:359-373); fold into one helper next to image_tags.id_candidates
- packages/backend/src/moire/services/generator_setup.py:96-135 re-derives workflow family id/name/file-match by hand (see finding 2)
- packages/frontend/src/components/TagPanel.tsx:88-96 and packages/frontend/src/components/generate/PromptBoard.tsx:147-155 hand-roll the /tags/samples query (see finding 3)
- packages/frontend/src/components/NewCharacterDialog.tsx:157, components/generate/Outfit.tsx:164, components/generate/CharacterBlock.tsx:260, components/generate/PromptInput.tsx:252, components/generate/ChipInput.tsx:84 each carry their own suggestion-list ArrowUp/Down handler (see finding 6)
- packages/frontend/src/pages/RulesPage.tsx:161-181 and pages/TagsPage.tsx:66-74 are two more hand-rolled localStorage prefs (extends the wave1 finding on useTagMarks vs DETAIL_TAB_KEY)
- Hint captions on settings/dialog controls (pages/settings/sections/TagColoursSection.tsx:273,280; components/TagEditDialog.tsx:351,379; components/RenameTagDialog.tsx:88-91) go against the user's 'no UI subtext' memory rule; low priority, move to tooltips if the rule is meant to cover settings

## S5-libraries

*The scan, watch and thumbnail stack is carefully commented and well covered (blurhash, storage_fs, scan_writer, nesting and discover are small, deep, testable modules). The weak points are structural: api/libraries.py holds the whole library lifecycle (and api/generate.py calls its handlers directly), image-row deletion is copy-pasted five times, scanner.py (898 lines) fuses five jobs, and the frontend spreads library writes and scan polling across four files with inconsistent cache invalidation. Already reported and not repeated: the _run closure, event-loop blocking joins, unbounded stale-delete transactions, dead file_hash, scan_error never shown in the UI.*

### S5.1 Library lifecycle lives in api/libraries.py and is reused by calling route handlers from another router

`boundary | M | L4 | conf high | tests partial | risk med`

**Problem.** add/move/remove are ordered sequences of side effects (DB write, library_nesting.invalidate, tag_index.invalidate, cancel_scan, start/stop_watch, scan_library_async, _rescan_libraries_around, delete_by_prefix) written inline in three route handlers. api/generate.py put_comfyui imports and awaits add_library and update_library as plain functions (and wraps them in `except ValueError`, which they never raise: they raise HTTPException), so the sequence is already a service with no service module. Consequences visible today: remove_library never deletes the `thumbs:{library_id}` stamp row scanner._save_stamp writes (orphaned forever); the event-loop-blocking joins (already reported) have to be fixed in three places; add_library has a check-then-insert race (two concurrent POSTs for one path both pass the dedupe, the second hits the primary key and returns 500); library_id_for and _rescan_libraries_around are router-private helpers.

**Proposal.** Add services/library_ops.py with async `create(path, name, watch)`, `move_or_edit(id, patch)`, `remove(id)`, `rescan_around(path, exclude)` and `library_id_for`. Each owns its full side-effect order, runs the cancel/join/start_watch calls via anyio.to_thread, deletes the scanner stamp row on remove, and makes create idempotent on IntegrityError (return the existing row). Routes become validate, call, shape response. api/generate.py put_comfyui calls `library_ops.ensure_watched(path, name)` instead of the two handlers. Return one response shape from create (existing rows return the full row, new ones a 3-key dict today).

**Evidence.** `packages/backend/src/moire/api/libraries.py:79-95`, `packages/backend/src/moire/api/libraries.py:126-154`, `packages/backend/src/moire/api/libraries.py:268-277`, `packages/backend/src/moire/api/generate.py:205-218`, `packages/backend/src/moire/api/libraries.py:28-46`

### S5.2 Image-row deletion (rows, raw gen, thumbnails, tag index) is hand-written in five places

`dedupe | M | L4 | conf high | tests partial | risk med`

**Problem.** Every site does `delete(images)` + `delete(image_gen_raw)` in the same transaction, then tag_index.invalidate(), then best-effort delete_thumb per key, each with its own lazy `from .storage_fs import delete_thumb` inside try/except pass (scanner.py:325 and :801 import lazily although put_thumb is already imported at module top, so there is no cycle to avoid). A sixth table that must cascade (the next derived table, or tag weights if stored beside the image) has to be added in five places; the scanner and nesting variants also forget to refresh libraries.indexed_count consistently (nesting recounts, remove_single_image uses a delta, the scan sets it from the walk).

**Proposal.** New small module (e.g. services/image_delete.py): `delete_rows(conn, ids) -> list[thumb_key]` (sync) plus an async twin used by purge/remove_library, and `drop_thumbs(keys)` (best-effort, logs at debug). Callers keep ownership of the transaction and call `tag_index.invalidate()` after commit, but the table list and the thumb cleanup exist once. The unbounded-transaction fix already reported for the scanner stale delete then lands in one chunking loop (200 ids per tx) used by scanner, nesting and remove_library.

**Evidence.** `packages/backend/src/moire/services/scanner.py:316-329`, `packages/backend/src/moire/services/scanner.py:783-807`, `packages/backend/src/moire/services/library_nesting.py:268-274`, `packages/backend/src/moire/services/library_nesting.py:600-618`, `packages/backend/src/moire/api/images.py:626-646`, `packages/backend/src/moire/api/libraries.py:146-163`

### S5.3 scanner.py (898 lines) fuses thumbnail rendering, scan stamp, reconcile policy, watcher entry points and the scan thread

`split | M | L3 | conf high | tests yes | risk low`

**Problem.** One module owns five jobs with different consumers: (1) thumbnail recipe (_THUMB_*, thumb_stamp, _make_thumb_bytes, is_image) which library_discover imports from the scanner, pulling PIL, gen_metadata and the whole scan machinery into a dry-run path counter; (2) the stamp/retry persistence (_load_stamp/_save_stamp); (3) the pure reconcile policy (reconcile_stale, stale_guard, unread_prefixes), the highest-risk code in the file; (4) the watcher-facing incremental API (ingest_single_file, remove_single_image, _touch_library); (5) the scan thread, slots and cancel registry. The cancel/slot state (_scan_lock, _current_scans, _cancel_scans, _scan_threads, _scans_ended) is module globals reached via scans_ended/is_scanning/cancel_scan.

**Proposal.** Split along existing seams, keeping `scanner` as the public facade so no caller changes: `thumbnailer.py` (recipe constants, thumb_stamp, make_thumb_bytes, is_image; library_discover imports this), `scan_reconcile.py` (reconcile_stale, stale_guard, unread_prefixes, plus the stamp load/save), `incremental.py` (ingest_single_file, remove_single_image, _touch_library, used only by library_watch), and scanner.py keeps the thread/slot/cancel registry and the (already flagged) _run, which can then shrink to orchestration. Pure moves, tests keep importing through `scanner` re-exports for one release.

**Depends on.** complements the reported _run closure decomposition; do the module moves first

**Evidence.** `packages/backend/src/moire/services/scanner.py:35-132`, `packages/backend/src/moire/services/scanner.py:54-88`, `packages/backend/src/moire/services/scanner.py:254-330`, `packages/backend/src/moire/services/scanner.py:332-388`, `packages/backend/src/moire/services/scanner.py:391-426`, `packages/backend/src/moire/services/library_watch.py:375-396`, `packages/backend/src/moire/services/library_discover.py:25`

### S5.4 LibrariesPage runs its own raw-fetch progress poller beside useLibraries, which already polls the same fields

`boundary | M | L3 | conf high | tests no | risk low`

**Problem.** GET /libraries (polled every 3 s by useLibraries while anything scans) already returns scanning, scan_total, scan_done, indexed_count. LibrariesPage additionally keeps a `progress` state, a prevScanningRef, and a 1.5 s setTimeout loop that does a raw `fetch('/api/v1/libraries/${id}/progress')` per scanning library (bypassing lib/api and TanStack), only to detect the scanning to done edge and invalidate the feed. Two sources of truth for 'is it scanning' (`progress[id]?.scanning || l.scanning`) can disagree for a poll tick, and WelcomePage ScanProgress is a third poller of the same list. The page is also 717 lines: card, edit dialog, selection state and folder-collapse persistence all inline.

**Proposal.** Delete the progress state and effect; render the bar from the library row (`scan_done/scan_total`). Detect the scanning to done edge in useLibraries itself (a small effect or select comparing the previous list) and invalidate the image feeds there. Keep GET /libraries/{id}/progress only because tests/perf_benchmark.py uses it, or switch the benchmark to the list endpoint and delete the route. Then split the page: `LibraryCard.tsx`, `EditLibraryDialog.tsx`, `hooks/useLibrarySelection.ts`, and a `useCollapsedFolders` hook (the same localStorage-set pattern exists elsewhere).

**Evidence.** `packages/frontend/src/pages/LibrariesPage.tsx:93-154`, `packages/frontend/src/pages/LibrariesPage.tsx:317`, `packages/frontend/src/pages/LibrariesPage.tsx:456-468`, `packages/frontend/src/lib/queries.ts:27-41`, `packages/frontend/src/lib/queries.ts:79-86`, `packages/frontend/src/pages/WelcomePage.tsx:369-385`, `packages/backend/src/moire/api/libraries.py:206-225`

### S5.5 Frontend library writes (create, edit, delete, rescan) are spread over four files with inconsistent cache invalidation

`dedupe | S | L3 | conf high | tests partial | risk low`

**Problem.** The same REST calls are made with raw `api(...)` and hand-built JSON headers from LibrariesPage (PATCH, DELETE x2, POST rescan), AddLibraryDialog (POST loop with per-row failure collection), WelcomePage.createLibraries (DELETE + POST loop with per-row failure collection, near-identical to the dialog's), and libraryPlan (discover). Only LibrariesPage invalidates the image feeds (`['images']`, `['image-groups']`) after a change; WelcomePage and AddLibraryDialog's callers rely on the page to do it, so creating or removing libraries from setup leaves a cached gallery stale. The two 'which candidates become libraries' rules also differ silently (defaultSelected: new and not hidden; onboarding.librariesToAdd/sourceTotals: new or empty and not hidden).

**Proposal.** Add lib/libraryApi.ts: `createLibraries(items) -> {created: Map<path,id>, failed: string[]}` (shared by dialog and setup), `updateLibrary`, `deleteLibrary`, `rescanLibrary`, and a `useLibraryMutations()` hook that owns `invalidate(LIBRARIES_KEY, ['images'], ['image-groups'])` so every caller gets the same cache behaviour. Move the candidate-eligibility predicates (`isAddable`, `defaultSelected`, the onboarding variant) into libraryPlan.ts beside the types with one comment on why empty folders differ.

**Evidence.** `packages/frontend/src/pages/LibrariesPage.tsx:71-74`, `packages/frontend/src/pages/LibrariesPage.tsx:156-253`, `packages/frontend/src/components/AddLibraryDialog.tsx:114-148`, `packages/frontend/src/pages/WelcomePage.tsx:55-62`, `packages/frontend/src/pages/WelcomePage.tsx:177-210`, `packages/frontend/src/lib/libraryPlan.ts:31-40`

### S5.6 Folder ancestry and 'innermost library' are implemented four ways

`dedupe | S | L3 | conf high | tests yes | risk low`

**Problem.** library_nesting owns the rule (path_key + is_inside, case-folded where the OS is). library_discover re-derives it with os.path.commonpath on un-case-folded strings (_is_within), so a Windows library stored as `D:/Images` and a candidate `d:/images/x` are judged by different rules in the dry run and in the scan. generation_jobs.held_by re-implements 'innermost library holding this file' as its own best-length loop, and library_nesting._adopt_from does the same with max(holders, key=len). library_discover also re-exports normalize_path through `__all__` only so api/libraries.py can call `library_discover.normalize_path` (twice) instead of importing it from models.library. The frontend has a fourth spelling in normalizeLibraryPath (display grouping only, acceptable).

**Proposal.** Add `library_nesting.innermost(path, libraries) -> (id, root) | None` and use it in _adopt_from and generation_jobs.held_by. Make library_discover._classify use `path_key`/`is_inside` (and a `related(a, b)` helper) instead of _is_within. Drop normalize_path from library_discover.__all__ and import it from models.library in the router. One test table of path pairs (posix, drive letters, case) shared by discover and nesting tests.

**Evidence.** `packages/backend/src/moire/services/library_nesting.py:30-43`, `packages/backend/src/moire/services/library_nesting.py:497-535`, `packages/backend/src/moire/services/library_discover.py:36-41`, `packages/backend/src/moire/services/library_discover.py:200-239`, `packages/backend/src/moire/services/generation_jobs.py:107-119`, `packages/backend/src/moire/api/libraries.py:28-46`, `packages/backend/src/moire/services/library_discover.py:24-27`, `packages/frontend/src/lib/libraryTree.ts:93-97`

### S5.7 Moving a library while it is scanning leaves the scan on the old folder and nothing rescans

`bug | S | L2 | conf med | tests no | risk med`

**Problem.** update_library on a path change calls scan_library_async(library_id, new_path), which returns {'started': False, 'status': 'already_running'} when a scan is in flight (the result is ignored). The running scan only re-reads libraries.path once, right after it gets its slot (scanner.py:588-594), so a scan already walking continues on the old root, writes rows with old absolute paths, and its stale reconciliation runs against that old root. The new location is not scanned until the watcher's reconcile timer fires (and never if watch_enabled is false). The same ignored return value applies to every caller of scan_library_async in the router.

**Proposal.** In the move path (in library_ops.move, see finding 1) call cancel_scan via to_thread, wait for it to end (join with a longer timeout than the 0.5 s default), then start the scan; or have scan_library_async record a `rescan_requested` flag that _run checks in its finally block and re-enters once. Add an integration test: start a scan, PATCH path, assert the final rows carry the new root.

**Depends on.** easiest after the library_ops extraction

**Evidence.** `packages/backend/src/moire/api/libraries.py:268-277`, `packages/backend/src/moire/services/scanner.py:545-549`, `packages/backend/src/moire/services/scanner.py:585-598`

### S5.8 What counts as an indexable file is decided in three places and the rules disagree

`drift | S | L2 | conf low | tests partial | risk med`

**Problem.** The full scan walks every file and keeps anything with an IMAGE_EXTS suffix or any mimetype that starts with image/ (so .svg, .tif, .ico, and whatever the host mime table adds). The watcher additionally drops dotfiles, ~files and .tmp/.part suffixes, but the scan does not, so `.cover.png` is indexed by a scan yet its watcher delete event is ignored and the row lingers until the next reconcile. A file Pillow cannot open (an .svg) passes is_image, _make_thumb_bytes returns (None, None, 0, 0, None) from a swallowed exception, and _process_image still returns ok=True with width=0, height=0 and thumb_key=None: it is indexed as a blank tile, never counted in failed_count, never listed in the retry ids, and rebuilt on every rescan because _unchanged needs a thumb_key. The discover preview counts with is_image only, so its numbers differ from both.

**Proposal.** One predicate `is_indexable(path)` in the new thumbnailer/scan module (extension allow-list, no generic mimetype fallback unless intended, plus the ignore rules) used by the walk, the watcher, ingest and library_discover._count_images. Treat a decode failure (width == 0) as a failed result (ok False, stage 'decode') so it appears in scan_failed_samples and the retry list instead of a silent blank row. Low confidence the mimetype fallback is accidental: confirm with the author before narrowing it.

**Evidence.** `packages/backend/src/moire/services/scanner.py:33-39`, `packages/backend/src/moire/services/scanner.py:134-138`, `packages/backend/src/moire/services/scanner.py:130-131`, `packages/backend/src/moire/services/scanner.py:530`, `packages/backend/src/moire/services/library_watch.py:101-103`, `packages/backend/src/moire/services/library_watch.py:326-330`, `packages/backend/src/moire/services/library_discover.py:68-81`

### S5.9 Thumbnail key is built by two formulas, and the thumb_format setting is half implemented

`invariant | S | L2 | conf high | tests yes | risk low`

**Problem.** put_thumb builds `f'{library_id}/{image_id}.webp'.replace(':','_')` from its two arguments while thumb_key(image_id) rebuilds the same string by splitting the id on ':'. thumb_version.urls() and urls_for_rows() trust the derived form (urls ignores the stored thumb_key entirely), so a URL is only correct while the two formulas agree; the put_thumb docstring claims readers need 'no matching transform', which is false. Separately, settings.thumb_format lets the scanner encode JPEG or PNG bytes but the key always ends `.webp` and the small copy is always WEBP, so a non-webp setting stores mislabelled files (it works only because browsers sniff content).

**Proposal.** Make put_thumb call thumb_key(image_id) (assert the library prefix matches) so there is one formula, and fix the docstring. Either remove thumb_format and the convert branch in _make_thumb_bytes (and from thumb_stamp), or derive the suffix from it in the one key function. Prefer removal: nothing in the UI sets it and CLAUDE.md describes WebP thumbnails.

**Evidence.** `packages/backend/src/moire/services/storage_fs.py:45-71`, `packages/backend/src/moire/services/thumb_version.py:44-62`, `packages/backend/src/moire/services/scanner.py:111-123`, `packages/backend/src/moire/core/config.py:91-92`, `packages/backend/src/moire/api/images.py:305`

### S5.10 library_watch.py mixes a child-process supervisor with per-library event routing; _write_loop is radon D21

`split | M | L2 | conf med | tests partial | risk med`

**Problem.** Lines 134-304 (_writer, _send, _add_cmd, _write_loop, _write, _close, _spawn, _back_off, _read_child, restart backoff globals) are a generic 'keep a JSON-lines child alive, replay its adds on respawn, drop commands while it is down' supervisor with no knowledge of libraries beyond `_watches`, which it reads unlocked and under `_lock` in different places. The rest is library semantics (_Watch, _run_watch debounce-merge, _wait_stable, reconcile timer, start/stop). The supervisor's tricky state machine (readded set, closing event, want_child, per-writer queue retired by stop_all) can only be tested through real subprocesses (test_library_watch_proc.py).

**Proposal.** Extract `services/watch_child.py` with `class ChildWatcher(on_message, current_adds)` exposing `add(cmd)`, `remove(key)`, `close(timeout)`; spawn and clock injectable. library_watch keeps _Watch, routing (`on_message` = _route) and the reconcile timer and passes `lambda: [_add_cmd(w) for w in _watches.values()]` as the respawn replay source. Gives _write_loop a unit-test surface with a fake process.

**Evidence.** `packages/backend/src/moire/services/library_watch.py:134-304`, `packages/backend/src/moire/services/library_watch.py:307-323`, `packages/backend/src/moire/services/library_watch.py:359-426`, `packages/backend/src/moire/services/library_watch.py:429-499`

**Cross-cutting hints.**

- packages/backend/src/moire/api/generate.py:205-218 awaits add_library and update_library handlers directly and catches ValueError they never raise (HTTPException is what they raise); overlaps the already-reported 'route handlers call each other' pattern.
- packages/backend/src/moire/services/generation_jobs.py:107-119 held_by re-implements the innermost-library lookup that library_nesting should own.
- packages/backend/src/moire/api/images.py:626-646 purge_image is one of five image-row delete recipes (see finding 2).
- packages/backend/tests/perf_benchmark.py:120,135 is the only caller of GET /libraries/{id}/progress; check before deleting the route.
- packages/frontend/src/lib/dropFiles.ts, hooks/useDropSide.ts and lib/dropSide.ts are generic UI utilities (ComfyStep drop, PromptBoard dropdown) with no library logic; they are mis-bucketed in slice S5 and look healthy (colocated pure tests, small).
- packages/frontend/src/lib/libraryPlan.ts:7 CandidateStatus is flagged by knip as an unused export but is used structurally through LibraryCandidate['status'] in AddLibraryDialog.tsx:23; harmless, do not delete.
- packages/backend/src/moire/services/scanner.py:268-286 ingest_single_file swallows reproject_image failures with a bare `except Exception: pass` and no log line, unlike the scan path which logs.

## S6-ai

*The AI slice is in decent shape: pure helpers (select_tags, clean_settings_patch, the lib/ai.ts predicates, describeTask) are separated and tested, and the download/tagger split is clean. The weak spots are duplicated vocabularies (tagger params and defaults in several places, job labels and cancel toasts in three UI paths, 'untagged' defined twice), a download error lost on the way to the load error, an unguarded worker loop, and a GET that enqueues work. Nothing here sits in the tag-weights path. Already reported and not repeated: retag wiping tags, AIJob setattr and pruning, ended counts, model download progress sums, dead helpers, event-loop joins.*

### S6.1 Tagger parameters and defaults are spelled in several places; SettingsPatch is a hand-synced copy of DEFAULT_AI_SETTINGS

`dedupe | M | L3 | conf high | tests yes | risk low`

**Problem.** The same knobs (general_thresh 0.35, character_thresh 0.85, mcut flags, max_general 80, max_character 40, idle 300) have defaults in DEFAULT_AI_SETTINGS, in the pydantic SettingsPatch field list, in _tag_one as eight settings.get(key, default) fallbacks, and as keyword defaults on select_tags, WDTagger.predict and TaggerManager.predict_image (which threads six separate args through twice). Adding a knob means editing 5 to 6 sites and a missed one silently falls back to a stale literal. clean_settings_patch coerces floats and ints but not general_mcut/character_mcut, which are only coerced because SettingsPatch does; removing SettingsPatch would let them through uncoerced. No range check exists on thresholds, so a typo like 35 silently tags nothing.

**Proposal.** Add a frozen dataclass TagParams(general_thresh, character_thresh, general_mcut, character_mcut, max_general, max_character) in ai_settings.py with from_settings(dict), the only place defaults are read (from DEFAULT_AI_SETTINGS). select_tags, WDTagger.predict and predict_image take one params argument and drop their keyword defaults; _tag_one passes TagParams.from_settings(settings) and ai_meta reads the same object. Make clean_settings_patch the single validator (coerce mcut bools, clamp thresholds to 0..1) and have POST /settings take a plain dict or a model generated from DEFAULT_AI_SETTINGS keys, deleting SettingsPatch.

**Evidence.** `packages/backend/src/moire/services/ai_settings.py:20-38`, `packages/backend/src/moire/services/ai_settings.py:41-70`, `packages/backend/src/moire/api/ai.py:26-37`, `packages/backend/src/moire/services/ai_jobs.py:363-383`, `packages/backend/src/moire/services/ai_jobs.py:402-411`, `packages/backend/src/moire/services/ai_tagger.py:108-118`, `packages/backend/src/moire/services/ai_tagger.py:248-258`, `packages/backend/src/moire/services/ai_tagger.py:483-495`, `packages/frontend/src/lib/ai.ts:8-21`

### S6.2 A failed model download is swallowed: download_wd_tagger returns paths and the load fails with a bare FileNotFoundError

`bug | S | L3 | conf high | tests no | risk low`

**Problem.** _runner catches every Exception and stores it on the state (status 'error', error text), so awaiting the task in wait() returns normally. download_wd_tagger then returns the expected paths without checking the state, and WDTagger.load goes straight to _load_labels_from_csv, which raises FileNotFoundError ('No such file or directory ...csv'). That text becomes TaggerManager's load_error and the AI job's job.error (shown as the load error line and the toast 'AI tagging failed: ...') instead of the real cause (HTTP 404 for a mistyped repo, DNS failure, disk full). The download card shows the real error only while no load error masks it.

**Proposal.** In download_wd_tagger, after dm.wait, read the state: if status == 'error' raise RuntimeError(st.error); if 'cancelled' raise asyncio.CancelledError. Add a test with a ModelDownloadManager whose _download_one raises, asserting the load error carries the download error text.

**Evidence.** `packages/backend/src/moire/services/ai_tagger_download.py:166-182`, `packages/backend/src/moire/services/ai_tagger_download.py:227-231`, `packages/backend/src/moire/services/ai_tagger_download.py:355-370`, `packages/backend/src/moire/services/ai_tagger.py:226-227`, `packages/backend/src/moire/services/ai_jobs.py:256-263`

### S6.3 AI worker loop dies on any error outside the per-image try, leaving the job 'running' and every later job queued forever

`bug | S | L3 | conf med | tests no | risk low`

**Problem.** _worker_loop sets job.status='running' and then runs get_ai_settings() (a DB read), set_idle_unload_s and resolved_model_target outside any except. Only _prepare_model and the per-image body are guarded. If the settings read raises (SQLite busy, schema error) the exception passes through the finally and out of the while True, ending the worker task. The job stays 'running' forever (Cancel only sets cancel_requested), and since start() is called once from the lifespan, every later enqueue goes into a queue nobody reads until restart.

**Proposal.** Wrap the per-job body in try/except Exception that logs, sets job.status='error' and job.error=str(e), and lets the loop continue (keep the finally for in-flight release and counters). Add a test that makes get_ai_settings raise for one job and checks a second job still completes.

**Evidence.** `packages/backend/src/moire/services/ai_jobs.py:240-313`, `packages/backend/src/moire/services/ai_jobs.py:135-139`

### S6.4 'Untagged' and 'not quarantined' are defined in two parallel queries beside the feed's own filter

`dedupe | S | L2 | conf high | tests partial | risk low`

**Problem.** enqueue_untagged selects ids with has_ai_tags false plus an inline coalesce(quarantined, False).is_(False), with a comment that it must match /ai/coverage; /ai/coverage (a 50-line raw SQL aggregate inside the router) repeats the coalesce and counts has_ai_tags and has_tags. Both skip image_tags.not_quarantined(), which CONTEXT.md names as the shared definition. The invariant 'a run tags the set the UI counted' is held only by a comment across two files plus the feed's no_ai_tags filter, a third spelling.

**Proposal.** Create services/ai_coverage.py with untagged_clause(library_id=None), built from image_tags.not_quarantined() and has_ai_tags, and coverage() returning the dict api/ai.py builds now. api/ai.py ai_coverage becomes a one-line call and enqueue_untagged uses untagged_clause. Add a test asserting coverage.untagged equals the ids enqueue_untagged would pick (large limit) with a quarantined image present.

**Evidence.** `packages/backend/src/moire/services/ai_jobs.py:197-213`, `packages/backend/src/moire/api/ai.py:204-253`, `packages/backend/src/moire/services/image_tags.py:517-520`, `packages/backend/src/moire/services/image_feed.py:129`, `packages/backend/src/moire/services/image_feed.py:167`

### S6.5 Job state wording and the cancel adapter are spelled in three UI paths that disagree

`dedupe | S | L2 | conf high | tests partial | risk low`

**Problem.** The mapping from (status, phase) to a label exists as aiJobLabel ('Waiting for model…'), as an inline special case in ActiveJob ('Waiting for model' for running + phase model) and in describeTask's ai_job case. Cancelling a job is toasted by useAiTagging ('Cancellation requested' / 'Job already finished', info) and by SettingsContext.cancelJob ('Cancellation requested' / 'Could not cancel job', error): the split the comment at lib/ai.ts:253-256 says was removed. useAiTagging also has a no-op ternary ok ? 'info' : 'info'. Jobs are read from three sources too: status.jobs.recent, per-job aiJob queries and activity items.

**Proposal.** Make lib/ai.ts own one pure aiJobPhaseLabel(job) used by aiJobLabel, ActiveJob and describeTask, and one cancelJobMessage(ok) returning [text, tone] used by both toasts. Drop the dead ternary. Add tests in lib/ai.test.ts for the label table.

**Evidence.** `packages/frontend/src/lib/ai.ts:156-164`, `packages/frontend/src/lib/ai.ts:223-241`, `packages/frontend/src/pages/settings/sections/JobsSection.tsx:68-70`, `packages/frontend/src/lib/backgroundTasks.ts:97-100`, `packages/frontend/src/hooks/useAiTagging.ts:120-131`, `packages/frontend/src/pages/settings/SettingsContext.tsx:127-135`

### S6.6 GET /ai/faces enqueues every avatar; face worker state is module globals and rides the AI router and settings blob

`boundary | M | L2 | conf med | tests partial | risk med`

**Problem.** status() is a read, but when ready it calls _queue_avatars, which runs characters.listing() (a full character query) and flips _avatars_queued; the frontend depends on it (CharactersSection:49-50), so the work starts only if someone opens Settings. status() also reads settings three times. The worker state is five module globals (_pending, _batch, drains, _worker, _avatars_queued) where every other background worker is a manager class with a singleton getter. The face endpoints live in api/ai.py but have no function in lib/ai.ts: CharactersSection does raw api() calls with its own FaceStatus type and re-sums download bytes. face_detect and prompt_positive_only are stored in the tagger settings doc, so update_ai_settings carries a reproject trigger and tag_index invalidation unrelated to the tagger.

**Proposal.** Move queue-all-avatars to an explicit call: once from lifespan when ready() and after the face download completes, and make status() pure. Wrap the globals in a FaceWorker class with the shape of the other managers (resettable in tests). Add fetchFaces/postFaces to lib/ai.ts and use them in CharactersSection. Longer term, split face_detect and prompt_positive_only out of the 'ai' doc so update_ai_settings handles only tagger knobs.

**Evidence.** `packages/backend/src/moire/services/face_detect.py:88-100`, `packages/backend/src/moire/services/face_detect.py:191-199`, `packages/backend/src/moire/services/face_detect.py:286-298`, `packages/backend/src/moire/services/face_detect.py:60-71`, `packages/backend/src/moire/api/ai.py:123-143`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:40-58`, `packages/backend/src/moire/services/ai_settings.py:90-100`

### S6.7 Generic formatters live in domain modules: two formatDuration with different output, formatBytes inside a React context file

`naming | S | L2 | conf high | tests yes | risk low`

**Problem.** formatDuration is exported from both lib/ai.ts ('3 min', '1 h 5 min') and lib/onboarding.ts ('7 min', '2.4 h'), a third duration style is etaShort in lib/eta.ts, and backgroundTasks.ts imports the AI one from lib/ai.ts though it is not AI specific. formatBytes is defined in pages/settings/SettingsContext.tsx and imported by sections from the context file. lib/activity.ts is the Overview chart's weekly image counts, while 'activity' elsewhere (api/activity.py, backgroundTasks, BACKGROUND_TASKS_KEY) means background work, so the name collides.

**Proposal.** Create lib/format.ts holding formatBytes and one formatDuration (keep the onboarding variant as roughDuration since its rounding is deliberate), and re-point backgroundTasks, JobsSection, ModelSection and onboarding. Rename lib/activity.ts to lib/weeklyActivity.ts with its test.

**Evidence.** `packages/frontend/src/lib/ai.ts:166-175`, `packages/frontend/src/lib/onboarding.ts:128-132`, `packages/frontend/src/lib/eta.ts:19-30`, `packages/frontend/src/pages/settings/SettingsContext.tsx:25-35`, `packages/frontend/src/lib/backgroundTasks.ts:1`, `packages/frontend/src/pages/settings/sections/ModelSection.tsx:5`, `packages/frontend/src/lib/activity.ts:1-12`

### S6.8 AITaggingPage borrows page-level components from settings/sections and mounts the whole settings controller

`boundary | M | L2 | conf med | tests no | risk low`

**Problem.** The AI Tagging page is built from ModelStatusLine (ModelSection.tsx), ActiveJob/RecentJobs/ResetAiTags (JobsSection.tsx) and wraps itself in SettingsProvider, a 190-line controller that also holds the editable settings form, the Save flow and all model commands. Components the page owns live under settings/sections, ModelSection.tsx fuses the Settings model panel with the page's status line, and DownloadProgress duplicates the sum-and-percent code in CharactersSection. Touching the Settings tab can break the tagging page.

**Proposal.** Move ModelStatusLine, ActiveJob, RecentJobs, ResetAiTags to components/ai/, keeping ModelSection (the manual load/unload card) in settings. Split SettingsController into useAiCommands (job and model commands, busy flag, toasts) and the settings form state so the page needs only the first. Pure move first, no behaviour change.

**Evidence.** `packages/frontend/src/pages/AITaggingPage.tsx:17-20`, `packages/frontend/src/pages/AITaggingPage.tsx:333-338`, `packages/frontend/src/pages/AITaggingPage.tsx:501-514`, `packages/frontend/src/pages/settings/sections/ModelSection.tsx:253-297`, `packages/frontend/src/pages/settings/sections/JobsSection.tsx:390-482`, `packages/frontend/src/pages/settings/SettingsContext.tsx:60-246`

### S6.9 Settings readers go through the ai_jobs re-export shim while others import ai_settings directly

`simplify | S | L1 | conf high | tests yes | risk low`

**Problem.** ai_jobs re-exports DEFAULT_AI_SETTINGS, get_ai_settings and update_ai_settings in __all__ purely as a pass-through, so api/ai.py, api/activity.py and main.py import settings from the job manager module while face_detect and tag_categories import ai_settings. Two import paths for one concept make ai_jobs look like the owner of settings.

**Proposal.** Delete the three names from ai_jobs.__all__ and its import, and change the three callers to import from services.ai_settings. Check tests that import them via ai_jobs (none found in test_ai_jobs.py).

**Evidence.** `packages/backend/src/moire/services/ai_jobs.py:17`, `packages/backend/src/moire/services/ai_jobs.py:28-34`, `packages/backend/src/moire/api/ai.py:12-16`, `packages/backend/src/moire/api/activity.py:22`, `packages/backend/src/moire/main.py:14`, `packages/backend/src/moire/services/face_detect.py:31`, `packages/backend/src/moire/services/tag_categories.py:113`

**Cross-cutting hints.**

- packages/backend/src/moire/services/reproject.py:53-62 reads prompt_positive_only from the 'ai' app_settings doc by raw SQL while ai_settings.get_ai_settings() is the owner (an extraction knob stored in tagger settings)
- packages/backend/src/moire/services/ai_settings.py:68-80 and reproject.py:53-62 are two more app_settings JSON-row readers (relevant to the existing app_settings read/upsert finding)
- packages/frontend/src/pages/ImageView.tsx:1200 consumes aiJobLabel; the module-level jobOfImage Map in packages/frontend/src/hooks/useAiTagging.ts:11 survives across images and is cleared only when the job query errors or ends
- packages/backend/src/moire/services/ai_tagger_download.py:26 DEFAULT_CACHE_DIR '.cache/moire/models' is a second default beside settings.model_cache_dir_path (core/config.py:109), reachable only when cache_dir is empty

## S7-prompts

*The backend extraction path is well layered (capture, pure extract, reprojection) and heavily tested, but gen_metadata.py has grown to 1073 lines with four unrelated jobs, and the "settings + aliases + rulesets feed extract" recipe is assembled by hand in two places. On the frontend there is no single prompt grammar: five separate comma/bracket splitters (one backend, four frontend) disagree on which brackets nest. That is the main risk for the tag-weights plan, whose claim that promptOutline already implements the weight rule is not true.*

### S7.1 Prompt weight rule exists nowhere yet; plan's premise is wrong and parsers disagree on brackets

`drift | M | L5 | conf high | tests partial | risk med TW`

**Problem.** The plan says the backend should port promptOutline's unwrap/readTerm rule (explicit weight, x1.1 per paren layer, /1.1 per bracket layer, group weight inherited). But readTerm/unwrap only read an explicit `:w` (or the enclosing group's explicit weight); they never multiply per layer, and splitSpans/closeOf ignore `{}` while the backend `_scan` treats `{`/`}` as groups. The backend `_scan` does track the bracket stack but `_clean` strips the weight and `Piece` carries only (text, kind), and `tokenize_prompt` reduces pieces to a sorted set of names, so weight information is discarded at three layers. Porting 'the frontend rule' would copy a rule that does not exist and bake in a frontend/backend mismatch (`((a))` is 1.21 in ComfyUI, `weight` undefined in the board).

**Proposal.** Define the weight semantics once, backend first: give `_scan` a third tuple field (the open-bracket stack snapshot or a computed multiplier) and add `weight: float | None` to `Piece` (explicit `:w` wins, else 1.1^parens / 1.1^-brackets, `{}` as 1.05 per ComfyUI/A1111 convention or explicitly 1.0, group members inherit). Add `tokenize_prompt_weighted() -> dict[name, weight]` next to `tokenize_prompt` (keep the latter for `prompt_terms`). Put the table of (text, name, weight) cases in one shared JSON fixture (e.g. packages/backend/tests/fixtures/prompt_weights.json) read by both test_prompt_parse.py and a promptOutline vitest, and make `readTerm` compute the same layer multiplier (then `bumpWeight` in promptEdit can reuse it). Fix the plan text step 1 accordingly.

**Depends on.** Finding 'Decompose _scan' makes this much easier; do together.

**Evidence.** `docs/tag-weights-plan.md:25`, `packages/frontend/src/lib/promptOutline.ts:77-90`, `packages/frontend/src/lib/promptOutline.ts:104-131`, `packages/backend/src/moire/services/prompt_parse.py:160-266`, `packages/backend/src/moire/services/prompt_parse.py:269-284`, `packages/backend/src/moire/services/gen_metadata.py:243-257`

### S7.2 Three more ad-hoc prompt splitters in the frontend duplicate promptOutline

`dedupe | M | L4 | conf high | tests yes | risk med TW`

**Problem.** promptOutline.splitSpans, promptRepeats.topTerms, compose.promptTerms and promptEdit.termAt each re-implement 'split a prompt at commas/newlines while respecting groups' with different rules: topTerms nests `([{`, `<lora:..>` and skips escapes; splitSpans nests only `([`, no `<>`; compose.promptTerms does not nest at all (a comma inside `(a, b:1.2)` splits it and a regex strips brackets); termAt ignores groups. keyOf in promptRepeats and readTerm in promptOutline both derive a tag name from written text with different canonicalisation (canonicalName vs lowercase+underscore). A prompt that parses one way in the board and another way in the repeat-remover is a drift bug waiting to happen, and bumpWeight (plan step 5) would add a fifth.

**Proposal.** Make `promptOutline.promptTerms` the one frontend term model: add `top: boolean` (not inside a group, no weight/bracket) and `key: string` (canonicalName+lowercase) to PromptTerm, and a `separatorsBetween(text, terms)` helper. Re-express prefixRepeats/tagRepeats/withoutTerms over `promptTerms(text).filter(t => t.top)` (withoutTerms keeps its separator logic but reads spans from terms), and make compose.promptTerms (limit 2, batch auto-name) `promptTerms(text).filter(kind tag).slice(0,limit).map(t => t.written)`. Leave termAt (caret-local, intentionally lenient) but have bumpWeight use promptTerms spans. Add `{}` and `<lora>` cases to promptOutline.test.ts before moving anything.

**Evidence.** `packages/frontend/src/lib/promptRepeats.ts:11-58`, `packages/frontend/src/lib/promptOutline.ts:28-51`, `packages/frontend/src/lib/compose.ts:49-61`, `packages/frontend/src/lib/promptEdit.ts:10-21`, `packages/frontend/src/components/generate/PromptInput.tsx:6`, `packages/frontend/src/components/generate/PromptRepeats.tsx:5`

### S7.3 Decompose prompt_parse._scan (complexity D30) and make it return group context

`split | M | L4 | conf high | tests yes | risk med TW`

**Problem.** `_scan` is 106 lines with 21 branches, 83 statements and nested closures (flush/emit) mixing five concerns: atom recognition at piece start (emoticon, BREAK/AND keyword, escape, embedding token, `<network>` token), separator handling, Danbooru qualifier glue, bracket stack, and the `[from:to:w]` colon rule. It returns `(text, in_group: bool)`, throwing away which brackets enclose the piece, which is exactly what weights need.

**Proposal.** Extract `_atom_at(text, i, has_text) -> tuple[str, int] | None` (emoticon, embedding, network token; returns raw text and end) and `_skip_at(text, i) -> int` (keyword, escaped comma) so the main loop only owns buf/stack/separators/brackets. Change the return type to a small `RawPiece(text, stack: tuple[str, ...])` (in_group = bool(stack)) so `Piece.weight` can be computed in `_parse_cached`. Keep the 339-line module whole; the split is within it. test_prompt_parse.py is a table test, so behaviour is pinned.

**Depends on.** pairs with the weight-rule finding

**Evidence.** `packages/backend/src/moire/services/prompt_parse.py:160-266`, `docs/refactor-pass/leads.txt:67-70`, `packages/backend/src/moire/services/prompt_parse.py:322-339`

### S7.4 Extraction inputs assembled by hand in two places; preview and reprojection can disagree; positive_only read by raw SQL

`invariant | M | L4 | conf high | tests partial | risk low TW`

**Problem.** What `gen_metadata.extract` needs (ruleset, keywords, prompt_positive_only, then apply_aliases to prompt_terms) is gathered in `reproject._reproject_where`; the rules preview endpoint re-gathers only keywords and passes no positive_only and no aliases, though its docstring says the result is 'what reproject would write'. So the preview's `gen.prompt_terms` differs from stored data whenever positive_only is off or a merge/split rule applies. Separately, an extraction setting (`prompt_positive_only`) lives in the tagger's 'ai' doc with its default hardcoded twice (ai_settings DEFAULT_AI_SETTINGS and `reproject._prompt_positive_only`'s `.get(..., True)`), read through a hand-written SELECT that bypasses ai_settings. Weights (plan) will add another post-extract step (aliases must carry weights through merge/split) that would also have to be added in both places.

**Proposal.** In extraction_settings add `@dataclass ExtractionConfig(keywords, positive_only, aliases)` with `load_sync()` (reproject thread) and `async load()` (preview), reading the 'ai' flag via one shared reader. Add `gen_metadata.derive(raw, ruleset, config) -> dict | None` (extract + apply aliases) and have both reproject and rules preview call it. Delete `reproject._prompt_positive_only/_load_aliases` and the duplicated default. Leave the setting's storage location (ai doc) alone; only the read path moves.

**Evidence.** `packages/backend/src/moire/services/reproject.py:35-62`, `packages/backend/src/moire/services/reproject.py:165-207`, `packages/backend/src/moire/api/rules.py:372-381`, `packages/backend/src/moire/services/ai_settings.py:27-31`, `packages/backend/src/moire/services/ai_settings.py:74-97`, `packages/backend/src/moire/services/extraction_settings.py:36-66`

### S7.5 One malformed graph aborts a whole reprojection: extract is not total and the loop has no per-row guard

`bug | S | L3 | conf med | tests no | risk low`

**Problem.** `_find_sampler` does `inp = node.get('inputs', {})` then `'positive' in inp`; a node with `"inputs": null` (or a list) raises TypeError, and `parse_comfyui` calls `.get` on it unguarded (AttributeError). Other helpers (`_resolve_text`, `comfy_loras`) do check `isinstance(inp, dict)`, so the module's own convention is 'never raise on hostile graphs' (resolve_path says 'Never raises'). In `_reproject_where` there is no try/except around `gen_metadata.extract`, so the exception propagates out of the run; `_tracked` only logs it. Every image after the bad row stays underived until the next restart/rescan, which then hits the same row first. Also `_empty` shallow-copies `_EMPTY`, so `loras`, `embeddings`, `guessed`, `guess_paths` are shared mutable objects across calls (currently safe only because each caller reassigns before mutating).

**Proposal.** In `_find_sampler`/`parse_comfyui` use `inp = node.get('inputs'); if not isinstance(inp, dict): continue`. In `_reproject_where` wrap the extract+aliases step in try/except Exception, log with the image id, and `continue` (counting it as advanced). Make `_empty` build fresh lists/dicts (`copy.deepcopy(_EMPTY)`). Add a test_gen_metadata case with `{'3': {'class_type': 'KSampler', 'inputs': None}}` and a reproject test with one poisoned raw.

**Evidence.** `packages/backend/src/moire/services/gen_metadata.py:723-733`, `packages/backend/src/moire/services/gen_metadata.py:746-750`, `packages/backend/src/moire/services/reproject.py:186-211`, `packages/backend/src/moire/services/reproject.py:267-273`

### S7.6 gen_metadata.py (1073 lines) fuses four jobs; callers reach into a private function

`split | M | L3 | conf high | tests yes | risk low`

**Problem.** One file holds (a) raw capture + format sniffing, (b) workflow identity (workflow_sig, node_types, editor_node_types, similarity, match_workflow_file, describe_signatures) used only by api/rules.py and generator_setup, (c) ComfyUI graph text resolution (display nodes, _resolve_text, ckpt walk), (d) LoRA/embedding extraction and (e) user ruleset pinning, plus the extract() dispatcher. Block (b) has no dependency on extraction at all. generator_discovery calls `gen_metadata._resolve_text` three times, so a 'private' function is in practice a public API with three callers and the leading underscore hides it from refactors. The module's own docstring promises 'pure parsers turning embedded data into gen.* fields'; (b) is not that.

**Proposal.** Move lines 240-400 to `services/workflow_identity.py` (re-export `workflow_sig` from gen_metadata for the scanner call at scanner.py:480 or update that one import); move 411-575 to `services/comfy_text.py` with public `resolve_text(prompt_json, ref, shown=None)` and `display_cache`/`displayed_text` (this is also where text_eval is already a sibling, which gives the comfy text stack one home); optionally 578-720 to `services/gen_loras.py`. Leave capture, parse_a1111, rules and extract() in gen_metadata (about 450 lines). Pure move plus renaming `_resolve_text` to `resolve_text`; update CONTEXT.md names (`gen_metadata._resolve_text`, `gen_metadata.comfy_loras`, `pin_value`).

**Evidence.** `packages/backend/src/moire/services/gen_metadata.py:240-400`, `packages/backend/src/moire/services/gen_metadata.py:411-575`, `packages/backend/src/moire/services/gen_metadata.py:578-720`, `packages/backend/src/moire/services/gen_metadata.py:859-1000`, `packages/backend/src/moire/api/rules.py:161-180`, `packages/backend/src/moire/services/generator_setup.py:131-132`, `packages/backend/src/moire/services/generator_discovery.py:190`, `packages/backend/src/moire/services/generator_discovery.py:257`, `packages/backend/src/moire/services/generator_discovery.py:504`

### S7.7 app_settings JSON-row read/upsert is hand-written in 8 modules; extraction_settings has it 4 times

`dedupe | M | L3 | conf high | tests partial | risk low`

**Problem.** `select(app_settings.doc).where(_id == ROW)` and the sqlite `insert ... on_conflict_do_update(set_={'doc': excluded.doc})` are copied into ai_settings, tag_settings, extraction_settings (three identical selects, sync and async variants), onboarding, comfy_settings, tag_migrations and the scanner stamp. Only the row id and defaults differ. This is how reproject came to read the 'ai' row with its own SELECT and its own default.

**Proposal.** Add `services/app_settings.py` with `async read(row) -> dict | None`, `read_sync(row)`, `async write(row, doc)` (upsert replace) and `write_sync`, using the `*_conn/*_tx` helpers. Convert extraction_settings and reproject first (in this slice), then the other modules opportunistically. Interface is four functions; the deletion test says it concentrates the upsert idiom in one place.

**Evidence.** `packages/backend/src/moire/services/extraction_settings.py:36-66`, `packages/backend/src/moire/services/extraction_settings.py:85-92`, `packages/backend/src/moire/services/reproject.py:53-62`, `packages/backend/src/moire/services/ai_settings.py:74-107`, `packages/backend/src/moire/services/tag_settings.py:85-110`, `packages/backend/src/moire/services/onboarding.py:26-44`, `packages/backend/src/moire/services/comfy_settings.py:83-95`, `packages/backend/src/moire/services/tag_migrations.py:47-58`

### S7.8 Same signatures query inlined in 3 components plus 2 manual fetches; ruleset API sits in lib/gen.ts with raw fetch

`boundary | S | L3 | conf high | tests partial | risk low`

**Problem.** lib/api.ts says `api<T>()` is the one fetch-JSON helper, but gen.ts defines its own private `getJson` and four more hand-rolled fetch+ok-check blocks (saveRuleset, deleteRuleset, previewRuleset, fetchWorkflow). The `["rules-signatures"]` useQuery with `staleTime: 60_000` is copy-pasted in TagPanel, CharacterPage and AllImagesPage (string key repeated, one with `enabled`), while RulesPage and ResolvePromptDialog call fetchSignatures() imperatively into local state, so they never share the cache and RulesPage's edits do not refresh the other three. The file name `gen.ts` also hides that it is mostly the Rules API (GenMeta is the only 'gen' content).

**Proposal.** Move the ruleset/signature/workflow functions and their types (Ruleset, RuleFields, SignatureRow, PreviewResult, WorkflowPayload, workflowClipboardText) to `lib/rules.ts` over `api()`; keep GenMeta in gen.ts. Add `useSignatures({enabled})` plus `SIGNATURES_KEY` to lib/queries (like TAG_SETTINGS_KEY) and use it in the three components; have saveRuleset/deleteRuleset callers invalidate the key. Update gen.test.ts and the useRulesetSession mock path.

**Evidence.** `packages/frontend/src/lib/gen.ts:79-139`, `packages/frontend/src/lib/api.ts:1-11`, `packages/frontend/src/components/TagPanel.tsx:70-74`, `packages/frontend/src/pages/CharacterPage.tsx:435-439`, `packages/frontend/src/pages/AllImagesPage.tsx:145-150`, `packages/frontend/src/pages/RulesPage.tsx:122-129`, `packages/frontend/src/components/ResolvePromptDialog.tsx:67`

### S7.9 BoilerplateSection and PromptGuessSection are the same chip-list editor written twice

`dedupe | S | L2 | conf high | tests no | risk low`

**Problem.** Both implement: `sameList`, draft-state seeded from server via useEffect, `dirty` + useUnsavedChangesGuard, a pill list with a remove X button (identical class strings), a comma-separated add form, a Reset to defaults / Save changes footer with identical markup, and the save toast flow. PromptGuessSection even has the pills inside a `KeywordList` subcomponent while BoilerplateSection inlines the same thing. A third chip-list setting would be a third copy. (The entry normalisation rules differ and legitimately stay per-section.)

**Proposal.** Extract `components/settings/ChipListEditor.tsx` (props: entries, onChange, normalize(piece) -> string | null, label, placeholder, renderChip?) and `components/settings/SaveBar.tsx` (dirty, saving, atDefaults, onReset, onSave), plus `lib/lists.ts` `sameList`. Both sections shrink to their query hook, normalizer and preview. Keep `hooks/useUnsavedChangesGuard` as is.

**Evidence.** `packages/frontend/src/pages/settings/sections/BoilerplateSection.tsx:26-28`, `packages/frontend/src/pages/settings/sections/BoilerplateSection.tsx:41-96`, `packages/frontend/src/pages/settings/sections/BoilerplateSection.tsx:190-196`, `packages/frontend/src/pages/settings/sections/PromptGuessSection.tsx:19-20`, `packages/frontend/src/pages/settings/sections/PromptGuessSection.tsx:121-205`

**Cross-cutting hints.**

- packages/backend/src/moire/services/tag_settings.py:57-82 and packages/frontend/src/lib/boilerplate.ts:15-24,55-62: the boilerplate entry normalisation (space/underscore, lowercase, bare-* rejection) is implemented on both sides by hand ('matching lives in the frontend'); BoilerplateSection.add re-validates what clean_boilerplate re-validates on save. A shared fixture or returning the server-cleaned list would stop drift.
- packages/backend/src/moire/services/scanner.py:60-90 and services/onboarding.py, comfy_settings.py, tag_migrations.py: more copies of the app_settings upsert (see finding 7) outside this slice.
- packages/frontend/src/lib/promptOutline.ts:28 splitSpans and :159 promptWord are exported but only used inside the module / tests (knip lead at leads.txt:134); de-export splitSpans, keep promptWord only if the board needs it.
- packages/backend/src/moire/services/text_eval.py:25 comment 'Literal string nodes: (class_type predicate, widget holding the text)' is stale (it describes _LITERAL_KEYS only). text_eval._text_concat/_show_text and gen_metadata._resolve_text/_is_display/_CONCAT_INPUT are two parallel graph text walkers with separate cycle guards; if they keep growing, fold the concat/display handling into text_eval's handler table (only worth it with a third caller).
- packages/backend/src/moire/services/generator_discovery.py:190,257,504 calls the private gen_metadata._resolve_text (see finding 6).
- packages/frontend/src/pages/settings/sections/PromptTagsSection.tsx:20 uses Checkbox `hint=` and several sections use long description/helper paragraphs; memory rule 'no UI subtext' may apply, worth a pass in the settings area owner's slice.

## S8-genengine

*The generation engine is well documented and its pure helpers are tested, but generation_jobs.py (1505 lines) has grown into four modules and creates an import inversion (estimate and batches import back from jobs, with lazy imports to hide the cycle). api/generate.py is a 751-line grab-bag of eight unrelated route groups with business logic in put_comfyui and repeated error mapping. The prompt-text helpers in generation_compose are a second, weaker prompt parser sitting beside prompt_parse, and they sit directly in the path of the tag-weights plan. No hard bugs in the poll loop; two small real bugs (auto-name with escaped parens, cancelled requests drawn as done frames).*

### S8.1 Split generation_jobs.py by job and fix the jobs/estimate/batches import cycle

`split | M | L5 | conf high | tests yes | risk low`

**Problem.** One 1505-line file holds five jobs: (a) pure ComfyUI history parsing (outputs_from_history, history_result, model_loaded, run_seconds), (b) output-folder discovery and download (held_by, root_candidates, output_image_id, _place_outputs, _find_output_root, _fetch_missing, _write_atomic), (c) pure batch-input normalization (batch_shape, _parts, _resolve, _characters_input, _character_input, _outfit_input, characters_of, outfit_tags), (d) Generator persistence (load_generator, which even self-heals the builtin row), (e) the GenerationManager poll loop and actions. generation_estimate needs load_generator and batch_shape, so it imports them lazily inside functions (lines 218, 425-426) while generation_jobs imports generation_estimate at module top: an inverted dependency hidden by deferred imports. generation_batches also imports Invalid/Unavailable/load_generator from the manager module just to reach the model.

**Proposal.** Carve out, leaving the manager a thin orchestrator: (1) services/comfy_history.py with the four pure history functions (+ _ENDS); (2) services/generation_outputs.py with the output-placement code (held_by, root_candidates, output_image_id, place_outputs(client, files, settings), fetch_missing); (3) services/generation_inputs.py with batch_shape + the _parts/_resolve/_characters_input family + characters_of/outfit_tags (all pure, no manager); (4) services/generators_store.py with load_generator and the builtin refresh. Errors (Unavailable/Invalid/Rejected) move to a tiny generation_errors.py. Then estimate imports generators_store and generation_inputs at top level with no cycle, and generation_batches imports from the store, not the manager. Keep re-exports in generation_jobs for one step if tests import from it (tests import held_by/root_candidates from generation_jobs).

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:86-190`, `packages/backend/src/moire/services/generation_jobs.py:196-278`, `packages/backend/src/moire/services/generation_jobs.py:280-425`, `packages/backend/src/moire/services/generation_jobs.py:428-471`, `packages/backend/src/moire/services/generation_jobs.py:830-940`, `packages/backend/src/moire/services/generation_estimate.py:218`, `packages/backend/src/moire/services/generation_estimate.py:425-426`, `packages/backend/src/moire/services/generation_batches.py:16`

### S8.2 Extract a pure build_batch_inputs from queue_batch (radon D24) and derive the requeue key list from it

`deepen | M | L4 | conf high | tests partial | risk med`

**Problem.** queue_batch does connection check, generator lookup, shape math, seed resolution, assembling the persisted `inputs` dict, two prompt-composition paths (layered parts vs legacy base/extra), the 50k composer cap, then locking and submit. The inputs schema is written in queue_batch and read back in requeue through a hand-copied 16-key tuple (1316-1334), so adding an input key to one and forgetting the other silently drops it on requeue. The legacy compose path is still live (start_test sends base/negative_base, and pre-layered batches requeue through it), so it cannot just be deleted. _insert_and_submit also embeds the batch auto-naming rules (1209-1228: single character names outfit, hide untouched Default).

**Proposal.** Add `build_batch_inputs(body, gen, settings, *, test) -> BatchPlan(inputs, sizes, seeds, name_words)` (pure, in the generation_inputs module from the previous finding) and `batch_name(body, inputs, gen_name, batch_id)` beside auto_name in generation_compose. queue_batch becomes: require connection, load generator, plan = build_batch_inputs(...), locked insert+submit. Put `REPLAY_KEYS` next to the function that writes inputs and have requeue use it, with a test asserting every key build_batch_inputs persists is in REPLAY_KEYS or explicitly derived (positive_text, negative_text, test, per_request, per_request_asked).

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:1097-1181`, `packages/backend/src/moire/services/generation_jobs.py:1302-1341`, `packages/backend/src/moire/services/generation_jobs.py:1183-1264`

### S8.3 generation_compose holds a second, weaker prompt parser (prompt_terms, without_terms/_top_level_pieces) beside prompt_parse; escaped-paren auto-name bug

`dedupe | S | L4 | conf high | tests partial | risk low TW`

**Problem.** CONTEXT says prompt parsing is owned by services/prompt_parse.py, yet generation_compose re-implements weight/bracket stripping with a regex (_WEIGHT) in prompt_terms and its own bracket-depth scanner in _top_level_pieces (without_terms then calls parse_prompt on each piece anyway). The regex version is wrong on escaped parens: `hu_tao_\(genshin_impact\)` has its trailing `)` stripped by `[)\]]+$`, then backslashes removed, leaving `hu_tao_(genshin_impact` in the batch's auto name. display()/prompt_terms also turn every `_` into a space, ignoring the kaomoji rule (`^_^`) that formatTag and CONTEXT state. without_terms is prompt editing used by remix and generator_setup, not composition, so it is misfiled. The frontend mirrors prompt_terms too (compose.ts:57-70). The tag-weights plan adds a weight reader in reproject and a bumpWeight editor, so this will become a third/fourth place that knows `(x:1.2)` unless consolidated first.

**Proposal.** Reimplement prompt_terms(text, limit) as `[p.text for p in parse_prompt(text) if p.kind == 'tag'][:limit]` (parse_prompt already drops weights/brackets and handles escapes), then display via a shared kaomoji-aware `display_tag` (put it in services/tag_names.py as the backend twin of formatTag). Move without_terms and _top_level_pieces to prompt_parse.py (or a prompt_edit.py) and keep generation_compose to compose_parts/compose/auto_name. Update the frontend promptTerms to the same rule and the shared test cases (compose.test.ts / test_generation_compose.py) with an escaped-paren and a kaomoji case. When the weights session starts, the weight reading belongs in prompt_parse next to this.

**Evidence.** `packages/backend/src/moire/services/generation_compose.py:57-74`, `packages/backend/src/moire/services/generation_compose.py:77-81`, `packages/backend/src/moire/services/generation_compose.py:103-134`, `packages/backend/src/moire/services/prompt_parse.py:41`, `packages/backend/src/moire/services/prompt_parse.py:122`, `packages/backend/src/moire/services/remix.py:22`, `packages/backend/src/moire/services/generator_setup.py:25`, `packages/frontend/src/lib/compose.ts:57-70`, `docs/tag-weights-plan.md:1-43`

### S8.4 api/generate.py is eight routers in one file, with service logic in put_comfyui and quadruplicated error mapping

`boundary | M | L4 | conf high | tests yes | risk low`

**Problem.** One router (mounted once at /generate) carries ComfyUI connection settings, generators, remix, character recipes, outfits (10 routes), prompt presets, LoRA presets, and batches. put_comfyui (201-241) is service work in a router: it registers/updates a Library, turns watching on, validates the PEM with ssl, checks output_root, resets output_root when the address changes, and decides when to reconfigure the manager; _settings_view imports another router's handler (api.libraries.list_libraries) to resolve a path. The `except Unavailable -> 503 / Invalid -> 400 / Rejected -> 422 body` mapping is hand-written in test_generator, queue_batch and requeue_batch. The prompt-preset and LoRA-preset route blocks (591-653) are identical line for line apart from the module.

**Proposal.** (1) Make api/generate/ a package of sub-routers (comfyui.py, generators.py, outfits.py, presets.py, batches.py) included from one __init__ router so main.py and URLs do not change. (2) Move put_comfyui's body into comfy_settings.apply_patch(patch) (or services/comfy_connection.py), returning whether the client must reconfigure; the router keeps only HTTP error translation. (3) Add one `queue_errors()` context manager or `raise_for_queue(e)` helper that maps Unavailable/Invalid/Rejected, used by the three sites. (4) Factor the preset CRUD into a `preset_router(module, error_cls)` builder used for both presets and lora-presets.

**Evidence.** `packages/backend/src/moire/api/generate.py:172-190`, `packages/backend/src/moire/api/generate.py:201-241`, `packages/backend/src/moire/api/generate.py:410-421`, `packages/backend/src/moire/api/generate.py:466-585`, `packages/backend/src/moire/api/generate.py:588-653`, `packages/backend/src/moire/api/generate.py:669-727`, `packages/backend/src/moire/main.py:198`

### S8.5 Route handlers call each other and build the full batch view just to 404; list/status do repeated queue_plan work

`simplify | S | L3 | conf high | tests yes | risk low`

**Problem.** rename_batch, retry_request, cancel_batch and cancel_request call the route function get_batch(); cancel_batch calls it twice (once only as a 404 check at 741, then for the reply) and each call runs generation_batches.get_batch, which reads outputs, joins images, resolves the generator and runs queue_plan (a history read + a queue query) when anything is unfinished. list_generators calls generator_view per Generator, and each one with a test batch calls get_batch again, so the Generators list does N queue_plans. cancel_request on an unknown batch cancels nothing and then 404s only via the final get_batch.

**Proposal.** Add `generation_batches.batch_exists(id)` (a one-row select) for the 404 check and call generation_batches.get_batch (not the route function) for replies. Give generator_view a lighter `test_status(batch_id)` that reads just the test's request row and outputs instead of the whole batch view with an estimate plan.

**Evidence.** `packages/backend/src/moire/api/generate.py:700-751`, `packages/backend/src/moire/services/generation_batches.py:97-163`, `packages/backend/src/moire/services/generation_batches.py:292-340`, `packages/backend/src/moire/api/generate.py:297-306`

### S8.6 The Generator test gate lives in the 'read side' module and generator_view writes on GET

`boundary | M | L3 | conf med | tests yes | risk med`

**Problem.** generation_batches claims to be the read side but also holds start_test (queues work and writes generators.test/ready) and generator_view, which flips generators.ready=True when it notices the test image arrived (316-322) as a side effect of GET /generators and GET /generators/{id}. The gate's rule (ready only after a test image reached the library, per CONTEXT) is therefore only evaluated when someone views the list, and the logic sits between presentation code. Callers wanting ready get a mutation by reading.

**Proposal.** Move start_test and a `settle_test(generator_id)` (the flip) into services/generator_test.py. Call settle_test from the manager's _finalize/_sync path for requests of a test batch (or from a tick hook) and keep generator_view purely read-only. Keep behaviour identical for clients; update the integration test that polls GET /generators/{id} to still see ready flip after a tick.

**Evidence.** `packages/backend/src/moire/services/generation_batches.py:1-4`, `packages/backend/src/moire/services/generation_batches.py:240-284`, `packages/backend/src/moire/services/generation_batches.py:292-340`, `packages/backend/src/moire/api/generate.py:297-306`, `packages/backend/src/moire/api/generate.py:400-407`

### S8.7 Request/batch state vocabulary is spelled out in five places

`dedupe | S | L2 | conf high | tests yes | risk low`

**Problem.** UNFINISHED and IN_COMFY are defined in generation_jobs; generation_batches re-spells the same tuple as _OPEN (defined mid-file at line 405, after its first use in a function above) and as inline literals at 39 and 123; generation_estimate does it inline again at 359; the failed/lost pair and the retryable set (1370) are inline too. A new state (a 'replaced' like state was already added and needed _VISIBLE) must be found by grep.

**Proposal.** One small generation_states.py: UNFINISHED, IN_COMFY, FAILED = ('failed','lost'), RETRYABLE, VISIBLE-excluded 'replaced'; import it in all four modules. Falls out naturally from splitting generation_jobs.

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:61-62`, `packages/backend/src/moire/services/generation_batches.py:39`, `packages/backend/src/moire/services/generation_batches.py:123`, `packages/backend/src/moire/services/generation_batches.py:405`, `packages/backend/src/moire/services/generation_estimate.py:359`, `packages/backend/src/moire/services/generation_jobs.py:1370`

### S8.8 Cancelled requests render as 'done' frames in the queue card

`bug | S | L2 | conf low | tests no | risk low`

**Problem.** _frames maps failed/lost to 'failed', running to 'making', _OPEN to 'waiting', and everything else (including 'cancelled') falls through to 'done' frames with thumb None. Cancelling one request of an active batch (POST .../requests/{id}/cancel) therefore shows n finished-looking empty frames, and active_summary counts it in `finished` without a distinct state. Low confidence it is unintended, since no test or comment covers a cancelled frame.

**Proposal.** Add a `cancelled` branch in _frames returning {'state': 'cancelled', 'thumb': None} (or drop cancelled requests from frames) and have the queue card style it; add a test of active_summary after a single-request cancel.

**Evidence.** `packages/backend/src/moire/services/generation_batches.py:405-422`, `packages/backend/src/moire/services/generation_batches.py:343-402`

### S8.9 Rejected duplicates ComfyRejected, and non-ComfyUI failures are raised as ComfyRejected

`naming | S | L2 | conf med | tests partial | risk low`

**Problem.** Rejected and ComfyRejected are the same class by shape (message, node_errors), and _insert_and_submit translates one into the other field by field. _submit also raises ComfyRejected('Its workflow was deleted', []) and ComfyRejected(str(GraphError), []) for failures ComfyUI never saw, so the client module's exception means two things and the failed request's error doc says type 'rejected' for them.

**Proposal.** Make Rejected the single type (define it in generation_errors, have ComfyRejected subclass it, or re-raise ComfyRejected as-is and drop the translation). Raise a distinct `GraphInvalid(Rejected)` for the deleted-workflow and GraphError cases so _fail_request can record a truthful type.

**Evidence.** `packages/backend/src/moire/services/generation_jobs.py:77-83`, `packages/backend/src/moire/services/comfy_client.py:45-52`, `packages/backend/src/moire/services/generation_jobs.py:1028-1048`, `packages/backend/src/moire/services/generation_jobs.py:1249-1253`

### S8.10 Test-only wrappers in generation_estimate and an unused on_state hook in the client

`dead | S | L1 | conf high | tests yes | risk low`

**Problem.** warm_estimate and load_cost are one-line wrappers over _warm and _Memo(...).load with no src caller (vulture confirmed by grep; only test_generation_estimate.py uses them). ComfyClient.events(on_state=...) is never passed by GenerationManager._ws_loop (only a test passes it), so the connect/drop callbacks are dead in production. The 'dead' cost is small, but they make the public surface of estimate look bigger than the real one (plan, for_new, queue_plan, forget, history).

**Proposal.** Delete the two wrappers and point the tests at plan() or the underscore functions (or rename _warm to a public name if the tests really want the ladder alone). Drop on_state from events() and its test, or use it in _ws_loop to set `connected` earlier than the poll.

**Evidence.** `packages/backend/src/moire/services/generation_estimate.py:135-145`, `packages/backend/src/moire/services/comfy_client.py:239-274`, `docs/refactor-pass/leads.txt:27-28`

**Cross-cutting hints.**

- packages/backend/src/moire/services/outfits.py: clean_tags is imported into generation_jobs and re-validated in _outfit_input; confirm the router's OutfitIn max_length and the service agree (api/generate.py:79).
- packages/frontend/src/lib/compose.ts:57-70 and packages/frontend/src/lib/batchName.ts mirror generation_compose.prompt_terms/auto_name; change them together with the backend (tag-weights path via lib/promptOutline.ts unwrap/readTerm).
- packages/backend/src/moire/services/comfy_models.py:32-44 calls client.object_info per class on every refresh and generation_jobs._node_info reads the whole /object_info separately; worth checking whether they could share one cached read.
- packages/backend/src/moire/api/activity.py:107 reads get_generation_manager() state directly (manager.progress/started), another consumer of the manager internals beside api/generate.py:283.
- packages/backend/src/moire/services/batch_pool.py is used only by scanner.py:673 (generic, fine) but CONTEXT lists it under Scan, outside the generation slice; no change needed.

## S9-comfysetup

*Backend is well factored and heavily commented: discovery and graph are pure, setup owns the DB, and carry_slots and the slot checks have unit tests. Weak spots are three leaky seams (graph helpers imported across modules by private name, family naming implemented twice, a setup payload computed but unread) and one oversized page (WorkflowSetupPage, 769 lines). Frontend pure logic (generatorSetup, workflow, workflows) is properly in lib/ with tests. Nothing here sits in the tag-weights path.*

### S9.1 Workflow family naming (name, matched file) is implemented in api/rules.py and again in generator_setup.image_source

`dedupe | M | L3 | conf high | tests partial | risk low`

**Problem.** workflow_family.py says both the Rules page and the gallery 'go through this module so they can never disagree', but it only owns family_sigs and the WORKFLOW_ID SQL expression. The rest of the family concept is written twice by hand. (a) The family key rule (editor workflow.id, else moire.family) exists in SQL as WORKFLOW_ID and again in Python in image_source (lines 103-107). (b) The name lookup (workflow_names), the imported-file lookup (workflow_files) and the editor-node-type match via gen_metadata.match_workflow_file are done once in the list_signatures router (_family, with the router doing the service work) and once in image_source. The two already differ: the router also returns file_match and rounds it, image_source drops it, and the frontend names a family differently again (groupWorkflows: name, else newest matched file, else 'Unnamed workflow'). A change to naming (e.g. tag-aware or case rules) has to be made in three places.

**Proposal.** Add to workflow_family.py a pure `family_key(raw) -> str|None` (the Python twin of WORKFLOW_ID, tested against it) and `async family_labels(conn, family_ids, ui_nodes_by_family) -> {family_id: {name, file_name, file_match}}` doing the two batched queries plus match_workflow_file. rules.py _family and generator_setup.image_source both call it (image_source with one id). Keep the response shapes unchanged. The router then loses ~40 lines of SQL.

**Evidence.** `packages/backend/src/moire/services/generator_setup.py:103-137`, `packages/backend/src/moire/api/rules.py:105-181`, `packages/backend/src/moire/services/workflow_family.py:1-41`

### S9.2 Graph primitives are scattered and imported by private name; stock LoRA loader check is spelled six times

`boundary | M | L3 | conf high | tests yes | risk low`

**Problem.** generator_graph.py is documented as 'pure functions over API graphs' but the basic vocabulary lives elsewhere and leaks by underscore: discovery imports generator_graph._is_link, remix imports generator_discovery._SAMPLING_INPUTS, discovery calls gen_metadata._resolve_text. The traversal helpers (_inputs, _upstream, _title) are private to discovery while generator_graph.drop_missing and bypass_loras hand-roll the same 'follow links upstream' walk with a different guard (node.get('inputs', {}) instead of the isinstance-checked _inputs, so a null inputs crashes there but not in discovery). The test 'is this a stock LoRA loader' appears as the private _STOCK_LORA_LOADERS tuple in generator_graph but as the literal ('LoraLoader','LoraLoaderModelOnly') in discovery (twice, plus once in the check_slots block), generator_setup.carry_slots and generation_jobs, so adding a loader class means six edits. remix.graph_settings is a second reader of 'what the base sampler ran with' (sampling via _SAMPLING_INPUTS, size via fixed_values(graph, {})['size']) parallel to discover()'s slot-finding.

**Proposal.** Make generator_graph the single owner: public `is_link`, `node_inputs(graph, nid)` (always a dict), `upstream(graph, start)`, `node_title`, `STOCK_LORA_LOADERS` plus `stock_lora_nodes(graph) -> [(nid, node)]`, and `SAMPLING_INPUTS`. drop_missing and bypass_loras use node_inputs/upstream. discovery imports only public names. Add `base_settings(graph) -> {size, sampling, checkpoint}` in discovery (built on base_sampler/_latent/model_loader) and have fixed_values and remix.graph_settings call it. Pure move plus rename, existing test_generator_graph/test_generator_discovery cover it.

**Evidence.** `packages/backend/src/moire/services/generator_discovery.py:20-27`, `packages/backend/src/moire/services/generator_discovery.py:56-79`, `packages/backend/src/moire/services/generator_discovery.py:430-446`, `packages/backend/src/moire/services/generator_discovery.py:547-552`, `packages/backend/src/moire/services/generator_setup.py:513-516`, `packages/backend/src/moire/services/generator_graph.py:37-39`, `packages/backend/src/moire/services/generation_jobs.py:414`, `packages/backend/src/moire/services/remix.py:24`, `packages/backend/src/moire/services/remix.py:76-95`, `packages/backend/src/moire/services/generator_graph.py:255-298`

### S9.3 JsonTree branch toggle opens and closes every sibling branch at once

`bug | S | L3 | conf med | tests partial | risk low`

**Problem.** Each JsonTree instance holds one `open` state (initially depth < 2) but renders many child entries. The per-child expand button calls `setOpen(o => !o)` on the parent instance, and every child computes `childOpen = open || ...` from that same state. So at depth 0 (where the root is open) clicking one node's arrow collapses all nodes; below depth 2 (closed by default) clicking one arrow expands every sibling branch of that node at once. The pin-a-path UI on Rules and the guessed-prompt marks therefore feel erratic on large graphs; the existing tests only cover path construction and search reveal, not manual toggling.

**Proposal.** Move the toggle state to the child: extract a small `Branch` component (key, value, path) that owns its own `useState(depth < 2)` and renders the button plus the nested JsonTree; JsonTree maps entries to either a leaf row or a Branch. Keep `open || matches || marks` as the forced-open rule inside Branch. Add a vitest that clicks one arrow and asserts siblings stay as they were.

**Evidence.** `packages/frontend/src/components/GraphTree.tsx:75`, `packages/frontend/src/components/GraphTree.tsx:118-122`, `packages/frontend/src/components/GraphTree.tsx:137-145`

### S9.4 Setup payload computes fields nothing reads, and the page's checklist re-derives the server's checks

`dead | S | L2 | conf high | tests partial | risk low`

**Problem.** grep of the frontend finds no consumer for setup.problems (typed at generate.ts:203, stubbed in a test), found.lora.existing or found.lora.consumers. Backend still computes them: _consumers is an O(nodes x inputs) scan per call, and check_slots runs on every setup_view. Meanwhile the UI's own `checklist()` re-implements a subset of check_slots (positive/negative chosen, Save Image present, node exists) with different wording, so the rules can drift: the server also blocks 'Positive and negative can't be the same input', 'prompt input is a link' and a bad LoRA insertion point, none of which the checklist shows, so the user can press an enabled Save and only learn from an error toast (create/update raise SetupError(problems[0])).

**Proposal.** Pick one source of truth. Preferred: have the page feed the live slots to the server's check or mirror those three missing rules in `checklist` and drop `problems` from setup_view. Either way delete `_consumers`, `found.lora.consumers` and `found.lora.existing` (the separate found.loras list already serves the UI) and their test assertions (test_generator_discovery.py:59). If kept, the checklist should render server problems for blocking items instead of re-deriving.

**Evidence.** `packages/backend/src/moire/services/generator_setup.py:265`, `packages/backend/src/moire/services/generator_discovery.py:366-373`, `packages/backend/src/moire/services/generator_discovery.py:419-435`, `packages/frontend/src/lib/generate.ts:189-190`, `packages/frontend/src/lib/generate.ts:203`, `packages/frontend/src/lib/generatorSetup.ts:77-108`, `packages/backend/src/moire/services/generator_discovery.py:516-555`

### S9.5 newer_version has an always-false branch and a duplicated field

`dead | S | L1 | conf high | tests yes | risk low`

**Problem.** `if src.workflow_sig in order and order.index(sig) > order.index(order[-1])` can never be true: order[-1] has the largest possible index in the list, so nothing is greater. It reads as a guard for 'the saved version is already newer than the family's newest' but does nothing. The return also sets `version` and `versions` both to len(order), so the banner ('version N of N') always reads 'version 5 of 5', which is the target version number, not the user's.

**Proposal.** Delete the dead branch, or if the intent was to skip when the saved sig is not the oldest-known, state it plainly. Drop the redundant key: return {image_id, workflow_sig, versions} and render 'A newer version is in your library (N versions)'; or compute the saved sig's position (order.index(src sig)+1) as `version` so 'version X of N' is meaningful. test_update_from_a_newer_version / test_newer_version_ignores_moires_own_outputs_and_older_ones already pin the contract.

**Evidence.** `packages/backend/src/moire/services/generator_setup.py:434-440`, `packages/backend/src/moire/services/generator_setup.py:454-459`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:723-727`

### S9.6 WorkflowSetupPage is a 769-line file with a 270-line SetupForm and shared UI parked in the wrong modules

`split | M | L2 | conf high | tests partial | risk low`

**Problem.** One file holds six components and the route container. SetupForm (lines 183-454) inlines eight slot cards, with logic that belongs in lib/: the sampling keys list is spelled twice (337, 340), the per-request stepper clamp (1..64, lines 292/301) duplicates the backend clamp, the save() normalisation of lora_model/lora_clip/lora_text (206-217) is untested inline code, and the 'From <family or file>' origin line (679-686) duplicates workflow.ts workflowLine with a slightly different rule (family_name || file_name versus family_name only). TestBadge, used by this page, ComfySection and the picker, lives inside WorkflowPicker.tsx so two pages import a component from a Generate widget, and its label table duplicates ComfyStatusLine's 'Needs a test run'.

**Proposal.** Split by component: components/workflow-setup/{SlotCard,PromptSlot,SetupForm,SourceStep,TestStep}.tsx with the page keeping only queries and mutations (about 200 lines). Move to lib/generatorSetup.ts: `finalSlots(slots, lorasOn, lora)` (the save() body), `SAMPLING_KEYS`, `clampPerRequest`, and a shared `workflowOrigin(source)` used by both the page and workflowLine. Move TestBadge and its STATE table next to testState in a components/generate/TestBadge.tsx. Pure move first, then the lib extractions with tests.

**Evidence.** `packages/frontend/src/pages/WorkflowSetupPage.tsx:44-454`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:458-512`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:516-588`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:337`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:340`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:679-686`, `packages/frontend/src/lib/workflow.ts:62-69`, `packages/frontend/src/components/generate/WorkflowPicker.tsx:15-27`

### S9.7 Workflow-file import flow is written twice and lib/workflows.ts uses raw fetch

`dedupe | S | L2 | conf high | tests partial | risk low`

**Problem.** ComfyStep.read and RulesPage.importFiles both do: filter .json, parseWorkflowFile each, count the skipped, call importWorkflowFiles. Only the surrounding messaging differs, and the 'no ComfyUI workflow files' empty-case handling is already worded differently. importWorkflowFiles and putWorkflowName hand-roll fetch + `if (!r.ok) throw new Error(await r.text())`, which is exactly lib/api.ts api(), and sit in the same file as the pure family-grouping code, so tests of groupWorkflows import a module that also does network.

**Proposal.** Add `async function readWorkflowFiles(files: File[]) -> {parsed: WorkflowFile[], skipped: number, imported: number, known: number}` in lib/workflows.ts (parse + batch import), and have both callers only format their message from the result. Rewrite the two fetches with api()/errorText. Optionally move the two network functions to lib/workflowQueries.ts so workflows.ts stays pure.

**Evidence.** `packages/frontend/src/components/onboarding/ComfyStep.tsx:80-98`, `packages/frontend/src/pages/RulesPage.tsx:199-232`, `packages/frontend/src/lib/workflows.ts:236-268`, `packages/frontend/src/lib/api.ts:6-11`

### S9.8 lora_stem is a model-name rule living in the graph module; workflow.ts / workflows.ts / WorkflowFamily names collide

`naming | S | L2 | conf med | tests yes | risk low`

**Problem.** lora_stem is the key matching ComfyUI files to image_loras.name, used by comfy_models, remix, recipes and lora_presets (4 non-graph modules), and comfy_models even applies it to checkpoints and embeddings (stem=lora_stem(n) for kind 'checkpoint'/'embedding'). It sits in generator_graph.py only because the graph code needed it first, so comfy_models imports the Generator graph module for a filename rule. On the frontend, lib/workflow.ts (a Generator's run bar and test state) and lib/workflows.ts (signature families for the Rules page and gallery) differ by one letter and are imported side by side; 'workflow' means a saved Generator in one, an editor-graph family in the other, while CONTEXT.md only defines the family sense, and the frontend type WorkflowFamily shadows the backend workflow_family module with different content.

**Proposal.** Backend: move lora_stem to a tiny pure module (services/model_names.py, `model_stem`, with lora_stem kept as an alias for one release) and import it from comfy_models, remix, recipes, lora_presets, generator_graph. Frontend: rename lib/workflow.ts to lib/generatorRunBar.ts (it is about Generators: runBarOf, testState, forWorkflow) and keep lib/workflows.ts for families; add the Generator vs workflow family sense to CONTEXT.md.

**Evidence.** `packages/backend/src/moire/services/generator_graph.py:55-64`, `packages/backend/src/moire/services/comfy_models.py:19`, `packages/backend/src/moire/services/comfy_models.py:46-48`, `packages/backend/src/moire/services/remix.py:25`, `packages/backend/src/moire/services/recipes.py:32`, `packages/backend/src/moire/services/lora_presets.py:25`, `packages/frontend/src/lib/workflow.ts:1-91`, `packages/frontend/src/lib/workflows.ts:136-144`

### S9.9 ComfyUI connection save-and-test is implemented in ComfySection and ComfyStep; per-request clamp lives in four places

`dedupe | S | L1 | conf med | tests partial | risk low`

**Problem.** Both screens do putSettings({address,...}) -> testConnection() -> invalidate GEN_KEY, with their own error and status shaping (toast vs ComfyState phase), and Disconnect is only in ComfyStep, so a fix to the sequence (e.g. testing before saving) must be made twice. The 'images per request 1..64' bound is hard-coded as max(1, min(64, n)) in comfy_settings.clean_patch, again in generator_setup.clean_slots, in the setup page stepper (Math.max(1,..)/Math.min(64,..)) and as max={64} on the Settings input, so changing it silently desynchronises client and server.

**Proposal.** Add a `useConnectComfy()` hook in lib/generate.ts returning `{connect(patch) -> {saved, result}, disconnect}` (saves then tests, invalidates GEN_KEY), used by both screens for the mutation, each keeping its own UI feedback. Export `PER_REQUEST_MAX = 64` from lib/generate.ts and `PER_REQUEST_MAX` from comfy_settings.py, imported by generator_setup, and expose the backend value on the settings GET so the frontend does not hard-code it.

**Evidence.** `packages/frontend/src/pages/settings/sections/ComfySection.tsx:145-160`, `packages/frontend/src/components/onboarding/ComfyStep.tsx:55-78`, `packages/backend/src/moire/services/comfy_settings.py:197-203`, `packages/backend/src/moire/services/generator_setup.py:324-328`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:292-301`, `packages/frontend/src/pages/settings/sections/ComfySection.tsx:333-336`

### S9.10 discover() is one 90-line function (radon D27) mixing six slot readers; text_inputs and check_slots are D21 and D23

`split | M | L1 | conf med | tests yes | risk med`

**Problem.** discover() interleaves prompt slots, latent size, sampling, checkpoint/loader, LoRA insertion and the node lists in one body, with the 'found' dict built by side effect as it goes. text_inputs packs a 6-clause literal filter and the reaches computation into one loop; check_slots has one long chain of per-slot rules. Adding a slot (a plausible next one: denoise or clip skip) means editing the middle of each of these plus clean_slots (D29) and the _SLOT_KEYS tuple, which is defined but never referenced (grep finds no other use).

**Proposal.** Split discover into `_prompt_slots`, `_latent_slots`, `_sampling_slots`, `_model_slots` (checkpoint + lora insertion), each returning (slots, found) fragments merged by discover. Pull text_inputs' literal test into `_is_prompt_literal(key, value)` and the reaches mapping into a two-set lookup. Delete the unused _SLOT_KEYS or make clean_slots iterate it so the allowed keys exist once. Keep behaviour pinned by the existing discovery tests.

**Evidence.** `packages/backend/src/moire/services/generator_discovery.py:376-464`, `packages/backend/src/moire/services/generator_discovery.py:205-262`, `packages/backend/src/moire/services/generator_discovery.py:516-555`, `packages/backend/src/moire/services/generator_setup.py:294-348`

**Cross-cutting hints.**

- packages/backend/src/moire/services/comfy_settings.py:55-69 hand-writes the app_settings JSON-row upsert (already in the 8-module finding); update_settings also does read-modify-write across two separate connections (get_settings, then async_tx), so two quick PUTs (ComfySection fires separate Save mutations for output folder, output root, download checkbox) can lose each other's field.
- packages/backend/src/moire/api/rules.py:105-181 holds service-level family/name/file assembly inside the signatures router (see finding 1); the same endpoint's thumb_version.urls and describe_signatures calls are fine.
- packages/backend/src/moire/services/generator_discovery.py:190 and :257 call gen_metadata._resolve_text (private); already covered by the gen_metadata private-function finding but discovery is a second external caller.
- packages/frontend/src/pages/RulesPage.test.tsx:3 imports JsonTree from ./RulesPage while the component now lives in components/GraphTree.tsx (works only if RulesPage re-exports it); worth checking the re-export is intentional.
- packages/backend/src/moire/services/generation_jobs.py:414 hard-codes ('LoraLoader','LoraLoaderModelOnly'), see finding 2.

## S10-compose

*The Generate composer is functional and the pure parts (generateForm, compose, promptRepeats) are well tested, but the three big UI files are fused: PromptInput (411 lines: suggestions, marked-term overlay and flash overlay), PromptBoard (653) and GeneratePage (873, with form reducers and board-layer building inline). Backend is small and clean; the two preset services are clones of each other and lora_presets mixes CRUD with library analytics. PromptInput is directly in the path of the Ctrl+Up/Down weight feature and its suggestion-list key handling would swallow those keys today.*

### S10.1 PromptInput fuses suggestions, marked-term overlay and flash overlay; Ctrl+Up/Down would be eaten by the suggestion list

`split | M | L5 | conf high | tests no | risk med TW`

**Problem.** One 350-line component owns three independent systems: tag/embedding autocomplete at the caret (term, matches, covers, pick, onKeyDown), the marks overlay (backRef mirror copy, markRefs, bubble, syncBack/syncScroll/ResizeObserver) and the flash overlay (flashing state, timers, note). onKeyDown treats ArrowUp/ArrowDown with no modifier check whenever the list is open, so the plan's Ctrl+Up/Down (bumpWeight) wired 'into PromptInput onKeyDown' would be consumed by list navigation while a suggestion is showing (it opens on every click/keystroke at a term). The doc comment for the component is stranded above the MIRRORED const, and the mirror-copy technique exists a second time in lib/caret.ts.

**Proposal.** Pure move first: extract `PromptOverlay.tsx` (props: value, marks, flash, textareaRef, className; owns backRef/markRefs/bubble/note/syncBack, exposes `markAt` handlers via a small hook `usePromptMarks`) and `usePromptSuggest.ts` (term, matches, at, pick, covers/thumbOf, returns {open, onKeyDown, listProps}). Leave PromptInput as ~100 lines composing them. Then add the weight keys in PromptInput's onKeyDown BEFORE the `open` branch with `if ((e.ctrlKey||e.metaKey) && (ArrowUp||ArrowDown)) { e.preventDefault(); apply(bumpWeight(...)) }` and make the list's arrow branch require !ctrlKey/metaKey. Move the covers `useTagBrowse`->thumbs map into one shared hook (see PromptBoard finding).

**Evidence.** `packages/frontend/src/components/generate/PromptInput.tsx:60-411`, `packages/frontend/src/components/generate/PromptInput.tsx:236-252`, `packages/frontend/src/components/generate/PromptInput.tsx:30-37`, `docs/tag-weights-plan.md`

### S10.2 Pure form logic and board-layer building live inside the 680-line GeneratePage component

`boundary | M | L4 | conf high | tests partial | risk low`

**Problem.** setOutfit, setCharacters (outfits/identityOff/fresh bookkeeping), the 'settle fresh character' reducer, chooseWorkflow (what to reset on a workflow switch), the board-layer construction with the strike/undo closures (lines 513-529, the most intricate untested logic), and the `blocked` reason chain are inline closures over setForm. generateForm.ts already holds sibling pure transforms (withCharacter, wearingOutfit, replaceCharacter) with tests, so these are split across two homes. The JSX also mixes the positive-layer stack (631-771) and the run bar (785-859) with page data wiring.

**Proposal.** Move to generateForm.ts as pure `(f, ...) => f` functions with tests: `setOutfitPick(f, tag, pick)`, `setCharacters(f, tags)`, `settleFresh(f, tag, pick)`, `switchWorkflow(f, id, next)`. Move board layers to `lib/boardLayers.ts`: `strikeCharacter(f, recipe, tags) -> {form, undo(form)}` as a pure pair plus `boardLayersOf(parts, recipes, everyone, form)`. Extract `PositiveLayers.tsx` (the blocks.map) and `RunBar.tsx` (settings card + run button, taking `blocked`/`queue` props) so GeneratePage keeps queries, draft sync and the cast-follow effect.

**Evidence.** `packages/frontend/src/pages/GeneratePage.tsx:209-253`, `packages/frontend/src/pages/GeneratePage.tsx:276-288`, `packages/frontend/src/pages/GeneratePage.tsx:496-548`, `packages/frontend/src/pages/GeneratePage.tsx:555-564`, `packages/frontend/src/pages/GeneratePage.tsx:631-771`, `packages/frontend/src/pages/GeneratePage.tsx:785-859`, `packages/frontend/src/lib/generateForm.ts:535-548`

### S10.3 PromptBoard: raw API fetch in a component, placement logic untested in-component, duplicated tag-cover map

`boundary | M | L4 | conf high | tests no | risk low TW`

**Problem.** TagPreview does `useQuery` with a hand-built `/api/v1/tags/samples?...` api() call and TAGS_KEY (same request TagPanel.tsx:92 builds again) instead of a lib/queries hook, against the lib/queries convention. PromptBoard also holds the pure board model inline: boxOf, placed(), the repeats count, byBox, coversOf, live/clearable, and the options ranking (library count then Danbooru posts), none unit-testable. The `useTagBrowse('all') -> Map(tag, thumb_url) -> thumbOf` trio is written identically in PromptBoard and PromptInput. The file is 653 lines with 4 components (TagPreview, Chip, CoverRow, GroupBox).

**Proposal.** Add `useTagSamples(tagId, per)` to lib/queries.ts and use it from TagPreview and TagPanel. Add `useTagCovers(enabled)` returning `thumbOf` and use it in both prompt components. Extract `lib/promptBoard.ts` with pure `placeTerms(terms, places, isBoilerplate) -> Placed[]`, `repeatedTags(placed)`, `groupByBox`, `rankOptions(offers, present, counts)` plus colocated tests; split TagPreview/Chip/GroupBox into `components/generate/board/` files, leaving PromptBoard as the orchestrator. Weights will add a chip number here (term.weight is already drawn at 160 and 258), so a smaller file helps.

**Evidence.** `packages/frontend/src/components/generate/PromptBoard.tsx:143-157`, `packages/frontend/src/components/TagPanel.tsx:88-95`, `packages/frontend/src/components/generate/PromptBoard.tsx:480-560`, `packages/frontend/src/components/generate/PromptBoard.tsx:525-531`, `packages/frontend/src/components/generate/PromptInput.tsx:78-82`, `packages/frontend/src/components/generate/PromptBoard.tsx:139-251`

### S10.4 ChipInput component is dead; the file survives only as the home of bareTagPool

`dead | S | L3 | conf high | tests no | risk low`

**Problem.** grep for 'ChipInput' across packages/frontend/src shows only three imports, all of `bareTagPool`; nothing renders `<ChipInput>`. The 120-line component (chip state, autocomplete, keyboard, toChip) is unused, and a pure data function lives in a component file imported by a page and two components. It also carries one of four hand-built `embedding:` spellings.

**Proposal.** Delete the ChipInput component and toChip. Move `bareTagPool` to lib/tags.ts (it already has tagName) with a one-case test, and update the three imports. useChipBorderStyle stays (used by CharacterBlock/CharacterPage).

**Evidence.** `packages/frontend/src/components/generate/ChipInput.tsx:1-162`, `packages/frontend/src/pages/GeneratePage.tsx:6`, `packages/frontend/src/components/generate/Outfit.tsx:16`, `packages/frontend/src/components/generate/CharacterBlock.tsx:19`

### S10.5 prompt_presets and lora_presets are the same CRUD service written twice, with two PresetError classes and doubled route error mapping

`dedupe | M | L3 | conf high | tests partial | risk low`

**Problem.** listing/create/update/delete, the name 1..80 and text <=4000 validation in `clean`, the `update` select-after-update, `delete` rowcount, and `updated_at` stamping are line-for-line the same (jscpd clones at lora_presets 78-87 and 99-110). Each module declares its own `PresetError`, so api/generate.py has two parallel try/except-to-400 blocks and eight near-identical handlers. A new preset field has to be added in two places and the validators can drift (e.g. strength rounding only exists on one side).

**Proposal.** Add `services/preset_store.py` with `class PresetError(ValueError)` and `class Store(table, clean_fields, order_by, seed=None)` providing listing/create/update/delete; each module becomes its field validator (`clean`) plus `store = Store(...)`. Share `clean_name`/`clean_text`. In api/generate.py register both route sets from one helper (`preset_routes(prefix, store)`) mapping PresetError once. Keep prompt_presets' seed-once-flag in its module.

**Evidence.** `packages/backend/src/moire/services/prompt_presets.py:21-128`, `packages/backend/src/moire/services/lora_presets.py:41-117`, `packages/backend/src/moire/api/generate.py:590-655`, `docs/refactor-pass/leads.txt:61-62`

### S10.6 lora_presets.py mixes CRUD with library analytics SQL and keeps its own ad-hoc TTL cache beside tag_index

`split | M | L3 | conf med | tests partial | risk low`

**Problem.** Past line 119 the module is not presets: it is trigger-word mining over `image_tags`/`image_loras`/`images` with a module-global `_total`/TOTAL_TTL cache that ignores tag writes (60 s stale, not generation-based), while the same codebase's derived-cache mechanism (`tag_index.read_derived/store_derived` with `current_generation`, used by api/tags.py `_library_bases` and `board_offers`) invalidates structurally. The 'distinct prompt' key (`coalesce(gen_prompt,_id)`), the `tag LIKE 'prompt:%'` filter and `not_quarantined()` are re-assembled three times (_prompt_total, _library, _common), which is how a filter gets missed in one of them.

**Proposal.** Move lines 119-335 (file_words, library_words, _prompt_total/_library/_common/_file, suggestions) to `services/lora_words.py`, leaving lora_presets as CRUD only. Inside, add one `_prompt_scope()` helper returning (key, tagged join, prompt predicate) used by the three queries, and replace `_total` with `tag_index.read_derived('lora-prompt-total')`/`store_derived`. Keep file_words/library_words pure and their tests.

**Evidence.** `packages/backend/src/moire/services/lora_presets.py:119-335`, `packages/backend/src/moire/services/lora_presets.py:168-196`, `packages/backend/src/moire/services/lora_presets.py:199-300`, `packages/backend/src/moire/api/tags.py:121-175`

### S10.7 prompt_board._section is a 39-complexity if-ladder that reaches into attire's private functions

`simplify | M | L3 | conf high | tests yes | risk low`

**Problem.** `_section` (radon E39, ruff C901 24) is one ordered ladder of 20+ rules with interleaved early returns, so the rule priority is only readable by tracing it. It and `place`/`offers` call attire's underscore-private `_load`, `_groups`, `_facet`, `_key` (7 call sites), so a refactor of attire's internals silently breaks the board and CLAUDE's 'one spelling rule' for keys is borrowed through a private name. `place` also re-runs the 'last words' fallback loop that calls _section again.

**Proposal.** Make `attire.key`, `attire.entry`, `attire.groups_of`, `attire.facet_of_entry` public (rename, no behavior change). In prompt_board split `_section` into named steps tried in order: `_identity_section` (overrides, characters, artist, meta), `_face_section`, `_pose_section` (holding, looking), `_facet_section(facet,...)` with the framing sub-ladder as its own function, `_entry_section`; `_section` becomes `for step in STEPS: if (s := step(ctx)) is not None: return s`. Test_prompt_board's parametrized test_sections already pins behavior.

**Evidence.** `packages/backend/src/moire/services/prompt_board.py:93-160`, `packages/backend/src/moire/services/prompt_board.py:106`, `packages/backend/src/moire/services/prompt_board.py:118`, `packages/backend/src/moire/services/prompt_board.py:168-178`, `packages/backend/src/moire/services/prompt_board.py:228-237`, `docs/refactor-pass/leads.txt:64-66`

### S10.8 generateForm.ts (548 lines) fuses form model, stored-draft validation, remix conversion and sampling display labels

`split | M | L2 | conf high | tests yes | risk low`

**Problem.** Four jobs share one file: (1) form types, block ops and toParts/previewText/toQueueBody; (2) validation of stored data (isStr, presetRef, block, validBlocks, composerFrom, keepOff, samplingOf, loadDraft/saveDraft, ~170 lines); (3) formFromBatch/formFromRemix; (4) pure display labels samplerLabel/samplingLabel/rejectedFields that RunControls and BatchPage import from a 'form' module. Any change to the form shape (a likely effect of new layers) edits one file in four places.

**Proposal.** Split along existing seams with no behavior change: `lib/generateDraft.ts` (validators + loadDraft/saveDraft/DRAFT_KEY), `lib/generateRemix.ts` (formFromBatch, formFromRemix, SeedChoice, withCharacter, wearingOutfit), `lib/sampling.ts` (samplingOf, samplerLabel, samplingLabel, rejectedFields). generateForm.ts keeps types, DEFAULT_FORM, block ops, toParts/previewText/toQueueBody/toEstimateBody. Re-export nothing; update the ~8 importers. Tests move with their functions.

**Evidence.** `packages/frontend/src/lib/generateForm.ts:196-232`, `packages/frontend/src/lib/generateForm.ts:258-361`, `packages/frontend/src/lib/generateForm.ts:365-424`, `packages/frontend/src/lib/generateForm.ts:489-528`, `packages/frontend/src/components/generate/RunControls.tsx:9`, `packages/frontend/src/pages/BatchPage.tsx:20`

### S10.9 Two parallel preset pickers and dialogs (prompt preset vs LoRA preset), plus a hand-rolled menu in AddLayer

`dedupe | M | L2 | conf med | tests no | risk med`

**Problem.** PresetControl+PresetDialog and LoraRow+LoraPresetDialog each reimplement: the NONE/NEW sentinel Picker options, the 'Deleted preset' dim row, current/deleted detection, the Edit button, seed-once-per-open dialog state with an eslint-disable, and save/delete mutations with invalidate+toast+onSaved. The LoRA copy adds strength and suggestions. AddLayer additionally hand-rolls an outside-click/Escape popup menu (role=menu) where CLAUDE.md says to use DropdownMenu.

**Proposal.** Extract `PresetPicker.tsx` taking `{presets, value, onPick(p|null), onNew, onEdit, noneLabel, detail?}` that builds the options and deleted-row logic, and `PresetDialogShell.tsx` (name field, footer with Delete/Cancel/Save, mutation wiring from `{create, update, remove, queryKey}`) with a children slot for the text/strength/suggestion fields. Replace AddLayer's popup with DropdownMenu using a custom icon trigger (items already have icon/label/title).

**Evidence.** `packages/frontend/src/components/generate/Layers.tsx:133-243`, `packages/frontend/src/components/generate/Layers.tsx:81-130`, `packages/frontend/src/components/generate/StyleLayer.tsx:44-165`, `packages/frontend/src/components/generate/StyleLayer.tsx:170-259`, `packages/frontend/src/components/ui/DropdownMenu.tsx:21-40`

### S10.10 The `embedding:` word spelling is hand-built in four places beside compose.ts's EMBEDDING_PREFIX

`dedupe | S | L1 | conf high | tests partial | risk low`

**Problem.** compose.ts exports EMBEDDING_PREFIX/isEmbedding/displayWord, but previewText and PromptInput (twice) write the literal 'embedding:' + name or startsWith('embedding:'), and knip flags the EMBEDDING_PREFIX export as unused outside the file. The backend has the matching pair in generation_compose (is_embedding, display), so a rename of the prefix would miss these sites silently.

**Proposal.** Add `embeddingWord(name)` to compose.ts and use it in previewText and PromptInput's resources list; use `isEmbedding(s._id)` at PromptInput:233. Keep EMBEDDING_PREFIX unexported. (ChipInput's copy goes away with the dead-code finding.)

**Evidence.** `packages/frontend/src/lib/compose.ts:11-21`, `packages/frontend/src/lib/generateForm.ts:186`, `packages/frontend/src/components/generate/PromptInput.tsx:99`, `packages/frontend/src/components/generate/PromptInput.tsx:233`, `packages/frontend/src/components/generate/ChipInput.tsx:59`

**Cross-cutting hints.**

- packages/backend/src/moire/api/generate.py:590-660 holds eight preset handlers with duplicated PresetError mapping (belongs with the api/generate split already reported).
- packages/frontend/src/hooks/useUnsavedChangesGuard.ts:19-26 default confirmLeave is window.confirm (already reported as native confirm; callers BoilerplateSection, PromptGuessSection, RulesPage all pass their own).
- packages/frontend/src/components/TagPanel.tsx:88-95 builds the same /tags/samples request as PromptBoard.tsx:146-153; a shared lib/queries hook serves both.
- packages/frontend/src/lib/batchName.ts:1-4 says the name is 'never parsed from prompt text', but GeneratePage.tsx:323 passes nameWords(form) (compose.promptTerms over the prompt), so the comment and the behavior disagree.
- packages/frontend/src/lib/caret.ts and PromptInput.tsx MIRRORED (lines 30-57) are two independent text-mirroring implementations with different copied-property lists; worth unifying when PromptInput is split.
- packages/frontend/src/lib/queries.ts:421-460 (useTagPlaces/useBoardOffers) feed the prompt board and CharacterPage; board section vocabulary (BoardSection) is duplicated by prompt_board.SECTIONS and PromptBoard BOXES.

## S11-runqueue

*The pure libs (requests, batches, eta, queueClock) are small, documented and well tested; the weight sits in three oversized presentation files (BatchResults 510, RunControls 543, BatchPage 294) that mix pure view-logic with markup, and in remix.py's single 100-line remix_view (radon E35). Real drift risk is the same small facts written in several places: sampling bounds, MAX_CHARACTERS, the "batch changed" cache invalidation, "which batch is in front", and three time formatters. Request-state vocabulary (UNFINISHED/GOING/inline arrays here) and the cancelled-frame bug are already reported in wave 1 and bugs.md, so they are not repeated. Nothing in this slice sits directly in the tag-weights path except remix's reuse of the weak without_terms splitter, which wave 1 already covers.*

### S11.1 Split remix_view (E35) into light and full reads; move the image-to-batch lookup and settings readers out

`split | M | L3 | conf high | tests yes | risk low`

**Problem.** remix_view takes a boolean `full` and does two jobs behind it: the viewer's light read (workflow + batch) and the full composer start (settings from graph or A1111 raw, LoRA table, character split with recipes, checkpoint match, sampling check). Inside the full half there are four unrelated steps inline (settings source selection with a raw SQL read of image_gen_raw, character extraction loop, checkpoint match, final assembly). It imports the private `_SAMPLING_INPUTS` from generator_discovery, it owns `_batch_of`, a 3-table join over generation_outputs/requests/batches that belongs with the other batch reads, and it matches a CHECKPOINT with `lora_stem` (a LoRA-named helper). The router already maps `?full=1` to two different responses.

**Proposal.** Make `remix_info(image_id)` (the `out` dict: workflow + batch) and `remix_doc(image_id)` (info plus the rest) public; keep `remix_view` only if the router needs one entry, as a 3-line dispatch. Extract async `_split_characters(prompt) -> (characters, prompt)` (the loop at 261-278), `_base_settings(gen, graph, image_id) -> (size, sampling)` (234-253) and `_match_checkpoint(model, installed)`. Move `_batch_of` to `generation_batches.batch_of_image(conn, image_id)`. Add a public `generator_discovery.sampling_literals(graph)` (or move graph_settings there) so remix stops importing a private dict, and rename/alias `lora_stem` as `file_stem` for the checkpoint use.

**Evidence.** `packages/backend/src/moire/services/remix.py:200-302`, `packages/backend/src/moire/services/remix.py:141-180`, `packages/backend/src/moire/services/remix.py:24`, `packages/backend/src/moire/api/generate.py:427-431`, `packages/backend/tests/test_remix.py:89-223`

### S11.2 Sampling bounds and MAX_CHARACTERS are each written in 3-4 places

`dedupe | S | L3 | conf high | tests partial | risk low`

**Problem.** Steps 1..200 and CFG 0..30 are the pydantic Field limits in api/generate.py, the hand-checked limits in remix.checked_sampling, and the NumberStepper min/max in RunControls. MAX_CHARACTERS = 8 is defined separately in remix.py (with a comment saying it mirrors the composer's), in generation_jobs.py, and in the frontend generateForm. outfits.py has a fourth, different WORN_MAX_CHARACTERS = 10. Change one and a remixed image can carry a value the queue endpoint then rejects with a 422, or a 9th character that the queue silently truncates ([:MAX_CHARACTERS]).

**Proposal.** Put `STEPS_RANGE = (1, 200)`, `CFG_RANGE = (0, 30)` and `MAX_CHARACTERS = 8` once in generator_graph.py (it already owns SAMPLING and lora_stem). api/generate.py Field(ge=, le=), remix.checked_sampling and generation_jobs import them. Add a test that asserts the frontend constants equal the backend ones by reading them from one place (e.g. serve them in the generators list or comfy models payload) or at minimum a comment-linked test. Delete the duplicate constants.

**Evidence.** `packages/backend/src/moire/services/remix.py:105`, `packages/backend/src/moire/services/remix.py:108`, `packages/backend/src/moire/api/generate.py:107-108`, `packages/frontend/src/components/generate/RunControls.tsx:277`, `packages/frontend/src/components/generate/RunControls.tsx:280`, `packages/backend/src/moire/services/remix.py:29-30`, `packages/backend/src/moire/services/generation_jobs.py:324`, `packages/frontend/src/lib/generateForm.ts`

### S11.3 RunControls.tsx is a form-widget grab bag; stemOf (LoRA/checkpoint name rule) lives in it and 5 modules import it

`boundary | M | L3 | conf high | tests no | risk low`

**Problem.** `stemOf` is the frontend half of the backend's `lora_stem` (the key matching image_loras.name) but sits at the top of a component file and is imported by a page, a dialog and two other components, so pages depend on a widget module. WorkflowSetupPage:404 re-implements it a weaker way (only `.safetensors`, no backslash handling). The file name says 'RunControls' but it holds FieldLabel, CheckpointPicker, FixedValue, NumberStepper, SamplingControl, SizePicker, SeedControl, CountStepper and BatchName. A stale comment at line 300 ('The compact queue card...') sits above the `Size` type. CountStepper hand-rolls the -/+ stepper that NumberStepper (same file) already is.

**Proposal.** Move `stemOf` to `lib/loraName.ts` (pure, with a test table that mirrors test_generator_graph's lora_stem cases) and use it in WorkflowSetupPage:404. Split RunControls into `components/generate/fields.tsx` (FieldLabel, FixedValue, CheckpointPicker, SizePicker, SeedControl, BatchName) and `SamplingControl.tsx` (NumberStepper + SamplingControl). Make CountStepper use an exported NumberStepper (add a `compact` prop for the 2rem input and the 1..500 clamp). Delete the stale comment.

**Evidence.** `packages/frontend/src/components/generate/RunControls.tsx:19-23`, `packages/frontend/src/components/generate/RunControls.tsx:299-301`, `packages/frontend/src/pages/BatchPage.tsx:21`, `packages/frontend/src/pages/GeneratePage.tsx:15`, `packages/frontend/src/components/generate/StyleLayer.tsx:21`, `packages/frontend/src/components/generate/CharacterBlock.tsx:18`, `packages/frontend/src/components/NewCharacterDialog.tsx:17`, `packages/frontend/src/pages/WorkflowSetupPage.tsx:404`, `packages/backend/src/moire/services/generator_graph.py:55-63`

### S11.4 'Which batch is in front / waiting' is derived three different ways

`dedupe | S | L3 | conf med | tests partial | risk low`

**Problem.** GenerationsPage picks `runningId = live.find(a => a.running) ?? live[0]` (API order) and treats every other active id as 'Queued'; OutputFeed picks `front = queueLegs(active).legs[0]?.id` (running first, then earliest start_in) and 'behind' = isWaiting && not front; queueLegs sorts yet a third way. When nothing is running (the gap between requests) the three can name different batches as front, so a card can read 'Queued' on the Generations page while the Generate page shows it in the output column. All of it is pure logic embedded in components with no tests.

**Proposal.** Add to lib/queueClock.ts `queueRoles(active: ActiveBatch[]): { front: number | undefined; waiting: Set<number> }` built on the same ordering as queueLegs (running first, then start). GenerationsPage (phaseOf inputs) and OutputFeed (behind) both call it; unit-test the empty/none-running/test-batch cases. Move `phaseOf` to lib/batches.ts next to isWaiting.

**Evidence.** `packages/frontend/src/pages/GenerationsPage.tsx:318-323`, `packages/frontend/src/pages/GenerationsPage.tsx:502-507`, `packages/frontend/src/components/generate/OutputFeed.tsx:345-352`, `packages/frontend/src/lib/queueClock.ts:36-48`, `packages/frontend/src/lib/batches.ts:92-100`

### S11.5 'Batch changed' cache invalidation and batch actions are hand-copied in four places, with inconsistent error handling

`dedupe | M | L3 | conf high | tests no | risk low`

**Problem.** The recipe 'set or invalidate batchKey(id), then invalidate BATCHES_KEY and STATUS_KEY' is written out in OutputFeed.BatchPanel.changed and BatchPage.changed (identical), partly in BatchPage.cancelAll, in QueueDeck.CancelX (a third spelling that also invalidates batchKey), and GeneratePage.queue. Cancel-a-batch is implemented twice (CancelX and BatchPage.cancelAll, the latter also handling the null return when the batch never ran). Error handling differs: CancelX and requeue toast on error; cancelAll, retryAll and the cell-level cancel/retry mutations in BatchResults have no onError, so a failed cancel or a retryAll that fails halfway (it loops retryRequest sequentially and never calls changed on a throw) leaves the screen stale and silent. A new batch action will pick one of the variants at random.

**Proposal.** In lib/generate.ts add `useBatchChanged(id)` returning `(next?: Batch) => void` and `useInvalidateQueue()` for the list/status pair, plus `useCancelBatch(id, {onGone})` and `useRetryFailed(batch)` hooks that include the toast onError. BatchPage, OutputFeed, QueueDeck, GeneratePage and the BatchResults cells all use them. Consider a single backend `POST /batches/{id}/retry-failed` instead of the client loop.

**Evidence.** `packages/frontend/src/components/generate/OutputFeed.tsx:18-22`, `packages/frontend/src/pages/BatchPage.tsx:161-194`, `packages/frontend/src/components/generate/QueueDeck.tsx:18-43`, `packages/frontend/src/pages/GeneratePage.tsx:361-370`, `packages/frontend/src/components/generate/BatchResults.tsx:173`

### S11.6 BatchResults.tsx (510 lines): review tile, running-cell view logic, failure labels and strip picker in one file; Tile keys ignore modifiers

`split | M | L2 | conf high | tests no | risk low`

**Problem.** One file holds the output Tile (a third copy of the K keep / X reject / 1-5 score triage handler, after AllImagesPage and ImageView), WaitingCell, FailedCell, PanelResults and NoImageMark. WaitingCell derives its display (elapsed, run phase, `big` clock text, `caption`, tooltip) in a 25-line nested-ternary block inside the component, which is pure logic untested and untestable there. FailedCell does the same for its label ('Cancelled' / 'Returned 0 images' / 'Lost' / 'Failed, n images'). Tile.onKeyDown tests e.key only, so Ctrl+1..5, Cmd+K, Ctrl+X on a focused tile score or reject the image (same class as the reported global-keydown bug, here in a new spot).

**Proposal.** Split into `ResultTile.tsx` (Tile, with the shared plain-key guard from the reported lib/dom.ts isPlainKey), `RunningCell.tsx` (WaitingCell + RunBar + AURORA), and keep BatchResults/PanelResults/StripThumb/NoImageMark. Move the derivations to lib/eta.ts as `cellProgress(req, elapsed) -> {big, caption, tip, fill, late, striped}` and to lib/batches.ts as `failureLabel(req)`, with tests. Share the triage key map (k/x/1-5) with AllImagesPage and ImageView via lib/shortcuts.ts.

**Evidence.** `packages/frontend/src/components/generate/BatchResults.tsx:16-117`, `packages/frontend/src/components/generate/BatchResults.tsx:160-272`, `packages/frontend/src/components/generate/BatchResults.tsx:274-341`, `packages/frontend/src/components/generate/BatchResults.tsx:399-479`, `packages/frontend/src/pages/AllImagesPage.tsx:655-662`, `packages/frontend/src/pages/ImageView.tsx:607`

### S11.7 BatchPage mixes the prompt-inputs formatter, a rename editor and the stats strip; stats are re-derived beside OutputFeed's panel header

`deepen | M | L2 | conf med | tests no | risk low`

**Problem.** BatchPage computes outputs/took/left/failed/'running' (it actually counts unfinished requests)/inLibrary inline, while OutputFeed.BatchPanel computes done/took/turn/left for the same batch with its own text rules, so the same fact reads differently on the two screens ('N running' vs 'done / total', turn label precedence only in the panel). PromptPanel is a ~70-line pure transform of batch.inputs into label/value rows (cast fallback for the legacy single `character`, PART_ROW filter) living in a page. NameHeading and RunControls.BatchName are two inline-rename editors with different commit rules (blur commits in one, not in the other; one ignores empty/unchanged, the other maps auto-name to null).

**Proposal.** Add `batchStats(b: Batch) -> {images, runs, perRun, took, left, failed, unfinished, inLibrary, done}` to lib/batches.ts (tested) and use it in both BatchPage and BatchPanel. Move PromptPanel to `components/generate/BatchInputs.tsx` with a pure `inputRows(batch) -> {label, value}[]` in lib/batches.ts. Extract an `InlineRename` component (value, onCommit, optional reset) used by both name editors.

**Evidence.** `packages/frontend/src/pages/BatchPage.tsx:31-103`, `packages/frontend/src/pages/BatchPage.tsx:105-150`, `packages/frontend/src/pages/BatchPage.tsx:210-282`, `packages/frontend/src/components/generate/OutputFeed.tsx:23-55`, `packages/frontend/src/components/generate/RunControls.tsx:470-542`

### S11.8 Three time formatters for the same job: eta.clock, queueClock.countdown, batches.durationLabel/etaShort

`dedupe | S | L2 | conf high | tests yes | risk low`

**Problem.** `clock(seconds)` (floor) and `countdown(seconds)` (round) produce the identical 'm:ss' / 'h:mm:ss' string with copy-pasted bodies; the Generate page shows one on tiles and the other on the queue deck, so the same number can read one second apart across the two (floor vs round). `durationLabel` ('1m 05s', 8.4s) and `etaShort` ('2m 30s', rounded to 5s/10s/60s) are two spellings of 'a duration in words' in different modules, and time-related code is split across eta.ts, queueClock.ts and batches.ts by history, not by concept. eta.ts also exports OVERRUN and FILL_CAP that nothing outside it uses.

**Proposal.** Create lib/duration.ts holding one `clockText(seconds, mode: 'floor' | 'round' | 'ceil')`, `durationWords` (old durationLabel) and the roundEta/etaShort/etaLabel trio; leave eta.ts with runProgress/batchLeft/leftLabel/queueTitle and queueClock.ts with legs. Keep the existing test cases, pointing at the new home. Drop the unused exports.

**Evidence.** `packages/frontend/src/lib/eta.ts:60-67`, `packages/frontend/src/lib/queueClock.ts:86-93`, `packages/frontend/src/lib/batches.ts:81-90`, `packages/frontend/src/lib/eta.ts:22-31`, `packages/frontend/src/components/generate/BatchResults.tsx:189-204`, `packages/frontend/src/components/generate/QueueFrames.tsx:64`

### S11.9 Dead or test-only code: requestFrames fallback, fixedSeeds, optional `frames`, unused Frame/FrameState exports

`dead | S | L2 | conf high | tests yes | risk low`

**Problem.** The backend always sends `frames` in every active batch (generation_batches.py:399), yet ActiveBatch.frames is typed optional and queueLegs falls back to `requestFrames(a)`, a second, count-only frame builder that mirrors the backend `_frames` (and lacks even failed). It is exercised by no production path. `fixedSeeds` in requests.ts has no caller besides its own test. QueueFrames exports `framesOf`, `Frame`, `FrameState` that only that file uses.

**Proposal.** Make `frames` required in ActiveBatch, delete requestFrames and the `??`, fix the queueClock test that omits frames, delete fixedSeeds and its test, and un-export framesOf/Frame/FrameState (knip flags the same). Keep the frame-state union in one place (QueueFrame in lib/generate.ts); this is also the type to extend for the reported cancelled-frame fix.

**Evidence.** `packages/frontend/src/lib/queueClock.ts:56-61`, `packages/frontend/src/lib/queueClock.ts:48`, `packages/frontend/src/lib/generate.ts:53-54`, `packages/frontend/src/lib/requests.ts:52-55`, `packages/frontend/src/lib/requests.test.ts:41`, `packages/backend/src/moire/services/generation_batches.py:399`, `packages/frontend/src/components/generate/QueueFrames.tsx:7`, `packages/frontend/src/components/generate/QueueFrames.tsx:15-23`

**Cross-cutting hints.**

- packages/frontend/src/pages/WorkflowSetupPage.tsx:404 strips only .safetensors by hand, a weaker copy of lora_stem/stemOf
- packages/backend/src/moire/services/outfits.py:148 WORN_MAX_CHARACTERS = 10 differs from the composer's 8 without a stated reason
- packages/frontend/src/hooks/useBatchScrub.ts is the gallery's image-group hover peek, not a Generation batch: the word 'batch' means two things in hooks/ and lib/batches.ts (CONTEXT.md only defines Generation batch)
- packages/backend/src/moire/api/images.py:521-545 get_image_workflow re-implements the id_candidates loop to read image_gen_raw, and remix.py:244-252 reads the same table a third way (find_image-style lookup missing there)
- packages/frontend/src/lib/generate.ts (828 lines) bundles types, a private fetch wrapper `send` that duplicates lib/api for errors, and ~50 endpoint fns for generators, outfits, recipes, presets and batches; wave 1 flagged the routers, the client file has the same split opportunity
- packages/frontend/src/components/generate/BatchResults.tsx:63 and OutputFeed/Remix navigate with hand-built `/image/${encodeURIComponent(id)}` URLs (already reported for ImageView, same pattern here)

## S12-characters

*The pure cores (palette, signature, confident, lora_candidates, outfit wear rules, pick helpers in lib/outfit.ts) are well factored and tested, and the domain rules from CONTEXT.md are followed. The weak spots are structural. The character signature pipeline exists twice and is recomputed uncached on every outfit request and image view. characters.page does character-only work for plain tags. CharacterBlock.tsx and SaveOutfitDialog.tsx are fused components with no shared home for the recipe/outfit editing widgets. One real bug found (deleting a hand-made character orphans its outfits). Nothing here is in the tag-weights path, though characterTags and wornTags are the future place to apply weights to character and outfit tags.*

### S12.1 Character signature pipeline is written twice and recomputed uncached on every outfit request and image view

`dedupe | M | L4 | conf high | tests partial | risk med`

**Problem.** recipes._signature and characters.page both do the same read: count the character's images, count visible images, signature_counts, signature(visible=vocab.general, skip=...), with different limits and then different filters (facet_of in LOOK vs is_identity/is_attire). The visible-image count query is written three times (characters.py:634, recipes.py:259, recipes.py:363, the last two inside one recipe() call). Worse, every outfit entry point goes through recipes.wardrobe, which recomputes the whole signature with no cache: outfits.default, covers, prefill, update_default (twice), and worn() once per character in the image (up to 10), on every image view with characters (WornOutfits). Each call also repeats characters._named (tag_index.browse plus vocab load) two to three times (_key -> character_key, then default -> wardrobe -> character_key). characters.create runs _named twice and update -> names_of a third time. tag_index already has a generation-keyed store (read_derived/store_derived) that exists for exactly this, structurally invalidated by tag writes.

**Proposal.** Add one function in characters.py (or a new character_look module), e.g. `async def look_of(key, names, key_of, rows) -> Look(n, counted, sig_tags, gender, hair_eyes_rows)`, holding the n/total/signature_counts/signature steps, and have both characters.page and recipes._signature call it. Add `tag_index.visible_count(conn)` for the three duplicate count queries. Memoize look_of (and recipes.wardrobe) per key with tag_index.read_derived/store_derived using the generation captured before computing, so no call site invalidates. Let outfits.worn resolve all keys with one _named call (pass the resolved key into default(), skipping the second character_key). Keep the public signatures; tests in test_recipes/test_outfits/test_characters stay valid.

**Evidence.** `packages/backend/src/moire/services/recipes.py:240-276`, `packages/backend/src/moire/services/recipes.py:288-301`, `packages/backend/src/moire/services/characters.py:632-646`, `packages/backend/src/moire/services/characters.py:724-736`, `packages/backend/src/moire/services/outfits.py:151-227`, `packages/backend/src/moire/services/outfits.py:345-376`, `packages/backend/src/moire/services/tag_index.py:104-125`

### S12.2 characters.page computes the character-only look for every plain tag page

`simplify | S | L3 | conf high | tests partial | risk low`

**Problem.** /tags/:tag reuses characters.page for any tag (api/tags.py says 'Any other tag gets the same page'). page() has no branch on detail['category']: for a plain tag like 'smile' it still runs signature_counts (a count over every image of the tag), the hair/eye query, the signature with attire.facet_of filtering, and solo_palette. The frontend ignores signature, signature_images and palette when person is false (Profile only reads signature if person, colours only if person). page is radon D(23) because it fuses the tag-page core (detail, cover, with, best, scored, ratings, lora scores) with the character-only look. Cost scales with the tag's image count, so the biggest plain tags are the slowest pages.

**Proposal.** Split page() into `_page_core(conn, key, names, ...)` (detail, cover, with, best, scored, ratings, lora_avg) and `_page_look(conn, ...)` returning {palette, signature, signature_images}. Call _page_look only when detail['category'] == 'character' or meta kind == 'character'; otherwise return palette [], signature [], signature_images 0 so the response shape the frontend types expect stays unchanged. Name the plain-tag use in the docstring or move the plain-tag branch to a small tag_page wrapper, since the module is the Character page owner per CONTEXT.md.

**Evidence.** `packages/backend/src/moire/services/characters.py:611-746`, `packages/backend/src/moire/api/tags.py:258-275`, `packages/frontend/src/pages/CharacterPage.tsx:63-68`, `packages/frontend/src/pages/CharacterPage.tsx:195-198`

### S12.3 Deleting a hand-made character leaves its outfits, Default edits and hides behind

`bug | S | L3 | conf high | tests partial | risk low`

**Problem.** remove_made deletes characters, recipe_edits, recipe_additions and recipe_genders rows, but not the character's rows in outfits (character column), outfit_defaults (character) or outfit_hidden (character), nor a tag_meta pin. Their private outfits stay in the Outfits page list (outfits.listing() with no character returns every row), where they have no character: the card falls back to the raw tag, editing opens SaveOutfitDialog whose cover grid and prefill 404 because recipes.wardrobe returns None, and a shared outfit from the deleted character stays in everyone's list with a dangling owner. The confirm text only promises 'Their identity tags and LoRA go too'. Re-creating a character with the same tag later silently resurrects the old outfits.

**Proposal.** In remove_made, in the same async_tx, also delete t.outfits where character == tag (and their outfit_hidden rows by outfit_id), t.outfit_hidden where character == tag, and t.outfit_defaults where character == tag. Decide for shared outfits (keep with the owner cleared, or delete); simplest is delete all, and say so in the confirm message ('Their outfits go too'). Add a test next to test_made_character_can_be_deleted that saves an outfit first.

**Evidence.** `packages/backend/src/moire/services/characters.py:374-389`, `packages/backend/src/moire/database/schema.py:358-395`, `packages/backend/src/moire/services/outfits.py:467-494`, `packages/frontend/src/components/CharacterEditDialog.tsx:62-70`

### S12.4 Tag-add combobox is written twice (AddTagInput, AttireTagInput) with a third weaker canonicalizer in NewCharacterDialog

`dedupe | S | L3 | conf high | tests no | risk low`

**Problem.** AddTagInput and AttireTagInput are the same 40-line state machine (text/active/moved, ArrowUp/Down/Tab/Enter/comma/Escape, bareTagPool filter, useTagMatches, TagSuggestList dropdown, identical classes); jscpd flagged the overlap. They differ only in the aria-label, an attire-first re-rank of matches and a noteOf label. Spelling is also done three ways for the same rule: canonicalName (Outfit.tsx), an inline trim().replace(/\s+/g,'_') (AddTagInput) and asTag in NewCharacterDialog, all mirrors of tag_names.canonical_name (lib/tags.ts documents canonicalName as that mirror). NewCharacterDialog's identity input is a third, simpler variant. A fix to keyboard handling has to be made in each.

**Proposal.** Extract `components/TagAddInput.tsx` with props {onAdd, taken, ariaLabel, rank?: (matches) => matches, noteOf?} that owns the keyboard/suggest state and calls canonicalName. AttireTagInput becomes `<TagAddInput rank={attireFirst} noteOf=... />` and AddTagInput `<TagAddInput />`. Replace asTag and the inline replace with canonicalName. NewCharacterDialog can reuse it for the identity field (its offered LoRA words stay as is).

**Evidence.** `packages/frontend/src/components/generate/CharacterBlock.tsx:234-281`, `packages/frontend/src/components/generate/Outfit.tsx:122-191`, `packages/frontend/src/components/NewCharacterDialog.tsx:257-258`, `packages/frontend/src/components/NewCharacterDialog.tsx:447-460`, `packages/frontend/src/lib/tags.ts:238-243`

### S12.5 CharacterBlock.tsx (795 lines) mixes the picker, the recipe editor and the composer rows; the editor is imported across layers

`split | M | L3 | conf high | tests no | risk low`

**Problem.** One file holds CharacterPicker (with its NewCharacterDialog flow), LoraControl, AddTagInput, GenderPick, useRecipePatch, RecipeEditor, CharacterRow, WearsLine, OutfitFold and CharacterLayer. The general-purpose RecipeEditor is consumed by components/CharacterEditDialog.tsx, which therefore imports from the Generate composer's block file. Inside RecipeEditor the identity chip markup is written three times (off mode, recipe mode) and again as OutfitChip in Outfit.tsx (same pill, strike, undo/x button). The folded 'comma list of tags, click to strike' is duplicated between CharacterRow (565-579) and WearsLine (672-684). GenderPick is exported but only used in this file.

**Proposal.** Cut at: (1) components/generate/RecipeEditor.tsx = LoraControl + AddTagInput (or the shared TagAddInput) + GenderPick + useRecipePatch + RecipeEditor (lines 113-460), imported by both CharacterBlock and CharacterEditDialog; (2) components/CharacterPicker.tsx = lines 30-111 plus NEW_CHARACTER; (3) CharacterBlock.tsx keeps CharacterRow/WearsLine/OutfitFold/CharacterLayer (~300 lines). Replace the three identity chip spans with the existing OutfitChip generalised as `TagPill` (rename OutfitChip, add optional style prop for chipBorderStyle), and add a `StrikeList` component for the two folded lists. Un-export GenderPick.

**Evidence.** `packages/frontend/src/components/generate/CharacterBlock.tsx:30-111`, `packages/frontend/src/components/generate/CharacterBlock.tsx:113-460`, `packages/frontend/src/components/generate/CharacterBlock.tsx:462-649`, `packages/frontend/src/components/generate/CharacterBlock.tsx:722-795`, `packages/frontend/src/components/CharacterEditDialog.tsx:16`, `packages/frontend/src/components/generate/CharacterBlock.tsx:384-446`, `packages/frontend/src/components/generate/Outfit.tsx:193-230`

### S12.6 SaveOutfitDialog fuses four modes and its seed and save-plan logic is untestable inside the component

`split | M | L3 | conf med | tests no | risk med`

**Problem.** One component serves: save from an image, New outfit (blank), edit a saved outfit, and edit a Default. The mode is re-derived as isDefault / outfit / blank in about 15 places (title, footer, ready, payload, cover, Key legend). A 30-line useEffect with an eight-entry dependency list and a 'seeded' latch builds the initial rows for each mode; the save mutation picks between putDefaultOutfit, updateOutfit and createOutfit and decides whether to send image_id by comparing with outfit.image_id. None of that is pure-testable although CLAUDE.md prefers pure logic in lib/ with tests (lib/outfit.ts already holds suggestOutfitName for this dialog).

**Proposal.** Add to lib/outfit.ts: `type OutfitMode = 'new-from-image' | 'blank' | 'edit' | 'default'` with `modeOf(outfit, imageId)`, `seedRows(mode, {outfit, prefill, usual})` returning {name, shared, cover, rows}, and `savePlan(mode, state)` returning {kind: 'default'|'update'|'create', body}. Each branch gets a vitest table test. The component then switches on mode for copy only (title/button/footer) and the effect shrinks to 'seed once when data for the mode is ready'.

**Evidence.** `packages/frontend/src/components/generate/SaveOutfitDialog.tsx:317-436`, `packages/frontend/src/components/generate/SaveOutfitDialog.tsx:359-389`, `packages/frontend/src/components/generate/SaveOutfitDialog.tsx:397-418`, `packages/frontend/src/lib/outfit.ts:385-400`

### S12.7 Outfit wear rule is implemented twice: pure `wears` and a hand-copied SQL condition in the feed

`dedupe | S | L2 | conf med | tests partial | risk low`

**Problem.** outfits.wears(rule, image_id, bases) is the pure statement of 'carries `need` of the rule tags, or is the outfit's own thumbnail'. image_feed re-expresses it in SQL (the comment says 'outfits.wears' and the docstring says 'the feed's SQL condition says the same'), with a separate WearRule consumer. The two are only tied by comments and two separate tests. The feed (a lower-level service) also reaches up into outfits via a function-local import in _resolved, because outfits imports recipes -> characters -> tag_index, which makes a fragile import web for what is a tiny value type.

**Proposal.** Move WearRule, wears_most, rule_of-independent parts and `wears` into a pure module `services/outfit_wear.py` together with `wear_condition(rule) -> sa.ColumnElement` (the SQL, taking t.images/t.image_tags), so both forms live side by side and one parametrised test asserts they agree on a seeded DB. image_feed imports outfit_wear at module top; outfits.wear_rule (the async lookup of an id into a rule) stays in outfits and the feed's _resolved keeps calling it lazily or receives the rules from the router.

**Evidence.** `packages/backend/src/moire/services/outfits.py:101-145`, `packages/backend/src/moire/services/image_feed.py:279-297`, `packages/backend/src/moire/services/image_feed.py:329-333`, `packages/backend/tests/test_outfits.py:322`

### S12.8 Outfit hooks live in component files and OutfitMenu re-implements the outfit queries inline

`boundary | S | L2 | conf med | tests no | risk low`

**Problem.** useOutfitActions is exported from the CharacterOutfits component file and imported by OutfitsPage; useCharacterOutfits is exported from Outfit.tsx (a file of presentational widgets); OutfitCover.tsx is named for the cover grid but also hosts OutfitMenu (the viewer menu). OutfitMenu builds two useQueries blocks with the same keys, fetchers and stale times as useOutfits/useDefaultOutfit in lib/generate.ts, only adding enabled: open, and an inline setCover mutation that does its own cache write. The /outfits?character= URL is hand-built in three places. This is the same pattern already reported for character query hooks.

**Proposal.** New hooks/useOutfitData.ts exporting useOutfitActions, useCharacterOutfits, and `useOutfitMenuData(characters, enabled)` built on queryOptions factories (`outfitsQuery(character)`, `defaultOutfitQuery(character)`) that useOutfits/useDefaultOutfit also use. Add `outfitsHref(character?)` to lib/outfit.ts next to outfitGalleryHref. Move OutfitMenu to its own file OutfitMenu.tsx; OutfitCover.tsx keeps CoverGrid.

**Evidence.** `packages/frontend/src/components/generate/CharacterOutfits.tsx:24-55`, `packages/frontend/src/pages/OutfitsPage.tsx:10`, `packages/frontend/src/components/generate/Outfit.tsx:34-47`, `packages/frontend/src/components/generate/OutfitCover.tsx:281-320`, `packages/frontend/src/lib/generate.ts:739-790`

### S12.9 characters.py (811 lines) fuses pure look statistics, character IO, the listing and the settings CRUD

`split | M | L2 | conf high | tests yes | risk low`

**Problem.** Five jobs share one module: pure colour/signature/gender statistics (COLOURS, colour_of, palette, solo_palette, confident, one_colour_per_slot, reads_solo, signature, gender; about 230 lines, all with no IO), name grouping and hand-made characters, the cached listing with covers and avatars, the page, and the validated override CRUD. It reaches into tag_index's private _pins (line 537) and recipes reaches into its private _named. SOLO_ENOUGH, SCORED_ENOUGH and _BEST are defined mid-file after the functions that use them (solo_palette at line 115 reads SOLO_ENOUGH defined at 608).

**Proposal.** Move the pure statistics into `services/character_look.py` (no sqlalchemy import) with constants at the top, and re-export from characters for existing callers/tests. Make `tag_index.pins(conn, bases)` public and `characters.named(base)` public (rename _named) since recipes and api call them. Keep characters.py for grouping, made characters, listing, page and settings. This is also where the shared look_of from the first finding belongs.

**Evidence.** `packages/backend/src/moire/services/characters.py:28-260`, `packages/backend/src/moire/services/characters.py:300-440`, `packages/backend/src/moire/services/characters.py:441-609`, `packages/backend/src/moire/services/characters.py:611-746`, `packages/backend/src/moire/services/characters.py:749-811`, `packages/backend/src/moire/services/characters.py:537`

### S12.10 CharactersSection does raw face-status fetches and hosts a Generate setting; test-only and unused exports linger

`boundary | S | L1 | conf high | tests no | risk low`

**Problem.** The section defines the FaceStatus type, a query key and two raw api('/api/v1/ai/faces...') calls inline instead of lib/ hooks, and carries a second, unrelated section ('Outfits in Generate', new_character_outfit, read by GeneratePage) that is a Generate/Comfy setting living under Characters. Dead-ish code: attire.category_of and attire.all_tags have no caller in src (only test_attire.py uses them); GenderPick, coverCaption and FEW_IMAGES are exported but only used inside their own file.

**Proposal.** Add useFaceStatus/faceAction to lib/ai.ts (or lib/queries.ts) with FaceStatus typed there; move NewCharacterOutfit into the ComfySection (it already edits ComfySettings via putSettings). Delete attire.category_of/all_tags and their two test asserts (or keep only if a script is planned), and drop the three needless `export` keywords.

**Evidence.** `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:15-60`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:142-175`, `packages/frontend/src/pages/GeneratePage.tsx:229`, `packages/backend/src/moire/services/attire.py:329-339`, `packages/frontend/src/components/generate/OutfitCover.tsx:27`, `packages/frontend/src/lib/character.ts:227`

**Cross-cutting hints.**

- packages/backend/src/moire/api/tags.py:341-377 set_tag_thumbnail writes tag_meta with raw SQL inside the router (boundary violation, belongs in a tag_index/tag_meta service next to tag_focus.put)
- packages/backend/src/moire/services/characters.py:537 and packages/backend/src/moire/services/recipes.py:282 call private tag_index._pins and characters._named across modules
- packages/backend/src/moire/services/face_detect.py:285-298 imports characters lazily to queue avatars by calling listing() for its side effect (a cycle workaround: face_detect <-> characters)
- packages/frontend/src/lib/generate.ts:739-790 outfit/recipe/cover fetch hooks sit in the 800+ line generate.ts; part of the already reported ruleset-in-lib/gen.ts pattern
- packages/backend/src/moire/services/generation_jobs.py:40 imports clean_tags from outfits (generation depends on the outfits service for a string cleaner; move clean_tags to tag_names)
- packages/frontend/src/pages/OutfitsPage.tsx:148-164 and packages/frontend/src/components/generate/OutfitCover.tsx:217-230 hand-roll the same segmented radiogroup also present in SortControl, Remix, GenerationsPage (a ui/Segmented component would remove five copies)

## S13-shell

*Backend shell (main, cli, web_ui, config, db, schema, onboarding) is small, commented and tested; its debt is a few dead models/settings and stale Mongo-era docstrings. Frontend ui/ primitives are healthy, but the glue is uneven: lib/queries.ts is a 475-line grab bag, App.tsx re-implements helpers lib/ already owns, gallery URL building bypasses lib/imageFilter in about a dozen places, and Dialog's key trap fights the popups it hosts. Items already reported (scan_error never shown, native confirm in useRulesetSession, app_settings row boilerplate, now with onboarding as a ninth copy) are not repeated.*

### S13.1 Gallery and image URLs are hand-built in a dozen places instead of through lib/imageFilter

`dedupe | S | L4 | conf high | tests partial | risk low`

**Problem.** CLAUDE.md makes lib/imageFilter.ts the one filter/URL mapping, yet galleryHref(patch) is defined three times (search.ts, TagPanel.tsx, CharacterPage.tsx; the search.ts copy differs, returning '/' for an empty query where the others return '/?'). libraryGalleryHref in queries.ts is a fourth variant. ToReview and TagsPage hard-code '/?no_ai_tags=1', '/?no_tags=1', '/?quarantined=1', so renaming a filter param breaks them silently. The '/image/<id>?<filters>' link is spelled by hand in about 8 places.

**Proposal.** Add to lib/imageFilter.ts: `galleryHref(patch: Partial<Filters>): string` (DEFAULT_FILTERS merged, '/' when empty) and `imageHref(id: string, filters?: Filters): string`. Delete the three local galleryHref copies, make libraryGalleryHref call galleryHref({libraryId}), and have ToReview/TagsPage pass {noAiTags:true} etc. Add tests next to imageFilter.test.ts.

**Evidence.** `packages/frontend/src/lib/search.ts:80-83`, `packages/frontend/src/components/TagPanel.tsx:40-41`, `packages/frontend/src/pages/CharacterPage.tsx:46-47`, `packages/frontend/src/lib/queries.ts:51`, `packages/frontend/src/components/overview/ToReview.tsx:16-18`, `packages/frontend/src/pages/TagsPage.tsx:383`, `packages/frontend/src/components/overview/RecentImages.tsx:61`, `packages/frontend/src/pages/ImageView.tsx:248`, `packages/frontend/src/components/TagPanel.tsx:397`, `packages/frontend/src/pages/CharacterPage.tsx:264`, `packages/frontend/src/pages/AllImagesPage.tsx:531`

### S13.2 Escape inside a Picker or DropdownMenu in a Dialog closes the whole Dialog

`bug | S | L4 | conf med | tests no | risk low`

**Problem.** Dialog registers a capture-phase document keydown that handles Escape unconditionally (stopPropagation, onClose) for the topmost dialog. Picker handles Escape in a React onKeyDown and DropdownMenu in a bubble-phase document listener, both of which run after the Dialog's capture handler. So with a Picker open inside NewCharacterDialog (and generate/StyleLayer, Layers, CharacterBlock, LibrariesPage dialogs), Escape discards the dialog and any typed state rather than just closing the list. Tooltip's Escape has no stopPropagation either. Same class as the ImageView Escape bug in bugs.md, rooted in the primitives having no shared ownership of Escape.

**Proposal.** Introduce lib/overlayStack.ts (push/pop token, isTopmost) that Dialog, Picker, DropdownMenu, SearchPalette and Tooltip register with while open, so only the topmost overlay reacts to Escape/Tab. Minimal fix first: in Dialog's onKey, skip Escape when the event target is inside an element with aria-expanded='true' (the Picker/Dropdown trigger or its list) or when e.defaultPrevented. Add a Picker.test case for Escape inside a Dialog.

**Evidence.** `packages/frontend/src/components/ui/Dialog.tsx:373-408`, `packages/frontend/src/components/ui/Picker.tsx:151-177`, `packages/frontend/src/components/ui/DropdownMenu.tsx:360-368`, `packages/frontend/src/components/NewCharacterDialog.tsx:114-180`

### S13.3 lib/queries.ts is a 475-line grab bag; split by domain and give api.ts a JSON-body helper

`split | M | L3 | conf high | tests partial | risk low`

**Problem.** One file holds libraries, tag aggregates/browse/detail/character, attire/facets/groups maps, tag settings, guess keywords, rename/merge/alias writes, merge suggestions, prompt board places/offers and tag descriptions, with plain writers (saveTagSettings, renameTag, addTagRules, saveGuessKeywords) mixed with hooks. The 'Content-Type: application/json' + JSON.stringify boilerplate is repeated five times here and on about 23 lines across the frontend (lib/onboarding.ts, lib/generate.ts x2, lib/gen.ts x2, lib/workflows.ts x2, lib/imageMutations.ts x4, AddLibraryDialog, WelcomePage, LibrariesPage, libraryPlan). The 'pure' lib/search.ts imports a runtime helper and a type from this React-Query module. TAG_FACETS_KEY and TAG_GROUPS_KEY are exported but unused (knip).

**Proposal.** Add `sendJson<T>(url, method, body, init?)` to lib/api.ts and replace the repeated blocks. Then split queries.ts into lib/queries/libraries.ts (Library, scanLabel, hrefs, useLibraries, plus the CRUD client in the next finding), lib/queries/tags.ts (TAGS_KEY, aggregates, maps, rename/aliases/merge suggestions) and lib/queries/board.ts (places, offers, descriptions, guess keywords, tag settings), re-exporting from lib/queries.ts for one release so imports migrate gradually. Un-export the two unused keys.

**Depends on.** none; do the sendJson step first

**Evidence.** `packages/frontend/src/lib/queries.ts:27-86`, `packages/frontend/src/lib/queries.ts:106-244`, `packages/frontend/src/lib/queries.ts:246-294`, `packages/frontend/src/lib/queries.ts:307-378`, `packages/frontend/src/lib/queries.ts:380-469`, `packages/frontend/src/lib/api.ts:1-23`, `packages/frontend/src/lib/queries.ts:221`, `packages/frontend/src/lib/queries.ts:234`, `packages/frontend/src/lib/search.ts:10`

### S13.4 Library API client is scattered; the Welcome wizard, AddLibraryDialog and LibrariesPage each call it raw

`boundary | M | L3 | conf high | tests partial | risk med`

**Problem.** Only list and discover have lib functions. Create, delete, update, rescan and progress are inline api()/fetch calls inside pages and dialogs (LibrariesPage even uses a bare fetch for /progress, skipping api()'s error handling). AllImagesPage runs its own libraries poll with api<Library[]> and pushes the result into the TanStack cache by hand, a second implementation of what useLibraries does. WelcomePage's Setup is a 245-line component whose create/remove diff against the previous Continue (createLibraries) is pure logic stuck in a component.

**Proposal.** Create lib/libraries.ts with createLibrary, deleteLibrary, updateLibrary, rescanLibrary, fetchProgress (all via api/sendJson) and call them from the four sites. Move the wizard's diff into lib/onboarding.ts as `planLibrarySync(created: Record<string,string>, want: {path,name}[]) -> {remove: [path,id][], add: {path,name}[]}` with a test, leaving Setup to run the plan. AllImagesPage should read useLibraries() and derive its watcher-activity effect from query data (S1 owns that page; flag to them).

**Evidence.** `packages/frontend/src/pages/WelcomePage.tsx:179-212`, `packages/frontend/src/pages/LibrariesPage.tsx:119`, `packages/frontend/src/pages/LibrariesPage.tsx:157-241`, `packages/frontend/src/components/AddLibraryDialog.tsx:127`, `packages/frontend/src/pages/AllImagesPage.tsx:366-368`, `packages/frontend/src/lib/queries.ts:58-60`, `packages/frontend/src/lib/libraryPlan.ts:35`

### S13.5 Sidebar owns nav data, shortcut text and platform detection that two other modules re-derive

`dedupe | S | L3 | conf high | tests partial | risk low TW`

**Problem.** IS_MAC is computed twice with different probes (navigator.userAgent in Sidebar, navigator.platform in shortcuts.ts) and the Search shortcut is spelled twice ('⌘K'/'Ctrl K' in Sidebar, `${MOD} K` in shortcuts.ts). SearchPalette imports NAV (data) from the Sidebar component file and hand-adds 'Settings' and 'New workflow' page rows. Global key handling is spread over three unrelated owners (App.tsx Ctrl+K, ShortcutHelp '?', App.tsx scroll keys) while lib/shortcuts.ts is a hand-synced documentation list. For the tag-weights plan, step 5 wants a 'Generate' group, but ShortcutPage is a closed union and shortcutPage() only knows /, /image/, /generations/, so the new group would never rank first on /generate.

**Proposal.** Add lib/platform.ts (IS_MAC, MOD_LABEL, searchKeys()), lib/nav.ts (NAV, plus the derived PAGES rows SearchPalette builds), and import them from Sidebar, SearchPalette and shortcuts.ts. Extend ShortcutPage with 'generate' and map '/generate' in shortcutPage() when adding the Ctrl+Up/Down row.

**Evidence.** `packages/frontend/src/components/Sidebar.tsx:24-54`, `packages/frontend/src/components/Sidebar.tsx:157-170`, `packages/frontend/src/lib/shortcuts.ts:239-240`, `packages/frontend/src/components/SearchPalette.tsx:9`, `packages/frontend/src/components/SearchPalette.tsx:36-56`, `packages/frontend/src/App.tsx:58-75`, `packages/frontend/src/components/ShortcutOverlay.tsx:339-356`, `packages/frontend/src/lib/shortcuts.ts:231`, `packages/frontend/src/lib/shortcuts.ts:303-309`

### S13.6 App.tsx re-implements lib helpers and carries 70 lines of key-scroll logic plus a raw health fetch

`boundary | S | L2 | conf high | tests no | risk low`

**Problem.** App.tsx defines a local isFormField that is the same helper lib/dom.ts says is 'the one copy'. The backend health check is a raw fetch('/api/v1/health') in a component, outside lib/api. The mobile-drawer effect hand-rolls matchMedia although useMediaQuery exists. The PageDown/PageUp/Home/End/Space/arrow scroller is a 70-line unnamed, untested effect in the shell component and, like the bugs.md ImageView finding, ignores modifier keys (Ctrl+Home, Alt+ArrowDown are swallowed when body has focus).

**Proposal.** Import isFormField from lib/dom. Extract `useShellKeyScroll(scrollRef, overlayOpen)` to hooks/ with a pure `scrollDeltaForKey(e, clientHeight)` in lib/dom.ts (modifier-key guard included) and a unit test. Use useQuery with api('/api/v1/health') for status, or a tiny useBackendStatus hook. Replace the matchMedia effect with useMediaQuery('(min-width: 768px)').

**Evidence.** `packages/frontend/src/App.tsx:93-170`, `packages/frontend/src/App.tsx:94-104`, `packages/frontend/src/lib/dom.ts:1-16`, `packages/frontend/src/App.tsx:85-89`, `packages/frontend/src/App.tsx:39-56`, `packages/frontend/src/hooks/useMediaQuery.ts:1-15`

### S13.7 Sidebar defines NavButton as a component inside render, remounting every link on each shell render

`bug | S | L2 | conf med | tests no | risk low`

**Problem.** `const NavButton = (...) => ...` is created inside Sidebar's body, so each Sidebar render gives React a new component type and unmounts/remounts all NavLinks (and the Settings link). Sidebar re-renders on every App state change (collapse toggle, mobile drawer, search open/close, route change), so a keyboard user who activates a nav link loses focus position, and hover/active transitions restart.

**Proposal.** Hoist NavButton to module scope taking `collapsed` as a prop (it only reads label, path, icon, collapsed), or call it as a plain function returning JSX instead of rendering it as a component.

**Evidence.** `packages/frontend/src/components/Sidebar.tsx:68-105`, `packages/frontend/src/App.tsx:35-37`, `packages/frontend/src/App.tsx:216`

### S13.8 Dead backend pieces and stale Mongo-era docs: models/image.py, models.library.Library, Settings.ai_tagging_url, db.write_lock()/sync_write_lock()

`dead | S | L2 | conf high | tests yes | risk low`

**Problem.** grep over src and tests finds no use of Image or ImageQuery (the whole of models/image.py), of models.library.Library, of settings.ai_tagging_url, or of the write_lock()/sync_write_lock() accessor functions (the underscored locks are used by async_tx/sync_tx). db.py's module docstring still says it 'Replaces the old Mongo motor.py' and points readers at the unused accessors, schema.py says pagination 'must match Mongo's byte-order sort', and the app_settings comment says 'currently only the "ai" row' when onboarding, migrations, tag settings, comfy settings, extraction settings and prompt presets all use it.

**Proposal.** Delete models/image.py, the Library class, ai_tagging_url, and the two accessor functions (and their __all__ entries); rewrite the three docstrings to describe current behaviour (SQLite byte order; app_settings holds many named rows). Keep ensure_schema_sync (used by tests/test_schema.py).

**Evidence.** `packages/backend/src/moire/models/image.py:1-23`, `packages/backend/src/moire/models/library.py:59-65`, `packages/backend/src/moire/core/config.py:60`, `packages/backend/src/moire/database/db.py:105-110`, `packages/backend/src/moire/database/db.py:1-13`, `packages/backend/src/moire/database/schema.py:17-19`, `packages/backend/src/moire/database/schema.py:264`

### S13.9 main.py mixes wiring, a BaseHTTPMiddleware on every request, an in-memory rate limiter and the startup sequence

`simplify | M | L2 | conf low | tests partial | risk med`

**Problem.** `@app.middleware('http')` is Starlette's BaseHTTPMiddleware, which wraps every response, thumbnails and originals included, in a streaming adapter; the project already wrote a pure-ASGI GZipExceptMedia precisely because media routes must pass through untouched, so the timing middleware undercuts that intent. The 'slow request' log stops at response headers (call_next returns when the response starts), so a slow FileResponse body is never counted. The rate limiter is off by default, covers one route (POST /libraries/*/rescan), and its _rl_state dict grows per client IP without eviction. vulture's 'unused _timing_and_rate_limit' is a false positive (decorator registration). The lifespan holds five unrelated startup steps inline.

**Proposal.** Move middleware to core/middleware.py: a pure-ASGI SlowRequestLog (timing around the whole send) next to GZipExceptMedia, and make the rescan limiter a small dependency on that one route with a bounded dict, or drop it if unused. Split lifespan into services/startup.py (run_startup_tasks: schema, migrations, nesting, thumb root, AI worker, watchers, generation) so main.py is only app assembly.

**Evidence.** `packages/backend/src/moire/main.py:29-85`, `packages/backend/src/moire/main.py:92-111`, `packages/backend/src/moire/main.py:134-179`, `packages/backend/src/moire/core/config.py:200-201`

### S13.10 SettingsContext is the AI-tagging controller under a generic name, and wraps every settings tab

`naming | S | L2 | conf high | tests no | risk low`

**Problem.** SettingsController holds only AI state (AISettings, AIStatus, jobs, model load/unload, clear AI tags) yet is named SettingsContext and lives under pages/settings; AITaggingPage imports it from there. SettingsPage mounts SettingsProvider for all sections, so opening the ComfyUI or Boilerplate tab still fetches AI settings and polls AI status. formatBytes (a generic formatter) lives in this file and is imported by two section files. The registry advertises SETTINGS_GROUPS ('Tags', 'Generation') and a left-nav, but SettingsPage renders a flat tab strip and never reads group titles; the registry comment is stale.

**Proposal.** Rename to hooks/useAiController.ts (AiControllerProvider/useAiController), move formatBytes to lib/format.ts, and mount the provider only around the sections that use it (or inside those sections). Either render group titles in the tab strip or flatten SETTINGS_GROUPS into one list and fix the registry comment.

**Evidence.** `packages/frontend/src/pages/settings/SettingsContext.tsx:1-247`, `packages/frontend/src/pages/SettingsPage.tsx:28-61`, `packages/frontend/src/pages/AITaggingPage.tsx:17`, `packages/frontend/src/pages/AITaggingPage.tsx:202`, `packages/frontend/src/pages/settings/sections/ModelSection.tsx:5`, `packages/frontend/src/pages/settings/sections/CharactersSection.tsx:13`, `packages/frontend/src/pages/settings/registry.tsx:35-97`

**Cross-cutting hints.**

- packages/frontend/src/components/onboarding/TaggingStep.tsx:448-463 and lib/onboarding.ts:84-87: UI copy states '0.1 s an image on a GTX 1650' (violates the no-personal-setup memory rule) and the step ships an always-disabled no-op SwitchRow with 'Not available during setup yet' subtext (violates no-UI-subtext); drop both until Phase 3.
- packages/frontend/src/pages/AllImagesPage.tsx:358-372 runs its own libraries poll (api<Library[]> plus manual setQueryData) instead of useLibraries; S1 should fold it.
- packages/frontend/src/pages/LibrariesPage.tsx:119 uses bare fetch for /libraries/{id}/progress, bypassing api().
- packages/frontend/src/lib/ambient.ts:539-548 has a dangling doc comment (the tintAmbient doc sits above useAmbientTint) and two stacked comments; cosmetic.
- packages/frontend/src/components/ui/ScoreMark.tsx holds ScorePicker (a domain editor) and MARKER_DIGIT in ui/; ui/index.ts barrel omits Dialog, ScoreMark and ScorePicker inconsistently.
- packages/frontend/src/components/ui/StatCard.tsx:25, TagPanel.tsx:111, TagsPage.tsx:347/548/828, MergeSuggestions.tsx:58 repeat Card's class string ('rounded-xl border border-white/5 bg-surface shadow-panel') instead of using Card.
- packages/backend/src/moire/services/onboarding.py:30-37 is a ninth copy of the app_settings upsert pattern already reported in S7.
- packages/frontend/src/hooks/useUnsavedChangesGuard.ts:21 also defaults to window.confirm (same class as the reported useRulesetSession finding).
- packages/backend/src/moire/services/ai_tagger_download.py:26 keeps DEFAULT_CACHE_DIR='.cache/moire/models', a second spelling of settings.model_cache_dir's default (config.py:184); only a fallback today, since DEFAULT_AI_SETTINGS uses settings.model_cache_dir_path.
