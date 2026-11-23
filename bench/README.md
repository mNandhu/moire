# Benchmarks

Scripts that measure Moiré's performance:
- the API and database
- the frontend in a real browser
- scanning and reprojection
- AI tagging and face detection
- all of the writers running at once

They only measure and change no app code. Findings and numbers are in `docs/dev/perf-benchmark-2026-11.md` (latest round) and `docs/dev/perf-findings.md` (Oct 2026).

These are developer tools, not part of the app or of CI. They assume Linux with:
- `/proc`
- `systemd-run --user`, for memory-capped runs
- the backend venv (`uv --directory packages/backend sync`)
- for the web suite: Playwright from `packages/e2e`
- for the AI suite: an NVIDIA GPU and `nvidia-smi`

## Safety rules

Every script follows these rules. Keep to them when you add one.

- **Never touch the live `data/` folder.** Benchmarks run on copies under the scratch root. `benvcore.guard` refuses any DB or thumbnail path outside it.
- **Make every copied DB safe before a backend boots on it** (`data/make_safe.py`). A copy carries your ComfyUI settings, and a backend with its lifespan on would talk to that server. make_safe:
  - points ComfyUI at `127.0.0.1:1`
  - cancels queued generations
  - turns off watchers, face detection and auto-tag

  Each run then turns back on only what it tests.
- **Keep scratch on a real disk.** If `/tmp` is tmpfs, disk timings there mean nothing.
- **Source image folders are read-only.** Tests that add, change or delete files work on copies (`$BENCH_WORK/scan/lib`).
- **Ports:** api 8810-8819, web 8820-8829, scan 8830-8839, ai 8840-8849, combined 8850-8859. They stay clear of `pnpm dev` (8000/5173).
  - Stop servers by PID (the `start.sh` scripts print it).
  - Don't use `pkill -f`: it matches the calling shell.
- **Heavy runs go in a memory-capped scope** (`capped` in `env.sh`, 6 GB by default via `BENCH_MEM`).
  - Don't run two heavy suites at once unless you mean to measure that.
  - Record the load average; trust ratios within one run over absolute numbers.

## Layout

| path | what |
|------|------|
| `env.sh` | Sourced by the shell scripts: `REPO`, `PY` (backend venv python), `BENCH_WORK`, `B` (the suite's scratch dir), `S` (its script dir), `capped` |
| `benvcore.py` | Python side: scratch paths, `setup()` (points `SQLITE_PATH`, `THUMB_ROOT` and the env file at scratch, before `moire` is imported), `guard`, page-cache `evict`, `/proc` CPU and RSS |
| `<suite>/benv.py` | `benvcore` with `BENCH` set to `$BENCH_WORK/<suite>` |
| `data/` | Dataset prep: `snapshot.py` (backup-API copy, WAL-safe), `make_safe.py`, `make_synth.py` (30k synthetic DB), `clone_raw.py` (gen-raw rows for the synthetic clones) |
| `api/` | HTTP and direct-call benchmarks of the API/DB layer |
| `web/` | Browser benchmarks (Playwright, CDP traces) |
| `scan/` | First scan, rescans, watcher ingest, reprojection, read latency under writes |
| `ai/` | Tagger stages, full AI jobs, face detection, auto-tag, re-tag |
| `combined/` | Several writers at once, the write-lock timeline, memory over time |

Scratch and results go to `$BENCH_WORK/<suite>/` (default `local-setup/bench/<suite>/`, gitignored). Each suite writes `results/*.json`, and the web suite writes `out/*.json`.

## Datasets

Run these from the repo root. `W` is the scratch root.

```bash
W=local-setup/bench; PY=packages/backend/.venv/bin/python

# "real": a snapshot of your library, made safe
mkdir -p $W/real
$PY bench/data/snapshot.py data/moire.db $W/real/moire.db
cp -r data/thumbs $W/real/thumbs
$PY bench/data/make_safe.py $W/real/moire.db

# "syn": ~30k images cloned from it (new ids, shifted mtimes, hardlinked thumbs, planted tags)
mkdir -p $W/api
cp -al $W/real $W/api/real    # or copy each suite's own; servers write to their DB
$PY bench/data/make_synth.py $W/real/moire.db $W/real/thumbs $W/api/syn/moire.db $W/api/syn/thumbs 30000
```

- **Planted tags** in `syn`: `bench_r30`, `bench_r299`, `bench_r301` and `bench_r3000`. Each is planted as an AI tag, a `prompt:` tag and a prompt term (`benchterm_r…`) on exactly that many images, so filter selectivity is known.
- **Gen-raw rows:** `make_synth.py` does not clone them. Run `data/clone_raw.py <db>` on a copy before benchmarking reprojection at 30k.
- **Each suite expects its copies at:**
  - **api:** `$W/api/{real,syn}/{moire.db,thumbs}`
  - **web:** `$W/web/{moire.db,thumbs}`
  - **scan:** `$W/scan/db/{real,syn}.db`
  - **ai:** `$W/ai/db/real.base.db`, `$W/ai/db/syn.base.db` and `$W/ai/db/syn-thumbs`, plus `$W/ai/db/thumbs` for the real base
  - **combined:** reuses `$W/ai/db/syn.base.db` and `$W/scan/lib`

  Always copy with `snapshot.py`, then run `make_safe.py`.
- **Tag names in `api/bench_http.py`:** the `FIX` tables pick mid and dense tags for a typical SD prompt library (`prompt:absurdres`, `prompt:masterpiece`). Edit them for yours; `api/direct.py` picks mid/dense by count itself.

## Suites

### api: API / DB

```bash
pid=$(bench/api/start.sh syn 8811)              # lifespan off; add --lifespan to boot fully
$PY bench/api/bench_http.py 8811 syn feed       # suites: feed tags misc media sens
bench/api/stop.sh $pid
$PY bench/api/direct.py syn browse:all --runs 5 --explain --profile
```

- **`serve.py`** loads the sensitivity state without the lifespan and adds `POST /__bench/invalidate`, which drops the tag view cache for "cold" runs.
- **`bench_http.py`** runs 3 warmups then 30 timed runs, p50/p95, cold and warm.
- **`direct.py`** captures the app's real SQL for a case, replays it with stdlib sqlite3 (SQL-only cost), runs EXPLAIN QUERY PLAN, and optionally profiles. Its cases are the `if c == ...` branches in `case_fn` (`browse:<source>`, `tags:<all|ai|merged>`, `characters`, `character`, `detail:<dense|mid>`, `merge`, `groups`, `feed:…`, `ids:…`, `samples`, …).
- **Other scripts:**
  - `startup_steps.py <dataset dir>` times each startup step.
  - `onepass_browse.py <dataset dir>` is the N2 browse prototype, checked row for row against the current code.
  - `drive_forms.py <syn db>` compares filter query shapes (N14).

### web: browser

```bash
pnpm -C packages/frontend build                  # the backend serves the built UI
bench/web/serve.sh 8820                          # DB/thumbs from $W/web; prints the PID
node bench/web/web-bench.cjs boot 7              # scenarios: boot scroll viewer pages typing coverage
node bench/web/web-bench.cjs scroll 5 speed=15000 device=phone
kill $(cat local-setup/bench/web/server-8820.pid)
```

- **`web-bench.cjs` options:**

  | option | does |
  |---|---|
  | `device=phone` | Pixel 7 viewport |
  | `warm=1` | warm browser cache |
  | `net=wan` | 40 ms RTT, 50/20 Mbps |
  | `cpu=4` | CPU throttling |
  | `gpu=0` | SwiftShader |
  | `react=1` | commit timings; needs the profiling build |
  | `nosib=1\|replace` | delete or rewrite the Tailwind sibling rules (N1) |
  | `nofade=1`, `fade=img\|anim` | turn off the fades (N10) |
  | `thumb=small\|route` | thumbnail size variants |
  | `pages=/a,/b` | page list; the default adds the most-used character's page |

- **Variant builds:**
  - `node bench/web/build-variant.mjs prof` (unminified, React profiling) or `rrprod`, served with `WEBDIR=$W/web/build-prof bench/web/serve.sh 8821`.
  - `bundle-stats.mjs` sizes each module per chunk.
- **Probes:**
  - `trace-scroll.cjs` (style recalc and invalidation tracking; `NOSIB`, `INVAL=1`)
  - `tile-pipeline.cjs` (tile mount → src → load)
  - `viewer-hops.cjs`
  - `decode-probe.cjs`
  - `cpuprofile.cjs` (against the profiling build)
- **Thumbnail throughput:** `make_urls.py` writes the URL lists, then `thumb_load.py PORT URLFILE N CONC`.
- **Batches:** `run-all.sh`, `run-extra.sh`, `run-nosib.sh` and `run-final.sh` are the passes behind the Nov 2026 report. They expect servers on 8820 (shipped), 8821 (prof) and 8822 (rrprod).

### scan: scanning, reprojection, writes vs reads

```bash
BENCH_LIBS="/path/to/folderA /path/to/folderB" bench/scan/run_first_scans.sh   # cold/warm, worker sweep
bench/scan/run_rescans.sh            # unchanged / touched / modified / deleted 10% (on a copy)
bench/scan/run_reproject.sh          # no-change / forced / settings flip, real and 30k
WATCH_ENABLED_DEFAULT=false bench/scan/start.sh $PWD/$W/scan/work/syn/s.db $PWD/$W/scan/work/syn/thumbs 8831 --lifespan
bench/scan/run_concurrency.sh 8831   # reads at 10 req/s + /health every 50 ms: idle, scan, reprojections
```

- **`BENCH_LIBS` folders are only read.** `run_first_scans.sh` copies each one to `$W/scan/lib/<name>` once, and the tests that change files use those copies.
- **`stages.py <folder> N`** times each per-image stage on one thread (`--cprofile` for a profile).
- **`serve.py`** adds `/__bench/stats` (invalidations, view rebuilds, RSS, WAL size) and `/__bench/reproject`.
- **Other scripts:**
  - `watch_ingest.py` (watched-folder bursts)
  - `trigger.py` (settings save → reprojection)
  - `small_thumb.py`
  - `delete_writer.py`
  - `summ_conc.py` (prints concurrency results)

### ai: tagging and face detection

Run anything that loads onnxruntime through `node scripts/uv-backend.mjs run python <absolute path>`, or the venv python directly. A plain `uv run` swaps the GPU onnxruntime for the CPU one.

```bash
node scripts/uv-backend.mjs run python $PWD/bench/ai/tagger_bench.py $PWD/$W/ai/db/real.base.db 200 cuda --batches 1,2,4,8 --evict
bench/ai/run_job.sh real-1000 $W/ai/db/real.base.db 8840 --limit 1000 --idle 20 --tail 10
bench/ai/run_job.sh faces300 $W/ai/db/real.faces.base.db 8840 --action faces --limit 300   # a copy with face_detect on
```

- **`run_job.sh`** gives each run a fresh DB copy, evicts the originals from the page cache, starts a lifespan-on server, samples the GPU (`gpumon.sh`), runs `job_bench.py`, then stops everything.
- **`serve.py`** adds:
  - `/__bench/ai`: per-image stage timings, the commit log and the view-build log
  - `/__bench/faces?n=`: queues images for face detection
  - `/__bench/reset`
- **Models:** the copied DB's `ai.cache_dir` setting still points at your model cache, which is only read. If the face model is missing, the face runs download it there.
- **Other scripts:**
  - `idle_unload.py`
  - `retag.py` (single re-tag, also during a bulk job)
  - `autotag.py` (auto-tag on ingest)
  - `face_spin.py` (face-detector thread and spin settings; reads the face model from `$W/ai/models/…`, or `FACE_MODEL`)

### combined: writers at once

```bash
bench/combined/run.sh c-solo-ai   8850 --actions tag:600 --idle 30
bench/combined/run.sh c-scan-ai   8850 --actions tag:600,scan --idle 30
bench/combined/run.sh c-ai-reproj 8850 --actions tag:600,reproject --idle 30
bench/combined/run.sh c-all       8851 --actions tag:600,scan,faces:600 --idle 30
bench/combined/run.sh c-memory    8852 --seq --actions scan,tag:600 --idle 60 --tail 120 --idle-unload 60
BENCH_JSL=67108864 bench/combined/run.sh c-jsl64 8853 --actions tag:600,scan --idle 30
$PY bench/combined/table.py c-solo-ai c-scan-ai
```

- **`run.sh`** builds a fresh safe copy (`prep.sh`), starts `serve.py`, runs `combo.py` and stops the server.
- **`serve.py`** monkeypatches the write path from the bench process, without editing the source:
  - write-lock wait and hold time
  - write-statement and commit time
  - DBAPI errors
  - scanner retries
  - RSS, CPU and WAL every second
- **`BENCH_JSL`** sets `PRAGMA journal_size_limit`.
- **`combo.py`** labels every request with the writers active at the time and reports each window separately.

## Adding a benchmark

- Put it in the suite it measures, import that suite's `benv` before `moire`, and write results under `benv.BENCH / "results"`.
- Start servers with the suite's port range.
- Give the script a docstring or header comment with its usage line.
- Lint Python with the backend's ruff config: `packages/backend/.venv/bin/ruff check --config packages/backend/pyproject.toml bench`.
