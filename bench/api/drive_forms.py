"""usage: drive_forms.py <syn moire.db>. feed first page (l200, newest) for driver forms at 301/3000/dense on syn."""

import sqlite3
import sys
import time
import statistics

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
COLS = "images._id, images.path, images.width, images.height, images.thumb_key, images.blurhash, images.score, images.rating, images.quarantined, images.has_ai_tags, images.mtime"
ORD = "ORDER BY coalesce(images.mtime, 0) DESC, images._id DESC LIMIT 200"
forms = {
    "exists-walk": lambda tag: (
        f"SELECT {COLS} FROM images WHERE EXISTS (SELECT 1 FROM image_tags WHERE image_tags.image_id = images._id AND image_tags.tag IN (?)) AND coalesce(images.quarantined, 0) IS 0 {ORD}",
        [tag],
    ),
    "in-subquery": lambda tag: (
        f"SELECT {COLS} FROM images WHERE images._id IN (SELECT image_id FROM image_tags WHERE tag IN (?)) AND coalesce(images.quarantined, 0) IS 0 {ORD}",
        [tag],
    ),
    "join": lambda tag: (
        f"SELECT {COLS} FROM image_tags it JOIN images ON images._id = it.image_id WHERE it.tag IN (?) AND coalesce(images.quarantined, 0) IS 0 {ORD}",
        [tag],
    ),
    "join-distinct(any:)": lambda tag: (
        f"SELECT DISTINCT {COLS} FROM image_tags it JOIN images ON images._id = it.image_id WHERE it.base = ? AND coalesce(images.quarantined, 0) IS 0 {ORD}",
        [tag.split(":")[-1]],
    ),
}


def bound_in(tag):
    ids = [
        r[0]
        for r in db.execute(
            "SELECT DISTINCT image_id FROM image_tags WHERE tag=?", (tag,)
        )
    ]
    return (
        f"SELECT {COLS} FROM images WHERE images._id IN ({','.join('?' * len(ids))}) AND coalesce(images.quarantined, 0) IS 0 {ORD}",
        ids,
    )


forms["bound-IN-list(D1)"] = bound_in
for tag in ("bench_r301", "bench_r3000", "prompt:masterpiece"):
    for name, f in forms.items():
        s, p = f(tag)
        ts = []
        for _ in range(12):
            t0 = time.perf_counter()
            n = len(db.execute(s, p).fetchall())
            ts.append((time.perf_counter() - t0) * 1000)
        plan = " / ".join(r[3] for r in db.execute("EXPLAIN QUERY PLAN " + s, p))
        print(
            f"{tag:20s} {name:20s} p50 {statistics.median(ts[2:]):7.1f} ms rows {n:3d} | {plan[:150]}"
        )
