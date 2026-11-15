#!/usr/bin/env bash
# usage: [WEBDIR=<built UI dir>] serve.sh PORT   -> starts a backend serving the built UI, prints its PID
# DB and thumbs: $BENCH_WORK/web/{moire.db,thumbs} (a safe copy, see bench/README.md).
# WEBDIR serves a variant build (build-variant.mjs) instead of the shipped UI.
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" web
W="$B"; P=${1:-8820}
cd "$REPO/packages/backend"
BENCH_WEB_DIR=$WEBDIR SQLITE_PATH=$W/moire.db THUMB_ROOT=$W/thumbs LOG_TO_FILE=false UPDATE_CHECK=false PYTHONPATH=$S \
  nohup "$PY" -m uvicorn web_app:app --port "$P" --host 127.0.0.1 --log-level warning > "$W/server-$P.log" 2>&1 &
echo $! > "$W/server-$P.pid"
for i in $(seq 60); do curl -s -o /dev/null "http://127.0.0.1:$P/health" && break; sleep 0.5; done
echo "pid $(cat "$W/server-$P.pid")"
