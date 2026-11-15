"""Prototype check (bench only): one-pass browse aggregate vs browse._browse.

usage: onepass_browse.py <dataset_dir>
Builds a single GROUP BY over image_tags (base order via ix_image_tags_base_img)
joined to materialized visible images and per-base seeds (real seed_sql),
computing count(DISTINCT), max(mtime) and ONE min() of a packed integer
(rank * 2^20 + rowid, pin = -1 key) so no bare column is relied on; then maps
rowid -> _id. Times it and diffs (tag, count, last_used, cover) against the
current _browse('all').
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

BENCH = benv.BENCH
ds = Path(sys.argv[1]).resolve()
benv.setup(ds / "moire.db", ds / "thumbs")
import sqlalchemy as sa  # noqa: E402

from moire.database import schema as t  # noqa: E402
from moire.database.db import async_conn  # noqa: E402
from moire.services.images import visibility  # noqa: E402
from moire.services.tags import browse, covers  # noqa: E402

SHIFT = 1 << 20  # rowid < 2^20 here; rank < 2^32 -> packed < 2^52


def onepass():
    it, im, tm = t.image_tags, t.images, t.tag_meta
    vis = (
        sa.select(im.c._id, im.c.mtime, sa.literal_column("rowid").label("rid"))
        .where(visibility.visible())
        .cte("vis")
        .prefix_with("MATERIALIZED")
    )
    bases = sa.select(it.c.base).where(it.c.base != "").distinct().subquery()
    seeds = (
        sa.select(
            bases.c.base,
            covers.seed_sql(bases.c.base).label("seed"),
            tm.c.thumb_image_id.label("pin"),
        )
        .select_from(bases.outerjoin(tm, tm.c.tag == bases.c.base))
        .cte("seeds")
        .prefix_with("MATERIALIZED")
    )
    key = sa.case(
        (vis.c._id == seeds.c.pin, -1),
        else_=covers.shuffle_rank(vis.c.rid, seeds.c.seed),
    )
    packed = sa.func.min(key * SHIFT + vis.c.rid)
    agg = (
        sa.select(
            it.c.base,
            sa.func.count(sa.distinct(it.c.image_id)).label("count"),
            sa.func.max(vis.c.mtime).label("last_used"),
            packed.label("packed"),
        )
        .select_from(
            it.join(vis, vis.c._id == it.c.image_id).join(
                seeds, seeds.c.base == it.c.base
            )
        )
        .where(it.c.base != "")
        .group_by(it.c.base)
        .subquery()
    )
    cover_rid = agg.c.packed % SHIFT
    cover_rid = sa.case((agg.c.packed < 0, agg.c.packed + SHIFT), else_=cover_rid)
    return (
        sa.select(agg.c.base, agg.c.count, agg.c.last_used, im.c._id.label("cover"))
        .select_from(agg.join(im, sa.literal_column("images.rowid") == cover_rid))
        .order_by(agg.c.count.desc(), agg.c.base)
    )


async def main():
    stmt = onepass()
    times = []
    for _ in range(3):
        async with async_conn() as conn:
            t0 = time.perf_counter()
            rows = (await conn.execute(stmt)).fetchall()
            times.append((time.perf_counter() - t0) * 1000)
    old_t = []
    for _ in range(2):
        t0 = time.perf_counter()
        old = await browse._browse("all")
        old_t.append((time.perf_counter() - t0) * 1000)
    new = {r.base: (r.count, r.last_used, r.cover) for r in rows}
    ref = {r["tag"]: (r["count"], r["last_used"], r["thumb_image_id"]) for r in old}
    diff = [k for k in ref if ref[k] != new.get(k)]
    extra = [k for k in new if k not in ref]
    print(
        f"onepass {sorted(times)} ms | current _browse {sorted(old_t)} ms | "
        f"rows {len(new)} vs {len(ref)} | mismatches {len(diff)} extra {len(extra)}"
    )
    for k in diff[:5]:
        print("  diff", k, ref[k], new.get(k))


asyncio.run(main())
