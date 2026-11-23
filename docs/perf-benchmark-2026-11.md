# Performance benchmark (Nov 2026)

A full benchmark of Moiré on 2026-11-15, covering:
- the API/DB layer
- the frontend in a real browser
- scanning and reprojection
- AI tagging and face detection
- several writers running at once

It follows the Oct 2026 round in `docs/perf-findings.md` (G, A, S and D items); comparisons to those IDs are noted inline. **This round only measured: no code was changed.** Every finding below is `open` until it is picked.

Status: `open` · `chosen` · `done` · `dropped`. Effort: S (hours) · M (a day or so) · L (more).

## Method

- **Machine:** 6-core/12-thread laptop CPU, 14 GB RAM, NVMe, GTX 1650 4 GB. The dev server was stopped.
  - Wave 1 ran two agents side by side (load 2-10).
  - Waves 2 and 3 ran alone (load under 2 at idle).
  - Trust ratios within one run more than absolute numbers.
- **Data:** never the live `data/`. Each agent took a SQLite backup-API snapshot and made it safe:
  - ComfyUI pointed at `127.0.0.1:1`, watchers, face detection and auto-tag off.
  - Each run then re-enabled only what it tested.
- **Datasets:**
  - **real:** 5,404 images, 162k `image_tags`, 162k `image_gen_terms`. Nearly every tag is a prompt tag.
  - **syn:** 30,000 images cloned from real: 910k `image_tags`, 906k terms, 28.8k gen-raw rows (644 MB of JSON). Planted tags have 30, 299, 301 and 3000 matches.
- **HTTP runs:** uvicorn plus httpx with keep-alive, 3 warmups then 30 runs, p50/p95. "Cold" means the app's tag cache was invalidated before each run.
- **Direct runs:** the app's real SQL was replayed with stdlib sqlite3, profiled, and checked with EXPLAIN QUERY PLAN.
- **Frontend:** a built UI served by the backend, driven by Playwright Chromium on a real GPU.
  - Screens: 1440x900 desktop (5 columns, 221 px tiles) and Pixel 7.
  - Measured: CDP traces, long tasks, Event Timing.
  - "Fix" rows inject CSS at runtime.
- **Scan:** first scans of three local folders (1,334 PNGs, 2.2 GB), cold page cache by `posix_fadvise(DONTNEED)`. Changes were only ever made to copies.
- **AI:** onnxruntime-gpu with the CUDA EP, 1,000-image jobs through `POST /ai/tag-untagged`.
- **Load during writes:** 10 req/s of mixed reads (feed, `/tags`, browse, image detail, thumbnail) plus a `/health` ping every 50 ms, to measure event-loop lag.
- **Scripts:** `bench/` (one folder per suite; `bench/README.md` covers datasets, safety rules and re-running).
- **Raw results:** `local-setup/bench/{api,web,scan,ai,combined}/` (gitignored, local only). The per-area reports are beside them:
  - `api-report.md`
  - `web-report.md`
  - `scan-report.md`
  - `ai-report.md`
  - `static-hotspots.md` (a code read, not measured)

## Headline

The app is fast at 5k images. At 30k, three things hurt:

1. **The tag views cost too much to rebuild.** Tags browse is a single 4.4 s SQL statement, and the character page, recipes and outfit routes all run it first. Hard invalidations (AI job end, every single re-tag, each reprojection batch) make the next viewer pay that, and the 15 s soft-rebuild cycle during a job spends ~100 s of CPU per 1,000 images.
2. **Reprojection runs in the API process and loads everything at once.** It holds 3.8 GB RSS and never gives it back. During the run, reads at 10 req/s go to p50 4 s / p95 18 s, and the WAL grows to 2.7 GB.
3. **The gallery's fast scroll is limited by CSS, not React.** Tailwind v3's `space-y-*` / `divide-*` sibling selectors re-style ~1,100 elements per tile mount.

Scanning (68-92 img/s, CPU-bound, scales to all cores), AI tagging (7-7.75 img/s, GPU-bound), media serving and normal feed paging are all in good shape.

## What's faster so far

Plain summary of the fixes made from this report, updated as each section lands. "30k" is the 30,000-image test library; times are before -> after. Details and caveats are in each section's results table under Tracker.

**Gallery and pages**
- App opens faster: largest paint 900 -> 556 ms.
- Fast scrolling no longer shows blank tiles: 6% -> 0% at 15k px/s, 41 -> 58 fps. On a phone, 40% -> 10% blank.
- Batch (grouped) view: each page 299 -> 5 ms, and a page deep in the list 385 -> 6 ms.
- Feed filtered by a rare tag: 71 -> 10 ms.
- A page deep in "top rated": 42 -> 7 ms.
- Search with no match: 84 -> 18 ms.
- Filter lists (sizes, LoRAs, embeddings): 57-137 ms -> 1-2 ms after the first load. Workflow signatures on the character page: 272 -> 23 ms (897 ms at the slow end).
- AI coverage, polled every 3 s during a job: 53 -> ~20 ms.
- Typing in the search palette: 24 -> 17 ms a key, and its one 95 ms hitch is gone. The Tags page filter's worst key: 67 -> 45 ms.
- Gallery shows sooner: first thumbnail 323 -> 286 ms on a first visit, 219 -> 193 ms on a reload; then 299 -> 229 ms and 190 -> 160 ms (the feed starts before the page renders, blurred placeholders draw 3x faster).
- Stepping through images in the image view: 66 -> ~49 ms from key press to the next image, and the gallery underneath no longer re-renders each step.
- Main script 130 -> 121 KB compressed (the Settings panels load with the Settings page).
- Big lists of thumbnails (1,000-image feed pages, the Tags page): 46 -> ~25 ms and 78 -> ~27 ms warm, back to where they were in October.

**Tags pages (30k)**
- Tags page with the sensitivity filter on: 5.6 s -> 0.4 s.
- Tags browse, first load: 4.6 -> 2.9 s. Character page: 7.8 -> 6.2 s.
- Opening a tag a second time: 2.8 s -> instant (cached).
- Merge suggestions: 1.2 -> 0.5 s.
- Tag mosaics (60 tags at once): 1.16 -> 0.17 s.
- After an AI job ends, the Tags and Characters pages show at once (were 4.7 s and 2.9 s) and refresh in the background.

**Background work no longer makes the app sluggish (30k)**
- While prompt tags are re-extracted, page loads stay fast: slowest 5% of requests 8.3 s -> 0.1 s, thumbnails 339 -> 11 ms.
- Re-extraction memory: 4.1 GB -> 0.46 GB, and the database's write log 2.5 GB -> 0.
- Re-extraction with nothing changed: 29 s -> 0.06 s. After a settings change: 88 -> 26 s.
- Rescanning a library with 10% of files touched: tag update 1.9 -> 0.46 s.
- Dropping 100 images into a watched folder: 62 s -> 2 s until they all show (4 s with prompt tags).

**AI tagging and memory**
- AI tagging: 7.2 -> 8.5 images/s (database writes no longer wait in line behind each image).
- Tagging while a scan and face detection run at the same time: 6.3 -> 8.0 images/s overall, and during the scan itself 4.2 -> 8.2 (the GPU is kept busy 88% of the time instead of 43%). The scan in that case takes longer (26 -> 41 s for 1,334 files); a scan on its own is unchanged.
- Page loads during that scan: slowest 5% 460 -> 173 ms.
- Memory after a scan and a 600-image tagging job: 1.5 GB -> 1.0 GB.

**Scanning**
- Adding two libraries at once: they now scan one after the other, which finishes both 12% sooner (15.7 -> 13.8 s with prompt tags) and the first in about half the time.

## Ranked findings

| ID | Area | Finding | Gain | Effort | Status |
|----|------|---------|------|--------|--------|
| N1 | Frontend | Tailwind v3 `space-y`/`divide` sibling selectors restyle the whole grid on every tile mount | Fast scroll at 15k px/s: blank tiles 95% -> 1%; 10k px/s 49 -> 58 fps; 4x-throttled phone 23 -> 38 fps | S-M | done |
| N2 | Tags | Tags browse cold is one 4.4 s statement at 30k (D4 still open); character page, recipes and outfit routes run it first | One-pass rewrite prototyped: 4.3 -> 2.5 s, output identical. Stored per-tag stats would go further (L) | S-M | done |
| N3 | Tags | Hard invalidations land on the next viewer: AI job end, each single re-tag (twice), each reprojection batch | Next browse 4.5-4.8 s, characters 1.2-3 s at 30k -> served stale while rebuilding | M | done |
| N4 | Reproject | `_derive_where` `fetchall()`s every gen-raw row | Peak RSS 3.8 GB -> paged; memory is never returned today | S | done |
| N5 | Reproject | Runs as a thread in the API process: GIL convoy | Reads at 10 req/s: p50 17 ms -> 4 s, /health stalls up to 7 s, even with nothing written | M | done |
| N6 | Reproject | Hard `tag_index.invalidate()` per 200-row batch | 151 invalidations -> 237 rebuilds (824 s of build time); run 178 s vs 77 s alone | S | done |
| N7 | DB | WAL has no size limit and is never truncated | 2.7 GB during reprojection with readers; 63-113 MB after jobs and scans | S | done |
| N8 | Sensitivity | With the filter on, tag counts run a correlated EXISTS per `image_tags` row | Cold `/tags` 5.8 s -> ~0.3-1.4 s at 30k (34x slower than filter off today) | S | done |
| N9 | Tags | Tag detail is never cached and recomputes its image-id subquery ~10 times | Dense tag 2.9 s every call -> ~2 s cold, ~0 warm | S | done |
| N10 | Frontend | 500 ms thumbnail fade (`ImageThumbnail.tsx:42`, `:147`) | LCP 888 -> 396 ms | S | done |
| N11 | AI | Soft-rebuild window fixed at 15 s during jobs | ~100 s of view-build CPU per 1,000 images at 30k; scale the window with build cost | S-M | done |
| N12 | Feed | Grouped (batch) view re-aggregates everything on every page, offset paged | 326 ms per page at 30k -> ~12 ms (rewrite tested unfiltered) | M | done |
| N13 | Library | Watcher ingests strictly one file at a time (0.5 s stability wait each, invalidation each) | 100 dropped files: 60 s -> ~1-2 s | M | done |
| N14 | Feed | `_RARE`=300 is too low at 30k; `/images/ids` never uses the id path | 301 matches 82 -> ~5 ms; ids 100 -> 2-5 ms | S | done |
| N15 | Reproject | No-change run still decodes all raws (`workflow` is 68% of bytes) | 30 s -> a few s at 30k | M | done |
| N16 | Scan | Post-scan reprojection covers the whole library, not the written ids | 10%-touched rescan 2.7 -> 0.9 s | S | done |
| N17 | AI | DB write runs serially after each inference | 7 -> 8.5-9 img/s | S-M | done |
| N18 | AI | Face detector session spins all 12 threads | Same 41 ms/img on 3 cores instead of 12 | S | done |
| N19 | AI | Model load freezes the event loop 0.4-0.9 s (job start, after idle unload, first re-tag) | Load at startup on GPU, skip idle unload there | S | won't do (accepted) |
| N20 | Frontend | Boot is serialized behind onboarding; the feed competes with 14 eager queries | First tile 319 -> ~200 ms (est.) | M | done |
| N21 | Tags | Merge suggestions `LIKE 'prompt:%'` reads every row | 1.2-1.6 s -> ~0.1 s cold | S | done |
| N22 | Tags | Tag samples scan all images once per tag | 60 tags 1.16 s -> ~0.3 s cold | S | done |
| N23 | Feed | Deep `sort=top` pages still grow with depth when scores tie (D2 gap) | Page 140: 54 -> ~5 ms | S | done |
| N24 | Frontend | Typing hotspots: palette `toLocaleString` per item, fuzzy re-normalizes, Tags filter sync | Worst key ~95 -> ~30 ms | S | done |
| N25 | Frontend | Image view step re-renders the gallery underneath; `/activity` refetched per step | 62 -> ~30 ms per step | M | done |
| N26 | Scan | Two concurrent scans x 12 threads oversubscribe the CPU | Multi-library first scan ~14% | S | done |
| N27 | Misc | Uncached linear endpoints: `/ai/coverage` (80 ms, polled every 3 s in jobs), loras, embeddings, sizes, search-no-hit, rules signatures (283-333 ms, loaded by the character page) | 50-300 ms each | S | done |
| N28 | Frontend | Bundle: main chunk 130 KB gz, 68% unused at boot; `SearchPalette` pulls in all Settings sections | ~10-20 ms local, more on WAN | S-M | done |
| N29 | Frontend | Per-tile render hops (4 renders); `alt=path` builds alt boxes for unloaded tiles | Pushes the blank-tile cliff further | S-M | done |
| N30 | Frontend | DPR-1 desktops load 768 px thumbs for 221 px tiles | 110 -> 31 MB per 2k tiles; no gain on LAN, helps WAN | S-M | dropped (measured: blank tiles 0% -> 97% cold) |

Not worth doing (measured): batching ONNX inference (0-7%), fp16 WD model (5x slower on CUDA), react-router production alias (no change), more scan workers than cores, a process pool for scanning (scaling is already linear).

## Writers at once (30k, 10 req/s reads throughout)

Across every combined run there were **no "database is locked" errors, no busy_timeout hits (worst write wait 1.23 s), no scanner retries, no 5xx and no OOM kills**. What combined load does find is long waits, not failures.

| scenario | scan | AI job | reads p95 / max | WAL peak | RSS peak |
|---|---|---|---|---|---|
| solo (same session) | 19.9 s, 67 img/s | 7.03 img/s | 123 ms / 5.2 s (idle; the max is a browse rebuild) | 90 / 44 MB | |
| AI + new-library scan | 23.2 s (-15%) | 6.13 img/s (-13%); 4.87 during the scan, **2.06 during the post-scan reprojection** | 343 ms / 6.9 s | 200 MB | 1.69 GB |
| AI + forced reprojection (5.2k raws) | | **1.07 img/s while the reprojection ran (-85%)**, 5.61 overall | 5.4 s / 7.6 s; browse p50 5.2 s | 485 MB | 1.97 GB |
| AI + face detection + scan | 35 s (-50%) | 5.49 img/s (-22%) | 447 ms / 7.6 s; browse 8.4 s during the reprojection | 197 MB | 1.92 GB |
| AI + scan, `journal_size_limit` 64 MiB | 22.3 s | 6.17 img/s | same | 142 MB, settles at 67 MB | |

New findings, beyond the solo ones above:

| ID | Finding | Gain | Effort | Status |
|----|---------|------|--------|--------|
| N31 | **A reprojection batch holds SQLite's write lock for 0.4-1.5 s.** The AI job's per-image write (on its serial path, N17) waits behind it, and tagging drops 70-85% for the length of any reprojection, including the automatic post-scan one. | Commit ~50 rows with derive done outside the transaction, plus N17 write-behind | S-M | done |
| N32 | **CPU-heavy writers saturate all 12 threads and starve the GPU.** Scan pool (12) + face detector (spinning) + readers keep 10.5-10.8 cores busy: GPU use 72% -> 40%, tagger prefetch 51 -> 182 ms, face detection 105 -> 256 ms. | N18 + N26, and cap threads while another heavy writer runs | S | done |
| N33 | **The async write lock serialises face writes and tagger writes.** Lock wait p95 112 ms, max 1.75 s. | Batch face writes, or route them through the AI write-behind | S | done |
| N34 | **Process memory only ratchets up.** 127 MB at boot, ~550 MB after a scan, ~1.85 GB after a job. Idle unload frees VRAM but only 24 MB of RSS (ORT/CUDA host arenas, glibc). A forced 30k reprojection on top would reach ~5.5 GB. | Free the ORT arena on unload, `malloc_trim` after scans/jobs, plus N4 | M | done |

- **N7 under combined load:** `journal_size_limit` caps where the WAL settles once a checkpoint finds a gap between readers, at no throughput cost. It does not cap a burst's peak, so pair it with `wal_checkpoint(TRUNCATE)` when the writers go quiet.
- **Untested:** a 30k-raw forced reprojection overlapping a job; the combined base DB had 5.2k raws. Expect the -85% tagging window to last ~77 s or more instead of 25 s.
- **Scenario 3 is synthetic:** with auto-tag on, tagging waits for a scan to finish, and faces are queued only for avatars.

### Re-checked by the parent session

| finding | agent's number | re-run |
|---|---|---|
| N1 | 15 sibling-combinator rules | Confirmed 15 in the built CSS; 119 `space-*`/`divide-*` uses in `src/` |
| N2 | browse cold 4.4 s; one-pass rewrite faster | Current 4.34-4.39 s, one-pass 2.55 s, 4,839 rows, 0 mismatches |
| N8 | filter-on cold `/tags` 5.8 s | 5.24 s (one SQL statement) vs 0.16 s with the filter off |

Code read, matching what the agents described:
- N4: `fetchall` in `_derive_where`
- N6: hard invalidate per reprojection batch
- N7: no `journal_size_limit` in `_apply_pragmas`
- N8: per-row `EXISTS` in `visible_tag_rows`
- N9: no cache on tag detail
- N14: `_RARE = 300`
- N16: `reproject_library_async` after any write

## Details by area

### API / DB (30k unless noted; p50 ms)

| endpoint | cold | warm | note |
|---|---|---|---|
| feed first page, all sorts | - | 12-18 | uncached; flat with depth for newest and oldest (D2 holds) |
| feed deep140, sort=top | - | 54 | N23 |
| feed tag 299 / 301 / 3000 matches | - | 18 / **82** / 37 | N14 cliff |
| `/images/ids`, tag 301 / dense | - | 100 / 146 | N14 |
| grouped view, first page / offset 20k | - | 326 / 409 | N12 |
| `/tags` all sources (real) | 169 (58) | 3.6 | D3 holds |
| `/tags` with sensitivity filter on | **5,755** | 2-3 | N8 |
| tags browse all / prompt (real) | **4,578** / 5,508 (859) | 64 | N2 |
| characters list | 1,514 | 7.8 | |
| character page, top character | **6,661** | 1,264 | N2 + N9 |
| tag detail, dense | 2,906 | 2,971 | N9, never cached |
| tag samples (60 tags) | 1,159 | 2.5 | N22 |
| merge suggestions | 1,216-1,580 | 1.8 | N21 |
| recipe / outfit routes for a character | 4,755-5,400 | 4-212 | N2 |
| thumbnail / small (first ask) / original | - | 2.5 / 24 / 5.5 | fine |

- Startup on 30k: ~1 s from launch to `/health`, of which importing `moire.main` is 0.75 s. `ensure_schema` takes 30 ms.
- Possible D5 regressions, not profiled, likely the per-row thumb stat behind versioned URLs: feed limit=1000 45.6 ms (was 18); warm browse 64 ms (was 24).

### Frontend (real DB)

- **Boot, desktop, cold:** FCP 208 ms, first tile 319 ms, visible thumbs 427 ms, LCP 896 ms. 18 API calls (60 KB gz).
- **Bundle:** main 403 KB raw / 130 KB gz, vendor 270 / 86 KB, CSS 86 / 16 KB. Generate is lazy (95 KB).
- **Scroll:** no blank tiles up to 10k px/s; the cliff sits at 12.5-15k px/s. No heap leak (+2 MB over 2,000 tiles). The server serves ~500 thumbs/s, which is not the limit.
- **N1 evidence:** Chrome invalidation tracking names the 15 compiled sibling rules on the grid container (144-168 hits per 3 s, 0 after the fix). Style recalc in a 6 s trace: 1,725 -> 477 ms; elements restyled per frame: ~1,100 -> ~120.
- **Image view:** opens in 171 ms; each step takes 65.6 ms median (preloaded neighbours decode in 0.5 ms, so decode is not the cost).
- **Pages:**
  - Tags, opened directly: 1.6 s (backend-bound); 444 ms in-app.
  - Character page, opened directly: 895 ms.
  - Settings, Outfits, Libraries: under 200 ms.
- **Typing:** palette 21 ms per key (worst 86); gallery tag search 19 ms; Tags page filter worst key 81-95 ms.
- **G-items:** G1 and G4 hold. G2 (blurhash) is still the top boot JS self-time at 36 ms.

### Scan and reprojection

- **First scan:** 68-92 img/s, the same with cold and warm cache.
  - Per image, single thread: webp encode 33 ms, PNG decode 26-61 ms, resize 12-20 ms.
  - Scales linearly to 6 cores, +36% from SMT. S4's "GIL-bound past 4 workers" no longer holds.
- **Rescan:** unchanged 0.3-0.5 s per 567 files (S1 holds). 10% touched: 0.86 s scan + 1.8 s whole-library reproject (N16).
- **Watcher:** 1.67 img/s (N13).
- **Reprojection:**

  | dataset | no change | forced | settings flip | peak RSS |
  |---|---|---|---|---|
  | real | 7.9 s | 15.4 s | 16.4 s | 0.8 GB |
  | 30k | 29.7 s | 77 s | | 3.8 GB |

  - S3c's real no-change run was 5.1 s and is now 7.9 s, likely from work added since (loras, embeddings, weights); not confirmed.
- **Concurrency, 30k, 10 req/s reads:**

  | phase | reads p50 / p95 / max | /health max | WAL max |
  |---|---|---|---|
  | idle | 13-18 / 118-224 ms | 117 ms | |
  | scan of 1,334 files | 24 / 480 ms | 316 ms | 113 MB |
  | forced reprojection | 56 ms / 9.8 s / 23 s | 10 s | 2.7 GB |
  | no-change reprojection | 4.0 / 18 / 27 s | 7.2 s | |
  | delete a 3.4k-image library | fine | | |

  No "database is locked" error anywhere.
- **RSS:** 125 MB at boot, ~560 MB after a scan, up to 5.6 GB after reprojections (never released).

### AI tagging and face detection

- **Tagger, GPU, ms per image:** inference 105, decode 24, prepare 22, select_tags 0.14.
  - CPU EP inference is 569 ms.
  - Batch size: no effect.
- **Job throughput:** 7.75 img/s alone; 6.9-7.1 img/s under read load. GPU 73-81% busy. The prefetch never stalls.
  - Cancel takes 94 ms.
- **Reads during a job:** no worse than idle. A2 holds: /libraries p50 8.8 ms (was 12).
- **Tag-view staleness:** max 15.0 s by design; fresh again 0.4 s after the job.
- **Single re-tag:** 243-293 ms warm, 2.3 s cold.
- **Face detection:** 41 ms per image on 11.8 cores (N18). It does not slow tagging yet, but it doubles the tagger's prefetch time.
- **Auto-tag on ingest:** 3.4-4.6 s, mostly the fixed 3 s debounce and the watcher's quiet window.
- **RSS:** 1.2-1.35 GB with the model loaded. VRAM 0.6-1.1 GB, 63 MiB after idle unload.

## Tracker

The work list for these findings, in the suggested order. Tick an item when it lands, with its commit, and set its row's Status in the tables above to `done` (or `dropped`, with the reason). Measure before and after with the matching `bench/` suite (`bench/README.md`).

### 1. Quick, independent wins
- [x] N1: Tailwind `space-y`/`divide` sibling selectors (gallery fast scroll) (`bdc97cc`)
- [x] N10: 500 ms thumbnail fade (LCP) (`84b173d`)
- [x] N4: reprojection reads raws in pages, not one `fetchall` (`761574e`)
- [x] N6: reprojection soft-invalidates per batch, hard once at the end (`7b8daf3`)
- [x] N7: `journal_size_limit` plus `wal_checkpoint(TRUNCATE)` after big writes (`3de898e`)
- [x] N8: sensitivity filter tests the visible-image set once, not per tag row (`9848fb6`)
- [x] N9: cache tag detail and compute its image ids once (`8cdd6a8, 79efc5c`)
- [x] N14: `_RARE` scales with library size; `/images/ids` takes the id path (`b9137d1`)
- [x] N18: face detector at 4 threads, no spin-wait (`ff183ff`)
- [x] N21: merge suggestions use a `prompt:` range on the covering index (`293622f`)

#### Section 1 results (2026-11-22)

Before (`0bb93d9`) and after (`c9fe948`), same session, one suite at a time, nothing else running (load 1.3-3.8). 30k is the `syn` dataset.

| finding | measure | before | after |
|---|---|---|---|
| N1, N10 | boot LCP, desktop (median of 7) | 900 ms | 556 ms (150 ms fade; no fade measured 396) |
| N1 | fast scroll 15k px/s: fps / blank tiles / blank frames | 41 / 6% / 17% | 58 / 0% / 0.2% |
| N1 | scroll 10k px/s: fps / p95 frame | 50 / 26 ms | 60 / 18 ms |
| N1 | phone, 4x CPU, 10k px/s: fps / blank tiles | 15 / 40% | 20 / 10% |
| N8 | `/tags` merged, filter on, cold (30k) | 5,578 ms | 401 ms |
| N9 | tag detail, dense tag: cold / repeat (30k) | 2,794 / 2,798 ms | 2,475 / 0 ms |
| N21 | merge suggestions, cold (30k) | 1,194 ms | 499 ms (the grouping SQL is 0.09 s; the rest is other statements) |
| N14 | feed, 301-match tag / `/images/ids` same tag (30k) | 71 / 102 ms | 10 / 7 ms |
| N4 | forced reprojection, 30k, alone: peak RSS / RSS after | 3,810 / 1,710 MB | 352 / 334 MB |
| N6 | same run: hard invalidations | 145 | 1 |
| N4-N7 | forced 30k reprojection with reads at 10 req/s: reads p95 / browse p50 | 8.3 s / 5.9 s | 0.43 s / 0.11 s |
| N6 | same: view rebuilds (build CPU) | 236 (815 s) | 18 (48 s) |
| N7 | same: WAL peak / at the end | 2,487 / 2,487 MB | 182 / 0 MB |
| N4-N7 | same: run time / server RSS peak / `/health` max | 165 s / 4.1 GB / 3.7 s | 106 s / 0.46 GB / 0.66 s |

- N18 was not re-measured: it applies the setting `bench/ai/face_spin.py` measured (same speed on 3 cores instead of 12).
- N9: a dense tag is still ~2.5 s cold; most of it is the related-tags count. Repeat views are cached.
- N21: the 1.2 s -> 0.1 s estimate covered the grouping statement only; the remaining ~0.4 s is in the other statements of `shown_merge_suggestions`.
- No regressions seen: `/tags` filter off 553 -> 555 ms, browse 4.3 -> 4.6 s (within this run's load drift), dense-tag feed 4 -> 5 ms (one extra `max(rowid)` read).

### 2. Tag-view cost
- [x] N2: one-pass Tags browse for the all-sources view (`23ad3ed`); the one-source views keep the old plan (one pass was 5-10x slower there). Stored per-tag stats are still open
- [x] N3: an AI job's end (and a one-image re-tag) bumps the generation but serves the previous view while one build replaces it, `tag_index.invalidate(refresh=True)` (`574e694`); the client asks again 6 s later (`13404e5`). Every other writer stays strict (sensitivity keys depend on it). A re-tag's extra hard invalidate from `clear_ai` is gone
- [x] N11: the soft window is 10x the view's last build time, 15-60 s (`8cbd0c8`, docs `1b86c4e`)

#### Section 2 results (2026-11-22)

Before `06ccbd5`, after `23ad3ed`, 30k `syn`, back to back (load 2-3). `bench/api/stale_bench.py` ends a job the way `jobs.py` does and simulates a 60 s job (7 soft writes/s, a reader each second).

| finding | measure | before | after |
|---|---|---|---|
| N2 | Tags browse, all sources, cold | 4,556 ms | 2,909 ms |
| N2 | character page, top character, cold | 7,825 ms | 6,178 ms |
| N3 | first browse / characters list after a job ends | 4,653 / 2,923 ms | 0 / 12 ms (fresh 3.1 s later) |
| N11 | 60 s job: browse rebuilds (build time) | 4 (18.8 s) | 2 (6.2 s) |

- N2 diffed row for row against the old query (all four sources, `bases` subsets, filter levels 0 and 1, syn and real): 0 mismatches. Real library: 0.83 -> 0.58 s. The prompt view is unchanged at ~5.5 s (30k), and the characters list cold is unchanged at ~3.5 s (it doesn't read the full browse).
- Reviewed (/code-review medium), fixes in `0b5879f` and the next commit: a refresh is strict while the sensitivity filter is on; a build begun before a refresh is kept (served stale) so back-to-back re-tags can't starve a view; past-TTL entries aren't revived; a re-tag's clear always reaches the views when its job ends however it ends; the packed cover key falls back past rowid 2^30; the client asks again at 6 s and 20 s.
- Trade-off: a one-image re-tag no longer makes the Tags page wait; its counts trail by one build. Clearing the AI tags of a job that then never writes reaches the views after the soft window.

### 3. Reprojection
- [x] N5: raw decode and derive run in one spawned worker process (`42e7d1b`, `b158328`, `278bae3`); in-thread fallback for small pages, tests, and a worker that can't start or dies. Yielding the GIL per row was tried first: it halved the tail but stayed far above idle
- [x] N15: a run skips rows whose inputs are unchanged, before reading their raw (`f59c509`): a stamp in `image_gen_derived` per row (ruleset, extraction settings, merge/split rules, `DERIVE_VERSION`), conditional on the raw revision read. Forced and id-targeted runs never skip; the manual library endpoint now runs forced (`e49a00b`)
- [x] N16: post-scan reprojection covers only the ids the scan wrote plus underived rows, or the whole library past half of it (`f78b97d`)
- [x] N31: writes are planned outside the transaction and committed ~50 rows at a time, re-read inside; diffs instead of rebuilds for `image_tags` and terms (`935fcc5`)

#### Section 3 results (2026-11-22)

Before `cb0df78`, after `278bae3`, 30k `syn` (load 2-3), one suite at a time.

| finding | measure | before | after |
|---|---|---|---|
| N15 | no-change reprojection, alone | 29.3 s | 0.06 s |
| N15 | no-change run with readers at 10 req/s: reads p50 / p95, browse max | 147 / 1,170 ms, 7.4 s | nothing read (0.2 s) |
| N5, N31 | forced run, alone | 77 s | 69 s |
| N5, N31 | settings flip, alone | 87.5 s | 26 s |
| N31 | write transaction hold, forced: mean / max | 343 / 1,017 ms | 32 / 99 ms |
| N5 | forced run with readers: thumbnail p95, feed p95, all p50 / p95 | 339, 487, 27 / 449 ms | 11, 28, 9 / 107 ms |
| N5 | same: `/health` p95 / max, run time | 75 / 666 ms, 103 s | 18 / 73 ms, 91 s |
| N16 | 567-file library, 10% touched: post-scan reprojection | 1.9 s | 0.46 s |

- N31 alone made the forced run slower (77 -> 100 s: four times the commits); N5's worker took it back below the old time.
- The worker is ~100 MB while it runs and exits after 120 s idle, or with the server (even a killed one).
- Reviewed (/code-review medium), fixes `bb4b7f9..3553c3b`: a small rescan also derives raws left unstamped (a cut-off run); raw revisions come from a counter that never repeats (a deleted and re-added image can't inherit a stamp); diff inserts ignore a stray join row instead of failing the chunk forever; rows with nothing to write are re-checked inside the stamping transaction; a stale idle timer can't stop the worker; a worker that fails twice is given up on until restart. Numbers re-run after: unchanged.
- Trade-off: an extraction code change reaches existing rows only through a `DERIVE_VERSION` bump or a forced migration entry (CLAUDE.md gotcha). A rule edit makes the next broad run re-derive everything once.

### 4. Writers
- [x] N13: the watcher ingests a burst as one batch: one shared stability wait (a file still growing waits, never dropped), the scan pool, 200-row commits, one invalidation and one targeted post-scan step per batch (`aa6ab4d..8881bb6`)
- [x] N12: the grouped view walks the sort index with the feed's keyset cursor; a row is shown if no matching member of its batch sorts before it, counts per page (`3205a9a..2028790`). Probe pinned to new `(gen_group_id, sort...)` indexes with `INDEXED BY`
- [x] N17: the AI job's writes run behind the next inference: a 4-deep queue, up to 8 images per transaction, an image counted only once committed, the job ends after its last write (`494a3f0`)
- [x] N33: the face worker stores 8 images per transaction (`fcdd893`)
- [x] N32: a scan uses about half the cores while tagging or face detection runs, decided at scan start (`fdd98a3`)
- [x] N34: `malloc_trim` after scans, AI jobs, reprojections and model unloads; the face detector unloads when its queue drains (`46e2a9d`). ORT arena options were tried and did not return memory

#### Section 4 results (2026-11-22)

Before `c2698c1` (same code as `ec33150`), after `a9fd0f4`, back to back, one suite at a time. AI runs on the GTX 1650 (CUDA). Combined: 600-image AI job on the 30k base with a 1,334-file scan and 600 face detections, reads at 10 req/s.

| finding | measure | before | after |
|---|---|---|---|
| N13 | 100 PNGs dropped into a watched folder: all listed / all with prompt tags | 62.1 / 62.1 s | 2.1 / 3.9 s |
| N13 | same: invalidations | 100 | 2 |
| N12 | grouped view, first page / ~20k groups in (30k) | 299 / 385 ms | 5.3 / 5.5 ms |
| N17 | AI job, 600 images, alone | 7.21 img/s | 8.53 img/s |
| N17, N32 | combined: AI job overall | 6.28 img/s | 8.01 img/s |
| N32 | combined, while the scan runs: tagging / GPU busy | 4.15 img/s / 43% | 8.23 img/s / 88% |
| N32 | same window: reads p95, feed p95 | 460, 209 ms | 173, 83 ms |
| N32 | same: scan of 1,334 files | 26 s | 41 s |
| N33 | combined, AI + faces: async write-lock wait p95 / max | 7.8 / 259 ms | 7.2 / 133 ms |
| N34 | scan then 600-image job, then 60 s idle unload: RSS at the end | 1,518 MB | 1,047 MB |

- Trade-off (N32): a scan that overlaps an AI job takes longer (here 26 -> 41 s) so the GPU stays fed; a scan alone keeps every core.
- N34 on CPU tagging: unload with gc alone 351 MB, with trim 62-87 MB. On CUDA most of what stays is the CUDA/cuDNN libraries (~600 MB mapped).
- Combined WAL peak was higher after (49 -> 250 MB, back to 0.4 MB at the end, vs 49 MB left before); the scan overlapped more of the job. Not investigated.
- N12 deep `sort=top` page is ~47 ms (few distinct scores, same as N23).
- Reviewed (/code-review medium), fixes `fc242de..d69bcf8`: the face detector unloads after 2 min idle instead of after every run (a run's last await let newly queued avatars sit with no worker, keeping scans capped); the tagger's unload runs gc and trim in a thread, not on the event loop; a watcher burst reprojects only the ids it wrote (no library-wide sweeps per burst); a watcher removal counts off only rows still there; reprojection trims the heap only after 1,000+ rows; a short page has no next cursor and the client pages on the cursor alone (a removal patched into the last cached page no longer ended infinite scroll; this one predates section 4); the grouped view shows a batch once if its head changed between page fetches. Watcher numbers re-run after: unchanged (100 files 2.0 / 3.8 s).
- A first AI/combined pass ran with the CPU onnxruntime by mistake (a plain `uv run` swaps it in); numbers above are the GPU rerun.

### 5. Smaller backend items
- [x] N19: no event-loop freeze on model load: accepted as is, not changed (see decision below)
- [x] N22: tag samples start from the tag's own rows
- [x] N23: deep `sort=top` pages split on the score tie
- [x] N24: typing hotspots (palette number formatting, fuzzy normalization, Tags filter)
- [x] N26: one scan at a time
- [x] N27: cache the linear endpoints (`/ai/coverage`, loras, embeddings, sizes, rules signatures)

**Status (2026-11-23): done (N19 accepted as is), reviewed (`/code-review medium 0f3204a..b240da0`: three nits, fixed in `7d0d467..4e114e8`: the Tags page's hand-made rows and empty state follow the deferred filter; a tag no bigger than its sample window reads every match in one query instead of two; a split top-rated page reads both parts in one read transaction). Nothing pushed.** Commits `3ccce72..b240da0` (plus `0f3204a`, the pre-commit hook fix below). Before at `9ae386e`, after at `b240da0`'s code; raw output in `local-setup/bench/runners/s5-before/`, `s5-after/`, `s5-after2/` (typing rerun on a quieter box), runner `runners/s5.sh <tag>`.

| item | measure | before | after |
|---|---|---|---|
| N22 | tag samples, 60 tags, cold (HTTP) | 1,157 ms | 171 ms (each tag's query 90 -> 0.1 ms) |
| N23 | feed page 140, `sort=top` (direct) | 42.5 ms | 7.2 ms (SQL 1.5 ms) |
| N27 | `/images/sizes` / loras / embeddings (warm p50) | 57 / 70 / 137 ms | 1.0 / 1.3 / 0.7 ms (cold unchanged, 45-128 ms) |
| N27 | `rules/signatures` (warm p50 / p95) | 272 / 897 ms | 23 / 26 ms (cold build still ~260 ms) |
| N27 | `/ai/coverage` (warm p50) | 53 ms | ~20 ms (rerun; 12 ms in-process) |
| N27 | search with no hit (`zzqx`) | 84 ms | 18 ms |
| N24 | palette, next frame per key (median / long task) | 23.9 ms / 95 ms | 17.4 ms / none |
| N24 | Tags filter, next frame (median / worst key) | 21.1 / 67 ms | 24 / 45 ms (median within noise) |
| N24 | gallery search (not changed) | 23.6 ms | 23.5 ms |
| N26 | Silly + Illustrious, two at once / one at a time | scan 13.0 s, with reprojection 15.7 s | scan 13.5 s, with reprojection 13.8 s |
| N19 | model load, longest event-loop freeze | first load 734-1,112 ms, reload ~200 ms | unchanged (accepted) |

- **N22:** `covers._shuffled_rows` ranks the tag's own `image_tags` rows by the shuffle and looks up only the first `limit * 4` in `images`; a second pass over every match runs only when hidden images leave the page short. Equivalence tests compare row for row with the old query, sensitivity filter off and on (`tests/test_tag_samples.py`).
- **N23:** `_paged` returns statements that `_page_rows` runs in turn: the rest of the cursor's score tie (score left out of the `ORDER BY`, or SQLite sorts the tie in a temp B-tree), then `score < s`. `newest`/`oldest` keep one query. Tests walk every page of every sort against the full sort.
- **N27:** new `ix_images_coverage` (coverage is not cached: the AI job only soft-invalidates, so a cache would lag its 3 s poll by 15-60 s). Search tests a rough `_id LIKE` first, which reads only the sort index. Facets (`services/images/facets.py`) and signatures go through `tag_index.cached`, keyed by library, quarantined view and filter level. New invalidations, each after its commit: a full scan that wrote rows (on any exit), ruleset save/delete, family naming, workflow file import. Side effect: those writes now also drop the Tags page views, so the next Tags load rebuilds once.
- **N24:** fuzzy caches each target's normalized forms (bounded map), the palette formats counts with one `Intl.NumberFormat`, and the Tags page filters on `useDeferredValue` with per-row name caching. `tagSuggest` left as is: its boilerplate split needs the full ranking.
- **N26:** `scanner_max_concurrent_scans` default 2 -> 1. Sharing the cores between two pools was not tried: two at once already scanned no faster than one (73 vs 77 img/s), and their reprojections overlapping is what cost the time.
- **N19 decision (2026-11-23, accepted):** keep the idle unload (the user does not want the model kept on the GPU). The load runs in a thread, but onnxruntime holds the GIL while building the session. A reload after an unload freezes the loop ~200 ms; a saved optimized graph gives the same, so not added. The first load in a process (0.7-1.1 s, one-time CUDA setup) is left: accept it, or build the session in a child process (M). Accepted: a one-time stall per process plus ~200 ms per reload does not earn a worker process, its lifecycle and crash handling.
- **Build breakage found on the way:** the main checkout's `node_modules` had hoisted links pointing into a removed agent worktree, so `tsc` found two copies of vitest and react-router (53 type errors). Cause: the husky pre-commit hook ran `pnpm exec`, which in a worktree with symlinked `node_modules` reinstalls through the links. Fixed in `0f3204a`: the hook and lint-staged call the binaries directly.

### 6. Frontend medium items
- [x] N20: boot not serialized behind onboarding; defer non-critical queries
- [x] N25: image view step without re-rendering the gallery underneath
- [x] N28: main bundle (Settings sections out of `SearchPalette`)
- [x] N29: fewer render hops per tile; no `alt` boxes for unloaded tiles
- [x] N30: `srcset` for the small thumbnail tier on DPR-1 desktops: built and measured, dropped 2026-11-23 (see below)

#### Section 6 results (2026-11-23)

**Status (2026-11-23): N20, N25, N28, N29 done, reviewed (`/code-review medium f2d40ed..b907303`: one real bug, fixed in `8f3e7ed`: HoldRoute held on path, search and hash only, so a same-path navigation with new state (Remix from the image view over Generate) never reached the page and the sidebar's Back/Forward went stale; it compares the history key too now. Five nits fixed in `ea73d56`). N30 measured and dropped (2026-11-23). Nothing pushed.** Commits `d0c0546..75aa367`, `8f3e7ed`, `ea73d56`. Before at `f2d40ed`, after at `ea73d56`'s code (the image view rows) and `d32f1c0` (the rest; the later commits only touch the image view and the Settings panels' loading). Raw output in `local-setup/bench/runners/s6-before/`, `s6-after/`, `s6-after2/` and `s6-after3/` (image view on `75aa367` and `ea73d56`), `s6-warm/` (reloads), `s6-n30/`; runners `s6.sh <tag>`, `s6prof.sh <tag>` (React commits, profiling build), `s6viewer.sh`, `s6warm.sh`, `s6n30.sh`. Desktop 1440x900, real DB, medians.

| item | measure | before | after |
|---|---|---|---|
| N20 | first visit (empty browser storage): first tile / all visible / LCP | 323 / 381 / 548 ms | 286 / 355 / 520 ms |
| N20 | first visit: feed request time / done at | 59 / 232 ms | 28 / 196 ms |
| N20 | reload: first tile / all visible / LCP | 219 / 237 / 430 ms | 193 / 221 / 404 ms |
| N20 | reload: feed starts / done at | 88 / 144 ms | 75 / 103 ms |
| N25 | image view step, key -> image shown (`viewer-hops`, 20 steps a run) | 66 ms (one run) | 49 ms (four runs: 47-53) |
| N25 | image view step, shown with fade done (`viewer`) | 70 ms | 61 ms |
| N25 | API calls per step | 4 | 3 (`/activity` gone) |
| N25 | React render time, 21 steps (profiling build) / gallery renders | 399 ms / `AllImagesPage` x42 | 216-230 ms / none |
| N28 | main chunk (raw / gz), unused at boot | 405 / 130 KB, 67.5% | 368 / 121 KB, 64.4% |
| N29 | `ImageThumbnail` renders per tile (2k-tile scroll) | 4.0 | 3.0 |
| N29 | scroll 15k px/s: blank tiles / fps | 0.1% / 56.8 | 0% / 57.8 |

- **N20:** a browser that has seen setup over (`onboarding:set-up` in local storage) renders at once while the check still runs; a pending answer still opens the welcome page, and a fresh browser waits as before. The search box's options (merged tags, models, loras, embeddings, outfits, generators) wait for the gallery's first page; cached answers still show. The characters prefetch waits a second, then for idle. The first-visit rows show only the deferred queries; the reload rows show both.
- **N25:** three causes. (1) `<Routes>` hands new location and route context objects to everything under it on every navigation, so each step re-rendered the gallery: `HoldRoute` keeps them while the gallery's location is the same history entry (key, path, search, hash; the background location's key is always "default"), and `App` is memoized. (2) `patchImageInFeeds` rebuilt a page's item array even when the sync from the open image's document changed nothing, rewriting the cached feed on every step (found with a fiber diff after (1) halved the renders; a test now checks the cached data is left as it was). (3) `/activity` had `staleTime: 0`, so readers the view mounts per step refetched it: its staleTime now follows its poll interval (the app keeps one poll running; invalidations still refetch). Also: a step onto a preloaded neighbour whose decode is done shows it in the same render, without the pending render and promise hop. Left per step: the image view's own renders and the sidebar's five `NavLink`s (they follow router state).
- **N28:** the settings panels load lazily, in one chunk (`features/settings/components/panels.ts`), with the Settings page. The rest of the unused share is the image view's code (characters, generate) and tailwind-merge; not moved.
- **N29:** eager tiles start with `shouldLoad` true instead of setting it in an effect. The `<img>` gets its `alt` with its `src`; the button carries the name (`aria-label`).
- **N30 (dropped 2026-11-23):** a `srcset` with the small copy (`?size=small`, 256 px short side) and `sizes` from the grid's column width, so DPR-1 tiles took the small copy. Measured at 15k px/s on a 1x screen:

  | | blank tiles | thumb request median | MB per 2k tiles |
  |---|---|---|---|
  | without (shipped) | 0.1% | 11 ms | 110 |
  | small copies not yet made | 97% | 87 ms | 18 |
  | every small copy on disk | 1.3% | 16 ms | 33 |

  Small copies are made on first ask (PIL, four at a time), which cannot keep up with a scroll, and even when they exist the `?size=small` route is slower than the thumbnail fast path (T1; boot thumbnails 11 -> 26-29 ms). Shipping it would need the small copies made at scan time plus the fast path for them (more scan time, and ~30% more thumbnail disk: 17 KB beside 56 KB each), for a gain only on slow links. Patch kept at `local-setup/bench/runners/n30-srcset.patch`.
- **Bench scripts:** `build-variant.mjs` and `bundle-stats.mjs` now take Vite's CJS entry (`build` sits on `default`), and must run from `packages/frontend` (Tailwind finds its config from the working directory).

### Follow-ups
- [x] T5: cheaper tile mount and earlier first fetch (`docs/perf-findings.md`, T5 section). Re-measured 2026-11-23 on top of section 6, which had already done P2c (N29) and most of finding 3 (N20). Shipped P1 (the gallery's first feed page starts in `main.tsx`, before React renders, with the hook's own query options so the hook picks it up in flight) and P2a (BlurHash decode with cached cosine tables, pixel-identical to the package on 60 hashes at four sizes, 0.47 -> 0.14 ms a tile). P2b (mount the viewport first) not done: what is left after these is small. Interleaved, 3 x 5 runs per variant, medians, first tile on a first visit / on a reload: base 299 / 190 ms, P1 260 / 192, P2a 266 / 175, both 229 / 160; LCP 524 -> 476 / 408 -> 368 ms. Runner `local-setup/bench/runners/t5.sh`, output `t5/`.
- [x] Find why reprojection got slower since Oct (real DB, no change: 5.1 -> 7.9 s). Moot (2026-11-23): since N15 a no-change run skips unchanged rows before reading them. Real DB at `0329e8f`, a fresh copy each: no change 0.01 s (the first run on a DB with no stamps yet: 6.2 s, once), forced 15.4 -> 12.9 s, settings flip 16.4 -> 7.6 s (Oct, S3c: 12.1 s). Runner `local-setup/bench/runners/rep.sh`.
- [x] Find the possible D5 regressions: feed `limit=1000` 18 -> 45.6 ms, warm browse 24 -> 64 ms. Found (2026-11-23): the thumbnail URL versions, though less the stat than building the file path for it (~10 us a row) plus `quote()` and the hash. Each thumbnail's (mtime, size) is now kept in memory and dropped by every write and delete (all go through `storage_fs`); a stat a write overlapped is not kept. Quoted ids and hashes are memoized, and feed rows take their column names once per result. Syn 30k, HTTP warm p50 at load ~1, three runs: feed `limit=1000` 46 -> 21-31 ms, browse 78 -> 25-30 ms; real: 15-23 ms and 23-26 ms. URL building alone, 1,000 rows: 25 -> 3 ms.
- [x] Measure a 30k-raw forced reprojection overlapping an AI job (only 5.2k raws were measured). Done (2026-11-23, `1046615`, `CLONE_RAW=1 bench/combined/run.sh`, 28.8k raws, tag:600, GTX 1650, load ~1): tagging 8.73 img/s alone -> 8.36 img/s with the reprojection running (-4%; it was -85% with 5.2k raws before section 3). The reprojection ran 96 s, 72 of them beside the job. Reads at 10 req/s while both ran: p50 8 ms, p95 47 ms, max 485 ms, browse p50 39 ms, `/health` max 401 ms; no lock errors. AI write transactions held p50 60 / p95 190 ms (alone 15 / 44), one at 1.7 s. Results `c30-solo-ai`, `c30-ai-reproj`.
- Follow-ups reviewed (/code-review medium `0329e8f^..2b24b36`, 2026-11-23): no bugs, five nits. Fixed: the stamp cache keys by the resolved thumbnail root (resolved once per list), keeps "no thumbnail" too (those rows were still stat'ed each time), and drops its oldest half at the limit instead of everything; URL building for 1,000 rows 3.3 -> 1.8 ms. Left: a thumbnail changed outside the app keeps its URL until a restart (only `storage_fs` writes them; noted in the code); the prefetch also fires on a fresh install's first load, where the welcome page discards it (gating it on the setup flag would drop the gain for every new browser); lock-free dict reads rely on the GIL (noted in the code).
- [x] T1-T3 thumbnail work: merged to main 2026-11-15 (`09af796..a5773a1`). Thumbnails 470 -> 2,050 req/s; blank tiles at 15k px/s: going down 94% -> 21-37%, coming back up 29% -> 0%.
