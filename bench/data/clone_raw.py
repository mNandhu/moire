"""Give the syn copy's bench clones their own image_gen_raw rows (make_synth.py
did not clone them), so a 30k reprojection derives 30k rows. usage: clone_raw.py <db>"""

import re
import sqlite3
import sys

c = sqlite3.connect(sys.argv[1])
ids = [r[0] for r in c.execute("select _id from images where _id like '%:bench%/%'")]
pat = re.compile(r"^([^:]+):bench\d+/(.*)$")
pairs = []
for nid in ids:
    m = pat.match(nid)
    if m:
        pairs.append((nid, f"{m.group(1)}:{m.group(2)}"))
c.execute("create temp table m(nid text, oid text)")
c.executemany("insert into m values (?,?)", pairs)
cols = [r[1] for r in c.execute("pragma table_info(image_gen_raw)")]
sel = ",".join("m.nid" if x == "_id" else "g." + x for x in cols)
n = c.execute(
    f"insert or ignore into image_gen_raw({','.join(cols)}) select {sel} from m join image_gen_raw g on g._id = m.oid"
).rowcount
c.commit()
print(
    "cloned raws:",
    n,
    "total raws:",
    c.execute("select count(*) from image_gen_raw").fetchone()[0],
    "images with gen:",
    c.execute("select count(*) from images where json_type(gen) = 'object'").fetchone()[
        0
    ],
)
