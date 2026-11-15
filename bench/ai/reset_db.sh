#!/usr/bin/env bash
# usage: reset_db.sh <base.db> <dst.db>   fresh backup-API copy of the safe base (server must be stopped)
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" ai
rm -f "$2" "$2-wal" "$2-shm"
"$PY" "$S/../data/snapshot.py" "$1" "$2"
