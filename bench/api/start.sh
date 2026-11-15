#!/usr/bin/env bash
# usage: start.sh <dataset: real|syn> <port 8810-8819> [--lifespan]
# Starts serve.py on $BENCH_WORK/api/<dataset>/{moire.db,thumbs} in a 6 GB
# scope and prints the server's PID (stop it with stop.sh <pid>).
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" api
setsid nohup systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 \
  "$PY" "$S/serve.py" "$B/$1" "$2" $3 > "$B/results/server-$1-$2.log" 2>&1 < /dev/null &
for i in $(seq 1 600); do
  if curl -sf "http://127.0.0.1:$2/health" > /dev/null; then break; fi; sleep 0.05
done
pgrep -f "serve.py $B/$1 $2" | tail -1
