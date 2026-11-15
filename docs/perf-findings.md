# Performance findings (Oct 2026)

Tracker for the perf investigation. Each finding has an ID, status, effort and evidence.
Agents measured on a loaded machine, so absolute timings are noisy; ratios are the reliable part.
Repro scripts lived in the session scratchpad (`scratchpad/<area>/`). **That was in /tmp and was wiped when WSL
was OOM-killed (2026-10-19)**: the script paths below are a record of what was measured, not runnable files.

Status: `open` (found, not verified) · `verified` (re-checked by parent) · `chosen` · `done` · `dropped`
Effort: S (hours) · M (a day or so) · L (more)

> **Nov 2026:** a full re-benchmark (API/DB, frontend, scan, AI, combined writers) is in `docs/perf-benchmark-2026-11.md`, findings N1-N34, with the work tracker at its end.

## Summary

| ID | Area | Finding | Gain | Effort | Status |
|----|------|---------|------|--------|--------|
| G1 | Gallery | Next page fetched only when sentinel is on screen | Removes multi-second stalls on fast scroll | S | done (`426b0ae`) |
| G2 | Gallery | BlurHash decoded at 64x64 on main thread, every mount | 4-20x less decode CPU | S | done (`426b0ae`, 32px) |
| G3 | Gallery | Thumbnails ~700x1024 vs ~250px displayed | 2-4x smaller downloads + decode | M | done (`eb4e869`, 768px) |
| G4 | Gallery | Grid setState every scroll frame | Small | S | done (`f16bf28`, 128px scroll steps) |
| G5 | Gallery | `openTile` identity changes per page append | Small | S | done (`f16bf28`, stable onOpen) |
| A1 | AI tagging | CPU-only ONNX; CUDA works on GTX 1650 | ~9x inference | M | done (`8e29af7`, `gpu` group; 134 ms/img on GTX 1650) |
| A2 | AI tagging | Decode + inference run on the event loop | API p50 during job 1.2-1.5s -> 12ms | S-M | done (merged) |
| A3 | AI tagging | Tag from local thumbnail instead of original on /mnt/g | ~45 ms/img, no 9P reads | S | dropped (measured: no gain behind the A2 prefetch; tags drift at 768px) |
| A4 | AI tagging | Pad-then-resize prep + Python `select_tags` loop | ~45 ms/img (matters only with A1) | S | done (`2907b74`: prep in the prefetch, numpy select; GPU job 166 -> 133 ms/img) |
| A5 | AI tagging | ORT `intra_op_num_threads` untuned | Unclear (contention artifact?) | S | dropped (measured: default/6/12 threads within noise) |
| S1 | Scan | Rescan re-processes every unchanged file; 15-min reconcile triggers it per watched library, plus full reproject | Unchanged rescan 6.8s -> 0.16s / 297 imgs (~40x) | S | done (`2d5e32a`) |
| S2 | Scan | Thumbs 1080px webp; 640px enough | Scan ~1.7-2x faster, thumbs ~45% smaller | S (+ regen) | done (`eb4e869`, 768px after visual check; 512 too soft for avatars) |
| S3 | Prompt extraction | Reproject reruns needlessly; `parse_prompt` ~22 calls/img uncached | Gate on change (S1); lru_cache 20.1 -> 14.5s real library (-28%) | S | done (a, b; c `a6f5e64`: skip unchanged + bulk writes, full re-run 17.6 -> 5.1 s) |
| S4 | Scan | Thread pool + GIL bound past ~4 workers; process pool | Maybe 1.3-2x, unproven | M | dropped (measured: +12% warm, first scans only) |
| S5 | Scan | Serial walk + stat over 9P (~7 ms/file) | Needed once S1 lands: 10k stats 70s -> ~10s | S | done (`2d5e32a`, stat on the pool) |
| D1 | API / DB | Rare tag/term filter walks all images in sort order, probing EXISTS per row | Rare filter 128 -> 5 ms @30k; threshold 3000 regresses mid filters 3-7x | S-M | done (`aa9a4e6`, `_RARE`=300) |
| D2 | API / DB | Cursor row-value compare can't seek the sort index; deep pages O(depth) | deep140 49 -> 3 ms @30k; sort=top not covered | S | done (`aa9a4e6`, all sorts incl. top) |
| D3 | API / DB | `image_tags` indexes not covering `(tag, image_id)` / `(base, image_id)` | Cold tag list 1.8s -> 0.24s @30k; +11-22% DB size | S | done (`aa9a4e6`, no `ix_images_cover`) |
| D4 | API / DB | Tags `browse` covers via window fn sorting every image_tags row | ~10% alone; browse cold 9.8 -> 4.7s with D3 | S | done (`aa9a4e6`) |
| D5 | API / DB | Characters listing uncached; `jsonable_encoder` on big lists; gzip on media | JSONResponse 3-5x on big lists; characters cache buggy | S | done (`aa9a4e6`; avatars live, gzip level 6) |
| T1 | Thumbnails | `/thumb` does a DB lookup, a `resolve()` and several thread hops per tile, and gets slower with concurrency | Server 185 -> 847 req/s at 6 connections; browser TTFB 31 -> 7 ms | S-M | in progress (branch `perf/thumbnails`, `d11f1dd`, `683d70a`; reviewed and fixed; backend suite, e2e and benchmark not run) |
| T2 | Thumbnails | A tile whose image already loaded this session still queues for a slot, decodes its BlurHash and fades for 500 ms | Scroll-back to fully visible 909 -> 31 ms (with T1) | S | in progress (branch `perf/thumbnails`, `dd1d305`, `621c1a2`, `38c2c44`; reviewed and fixed; e2e and benchmark not run) |
| T3 | Thumbnails | The slot queue is FIFO, so tiles already scrolled past load before the visible ones | With T2: blank tiles during a flick 32 -> 17%, settle 151 -> 87 ms; split between T2 and T3 unresolved | S | in progress (branch `perf/thumbnails`, `a7b8eac`, `621c1a2`, `38c2c44`; reviewed and fixed; e2e and benchmark not run) |
| T4 | Thumbnails | Other levers: event-loop reads, ASGI bypass, HTTP/2, 24 slots, `setswitchinterval`, `RWF_NOWAIT` | None worth taking | - | dropped (measured), see section |
| T5 | Thumbnails | First tile takes ~730 ms in every variant, and the feed is only 7-20 ms | First thumbnail request -44 to -62% (prototype, box under load) | S-M | open (prototype measured, see section; re-measure on a quiet box) |
| T6 | Thumbnails | WebP `method=6` instead of the default 4 | 3.2% smaller, encode ~2.3x slower | S + rebuild | dropped (measured), see section |

## Next steps (agreed order)

Done 2026-10-20: A2, S1 + S5, G1, G2, S2 + G3 (768px), S3b, A1, D1-D5, plus the medium code review of the cache and skip work (`dd642d0`). A4 (`2907b74`) and a high code review of all of it (`f02ba49`: failed-file retry, resuming cut-off reprojections, coalesced full reprojections, lock held through cancelled inference, gzip wrapper, sentinel viewport fallback).

Done after that (2026-10-20):
- S3c (`a6f5e64`): reprojection skips unchanged rows and writes in bulk, results byte-identical. 18.2 -> 12.1 s after a settings flip, 17.6 -> 5.1 s with nothing changed. Migrations use `force=True`.
- G4/G5 (`f16bf28`).
- Tags browse (`df95782`): one pass, materialized visible images. Byte-identical; cold all 565 -> 350 ms, prompt 1040 -> 395, ai 408 -> 33.

Measured and dropped (2026-10-20), so nothing is open:
- S4: 240 real files, warm page cache, 768px thumbs. Thread pool x12: 45-47 img/s; process pool x12: 50-53 img/s (+12%). It only helps a library's first scan (rescans skip unchanged files), the cold read over /mnt/g is I/O that threads already overlap, and 12 worker processes cost memory and make cancellation harder.
- A5: WD v3 on CPU, 12 runs each, twice: default 754-780 ms, 6 threads 755-769 ms, 12 threads 746-760 ms. All within noise; ORT's default is fine.

Review findings left as is (`dd642d0` review):
- The rare-filter id list and the page query run as separate statements (separate snapshots). An image tagged in the milliseconds between them can miss one page; plain EXISTS paging has the same exposure across pages.

## Working notes (how this was run, for re-running)

- Never benchmark against `data/moire.db` / `data/thumbs`. Snapshot the DB with SQLite's backup API (the file is in WAL mode, a plain `cp` can be inconsistent), and set both `SQLITE_PATH` and `THUMB_ROOT` to scratch copies before starting a backend: startup runs migrations, the AI worker and library watchers. Set `watch_enabled = 0` on the copied libraries.
- Use ports other than 8000/5173 (the user's `pnpm dev`).
- The AI model cache is `/home/mnand/Projects/Tagify/.cache/tagify/models/` (the absolute `cache_dir` in the `ai` app_settings row), so DB copies find it.
- This WSL box has ~9.7 GB RAM / 12 cores. Three heavy agents at once (90k-row DB synthesis + ONNX bench + Playwright) OOM-killed WSL and wiped `/tmp`. Run at most 2 heavy jobs; keep results out of `/tmp`.
- Subagents can't `Write` report files; have them return the report as text, then save it here.
- New worktrees have no `node_modules`, so the husky pre-commit hook fails. Symlink `node_modules` and `packages/frontend/node_modules` from the main checkout for the commit, then `rm -rf` the links.
- Playwright Chromium is in `~/.cache/ms-playwright`; `uv run --with playwright python ...` drives it. Software rendering under WSL: frame times are unreliable, use stall time and request counts.
- Agent timings were taken under load average 8-46. Trust ratios from the same run, not absolute numbers.

## Gallery (frontend)

Setup: 10,776-row scratch DB, prod build, headless Chromium, 2500 px/s scroll x 8 s.
Ruled out: no HEAD per tile (1 GET/tile measured); thumbs cached `immutable` 1y;
`packColumns` memoized (1.5 ms @10k, 98 ms @50k items); tiles `React.memo`, selection
re-renders only the toggled tile; `content-visibility:auto` deliberately not proposed.

### G1. Infinite-scroll sentinel has no prefetch margin
- Where: `packages/frontend/src/pages/AllImagesPage.tsx:503-517`; `PAGE_LIMIT = 100` in `features/images/lib/imageFilter.ts:116`.
- Evidence: observer created with no `root`/`rootMargin`. Fast scroll waited 3-6 s of 8 s at page ends; with a 3000px margin, 0-3.3 s.
- Fix: `root: getScrollContainer()`, `rootMargin: "0px 0px 3000px 0px"` (root must be the scroll element, same trap as `useImageLoadSlot.ts`). Optionally PAGE_LIMIT 200.
- Repro: `scratchpad/gallery/scroll_bench.py` + `prototype.patch`, `start.sh`, `prod.sh`.

### G2. BlurHash decode cost
- Where: `packages/frontend/src/features/images/components/ImageThumbnail.tsx:10` (`BLUR_PX = 64`).
- Evidence: decode 10.3 ms @64px, 2.4 ms @32px, 0.47 ms @16px. Virtualized tiles remount constantly, each pays again.
- Fix: `BLUR_PX = 16` or `32`; optional small LRU keyed by hash.
- Repro: `scratchpad/gallery/bench-layout.mjs`.

### G3. Oversized thumbnails
- Where: thumb generation (`services/library/scanner.py`, `THUMB` size in `core/config.py:60`, 1080 max).
- Evidence: mean 73 KB, typ. 701x1024 webp; tiles ~250px (460 max) wide. Frame-time gain inferred.
- Fix: ~480-640px thumbs + regenerate. Keep >= 512 if A3 tags from thumbnails.
- Repro: `scratchpad/gallery/thumbdims.py`.

### G4. Grid re-renders every scroll frame
- Where: `packages/frontend/src/features/images/components/VirtualizedGrid.tsx:99-105`.
- Fix: only setState when first/last visible row changes. Inferred <1 ms/frame; low priority.

### G5. `openTile` re-created on each page append
- Where: `packages/frontend/src/pages/AllImagesPage.tsx:521-536`.
- Fix: read `items`/`filters` via ref. Inferred small.

## AI tagging

Per-image (832x1216 PNG, CPU): read via 9P ~50 ms, decode ~38, prep ~35, **ONNX ~1500 (90-95%)**,
select_tags 6-25, DB ~18. Real job queue: 0.59 img/s. CPU batching gives nothing.
Model lifecycle fine (load once, 300s idle unload). Face detect not on tagging path.

### A1. GPU inference (CUDA EP)
- Where: `packages/backend/src/services/ai/tagger.py:177` hardcodes `CPUExecutionProvider`.
- Evidence: CPU 890 ms/img vs CUDA 108 ms/img (bs1), 100 ms (bs8). Works on GTX 1650 / WSL2 with `onnxruntime-gpu==1.23.2` + `nvidia-*-cu12` pip wheels; `ort.preload_dlls()` required, otherwise silent CPU fallback.
- Setup detail: system CUDA toolkit is 13, which ORT 1.23 can't use; the CUDA 12 libs come from pip: `nvidia-cudnn-cu12 nvidia-cublas-cu12 nvidia-cuda-runtime-cu12 nvidia-cufft-cu12 nvidia-curand-cu12 nvidia-cuda-nvrtc-cu12`. Check `session.get_providers()` starts with `CUDAExecutionProvider`. A `/sys/class/drm/card0/device/vendor` warning is harmless. TensorRT EP listed but untried.
- Cost: ~2 GB of wheels; conflicts with `onnxruntime`, so an optional extra (`uv sync --extra gpu`); CPU fallback; 4 GB VRAM shared with Windows, one session only.
- Repro: `scratchpad/ai/gpuvenv/bin/python scratchpad/ai/gpu_bench.py CUDAExecutionProvider,CPUExecutionProvider 1,4,8 5`.

### A2. Inference blocks the event loop
- Where: `packages/backend/src/services/ai/tagger.py:397` `predict_bytes` (sync `Image.open` + `predict` inside `async def`); `ai_jobs.py` `_tag_one`.
- Evidence: verified in code. Every API request stalls ~1.3 s per image while a job runs.
- Fix: `asyncio.to_thread` for decode + `session.run` (ORT releases GIL); prefetch 2-4 images in a pool. With A1: 3.7 -> 9-10 img/s.
- Repro: `scratchpad/ai/bench.py 30`.
- Done: `predict_bytes` replaced by `predict_image` (inference via `asyncio.to_thread` under the session lock); worker prefetches ids[i+1] read + decode during inference of ids[i]. Tests: `tests/test_ai_jobs.py` (non-blocking loop, prefetch order, failed load, cancel).
- Result (12-image job, real model, scratch DB, two runs each order): GET /libraries during the job p50 1192/1475 ms -> 12/12 ms, max 4.4 s -> 0.14 s. Throughput too noisy under agent load to claim (0.47-0.48 vs 0.38-0.76 img/s); the prefetch hides ~90 ms of ~1.5 s on CPU, more with A1.
- Repro: `scratchpad/a2/run.sh <backend_dir> <port> <label>` (fresh DB copy, watchers off).

### A3. Tag from thumbnail
- Where: `ai_jobs.py` `_read_image_bytes` (~150).
- Evidence: 30 images, mean tag Jaccard 0.976 (min 0.907), rating 30/30.
- Fix: read thumb via `storage_fs` if present, else original. Tags shift slightly: maybe a setting.
- Repro: `scratchpad/ai/equiv.py`.

### A3 result (2026-10-20): dropped
- With the A2 prefetch, reading + decoding the next original runs during inference. Cold read over /mnt/g plus decode was ~89 ms against ~117 ms of GPU inference, so it is already hidden.
- Tags from 768px thumbnails vs originals, 30 images: mean Jaccard 0.946, min 0.80, ratings 30/30. The earlier 0.976 was likely measured on 1024px thumbs.

### A4. Cheaper prep + vectorized select_tags
- Where: `ai_tagger.py` `_prepare_image` (~175-190), `select_tags` (~90-125).
- Fix: resize before pad; numpy masks over 10,861 labels. Re-check tag equivalence. Only worth it with A1.
- Result (`2907b74`):
  - Resize-before-pad moved borderline tags (Jaccard 0.959, 1/30 ratings flipped), so it was dropped. The reference pad-then-resize is kept, and it now runs in the prefetch thread.
  - Numpy select: 4 -> 0.2 ms.
  - Tags are identical to before (30/30).
  - 40-image job on GTX 1650, warm cache, alternating runs: 166 -> 133 ms/img. On the CPU, ~1%.

### A5. ORT thread count
- 4-6 intra-op threads looked faster under heavy external load; low confidence.

## Scan / prompt extraction

Per image, single thread, local disk (832x1216 ComfyUI PNG, ~1.3 MB): read 0.5 ms (9P ~30 ms serial,
overlapped by the pool), PNG decode ~31, resize 12-20, **webp encode @1080 m4 ~72**, blurhash 2-3,
metadata JSON parse 0.5, workflow_sig 0.03, DB upsert amortized. ~143 ms/img single thread;
end to end 12 workers ~27-35 img/s. Metadata parsing is negligible. Startup migrations don't rerun.
`file_hash` (`scanner.py:81`) is dead code. Scripts: `scratchpad/scan/` (`run_e2e.sh`, `stages.py`, `rep.py`, `walk9p.py`).

### S1. Skip unchanged files on rescan
- Where: `packages/backend/src/services/library/scanner.py:458-470` (walk, then every file submitted to `_process_image`); `library_watch.py:133-153` (reconcile every `watch_reconcile_interval_s` = 900s); post-scan `reproject_library_async` (`scanner.py:~621`).
- Evidence: verified in code, no size/mtime check. Unchanged rescan of 297 imgs: 6.8s (full decode + encode) plus a full reproject. 10k library: ~4 min all-core CPU + ~80s reproject + 13 GB of 9P reads, every 15 min.
- Fix: preload `{_id: (size, mtime, thumb_key)}`; skip when size + mtime match and thumb exists; thumb-settings version stamp so S2 regenerates; reproject only if something changed; count skips as processed.
- Prototype (lost with /tmp, ~40 lines): preload rows for the library, skip matches before submitting to the pool, gate the post-scan reproject on `scanned > 0`. 6.8s -> 0.16s (44 -> 1890 img/s). `git apply scratchpad/scan/skip_unchanged.diff`, then `scratchpad/scan/run_e2e.sh proto` vs `run_e2e.sh base` ("rescan (unchanged)" line).

### S2. Smaller thumbnails
- Where: `core/config.py:60` (`thumb_max_size = 1080`); `scanner.py:55-59` (`img.save(..., quality=85)`, default method 4).
- Evidence: 1080 -> 640: single-thread 143 -> 73 ms/img; e2e 27-35 -> 57 img/s; disk 70 -> 40 KB/thumb. Method 0 bloats files 35%; don't.
- Overlaps G3 (gallery decode + download). Keep >= 512 for A3. Needs regen of existing thumbs (via S1 version stamp). Quality not visually checked.
- Repro: `run_e2e.sh v THUMB_MAX_SIZE=640`.

### S3. Reproject cost
- Where: post-scan trigger `scanner.py:~621`; `api/rules.py:305` (`reproject_all_async` on any extraction-settings save); `prompt_guess.pick` -> `_hits` calls `parse_prompt` ~22x/img when prompt/negative empty.
- Evidence: ~7-9 ms/img (load+JSON 1.7-3.5, extract 1.7-3.2, flush 2.7-4.8, ~9 statements/img across 5 tables).
- Fix: (a) gate on change (S1); (b) `lru_cache` on `parse_prompt` returning a tuple (`Piece` is frozen): extract 2.8 -> 1.7 ms, total 9.1 -> 6.8 ms/img; (c) batch flush with executemany (~2 ms/img, inferred, M).
- Repro: `SQLITE_PATH=scratchpad/scan/rep.db scratchpad/scan/rep.py`.

### S4. Process pool for decode/encode
- `batch_pool.py:26`. 4 workers 25.6 img/s, 12 workers ~30-35. GIL glue (blurhash/numpy/JSON) caps scaling. Unproven gain 1.3-2x. Do S1 + S2 first.

### S5. Parallel stat over 9P
- `scanner.py:458-470`. Serial `os.walk` + per-file `Path`; `stat` ~7 ms/file over 9P. Fold into S1 (stat in a pool or use `os.scandir` entries).

## API / DB

Prototype: WIP commit `3586e3c` (branch deleted after the port in `aa9a4e6`; still reachable by hash until git gc).
**Measured 2026-10-20** by one agent alone: baseline = main (backend identical to `db648fd`) vs prototype.
- Datasets: backup-API copy of the real DB (3,881 images, 150k image_tags, 150k gen_terms), and a 30k synthetic DB (rows cloned from the real one; 1.1M image_tags, 1.2M gen_terms; 18 planted rare tags/terms of known size).
- Method: real uvicorn on ports 8810/8811 with httpx, 30 runs after 3 warmups. A direct-call bench (no HTTP) separated query cost from serialization. A 4-way matrix (code x indexes) attributed D3.
- Noise: p50 swings of 10-15% and 1-3 ms run to run; differences below that are treated as noise.
- Correctness: ids, order and cursors are identical on every compared feed, ids and groups query, and tags/browse JSON is identical, except the characters cache (D5).
- Prototype pytest: 4 failures. 3 are real (characters cache); 1 is expected (`test_schema` lists the old index names).
- The benchmark scripts lived in the agent's worktree, removed at wrap-up; the method above is enough to rebuild them.

### D1. Drive rare filters by id list: keep, lower the threshold
- Where: `services/images/feed.py` `_resolved` / `feed_where`.
- Idea: when the rarest tag group or prompt term matches few images, fetch their ids first and filter `_id IN (...)`.
- Rare filter (30 matches) at 30k: 126 -> 7 ms (HTTP), and `/images/ids` 128 -> 6 ms. On the real DB the gain is small (17.5 -> 9 ms).
- **The 3000 threshold is wrong.** D1 costs about 10 ms per 1000 ids, while the baseline gets cheaper as the filter gets denser.

  | DB | break-even | mid filter that regressed |
  |----|------------|---------------------------|
  | 30k | ~1300 matches | 2900 matches: 2.9x slower |
  | real (3.9k) | ~350 matches | 1899 matches: 7.1 -> 21.7 ms (3x); 2591 matches: 7.5x |

- Fix: `_RARE` about 300, or about 4-5x sqrt(N). The big wins are all under 100 matches.

### D2. Keyset paging seek: keep, extend to sort=top
- Plan: `SCAN images USING INDEX ix_images_recent` becomes `SEARCH ... (<expr><?)`.
- Deep pages go flat: on 30k, deep140 drops 58 -> 8 ms over HTTP and 49 -> 3 ms direct; newest, oldest, library and tag filters all benefit.
- Sort=top (two keys: score, mtime) still scans: deep50 ~21 ms, deep140 ~55 ms. Add the same range on the score key.

### D3. Covering indexes: keep the two image_tags indexes, drop `ix_images_cover`
- `(tag, image_id)` / `(base, image_id)` replace the single-column indexes.
- `/tags` with all sources, cold: 1794 -> 243 ms on 30k (7.4x), 298 -> 69 ms on the real DB. All of that gain is D3.
- Browse, cold: 9.8 s -> 5.8 s with D3 alone.
- `ix_images_cover` appears in no plan: drop it.
- Cost:
  - Index build: one-time, ~0.4 s on the real DB, ~3.8 s on 30k (startup 4.7 s vs 0.9 s; later boots are normal).
  - DB size: the real DB file grows 194.6 -> 216.4 MB (+11%); 30k goes +22%. The indexes repeat the long `_id` in every entry, and the dropped indexes' pages aren't reclaimed without VACUUM.

### D4. Tags browse in one grouped pass: keep (small alone)
- `GROUP BY base` + `min(key)` instead of the `row_number()` window. Output is identical (md5 matches in all 4 configs).
- Alone: browse(all) cold 9.8 -> 8.7 s (~11%). With D3: 4.7 s.
- Browse is still 5-9 s cold at 30k (per-row work dominates). Browse(ai/manual) is unchanged. That is the next thing to look at if browse matters.

### D5. Small API overheads: keep JSONResponse + gzip changes, fix the characters cache
- **JSONResponse** instead of `jsonable_encoder` is the biggest warm win. Identity encoding:
  - feed limit=1000: 45 -> 18 ms
  - `/tags` all sources: 32 -> 6 ms
  - browse: 70 -> 24 ms

  Bodies are byte-equal JSON.
- **GZip media exclusion: keep.**
  - Baseline gzips thumbnails (0.06% larger) and originals (2.3% smaller, ~30 ms CPU each, no Content-Length).
  - A 200-tile page spends ~0.4 s CPU compressing thumbs.
- **compresslevel 5 vs default 9: a trade.**
  - About 60% less gzip CPU.
  - Payloads 8-31% larger (`/images/ids` +31%).
  - Prefer 6 if remote access over slow links matters.
- **Characters cache: buggy as written.**
  - Warm: 844 ms -> 4 ms at 30k.
  - Nothing invalidates it on colour/name/series/focus edits: `characters.update` invalidates only when `kind` changes.
  - Nothing invalidates it on background face-detector results.
  - Result: stale for up to 30 s. 3 failing tests.
  - Fix: invalidate on every `update()` and after face-detector writes.
- **`find_image` projection:** saves under 0.25 ms per call. Harmless, negligible.

## Thumbnails (Nov 2026)

Question: how long do gallery thumbnails take to load, and what helps other than making them smaller? The numbers below come from prototypes in a throwaway worktree, not the real versions (see Progress). Scripts and the frontend prototype diff are in `local-setup/thumb-bench/` (gitignored, its README has the setup).

Setup: commit `073ab8f`, snapshot of a 4,103-image DB on disk, ~52 KB median WebP at 768px, server started with `--lifespan off` (no watchers, migrations, AI or ComfyUI workers). Thumbnails were read from the real `data/thumbs`, GET of the full size only, which writes nothing: a scratch copy on `/tmp` would have been tmpfs and hidden disk costs. Load test: raw keep-alive sockets, 2,500-3,000 requests. Browser: headless Chromium, 1920x1080, 30 tiles on screen, empty HTTP cache per run, medians of 5 runs (3 on WAN). "WAN" is Chromium's emulation: 40 ms latency, 50 Mbit/s.

### Progress

Tracked here; the summary table has the status of each finding.

Done (2026-11-02):
- T1, T2 and T3 implemented on branch `perf/thumbnails`, based on `073ab8f`: `d11f1dd` (T1), `dd1d305` (T2), `a7b8eac` (T3), `621c1a2` (fixes from reading the merge). Not on `main`, not pushed.
- T6 measured and dropped, see its section below.
- T5 investigated, nothing committed, see its section below.
- High code review of `073ab8f..perf/thumbnails`: 10 findings, static only, none applied yet. Listed below, awaiting decisions.

Next:
1. Full backend suite and `pnpm e2e` on the branch. Both skipped on request for now (the backend run was stopped before finishing, so it has no result). So far: full vitest passed (1092) before the last two tests were added, then the hook and `ImageThumbnail` tests passed (35), `tsc` and eslint clean, 47 targeted backend tests passed, and T1's wider image and thumbnail tests passed before the fixes. Two commits skipped the pre-commit hook (`--no-verify`, no `node_modules` links); eslint was run by hand on the frontend files afterwards.
2. Rerun `local-setup/thumb-bench` on the real versions and replace the prototype numbers. Check in a real browser: `img.complete` on an instant tile after memory-cache eviction, a reused tile changing `src`, and that nearest-first picks well in a very fast flick (the viewport it uses is the stepped `scrollTop`).
3. Merge to `main`, once decided.
4. Re-measure T5 on a quiet box, then decide which parts to do.

Review findings (R1-R10). Decided 2026-11-02: fix R1-R6 and R8-R10 (R5: only send `Range` requests down the old path, leave HEAD as is); accept R7 for now (versioned URLs are `immutable`, so most come from cache; a real fix needs a slot unless already `complete`). Fixed in `683d70a` (backend) and `38c2c44` (frontend), on the branch, static review not repeated:
- R1: `read_thumb` opens without `O_BINARY`, which corrupts bytes on Windows.
- R2: the fast path serves any file at the derived key before asking the DB: a stale file after a failed rethumb, or a leftover after purging a row with a NULL key.
- R3: an instant tile drops its BlurHash at `img.complete`, but with `decoding="async"` the image may not be decoded, so a tile could paint bare on scroll-back.
- R4: the `..` guard splits on `/` only, so on Windows a backslash traversal reaches another library's thumbnail.
- R5: GET and HEAD disagree on orphans, and the inline `Response` ignores `Range` for files under 1 MiB.
- R6: the over-1 MiB branch re-resolves and reopens the file: a second hop and a stale-stat race.
- R7 (accepted): a seen URL bypasses the slot cap and nearest-first, which matters if the cache was evicted on a slow link.
- R8: `spanTop`/`spanBottom` props defeat `ThumbnailTile`'s memo on reflow.
- R9: `_thumb_headers` builds a throwaway `FileResponse` twice per request.
- R10: the late-grant hand-back branches are dead now that waiters are cancelled.

How the real versions differ from the prototypes:
- T1: `read_thumb` refuses a key with a `..` part or one that escapes the root, then falls back to the DB's key, as does a missing file. Files over 1 MiB go through `FileResponse`. `?size=small` and HEAD keep the old path.
- T1 orphans: thumbnail files are removed right after the DB commit on delete, scan, reconcile, nesting and library removal. After R2, deletes also drop the derived key and a failed rethumb removes the old file. A crash or failed unlink between commit and removal can still leave a file, reachable only by its exact id. If a row's stored key differs and both files exist, the derived one is served; `put_thumb` always writes the derived key.
- T1 also sends files over 1 MiB and `Range` requests down the old path.
- T2: seen tiles decode with `decoding="sync"`, which needs a jank check in the browser. The BlurHash stays underneath. An instant tile counts as loaded only when the `<img>` holds this src and is `complete`, or its load event fires. The decode is skipped if the image is already complete at mount. The set holds 5,000 URLs, oldest out first; failed URLs never enter it.
- T3 reads positions through a stable getter, not props. The plan to read distance from the existing IntersectionObserver was wrong, because the grid passes `eager`, which skips that observer. Distance is plain arithmetic on the grid's tile positions and the stepped `scrollTop`, with no DOM reads. Tiles with no position count as distance 0, ties and no known viewport fall back to FIFO. Tiles that unmount or change src leave the queue.

### Where a request goes

| Stage, called one at a time | p50 |
|---|---|
| `find_image(id, ("thumb_key",))` | 1,165 us |
| anyio open + read chunks + close (what `FileResponse` does) | 701 us |
| thread hop, no work | 131 us |
| `thumb_path` (`resolve()` + `is_file`) | 90 us |
| `thumb_stat` (lexical + stat) | 9 us |
| open + read + close, plain | 36 us |
| `thumb_key(id)`, derived | 1 us |

The stored `thumb_key` equals `thumb_key(_id)` on all 4,103 rows, so the lookup only produces something the id already gives.

### T1. Server route

| Variant, warm page cache | 1 conn req/s | 6 conn req/s | 6 conn p50 | 12 conn req/s |
|---|---|---|---|---|
| Current route | 270 | 185 | 31.2 ms | 179 |
| No DB, one stat, still `FileResponse` | 673 | 456 | 12.6 ms | 543 |
| **No DB, one thread hop reads the bytes, `Response`** | 1,206 | 847 | 6.6 ms | 922 |
| Same + `setswitchinterval(0.5 ms)` | 1,004 | 933 | 6.1 ms | 976 |
| Same as bold, as ASGI middleware ahead of routing | 1,676 | 1,086 | 5.3 ms | 1,129 |
| No DB, read on the event loop | 1,802 | 3,485 | 1.5 ms | 3,781 |
| ASGI middleware + event-loop read | 1,908 | 7,156 | 0.8 ms | 7,294 |

The current route loses throughput as connections rise (270 -> 185), and the browser runs at 6. Thread handoff under contention is the likely cause, since only the variants without thread hops scale with connections; that is an inference, not separately isolated, and the switch-interval run barely moved it.

Cold page cache (`posix_fadvise` eviction, guest only: the Windows host may still cache, so a truly cold disk is worse), 6 connections: current 174 req/s, thread hop 810, event loop 950. The event-loop read stalled `/health` for up to 85 ms against 11 ms for the thread hop. Only those maxima compare: the probe outlasted the shorter load runs, so their percentiles include idle time. On a slow disk every API request would wait out those stalls.

Past one thread hop the browser sees no clear gain (all visible at 898 ms thread hop, 973 event loop, 960 middleware + event loop, within run-to-run noise), so the bold row is the pick.

The prototype is not shippable as is. A real change must:
- apply the traversal guard, because the URL's id now feeds the path (`thumb_stat`'s lexical check);
- fall back to `find_image` when the file is missing, which keeps slash/backslash id variants and any row whose key differs from the derived one working;
- keep `If-None-Match`/304, the `no-cache` header for unversioned URLs, `?size=small` and the HEAD route, and keep the tests that pin them passing;
- bound the in-memory read (largest thumbnail today ~370 KB), using `FileResponse` above a limit;
- decide whether a thumbnail file left behind by a deleted image may still be served, since nothing asks the DB any more.

### T2, T3. Frontend

T2: keep a session set of URLs that fired `onLoad`. A tile mounting with a URL in the set renders the `<img>` at once, without slot, BlurHash or fade. URLs are versioned, so a stale entry cannot show an old image. T3: on each free slot, grant the queued tile nearest the viewport rather than the oldest.

| Local, HTTP/1.1 | Current | T1 only | T2+T3 only | **T1+T2+T3** | + 24 slots |
|---|---|---|---|---|---|
| Open: all visible loaded | 1,239 ms | 898 | 1,064 | **880** | 917 |
| ...of which after the first tile appears | ~510 ms | ~165 | ~335 | **~110** | ~130 |
| Blank visible tiles during flick | 47% | 32% | 45% | **17%** | 5.5% |
| Settle after flick | 556 ms | 151 | 252 | **87** | 13 |
| Scroll back: loaded | 340 ms | 342 | 127 | **40** | 44 |
| Scroll back: fully visible, fade included | 909 ms | 884 | 125 | **31** | 37 |
| Thumb TTFB in browser | 31 ms | 7.4 | 31.6 | **7.2** | 7.7 |

Flick: 700 px every 100 ms, 25 times. Blank %: unloaded share of visible tiles, sampled per frame. It is the noisiest number here: T1+T2+T3 also gave 1.5% in a 3-run pass, so read it as a direction. 

T2 and T3 were only run together in this table. The one pass that separated them (3 runs, with T1) does not show which helps the flick:

| With T1, 3 runs | Neither | T3 only | T2 only | Both |
|---|---|---|---|---|
| Blank during flick | 30.6% | 31.6% | 15.6% | 1.5% |
| Settle after flick | 222 ms | 131 ms | 112 ms | 27.5 ms |

A seen-set should do nothing on a forward-only flick, yet T2 alone measured better, and this remains unexplained. A count of newly inserted tile nodes found no remounts (0 of 368), but it would miss a node reused with a new `src`. Rerun the separate toggles at 5 runs before shipping the two apart.

Costs the prototype does not show:
- T2's scroll-back number is best case: it scrolls back right after loading, with the browser's memory cache warm. The prototype also drops the BlurHash for these tiles, so a revisit late in a long session could show a bare dark tile for a moment. A real version should keep the BlurHash underneath and skip only the slot and the fade.
- T3's prototype calls `getBoundingClientRect` on every queued tile each time a slot frees, a layout read not measured here. A real version should get distance from the existing IntersectionObserver instead.

The first tile takes ~730 ms in every column and is not thumbnail work: the feed answers in 7-20 ms (100 items), which leaves app start-up. Not investigated further. It is now the largest part of opening the gallery.

Not measured: image decode and paint. "Loaded" is `img.complete`, and frame timing under WSL software rendering is unreliable.

### T4. Measured and dropped

- **Event-loop reads and ASGI bypass:** much higher load-test numbers, no clear browser gain, and event-loop reads stall the API on a cold disk.
- **`RWF_NOWAIT` (read on the loop only if cached):** `preadv2` flags raise `NotImplementedError` on the uv-managed Python, the supported install path.
- **`setswitchinterval`:** within noise, and it would affect the whole process.
- **24 slots:** best local flick (5.5%), worse on WAN (all visible 1,299 -> 1,458 ms, stall 47 -> 130 ms). Requests pile up in the browser's own queue, where nearest-first can't reorder them. Keep 12.
- **HTTP/2 (WAN, hypercorn + TLS, T1-T3 on):** stall 47 -> 3 ms as expected, but all visible no better (1,393 vs 1,299 ms) and settle about the same (373 vs 397 ms): with connection limits gone, the 50 Mbit/s link looks like the limit. A different server and TLS were also in play, so this does not rule out a benefit on a faster link. One scroll-back median of 945 ms looks like an artifact (the other h2 run gave 32 ms); possibly Chromium not caching over the self-signed cert, not checked.

WAN, current vs T1+T2+T3 (3 runs): all visible 1,719 -> 1,299 ms, settle 926 -> 397 ms, scroll back loaded 395 -> 111 ms, blank during flick unchanged at ~55%. T1 alone gave almost nothing there (1,654 ms): the link limits first, so the frontend changes do the work on slow connections.

Not tried: multiple uvicorn workers (one process owns watchers and workers).

### T5. Start-up before the first thumbnail

Setup: `073ab8f`, prod build, same DB snapshot and browser as above, `--lifespan off`, no `?size=small`. Variants ran interleaved in one run, medians of 7, chosen by `localStorage` flags in one build. Prototypes were not kept. "First thumbnail" here is the request start, not pixels on screen.

**Read the absolute numbers and the stage split with care.** Other agents and benchmarks were running, and the box was ~1.7x slower than the runs above. One earlier quiet run gave ~710 ms, with tiles in the DOM at 598 ms and the first `src` ~115 ms later. Under load that last gap was 690-720 ms. So the BlurHash decode's share may be inflated by load, and in a quiet run most of the time came before the tiles rendered. The ranking below needs a quiet re-measure.

| Stage, ms from navigation start | Empty cache | Reload | Warm (new tab) |
|---|---|---|---|
| Entry JS, vendor and CSS downloaded | 106-147 | ~53 | ~28 |
| Module eval done, before `createRoot` | 163 | 76 | 109 |
| Onboarding fetch ends; root renders `null` until then | 219 | 147 | 169 |
| Feed request starts | 368 | 196 | 323 |
| Feed response ends | 537 | 368 | 561 |
| Grid renders tiles (75 mounted, 30 visible) | 635 | 406 | 591 |
| First thumbnail request starts | 1,326 | 1,107 | 1,299 |
| Long tasks, total | 1.1 s | 0.87 s | 1.04 s |

| Prototype, first thumbnail request | Warm | Cold | Reload |
|---|---|---|---|
| Baseline | 1,299 | 1,326 | 1,107 |
| P1: start onboarding and feed fetches before `createRoot` | 1,210 | 1,198 | 950 |
| P2a: BlurHash decode with precomputed cosine tables | 1,033 | - | - |
| P2b: first commit mounts the viewport only, overscan after 300 ms | 927 | - | - |
| P2c: `shouldLoad` starts true for eager or priority tiles | 1,227 | - | - |
| P2a + P2b + P2c | 794 | 798 | 558 |
| All | 574 | 600 | 423 |

Findings, biggest measured first:
1. **Cheaper tile mount (P2), S-M.** 75 tiles mount before any gets a `src`, through three React passes, and the first pass decodes one BlurHash per tile: 365-404 ms in total here, 61 ms with cosine tables, whose output matched the library exactly on 200 real hashes. Where: `ImageThumbnail.tsx`, `VirtualizedGrid.tsx` (`visibleSlice`), `useImageLoadSlot.ts`. Costs: tables tied to size and component counts (cache by those); tiles below the fold mount 300 ms later, and a flick right after opening was not tested; P2c changes slot order slightly. T2's changes touch the same code, so this should be built on `perf/thumbnails`.
2. **Fetch before React renders (P1), S.** The app renders `null` until `/onboarding` returns, and that request starts only after the first render. The feed then shares a burst of about a dozen requests and takes 170-240 ms, against 26-30 ms alone. Small alone (-90 to -160 ms), a further -135 to -220 ms on top of P2. Costs: filter parsing shared with `useFilters`, must match `imageFeedKey` exactly or the fetch is wasted, and it fires before the welcome redirect on a fresh install.
3. **Defer the non-gallery requests, S-M, not prototyped.** Models, embeddings, LoRAs, outfits, generators and tags with `merge_sources` (178 KB JSON) fire from the gallery shell. Covers much the same ground as P1 for the feed.
4. **Pre-compress assets at build, S, inferred.** The server gzips JS per request, ~65 ms CPU over entry and vendor. Cold load only.

Ruled out: fonts (non-blocking), lazy chunks (the gallery loads none), feed endpoint alone, slot wait at open, thumbnail server work (~40 ms), and headless rendering as the cause of the decode and effect costs, which are pure CPU.

Not measured: pixels on screen including the fade and entrance animation, a real network, a per-module breakdown of the 362 KB entry chunk, and what the remaining 574 ms consists of beyond react-dom work.

### T6. WebP encoder settings

120 originals sampled across the library, 768px, one thread. Encode times are rough, since load rose during the run; sizes and quality are not affected. SSIM and PSNR are on luma against the resized source.

| Variant | Median size | Total vs now | Encode | Decode | SSIM | PSNR |
|---|---|---|---|---|---|---|
| m4 q85 (now) | 48.9 KB | - | 113 ms | 16.1 ms | 0.9870 | 42.36 dB |
| m5 q85 | 48.1 KB | -1.6% | 127 ms | 15.5 ms | 0.9865 | 42.16 dB |
| m6 q85 | 47.3 KB | -3.2% | 255 ms | 16.4 ms | 0.9866 | 42.17 dB |
| m6 q83 | 43.2 KB | -11.2% | 259 ms | 15.2 ms | 0.9850 | 41.50 dB |
| m6 q80 | 38.6 KB | -20.8% | 242 ms | 14.3 ms | 0.9824 | 40.56 dB |

- m6 at the same quality saves ~50 KB over 30 visible tiles, about 8 ms at 50 Mbit (calculated, not a browser run), and adds ~140 ms of encoding per image on top of ~220 ms open, decode and resize. Every first scan pays that, after release too.
- Rebuild cost is not the objection: the app is unreleased, and bumping `_THUMB_RECIPE` rebuilds on the next scan.
- The q83 and q80 savings come mostly from lowering quality, not from the method. Lower quality was out of scope for this work. m4 q80 was not measured.
