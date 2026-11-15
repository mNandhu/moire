"""Backup-API copy of a SQLite DB (WAL-safe). usage: snapshot.py <src> <dst>"""

import sqlite3
import sys

src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.execute("pragma journal_mode=wal")
dst.close()
src.close()
print("ok", sys.argv[2])
