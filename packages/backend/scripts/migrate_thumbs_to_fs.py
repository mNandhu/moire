"""One-shot migration: copy existing thumbnails out of MinIO onto the local FS.

The FS key scheme is identical to the old MinIO object keys
(`{library_id}/{image_id}.webp`), so existing `thumb_key` values in Mongo stay
valid — this migration writes files only, it does NOT touch the database.

`minio` was removed from the backend deps, so run this with it temporarily:

    uv --directory packages/backend run --with minio \
        python scripts/migrate_thumbs_to_fs.py

Reads the OLD MinIO connection from env (or sensible dev defaults):
    MINIO_ENDPOINT, MINIO_ACCESS_KEY/MINIO_ROOT_USER,
    MINIO_SECRET_KEY/MINIO_ROOT_PASSWORD, MINIO_SECURE, MINIO_BUCKET_THUMBS
Writes to THUMB_ROOT (via the backend config / storage_fs key resolution).

Alternative: skip this entirely and just rescan each library — thumbnails are
derived and will be regenerated onto the FS. Prefer that for small/fresh data.
"""

from __future__ import annotations

import os
import sys

# Ensure `src` is importable when run from packages/backend.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from minio import Minio  # noqa: E402  (optional dep, installed via --with)

from src.services.storage_fs import _safe_path, ensure_thumb_root  # noqa: E402


def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def main() -> int:
    endpoint = _env("MINIO_ENDPOINT", default="127.0.0.1:9000")
    access = _env("MINIO_ACCESS_KEY", "MINIO_ROOT_USER", default="admin")
    secret = _env("MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD", default="password123")
    secure = _env("MINIO_SECURE", default="false").lower() == "true"
    bucket = _env("MINIO_BUCKET_THUMBS", default="moire-thumbs")

    client = Minio(endpoint, access_key=access, secret_key=secret, secure=secure)
    if not client.bucket_exists(bucket):
        print(f"bucket {bucket!r} not found at {endpoint} — nothing to migrate")
        return 0

    ensure_thumb_root()
    copied = 0
    for obj in client.list_objects(bucket, recursive=True):
        key = obj.object_name
        if not key:
            continue
        dst = _safe_path(key)  # same key → same destination, no DB rewrite
        dst.parent.mkdir(parents=True, exist_ok=True)
        client.fget_object(bucket, key, str(dst))
        copied += 1
        if copied % 500 == 0:
            print(f"  ... {copied} thumbnails copied")

    print(f"done: {copied} thumbnails migrated from minio://{bucket} to the FS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
