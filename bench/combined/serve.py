"""Combined-load bench launcher: a Moire backend (lifespan on) on a bench DB copy,
with the scan bench's and the AI bench's instrumentation merged, plus write-path
instrumentation done by monkeypatching from this process (no source edits):

  - db._async_write_lock / db._sync_write_lock swapped for timed wrappers:
    per side, Python-lock wait and hold time (tx body + commit), by thread name
  - engine events on both engines: write-statement latency (INSERT/UPDATE/DELETE,
    which is where SQLite's busy_timeout wait happens in WAL), commit latency,
    every DBAPI error (counts 'database is locked' / busy)
  - scan_writer.retry wrapped: counts retried scanner writes
  - an RSS/CPU/WAL sampler thread, 1 s, from process start -> results/rss-<port>.csv
  - env BENCH_JSL=<bytes>: PRAGMA journal_size_limit on every new connection

usage: serve.py <db> <thumbs> <port>     (ports 8850-8859; lifespan always on)
Bench-only routes:
  GET  /__bench/stats    invalidations, view builds, RSS, CPU, WAL, state, tx counters
  GET  /__bench/tx       full write-path samples
  GET  /__bench/ai       AI per-image stage log (load, tag_one, write, face)
  POST /__bench/faces?n= queue the newest n images for face detection
  POST /__bench/reproject?force=1   reproject_all in a thread
The DB must have been through data/make_safe.py.
"""

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

# Spawned helper processes (reprojection's derive worker) import this
# script as their main module: only a direct run does the bench.
if __name__ == "__main__":
    db, thumbs, port = (
        Path(sys.argv[1]).resolve(),
        Path(sys.argv[2]).resolve(),
        int(sys.argv[3]),
    )
    assert 8850 <= port <= 8859, "combined bench ports 8850-8859 only"
    benv.setup(db, thumbs)
    T_BOOT = time.time()
    RSS_OUT = benv.BENCH / "results" / f"rss-{port}.csv"

    def _sampler():
        wal = Path(f"{db}-wal")
        with open(RSS_OUT, "w") as f:
            f.write("t,rss_MB,cpu_s,wal_MB,threads\n")
            while True:
                rss, _ = benv.proc_mem()
                w = wal.stat().st_size / 1e6 if wal.exists() else 0
                f.write(
                    f"{time.time():.2f},{rss},{benv.proc_cpu():.2f},{w:.1f},{threading.active_count()}\n"
                )
                f.flush()
                time.sleep(1.0)

    threading.Thread(target=_sampler, daemon=True, name="bench-rss").start()

    from moire.database.db import ensure_schema_sync  # noqa: E402

    ensure_schema_sync()

    import uvicorn  # noqa: E402
    from sqlalchemy import event  # noqa: E402

    from moire.database import db as dbm  # noqa: E402
    from moire.main import app  # noqa: E402
    from moire.services.tags import index as tag_index  # noqa: E402
    from moire.services.tags import image_tags  # noqa: E402
    from moire.services.ai import jobs as ai_jobs  # noqa: E402
    from moire.services.ai import face_detect  # noqa: E402
    from moire.services.library import scanner  # noqa: E402
    from moire.services.metadata import reproject  # noqa: E402

    # ---- tag view counters --------------------------------------------------------
    STATS = {
        "invalidate": 0,
        "invalidate_soft": 0,
        "builds": {},
        "build_s": 0.0,
        "build_log": [],
    }
    _oi, _ois, _oc = tag_index.invalidate, tag_index.invalidate_soft, tag_index.cached

    def _inv(*a, **kw):
        STATS["invalidate"] += 1
        _oi(*a, **kw)

    def _invs(*a, **kw):
        STATS["invalidate_soft"] += 1
        _ois(*a, **kw)

    async def _cached(name, key, build, *args, **kw):
        async def counted():
            t0 = time.perf_counter()
            w0 = time.time()
            try:
                return await build()
            finally:
                dt = time.perf_counter() - t0
                STATS["builds"][name] = STATS["builds"].get(name, 0) + 1
                STATS["build_s"] += dt
                STATS["build_log"].append((w0, name, round(dt * 1000, 1)))

        return await _oc(name, key, counted, *args, **kw)

    tag_index.invalidate, tag_index.invalidate_soft, tag_index.cached = (
        _inv,
        _invs,
        _cached,
    )
    reproject.tag_index.invalidate = _inv  # bound by module attribute there too

    # ---- write-path instrumentation -------------------------------------------------
    # Each sample: (wall time, side, thread, value_ms)
    TX = {
        "lock_wait": [],
        "lock_hold": [],
        "write_stmt": [],
        "commit": [],
        "errors": [],
        "retries": [],
    }

    def _thread():
        n = threading.current_thread().name
        for p in ("reproject", "scan", "ThreadPool", "face", "bench"):
            if n.startswith(p):
                return p
        return n[:24]

    class TimedLock:
        def __init__(self, inner):
            self.inner = inner
            self.t_acq = 0.0

        def __enter__(self):
            t0 = time.perf_counter()
            self.inner.acquire()
            self.t_acq = time.perf_counter()
            TX["lock_wait"].append(
                (time.time(), "sync", _thread(), (self.t_acq - t0) * 1000)
            )
            return self

        def __exit__(self, *exc):
            hold = (time.perf_counter() - self.t_acq) * 1000
            TX["lock_hold"].append((time.time(), "sync", _thread(), hold))
            self.inner.release()
            return False

        def locked(self):
            return self.inner.locked()

    class TimedALock:
        def __init__(self):
            self.inner = asyncio.Lock()
            self.t_acq = 0.0

        async def __aenter__(self):
            t0 = time.perf_counter()
            await self.inner.acquire()
            self.t_acq = time.perf_counter()
            TX["lock_wait"].append(
                (time.time(), "async", _task(), (self.t_acq - t0) * 1000)
            )
            return self

        async def __aexit__(self, *exc):
            hold = (time.perf_counter() - self.t_acq) * 1000
            TX["lock_hold"].append((time.time(), "async", _task(), hold))
            self.inner.release()
            return False

    def _task():
        try:
            tk = asyncio.current_task()
            n = tk.get_name() if tk else "?"
        except RuntimeError:
            n = "?"
        return "request" if n.startswith("Task-") else n[:24]

    dbm._sync_write_lock = TimedLock(dbm._sync_write_lock)
    dbm._async_write_lock = TimedALock()

    JSL = os.environ.get("BENCH_JSL")

    def _instrument(engine, side):
        if JSL:

            @event.listens_for(engine, "connect")
            def _jsl(dbapi_conn, _rec):
                cur = dbapi_conn.cursor()
                cur.execute(f"PRAGMA journal_size_limit={int(JSL)}")
                cur.close()

        @event.listens_for(engine, "before_cursor_execute")
        def _b(conn, cursor, statement, params, context, executemany):
            conn.info["_bt0"] = time.perf_counter()

        @event.listens_for(engine, "after_cursor_execute")
        def _a(conn, cursor, statement, params, context, executemany):
            s = statement.lstrip()[:7].upper()
            if s.startswith(("INSERT", "UPDATE", "DELETE", "REPLACE")):
                dt = (
                    time.perf_counter() - conn.info.get("_bt0", time.perf_counter())
                ) * 1000
                TX["write_stmt"].append(
                    (time.time(), side, _thread() if side == "sync" else "async", dt)
                )

        @event.listens_for(engine, "handle_error")
        def _e(ctx):
            TX["errors"].append(
                (time.time(), side, _thread(), repr(ctx.original_exception)[:200])
            )

    _instrument(dbm.get_async_engine().sync_engine, "async")
    _instrument(dbm.get_sync_engine(), "sync")

    # commit latency (includes WAL auto-checkpoints run at commit)
    try:
        from sqlalchemy.engine import Connection as _SAConn

        _o_do_commit = _SAConn._commit_impl

        def _commit_impl(self, *a, **kw):
            t0 = time.perf_counter()
            try:
                return _o_do_commit(self, *a, **kw)
            finally:
                side = "async" if "aiosqlite" in self.engine.dialect.driver else "sync"
                TX["commit"].append(
                    (
                        time.time(),
                        side,
                        _thread() if side == "sync" else "async",
                        (time.perf_counter() - t0) * 1000,
                    )
                )

        _SAConn._commit_impl = _commit_impl
    except Exception as e:  # noqa: BLE001
        print("commit instrumentation unavailable:", e, file=sys.stderr)

    from moire.services.library import scan_writer  # noqa: E402

    _o_retry = scan_writer.retry

    def _retry(fn, *args, **kw):
        calls = [0]

        def counted(*a2, **k2):
            calls[0] += 1
            if calls[0] > 1:
                TX["retries"].append((time.time(), "sync", _thread(), calls[0]))
            return fn(*a2, **k2)

        return _o_retry(counted, *args, **kw)

    from moire.services.library import scan_reconcile  # noqa: E402

    scan_writer.retry = scanner.retry = scan_reconcile.retry = _retry

    # ---- AI pipeline instrumentation (subset of ai/serve.py) ---------------
    AI = {"load": [], "tag_one": [], "write": [], "face": [], "model_load": []}
    _o_load = ai_jobs.AIJobManager._load_image

    async def _load_image(self, image_id):
        t0 = time.time()
        try:
            return await _o_load(self, image_id)
        finally:
            AI["load"].append((t0, time.time() - t0))

    ai_jobs.AIJobManager._load_image = _load_image
    _o_tag_one = ai_jobs.AIJobManager._tag_one

    async def _tag_one(self, **kw):
        t0 = time.time()
        try:
            return await _o_tag_one(self, **kw)
        finally:
            AI["tag_one"].append((t0, time.time() - t0))

    ai_jobs.AIJobManager._tag_one = _tag_one
    _o_replace = image_tags.replace_ai

    async def _replace_ai(image_id, *, ai_tags, **kw):
        t0 = time.time()
        try:
            return await _o_replace(image_id, ai_tags=ai_tags, **kw)
        finally:
            AI["write"].append((t0, time.time() - t0))

    image_tags.replace_ai = _replace_ai
    _o_detect = face_detect.detect

    def _detect(path, cache_dir):
        t0 = time.time()
        try:
            return _o_detect(path, cache_dir)
        finally:
            AI["face"].append((t0, time.time() - t0))

    face_detect.detect = _detect

    def _state():
        from moire.services.ai.face_worker import get_face_worker
        from moire.services.ai.tagger import get_tagger_manager

        jm = ai_jobs.get_ai_job_manager()
        active = [
            j
            for j in jm._jobs.values()
            if j.status in ("queued", "running", "cancelling")
        ]
        try:
            loaded = get_tagger_manager().status().get("loaded")
        except Exception:  # noqa: BLE001
            loaded = None
        return {
            "scanning": scanner.any_scanning(),
            "reproject": reproject.busy(),
            "ai_active": len(active),
            "ai_done": sum(j.done for j in jm._jobs.values()),
            "faces_pending": get_face_worker().pending,
            "faces_done": len(AI["face"]),
            "model_loaded": loaded,
        }

    def _count(k, side=None):
        return sum(1 for x in TX[k] if side is None or x[1] == side)

    @app.get("/__bench/stats")
    async def _bench_stats():
        rss, hwm = benv.proc_mem()
        wal = Path(f"{db}-wal")
        return {
            **{k: v for k, v in STATS.items() if k != "build_log"},
            "rss_MB": rss,
            "hwm_MB": hwm,
            "cpu_s": benv.proc_cpu(),
            "wal_MB": round(wal.stat().st_size / 1e6, 2) if wal.exists() else 0,
            "threads": threading.active_count(),
            "now": time.time(),
            "state": _state(),
            "tx_errors": len(TX["errors"]),
            "tx_retries": len(TX["retries"]),
        }

    @app.get("/__bench/tx")
    async def _bench_tx():
        return {**TX, "build_log": STATS["build_log"], "ai": AI, "boot": T_BOOT}

    @app.get("/__bench/ai")
    async def _bench_ai():
        return {**AI, "now": time.time()}

    @app.post("/__bench/faces")
    async def _bench_faces(n: int = 300):
        import sqlalchemy as sa
        from moire.database.db import async_conn
        from moire.database import schema as t
        from moire.services.ai.face_worker import get_face_worker

        async with async_conn() as conn:
            ids = [
                r[0]
                for r in (
                    await conn.execute(
                        sa.select(t.images.c._id)
                        .order_by(t.images.c.mtime.desc())
                        .limit(n)
                    )
                ).fetchall()
            ]
        await get_face_worker().queue(ids)
        return {"queued": len(ids), "pending": get_face_worker().pending}

    @app.post("/__bench/reproject")
    async def _bench_reproject(force: int = 0):
        def run():
            t0 = time.perf_counter()
            n = reproject.reproject_all(force=bool(force))
            STATS["last_reproject"] = {"n": n, "s": round(time.perf_counter() - t0, 2)}

        threading.Thread(target=run, name="bench-reproject", daemon=True).start()
        return {"started": True}

    for _ in range(6):
        app.router.routes.insert(0, app.router.routes.pop())

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        lifespan="on",
        log_level="warning",
        access_log=False,
    )
