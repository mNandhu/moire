# Performance findings (Oct 2026)

Tracker for the perf investigation. Each finding has an ID, status, effort and evidence.
Agents measured on a loaded machine, so absolute timings are noisy; ratios are the reliable part.
Repro scripts lived in the session scratchpad (`scratchpad/<area>/`). **That was in /tmp and was wiped when WSL
was OOM-killed (2026-10-19)**: the script paths below are a record of what was measured, not runnable files.

Status: `open` (found, not verified) · `verified` (re-checked by parent) · `chosen` · `done` · `dropped`
Effort: S (hours) · M (a day or so) · L (more)

## Summary

| ID | Area | Finding | Gain | Effort | Status |
|----|------|---------|------|--------|--------|
| G1 | Gallery | Next page fetched only when sentinel is on screen | Removes multi-second stalls on fast scroll | S | done (`426b0ae`) |
| G2 | Gallery | BlurHash decoded at 64x64 on main thread, every mount | 4-20x less decode CPU | S | done (`426b0ae`, 32px) |
| G3 | Gallery | Thumbnails ~700x1024 vs ~250px displayed | 2-4x smaller downloads + decode | M | done (`eb4e869`, 768px) |
| G4 | Gallery | Grid setState every scroll frame | Small | S | open |
| G5 | Gallery | `openTile` identity changes per page append | Small | S | open |
| A1 | AI tagging | CPU-only ONNX; CUDA works on GTX 1650 | ~9x inference | M | done (`8e29af7`, `gpu` group; 134 ms/img on GTX 1650) |
| A2 | AI tagging | Decode + inference run on the event loop | API p50 during job 1.2-1.5s -> 12ms | S-M | done (merged) |
| A3 | AI tagging | Tag from local thumbnail instead of original on /mnt/g | ~45 ms/img, no 9P reads | S | dropped (measured: no gain behind the A2 prefetch; tags drift at 768px) |
| A4 | AI tagging | Pad-then-resize prep + Python `select_tags` loop | ~45 ms/img (matters only with A1) | S | done (`2907b74`: prep in the prefetch, numpy select; GPU job 166 -> 133 ms/img) |
| A5 | AI tagging | ORT `intra_op_num_threads` untuned | Unclear (contention artifact?) | S | open |
| S1 | Scan | Rescan re-processes every unchanged file; 15-min reconcile triggers it per watched library, plus full reproject | Unchanged rescan 6.8s -> 0.16s / 297 imgs (~40x) | S | done (`2d5e32a`) |
| S2 | Scan | Thumbs 1080px webp; 640px enough | Scan ~1.7-2x faster, thumbs ~45% smaller | S (+ regen) | done (`eb4e869`, 768px after visual check; 512 too soft for avatars) |
| S3 | Prompt extraction | Reproject reruns needlessly; `parse_prompt` ~22 calls/img uncached | Gate on change (S1); lru_cache 20.1 -> 14.5s real library (-28%) | S | done (a, b); c open |
| S4 | Scan | Thread pool + GIL bound past ~4 workers; process pool | Maybe 1.3-2x, unproven | M | open |
| S5 | Scan | Serial walk + stat over 9P (~7 ms/file) | Needed once S1 lands: 10k stats 70s -> ~10s | S | done (`2d5e32a`, stat on the pool) |
| D1 | API / DB | Rare tag/term filter walks all images in sort order, probing EXISTS per row | Rare filter 128 -> 5 ms @30k; threshold 3000 regresses mid filters 3-7x | S-M | done (`aa9a4e6`, `_RARE`=300) |
| D2 | API / DB | Cursor row-value compare can't seek the sort index; deep pages O(depth) | deep140 49 -> 3 ms @30k; sort=top not covered | S | done (`aa9a4e6`, all sorts incl. top) |
| D3 | API / DB | `image_tags` indexes not covering `(tag, image_id)` / `(base, image_id)` | Cold tag list 1.8s -> 0.24s @30k; +11-22% DB size | S | done (`aa9a4e6`, no `ix_images_cover`) |
| D4 | API / DB | Tags `browse` covers via window fn sorting every image_tags row | ~10% alone; browse cold 9.8 -> 4.7s with D3 | S | done (`aa9a4e6`) |
| D5 | API / DB | Characters listing uncached; `jsonable_encoder` on big lists; gzip on media | JSONResponse 3-5x on big lists; characters cache buggy | S | done (`aa9a4e6`; avatars live, gzip level 6) |

## Next steps (agreed order)

Done 2026-10-20: A2, S1 + S5, G1, G2, S2 + G3 (768px), S3b, A1, D1-D5, plus the medium code review of the cache and skip work (`dd642d0`).

Still open, roughly by value:
1. S3c: batch the reproject flush (executemany).
2. G4/G5: grid re-renders per scroll frame; `openTile` identity churn. Small.
3. S4 process pool, A5 ORT threads: unproven, low priority.
4. Tags browse is still 5-9 s cold at 30k (per-row work); profile if the Tags page feels slow.

Review findings left as is (`dd642d0` review):
- Stamp saved when some files failed in a rebuild scan. Decode and thumbnail-write failures already store `thumb_key = NULL`, so they are retried. Only a transient `stat` failure during the one rebuild scan keeps an old-size thumbnail: cosmetic.
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
- Where: `packages/frontend/src/pages/AllImagesPage.tsx:503-517`; `PAGE_LIMIT = 100` in `lib/imageFilter.ts:116`.
- Evidence: observer created with no `root`/`rootMargin`. Fast scroll waited 3-6 s of 8 s at page ends; with a 3000px margin, 0-3.3 s.
- Fix: `root: getScrollContainer()`, `rootMargin: "0px 0px 3000px 0px"` (root must be the scroll element, same trap as `useImageLoadSlot.ts`). Optionally PAGE_LIMIT 200.
- Repro: `scratchpad/gallery/scroll_bench.py` + `prototype.patch`, `start.sh`, `prod.sh`.

### G2. BlurHash decode cost
- Where: `packages/frontend/src/components/ImageThumbnail.tsx:10` (`BLUR_PX = 64`).
- Evidence: decode 10.3 ms @64px, 2.4 ms @32px, 0.47 ms @16px. Virtualized tiles remount constantly, each pays again.
- Fix: `BLUR_PX = 16` or `32`; optional small LRU keyed by hash.
- Repro: `scratchpad/gallery/bench-layout.mjs`.

### G3. Oversized thumbnails
- Where: thumb generation (`services/scanner.py`, `THUMB` size in `core/config.py:60`, 1080 max).
- Evidence: mean 73 KB, typ. 701x1024 webp; tiles ~250px (460 max) wide. Frame-time gain inferred.
- Fix: ~480-640px thumbs + regenerate. Keep >= 512 if A3 tags from thumbnails.
- Repro: `scratchpad/gallery/thumbdims.py`.

### G4. Grid re-renders every scroll frame
- Where: `packages/frontend/src/components/VirtualizedGrid.tsx:99-105`.
- Fix: only setState when first/last visible row changes. Inferred <1 ms/frame; low priority.

### G5. `openTile` re-created on each page append
- Where: `packages/frontend/src/pages/AllImagesPage.tsx:521-536`.
- Fix: read `items`/`filters` via ref. Inferred small.

## AI tagging

Per-image (832x1216 PNG, CPU): read via 9P ~50 ms, decode ~38, prep ~35, **ONNX ~1500 (90-95%)**,
select_tags 6-25, DB ~18. Real job queue: 0.59 img/s. CPU batching gives nothing.
Model lifecycle fine (load once, 300s idle unload). Face detect not on tagging path.

### A1. GPU inference (CUDA EP)
- Where: `packages/backend/src/services/ai_tagger.py:177` hardcodes `CPUExecutionProvider`.
- Evidence: CPU 890 ms/img vs CUDA 108 ms/img (bs1), 100 ms (bs8). Works on GTX 1650 / WSL2 with `onnxruntime-gpu==1.23.2` + `nvidia-*-cu12` pip wheels; `ort.preload_dlls()` required, otherwise silent CPU fallback.
- Setup detail: system CUDA toolkit is 13, which ORT 1.23 can't use; the CUDA 12 libs come from pip: `nvidia-cudnn-cu12 nvidia-cublas-cu12 nvidia-cuda-runtime-cu12 nvidia-cufft-cu12 nvidia-curand-cu12 nvidia-cuda-nvrtc-cu12`. Check `session.get_providers()` starts with `CUDAExecutionProvider`. A `/sys/class/drm/card0/device/vendor` warning is harmless. TensorRT EP listed but untried.
- Cost: ~2 GB of wheels; conflicts with `onnxruntime`, so an optional extra (`uv sync --extra gpu`); CPU fallback; 4 GB VRAM shared with Windows, one session only.
- Repro: `scratchpad/ai/gpuvenv/bin/python scratchpad/ai/gpu_bench.py CUDAExecutionProvider,CPUExecutionProvider 1,4,8 5`.

### A2. Inference blocks the event loop
- Where: `packages/backend/src/services/ai_tagger.py:397` `predict_bytes` (sync `Image.open` + `predict` inside `async def`); `ai_jobs.py` `_tag_one`.
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
- Where: `packages/backend/src/services/scanner.py:458-470` (walk, then every file submitted to `_process_image`); `library_watch.py:133-153` (reconcile every `watch_reconcile_interval_s` = 900s); post-scan `reproject_library_async` (`scanner.py:~621`).
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

Prototype: WIP commit `3586e3c` on branch `worktree-agent-a138fde68c184719a` (not for merge; marked `# PROTOTYPE`).
**Measured 2026-10-20** by one agent alone: baseline = main (backend identical to `db648fd`) vs prototype.
- Datasets: backup-API copy of the real DB (3,881 images, 150k image_tags, 150k gen_terms), and a 30k synthetic DB (rows cloned from the real one; 1.1M image_tags, 1.2M gen_terms; 18 planted rare tags/terms of known size).
- Method: real uvicorn on ports 8810/8811 with httpx, 30 runs after 3 warmups. A direct-call bench (no HTTP) separated query cost from serialization. A 4-way matrix (code x indexes) attributed D3.
- Noise: p50 swings of 10-15% and 1-3 ms run to run; differences below that are treated as noise.
- Correctness: ids, order and cursors are identical on every compared feed, ids and groups query, and tags/browse JSON is identical, except the characters cache (D5).
- Prototype pytest: 4 failures. 3 are real (characters cache); 1 is expected (`test_schema` lists the old index names).
- Scripts (DB copies deleted; rebuild with `copy_real.py` / `build_synth.py`): `.claude/worktrees/agent-a8a9ade2ecacaaf3f/perf-scratch/`, untracked.
  - `run.sh` runs the HTTP bench, `drun.sh` the direct bench, `cmp4.py` the 4-way matrix, `srun.sh` the D1 sweep, `prun.sh` the query plans.
  - Copy `*_base.db` to a fresh file before each prototype run, so index state is clean.

### D1. Drive rare filters by id list: keep, lower the threshold
- Where: `services/image_feed.py` `_resolved` / `feed_where`.
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
