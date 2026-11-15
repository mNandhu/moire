"""Drop the page cache of the N originals a tag-untagged run would read first. usage: evict_top.py <db> <n>"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
ps = [
    r[0]
    for r in db.execute(
        "select path from images where has_ai_tags=0 and coalesce(quarantined,0)=0 order by mtime desc, _id desc limit ?",
        (int(sys.argv[2]),),
    )
]
print("evicted", benv.evict(ps), "of", len(ps))
