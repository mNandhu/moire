#!/usr/bin/env bash
# usage: [CLONE_RAW=1] prep.sh   fresh run DB (backup-API copy of $BENCH_WORK/ai/db/syn.base.db, made safe) + hardlinked
# thumbs; drops the page cache of the 600 originals a tag run reads first and of $BENCH_WORK/scan/lib.
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" combined
W="$BENCH_WORK"
mkdir -p "$B/db"; db="$B/db/run.db"; th="$B/db/thumbs"
rm -f "$db" "$db-wal" "$db-shm"; rm -rf "$th"
"$PY" "$S/../data/snapshot.py" "$W/ai/db/syn.base.db" "$db" >/dev/null
"$PY" "$S/../data/make_safe.py" "$db"
# CLONE_RAW=1: every 30k clone gets its own gen raw, so a forced reprojection derives 30k rows.
if [ -n "${CLONE_RAW:-}" ]; then "$PY" "$S/../data/clone_raw.py" "$db"; fi
cp -al "$W/ai/db/syn-thumbs" "$th"
"$PY" - "$db" "$W/scan/lib" <<'PY'
import os, sqlite3, sys
from pathlib import Path
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
ps = [r[0] for r in db.execute("select path from images where has_ai_tags=0 and coalesce(quarantined,0)=0 order by mtime desc, _id desc limit 700")]
ps += [str(p) for p in Path(sys.argv[2]).rglob("*") if p.is_file()]
n = 0
for p in ps:
    try:
        fd = os.open(p, os.O_RDONLY)
    except OSError:
        continue
    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); os.close(fd); n += 1
print("evicted", n)
PY
