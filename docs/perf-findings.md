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
| G1 | Gallery | Next page fetched only when sentinel is on screen | Removes multi-second stalls on fast scroll | S | verified (code) |
| G2 | Gallery | BlurHash decoded at 64x64 on main thread, every mount | 4-20x less decode CPU | S | verified (code) |
| G3 | Gallery | Thumbnails ~700x1024 vs ~250px displayed | 2-4x smaller downloads + decode | M | open |
| G4 | Gallery | Grid setState every scroll frame | Small | S | open |
| G5 | Gallery | `openTile` identity changes per page append | Small | S | open |
| A1 | AI tagging | CPU-only ONNX; CUDA works on GTX 1650 | ~9x inference | M | open |
| A2 | AI tagging | Decode + inference run on the event loop | API p50 during job 1.2-1.5s -> 12ms | S-M | done (branch `perf/a2-ai-offload`, unmerged) |
| A3 | AI tagging | Tag from local thumbnail instead of original on /mnt/g | ~45 ms/img, no 9P reads | S | open |
| A4 | AI tagging | Pad-then-resize prep + Python `select_tags` loop | ~45 ms/img (matters only with A1) | S | open |
| A5 | AI tagging | ORT `intra_op_num_threads` untuned | Unclear (contention artifact?) | S | open |
| S1 | Scan | Rescan re-processes every unchanged file; 15-min reconcile triggers it per watched library, plus full reproject | Unchanged rescan 6.8s -> 0.16s / 297 imgs (~40x) | S | verified (code) |
| S2 | Scan | Thumbs 1080px webp; 640px enough | Scan ~1.7-2x faster, thumbs ~45% smaller | S (+ regen) | open |
| S3 | Prompt extraction | Reproject reruns needlessly; `parse_prompt` ~22 calls/img uncached | Gate on change (S1); lru_cache ~25% of reproject | S | open |
| S4 | Scan | Thread pool + GIL bound past ~4 workers; process pool | Maybe 1.3-2x, unproven | M | open |
| S5 | Scan | Serial walk + stat over 9P (~7 ms/file) | Needed once S1 lands: 10k stats 70s -> ~10s | S | open |
| D1 | API / DB | Rare tag/term filter walks all images in sort order, probing EXISTS per row | Unmeasured | S-M | prototype |
| D2 | API / DB | Cursor row-value compare can't seek the sort index; deep pages O(depth) | Unmeasured | S | prototype |
| D3 | API / DB | `image_tags` indexes not covering `(tag, image_id)` / `(base, image_id)` | Unmeasured | S | prototype |
| D4 | API / DB | Tags `browse` covers via window fn sorting every image_tags row | Unmeasured | S | prototype |
| D5 | API / DB | Characters listing uncached; `jsonable_encoder` on big lists; gzip on media | Unmeasured | S | prototype |

## Next steps (agreed order)

1. Merge A2 (`perf/a2-ai-offload`, `109314c`; tests green, 416 passed).
2. S1 + S5 (skip unchanged on rescan, stat in a pool), with a thumb-settings version stamp.
3. G1 (sentinel prefetch margin) and G2 (`BLUR_PX` 16/32). One-liners, high visibility.
4. S2 + G3 together (640px thumbs + `method` setting), regenerated via S1's version stamp. Check visual quality.
5. S3b (`lru_cache` on `parse_prompt`).
6. A1 (GPU) as an optional `gpu` extra, then A3/A4 on top of it.
7. Re-measure D1-D5 from the WIP prototype, one agent alone, ~30k-row synthetic DB.

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

### A4. Cheaper prep + vectorized select_tags
- Where: `ai_tagger.py` `_prepare_image` (~175-190), `select_tags` (~90-125).
- Fix: resize before pad; numpy masks over 10,861 labels. Re-check tag equivalence. Only worth it with A1.

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

The agent was synthesizing a ~90k-image DB when WSL ran out of memory; its report and numbers are lost.
Its prototype edits survived and are saved as WIP commit `3586e3c` on branch
`worktree-agent-a138fde68c184719a` (not for merge; marked `# PROTOTYPE`). All D findings are
**inferred from the prototype, not measured**: re-measure before choosing (smaller synthetic DB, ~30k rows).

### D1. Drive rare filters by id list
- Where: `services/image_feed.py` `_resolved` / `feed_where`.
- Idea: when the rarest tag group or prompt term matches <= 3000 images, fetch their ids first and filter `_id IN (...)`, instead of SQLite walking `images` in sort order with an EXISTS probe per row.

### D2. Keyset paging seek
- Where: `services/image_feed.py` `list_feed` cursor clause.
- Idea: SQLite won't seek an expression index from a row-value `<` comparison. Add a redundant `key <= v` (desc) / `key >= v` range on the leading sort key so deep pages seek.

### D3. Covering indexes
- Where: `database/schema.py`.
- Idea: replace `ix_image_tags_tag` / `ix_image_tags_base` with `(tag, image_id)` / `(base, image_id)`; add `ix_images_cover (_id, mtime, quarantined)`. Old names go to `RETIRED_INDEXES`.

### D4. Tags browse covers in one grouped pass
- Where: `services/tag_index.py` `browse` (~378).
- Idea: replace `row_number() OVER (PARTITION BY base ...)` with `GROUP BY base` + `min(key)` (SQLite bare-column rule).

### D5. Small API overheads
- Characters `listing()` (`services/characters.py:181`) uncached: cache it via tag_index TTL + generation.
- Large list routes (`/images`, `/images/ids`, `/tags`, `/tags/browse`) return dicts through `jsonable_encoder`: return `JSONResponse` directly.
- `GZipMiddleware` (`main.py`) also compresses image/video responses: exclude them, `compresslevel=5`.
- `find_image` ignores its projection (`services/image_tags.py:~303`): select only the requested columns.
