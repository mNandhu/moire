"""Write the thumbnail URL lists thumb_load.py replays: urls.txt (full
thumbnails) and urls-small.txt (``?size=small``), one per image in the web
bench DB. usage: make_urls.py   (writes into $BENCH_WORK/web)"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benvcore import setup, work  # noqa: E402

W = work("web")
setup(W, W / "moire.db", W / "thumbs")

from moire.services.library.thumb_version import thumb_url, version  # noqa: E402

rows = (
    sqlite3.connect(W / "moire.db")
    .execute("select _id, thumb_key from images")
    .fetchall()
)
urls = [thumb_url(i, version(k)) for i, k in rows]
(W / "urls.txt").write_text("\n".join(urls) + "\n")
(W / "urls-small.txt").write_text(
    "\n".join(u + ("&" if "?" in u else "?") + "size=small" for u in urls) + "\n"
)
print(len(urls), "urls ->", W)
