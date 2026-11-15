#!/usr/bin/env bash
# usage: [BENCH_JSL=bytes] start.sh <port>  -> starts serve.py on db/run.db (6G cap), prints the python PID
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" combined
W="$BENCH_WORK"
export WATCH_ENABLED_DEFAULT=false BENCH_JSL="${BENCH_JSL:-}"
setsid nohup systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 \
  "$PY" "$S/serve.py" "$B/db/run.db" "$B/db/thumbs" "$1" > "$B/results/server-$1.log" 2>&1 < /dev/null &
for i in $(seq 1 1200); do
  if curl -sf "http://127.0.0.1:$1/health" > /dev/null; then break; fi; sleep 0.05
done
pgrep -f "$S/serve.py $B/db/run.db $B/db/thumbs $1" | tail -1
