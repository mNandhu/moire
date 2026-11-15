#!/usr/bin/env bash
# usage: start.sh <db> <thumbs> <port> [--lifespan]  -> prints the python PID; log results/server-<port>.log
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" ai
setsid nohup systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 \
  "$PY" "$S/serve.py" "$1" "$2" "$3" $4 > "$B/results/server-$3.log" 2>&1 < /dev/null &
for i in $(seq 1 1200); do
  if curl -sf "http://127.0.0.1:$3/health" > /dev/null; then break; fi; sleep 0.05
done
pgrep -f "$S/serve.py $1 $2 $3" | tail -1
