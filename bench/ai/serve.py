"""AI bench launcher: a Moire backend on a bench DB copy, with the AI job
pipeline instrumented.

usage: serve.py <db> <thumbs> <port> [--lifespan]

Env as scan/serve.py (empty env file, no file log, no update check),
ports 8840-8849 only. The DB must have been through data/make_safe.py.
Bench-only routes:
  GET  /__bench/stats   tag_index invalidations / view builds, RSS, CPU s, WAL size
  GET  /__bench/ai      per-image stage timings of AI jobs + commit log
  POST /__bench/reset   clear the AI stage log
"""

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
    with_lifespan = "--lifespan" in sys.argv
    assert 8840 <= port <= 8849, "ai bench ports 8840-8849 only"
    benv.setup(db, thumbs)

    from moire.database.db import ensure_schema_sync  # noqa: E402

    ensure_schema_sync()

    import uvicorn  # noqa: E402

    from moire.main import app  # noqa: E402
    from moire.services.tags import index as tag_index  # noqa: E402
    from moire.services.tags import image_tags  # noqa: E402
    from moire.services.ai import jobs as ai_jobs  # noqa: E402
    from moire.services.ai import tagger as ai_tagger  # noqa: E402
    from moire.services.ai import face_detect  # noqa: E402

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
                STATS["build_log"].append((w0, name, str(key)[:60], round(dt * 1000, 1)))

        return await _oc(name, key, counted, *args, **kw)


    tag_index.invalidate, tag_index.invalidate_soft, tag_index.cached = _inv, _invs, _cached

    # ---- AI pipeline instrumentation -------------------------------------------
    AI = {
        "load": [],
        "tag_one": [],
        "predict_thread": [],
        "session_run": [],
        "write": [],
        "commits": [],
        "face": [],
        "model_load": [],
    }
    _pairs = [0]


    _o_load = ai_jobs.AIJobManager._load_image


    async def _load_image(self, image_id):
        t0 = time.time()
        try:
            return await _o_load(self, image_id)
        finally:
            AI["load"].append((t0, time.time() - t0))


    ai_jobs.AIJobManager._load_image = _load_image

    # "tag_one": one image's inference step (its DB write runs behind it,
    # timed as "write" below).
    _o_infer_one = ai_jobs.AIJobManager._infer_one


    async def _infer_one(self, **kw):
        t0 = time.time()
        try:
            return await _o_infer_one(self, **kw)
        finally:
            AI["tag_one"].append((t0, time.time() - t0))


    ai_jobs.AIJobManager._infer_one = _infer_one

    _o_predict = ai_tagger.WDTagger.predict


    def _predict(self, **kw):
        t0 = time.time()
        try:
            return _o_predict(self, **kw)
        finally:
            AI["predict_thread"].append((t0, time.time() - t0))


    ai_tagger.WDTagger.predict = _predict

    _o_load_model = ai_tagger.WDTagger.load


    async def _load_model(self, *a, **kw):
        t0 = time.time()
        try:
            return await _o_load_model(self, *a, **kw)
        finally:
            AI["model_load"].append((t0, time.time() - t0))


    ai_tagger.WDTagger.load = _load_model

    # Every AI tag write (the job's batches, and replace_ai) goes through
    # replace_ai_many: one "write" per transaction, one "commits" per image.
    _o_replace = image_tags.replace_ai_many


    async def _replace_ai_many(writes, **kw):
        t0 = time.time()
        await _o_replace(writes, **kw)
        t1 = time.time()
        AI["write"].append((t0, t1 - t0))
        for w in writes:
            _pairs[0] += len(w.ai_tags)
            AI["commits"].append((t1, _pairs[0], w.image_id))


    image_tags.replace_ai_many = _replace_ai_many

    _o_detect = face_detect.detect


    def _detect(path, cache_dir):
        t0 = time.time()
        try:
            return _o_detect(path, cache_dir)
        finally:
            AI["face"].append((t0, time.time() - t0))


    face_detect.detect = _detect


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
        }


    @app.get("/__bench/ai")
    async def _bench_ai():
        return {**AI, "build_log": STATS["build_log"], "now": time.time()}


    @app.post("/__bench/reset")
    async def _bench_reset():
        for v in AI.values():
            v.clear()
        STATS["build_log"].clear()
        return {"ok": True}


    @app.post("/__bench/faces")
    async def _bench_faces(n: int = 300):
        """Queue the newest n images for face detection (normally only avatars)."""
        import sqlalchemy as sa
        from moire.database.db import async_conn
        from moire.database import schema as t
        from moire.services.ai.face_worker import get_face_worker

        async with async_conn() as conn:
            ids = [
                r[0]
                for r in (
                    await conn.execute(
                        sa.select(t.images.c._id).order_by(t.images.c.mtime.desc()).limit(n)
                    )
                ).fetchall()
            ]
        await get_face_worker().queue(ids)
        return {"queued": len(ids), "pending": get_face_worker().pending}


    for _ in range(4):
        app.router.routes.insert(0, app.router.routes.pop())

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        lifespan="on" if with_lifespan else "off",
        log_level="warning",
        access_log=False,
    )
