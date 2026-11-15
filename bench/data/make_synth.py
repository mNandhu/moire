"""Build the ~30k synthetic DB from a (safe) copy of the real one.

usage: make_synth.py <src.db> <src_thumbs> <dst.db> <dst_thumbs> [total=30000]

Clones images rows (new _id `<lib>:bench<k>/<rel>`, mtime - k*997.13 s so sort
keys never tie, gen_group_id suffixed per copy so batches keep their size) with
their image_tags, image_gen_terms (weight kept), image_loras, image_embeddings.
image_gen_raw is NOT cloned (only /workflow reads it). Each clone's thumbnail is
a hardlink of its source's under the clone's key (so thumb_version stats a real
file). No ANALYZE (the real DB has no sqlite_stat1).

Planted with a fixed seed on rows spread across all mtimes, each as an AI tag,
a prompt tag and a prompt term:
  bench_r30 / prompt:bench_r30 / benchterm_r30      -> 30 images
  bench_r299 ...                                     -> 299
  bench_r301 ...                                     -> 301
  bench_r3000 ...                                    -> 3000
Also 20 tag_meta cover pins on top tags and 10 merge rules.
"""

import json
import os
import random
import shutil
import sqlite3
import sys
import time

src, src_thumbs, dst, dst_thumbs = sys.argv[1:5]
TOTAL = int(sys.argv[5]) if len(sys.argv) > 5 else 30000
PLANT = (30, 299, 301, 3000)


def thumb_key(image_id: str) -> str:
    # services/library/storage_fs.thumb_key
    return f"{image_id.split(':', 1)[0]}/{image_id}.webp".replace(":", "_")


t0 = time.time()
if os.path.exists(dst):
    os.remove(dst)
for ext in ("-wal", "-shm"):
    if os.path.exists(dst + ext):
        os.remove(dst + ext)
s = sqlite3.connect(src)
d = sqlite3.connect(dst)
s.backup(d)
s.close()
d.execute("pragma journal_mode=WAL")
d.execute("pragma synchronous=OFF")
if os.path.exists(dst_thumbs):
    shutil.rmtree(dst_thumbs)
shutil.copytree(src_thumbs, dst_thumbs)
print(f"copied db+thumbs {time.time() - t0:.1f}s")

c = d.cursor()
cols = [r[1] for r in c.execute("pragma table_info(images)")]
base_ids = [r[0] for r in c.execute("select _id from images order by _id")]
n_real = len(base_ids)
need = TOTAL - n_real
copies = []  # (k, orig_id)
k = 1
while len(copies) < need:
    for oid in base_ids:
        if len(copies) >= need:
            break
        copies.append((k, oid))
    k += 1
print(f"real={n_real} clones={len(copies)} copies={k - 1}")

c.execute("create temp table m(k int, oid text, nid text, primary key(oid, k))")
rows = []
for kk, oid in copies:
    lib, rel = oid.split(":", 1)
    rows.append((kk, oid, f"{lib}:bench{kk}/{rel}"))
c.executemany("insert into m values (?,?,?)", rows)

sel = []
for col in cols:
    if col == "_id":
        sel.append("m.nid")
    elif col == "mtime":
        sel.append("i.mtime - m.k * 997.13")
    elif col == "ctime":
        sel.append("i.ctime - m.k * 997.13")
    elif col == "gen_group_id":
        sel.append(
            "case when i.gen_group_id is null then null else i.gen_group_id || '#' || m.k end"
        )
    elif col == "thumb_key":
        sel.append("i.thumb_key")  # fixed below
    else:
        sel.append(f"i.{col}")
c.execute(
    f"insert into images ({','.join(cols)}) select {','.join(sel)} from m join images i on i._id = m.oid"
)
c.execute(
    "insert into image_tags(image_id, tag, base) select m.nid, it.tag, it.base from m join image_tags it on it.image_id = m.oid"
)
gcols = [r[1] for r in c.execute("pragma table_info(image_gen_terms)")]
c.execute(
    f"insert into image_gen_terms({','.join(gcols)}) select {','.join('m.nid' if x == 'image_id' else 'g.' + x for x in gcols)} from m join image_gen_terms g on g.image_id = m.oid"
)
for tbl in ("image_loras", "image_embeddings"):
    tc = [r[1] for r in c.execute(f"pragma table_info({tbl})")]
    c.execute(
        f"insert into {tbl}({','.join(tc)}) select {','.join('m.nid' if x == 'image_id' else 'g.' + x for x in tc)} from m join {tbl} g on g.image_id = m.oid"
    )
d.commit()
print(f"cloned rows {time.time() - t0:.1f}s")

# thumb keys + hardlinks
upd = []
linked = missing = 0
for nid, src_key in c.execute(
    "select m.nid, i.thumb_key from m join images i on i._id = m.oid"
).fetchall():
    if not src_key:
        continue
    nk = thumb_key(nid)
    upd.append((nk, nid))
    sp = os.path.join(dst_thumbs, src_key)
    dp = os.path.join(dst_thumbs, nk)
    if os.path.exists(sp):
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        if not os.path.exists(dp):
            os.link(sp, dp)
        linked += 1
    else:
        missing += 1
c.executemany("update images set thumb_key=? where _id=?", upd)
d.commit()
print(f"thumbs linked={linked} missing_src={missing} {time.time() - t0:.1f}s")

# plant
rng = random.Random(42)
all_ids = [r[0] for r in c.execute("select _id from images")]
for n in PLANT:
    pick = rng.sample(all_ids, n)
    ai, pr, term = f"bench_r{n}", f"prompt:bench_r{n}", f"benchterm_r{n}"
    for iid in pick:
        tags = json.loads(
            c.execute("select tags from images where _id=?", (iid,)).fetchone()[0]
            or "[]"
        )
        tags += [ai, pr]
        c.execute(
            "update images set tags=?, has_tags=1, has_ai_tags=1, has_prompt_tags=1 where _id=?",
            (json.dumps(tags), iid),
        )
    c.executemany(
        "insert or ignore into image_tags(image_id, tag, base) values (?,?,?)",
        [(i, ai, ai) for i in pick] + [(i, pr, ai) for i in pick],
    )
    c.executemany(
        "insert or ignore into image_gen_terms(image_id, term, weight) values (?,?,1.0)",
        [(i, term) for i in pick],
    )
d.commit()

# cover pins + merge rules
top = [
    r[0]
    for r in c.execute(
        "select base from image_tags where base != '' group by base order by count(*) desc limit 20"
    )
]
now = time.time()
for b in top:
    iid = c.execute(
        "select image_id from image_tags where base=? order by image_id limit 1 offset 7",
        (b,),
    ).fetchone()[0]
    c.execute(
        "insert or replace into tag_meta(tag, thumb_image_id, updated_at) values (?,?,?)",
        (b, iid, now),
    )
pterms = [
    r[0]
    for r in c.execute(
        "select base from image_tags where tag like 'prompt:%' group by base order by count(*) desc limit 40 offset 20"
    )
]
for i in range(10):
    c.execute(
        "insert or replace into tag_rules(from_name, to_names, created_at) values (?,?,?)",
        (pterms[i], json.dumps([pterms[i + 20]]), now),
    )
d.commit()
for q in (
    "select count(*) from images",
    "select count(*) from image_tags",
    "select count(*) from image_gen_terms",
    "select count(*) from image_loras",
    "select count(*) from image_embeddings",
    "select count(*) from tag_meta",
    "select count(*) from tag_rules",
):
    print(q, c.execute(q).fetchone()[0])
for n in PLANT:
    print(
        n,
        c.execute(
            "select count(distinct image_id) from image_tags where tag=?",
            (f"bench_r{n}",),
        ).fetchone()[0],
        c.execute(
            "select count(*) from image_gen_terms where term=?", (f"benchterm_r{n}",)
        ).fetchone()[0],
    )
c.execute("pragma wal_checkpoint(TRUNCATE)")
d.close()
print(f"done {time.time() - t0:.1f}s size={os.path.getsize(dst) / 1e6:.0f}MB")
