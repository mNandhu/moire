#!/usr/bin/env bash
# usage: [BENCH_JSL=bytes] run.sh <name> <port> [combo.py args...]
# fresh DB -> server (boot RSS sampled from process start) -> combo.py -> stop server.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" combined
W="$BENCH_WORK"
name=$1; port=$2; shift 2
"$S/prep.sh"
echo "load before: $(cat /proc/loadavg)"
pid=$("$S/start.sh" "$port")
echo "server pid $pid"
"$PY" "$S/combo.py" "$name" --port "$port" "$@" > "$B/results/$name.out" 2>&1
kill "$pid"; sleep 3; kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
cp "$B/results/rss-$port.csv" "$B/results/$name.rss.csv"
grep -iE "locked|Traceback|error" "$B/results/server-$port.log" | head -20 > "$B/results/$name.serverlog-errors.txt" || true
tail -3 "$B/results/$name.out" | cut -c1-300
