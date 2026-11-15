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

## Ranked findings

| ID | Area | Finding | Gain | Effort | Status |
|----|------|---------|------|--------|--------|
| N1 | Frontend | Tailwind v3 `space-y`/`divide` sibling selectors restyle the whole grid on every tile mount | Fast scroll at 15k px/s: blank tiles 95% -> 1%; 10k px/s 49 -> 58 fps; 4x-throttled phone 23 -> 38 fps | S-M | open |
| N2 | Tags | Tags browse cold is one 4.4 s statement at 30k (D4 still open); character page, recipes and outfit routes run it first | One-pass rewrite prototyped: 4.3 -> 2.5 s, output identical. Stored per-tag stats would go further (L) | S-M | open |
| N3 | Tags | Hard invalidations land on the next viewer: AI job end, each single re-tag (twice), each reprojection batch | Next browse 4.5-4.8 s, characters 1.2-3 s at 30k -> served stale while rebuilding | M | open |
| N4 | Reproject | `_derive_where` `fetchall()`s every gen-raw row | Peak RSS 3.8 GB -> paged; memory is never returned today | S | open |
| N5 | Reproject | Runs as a thread in the API process: GIL convoy | Reads at 10 req/s: p50 17 ms -> 4 s, /health stalls up to 7 s, even with nothing written | M | open |
| N6 | Reproject | Hard `tag_index.invalidate()` per 200-row batch | 151 invalidations -> 237 rebuilds (824 s of build time); run 178 s vs 77 s alone | S | open |
| N7 | DB | WAL has no size limit and is never truncated | 2.7 GB during reprojection with readers; 63-113 MB after jobs and scans | S | open |
| N8 | Sensitivity | With the filter on, tag counts run a correlated EXISTS per `image_tags` row | Cold `/tags` 5.8 s -> ~0.3-1.4 s at 30k (34x slower than filter off today) | S | open |
| N9 | Tags | Tag detail is never cached and recomputes its image-id subquery ~10 times | Dense tag 2.9 s every call -> ~2 s cold, ~0 warm | S | open |
| N10 | Frontend | 500 ms thumbnail fade (`ImageThumbnail.tsx:42`, `:147`) | LCP 888 -> 396 ms | S | open |
| N11 | AI | Soft-rebuild window fixed at 15 s during jobs | ~100 s of view-build CPU per 1,000 images at 30k; scale the window with build cost | S-M | open |
| N12 | Feed | Grouped (batch) view re-aggregates everything on every page, offset paged | 326 ms per page at 30k -> ~12 ms (rewrite tested unfiltered) | M | open |
| N13 | Library | Watcher ingests strictly one file at a time (0.5 s stability wait each, invalidation each) | 100 dropped files: 60 s -> ~1-2 s | M | open |
| N14 | Feed | `_RARE`=300 is too low at 30k; `/images/ids` never uses the id path | 301 matches 82 -> ~5 ms; ids 100 -> 2-5 ms | S | open |
| N15 | Reproject | No-change run still decodes all raws (`workflow` is 68% of bytes) | 30 s -> a few s at 30k | M | open |
| N16 | Scan | Post-scan reprojection covers the whole library, not the written ids | 10%-touched rescan 2.7 -> 0.9 s | S | open |
| N17 | AI | DB write runs serially after each inference | 7 -> 8.5-9 img/s | S-M | open |
| N18 | AI | Face detector session spins all 12 threads | Same 41 ms/img on 3 cores instead of 12 | S | open |
| N19 | AI | Model load freezes the event loop 0.4-0.9 s (job start, after idle unload, first re-tag) | Load at startup on GPU, skip idle unload there | S | open |
| N20 | Frontend | Boot is serialized behind onboarding; the feed competes with 14 eager queries | First tile 319 -> ~200 ms (est.) | M | open |
| N21 | Tags | Merge suggestions `LIKE 'prompt:%'` reads every row | 1.2-1.6 s -> ~0.1 s cold | S | open |
| N22 | Tags | Tag samples scan all images once per tag | 60 tags 1.16 s -> ~0.3 s cold | S | open |
| N23 | Feed | Deep `sort=top` pages still grow with depth when scores tie (D2 gap) | Page 140: 54 -> ~5 ms | S | open |
| N24 | Frontend | Typing hotspots: palette `toLocaleString` per item, fuzzy re-normalizes, Tags filter sync | Worst key ~95 -> ~30 ms | S | open |
| N25 | Frontend | Image view step re-renders the gallery underneath; `/activity` refetched per step | 62 -> ~30 ms per step | M | open |
| N26 | Scan | Two concurrent scans x 12 threads oversubscribe the CPU | Multi-library first scan ~14% | S | open |
| N27 | Misc | Uncached linear endpoints: `/ai/coverage` (80 ms, polled every 3 s in jobs), loras, embeddings, sizes, search-no-hit, rules signatures (283-333 ms, loaded by the character page) | 50-300 ms each | S | open |
| N28 | Frontend | Bundle: main chunk 130 KB gz, 68% unused at boot; `SearchPalette` pulls in all Settings sections | ~10-20 ms local, more on WAN | S-M | open |
| N29 | Frontend | Per-tile render hops (4 renders); `alt=path` builds alt boxes for unloaded tiles | Pushes the blank-tile cliff further | S-M | open |
| N30 | Frontend | DPR-1 desktops load 768 px thumbs for 221 px tiles | 110 -> 31 MB per 2k tiles; no gain on LAN, helps WAN | S-M | open |

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
| N31 | **A reprojection batch holds SQLite's write lock for 0.4-1.5 s.** The AI job's per-image write (on its serial path, N17) waits behind it, and tagging drops 70-85% for the length of any reprojection, including the automatic post-scan one. | Commit ~50 rows with derive done outside the transaction, plus N17 write-behind | S-M | open |
| N32 | **CPU-heavy writers saturate all 12 threads and starve the GPU.** Scan pool (12) + face detector (spinning) + readers keep 10.5-10.8 cores busy: GPU use 72% -> 40%, tagger prefetch 51 -> 182 ms, face detection 105 -> 256 ms. | N18 + N26, and cap threads while another heavy writer runs | S | open |
| N33 | **The async write lock serialises face writes and tagger writes.** Lock wait p95 112 ms, max 1.75 s. | Batch face writes, or route them through the AI write-behind | S | open |
| N34 | **Process memory only ratchets up.** 127 MB at boot, ~550 MB after a scan, ~1.85 GB after a job. Idle unload frees VRAM but only 24 MB of RSS (ORT/CUDA host arenas, glibc). A forced 30k reprojection on top would reach ~5.5 GB. | Free the ORT arena on unload, `malloc_trim` after scans/jobs, plus N4 | M | open |

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
- [ ] N1: Tailwind `space-y`/`divide` sibling selectors (gallery fast scroll)
- [ ] N10: 500 ms thumbnail fade (LCP)
- [ ] N4: reprojection reads raws in pages, not one `fetchall`
- [ ] N6: reprojection soft-invalidates per batch, hard once at the end
- [ ] N7: `journal_size_limit` plus `wal_checkpoint(TRUNCATE)` after big writes
- [ ] N8: sensitivity filter tests the visible-image set once, not per tag row
- [ ] N9: cache tag detail and compute its image ids once
- [ ] N14: `_RARE` scales with library size; `/images/ids` takes the id path
- [ ] N18: face detector at 4 threads, no spin-wait
- [ ] N21: merge suggestions use a `prompt:` range on the covering index

### 2. Tag-view cost
- [ ] N2: one-pass tags browse (prototype `bench/api/onepass_browse.py`, output identical); later, stored per-tag stats
- [ ] N3: keep serving the stale view while rebuilding after a hard invalidation
- [ ] N11: scale the soft-rebuild window with build cost during AI jobs

### 3. Reprojection
- [ ] N5: run it outside the API process, or page and yield
- [ ] N15: skip unchanged rows before decoding their raw
- [ ] N16: post-scan reprojection only for the ids the scan wrote
- [ ] N31: shorter reprojection write transactions (derive outside, ~50 rows a commit)

### 4. Writers
- [ ] N13: watcher ingests in batches
- [ ] N12: grouped view walks the recency index with a cursor
- [ ] N17: AI job writes behind the next inference
- [ ] N33: face writes batched or routed through the AI write-behind
- [ ] N32: cap scan and face-detector threads while another heavy writer runs
- [ ] N34: give memory back after jobs and scans (ORT arena on unload, `malloc_trim`)

### 5. Smaller backend items
- [ ] N19: no event-loop freeze on model load (GPU: load at start, skip idle unload)
- [ ] N22: tag samples start from the tag's own rows
- [ ] N23: deep `sort=top` pages split on the score tie
- [ ] N24: typing hotspots (palette number formatting, fuzzy normalization, Tags filter)
- [ ] N26: one scan at a time, or one shared pool
- [ ] N27: cache the linear endpoints (`/ai/coverage`, loras, embeddings, sizes, rules signatures)

### 6. Frontend medium items
- [ ] N20: boot not serialized behind onboarding; defer non-critical queries
- [ ] N25: image view step without re-rendering the gallery underneath
- [ ] N28: main bundle (Settings sections out of `SearchPalette`)
- [ ] N29: fewer render hops per tile; no `alt` boxes for unloaded tiles
- [ ] N30: `srcset` for the small thumbnail tier on DPR-1 desktops

### Follow-ups
- [ ] T5: cheaper tile mount and earlier first fetch (`docs/perf-findings.md`, T5 section). Re-measure on a quiet box with `bench/web`, then decide.
- [ ] Find why reprojection got slower since Oct (real DB, no change: 5.1 -> 7.9 s).
- [ ] Find the possible D5 regressions: feed `limit=1000` 18 -> 45.6 ms, warm browse 24 -> 64 ms (suspect: the per-row thumbnail stat behind versioned URLs).
- [ ] Measure a 30k-raw forced reprojection overlapping an AI job (only 5.2k raws were measured).
- [x] T1-T3 thumbnail work: merged to main 2026-11-15 (`09af796..a5773a1`). Thumbnails 470 -> 2,050 req/s; blank tiles at 15k px/s: going down 94% -> 21-37%, coming back up 29% -> 0%.
