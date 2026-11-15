"""Make a bench DB copy safe to boot with lifespan on.

- comfyui row -> address http://127.0.0.1:1 (nothing listens), no headers
- ai doc: face_detect off, auto_tag off
- no queued generation requests
- every library watch_enabled = 0

usage: make_safe.py <db>
"""

import json
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
c = db.cursor()
row = c.execute("select doc from app_settings where _id='comfyui'").fetchone()
doc = json.loads(row[0]) if row and row[0] else {}
doc.update({"address": "http://127.0.0.1:1", "headers": {}, "download_outputs": False})
c.execute(
    "insert or replace into app_settings(_id, doc) values ('comfyui', ?)",
    (json.dumps(doc),),
)
row = c.execute("select doc from app_settings where _id='ai'").fetchone()
ai = json.loads(row[0]) if row and row[0] else {}
ai.update({"face_detect": False, "auto_tag": False})
c.execute(
    "insert or replace into app_settings(_id, doc) values ('ai', ?)", (json.dumps(ai),)
)
c.execute(
    "update generation_requests set state='cancelled' where state not in ('done','failed','cancelled')"
)
c.execute("update libraries set watch_enabled = 0")
db.commit()
print(
    "comfyui:",
    c.execute("select doc from app_settings where _id='comfyui'").fetchone()[0],
)
print("ai:", c.execute("select doc from app_settings where _id='ai'").fetchone()[0])
print(
    "pending gen requests:",
    c.execute(
        "select count(*) from generation_requests where state not in ('done','failed','cancelled')"
    ).fetchone()[0],
)
print(
    "watching libraries:",
    c.execute("select sum(watch_enabled) from libraries").fetchone()[0],
)
