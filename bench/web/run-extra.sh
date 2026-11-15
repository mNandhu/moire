#!/usr/bin/env bash
# Extra checks: profiling-build boot, fade off, WAN throttling, server thumb
# throughput (thumb_load.py over make_urls.py lists) and small-thumb scrolls.
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" web
W="$B"; mkdir -p "$W/out"; cd "$W"
LOG=$W/out/run-extra-$(date +%H%M%S).log
run() { echo "=== $* | $(uptime | sed 's/.*load/load/')" >> $LOG; capped env "${ENVV[@]}" node $S/web-bench.cjs "$@" 2>&1 | grep -v '^RUN ' >> $LOG; }
ENVV=(BASE=http://127.0.0.1:8821)
run boot 5 react=1 tag=prof
ENVV=(BASE=http://127.0.0.1:8820)
run boot 5 nofade=1
run boot 5 net=wan
run boot 5 net=wan warm=1
echo "=== server thumb throughput (load.py, keep-alive, full thumbs) $(uptime | sed 's/.*load/load/')" >> $LOG
for c in 1 6 12; do $PY $S/thumb_load.py 8820 $W/urls.txt 3000 $c >> $LOG; done
echo "=== prime small thumbs" >> $LOG
$PY $S/thumb_load.py 8820 $W/urls-small.txt 5404 6 >> $LOG
echo "=== server thumb throughput small" >> $LOG
for c in 6 12; do $PY $S/thumb_load.py 8820 $W/urls-small.txt 3000 $c >> $LOG; done
run scroll 3 speed=15000 thumb=route
run scroll 3 speed=15000 thumb=small
run scroll 3 speed=12500
run scroll 3 speed=20000 thumb=small
echo "=== trace" >> $LOG
node $S/trace-scroll.cjs 10000 6 0 >> $LOG 2>&1
node $S/trace-scroll.cjs 10000 6 1 >> $LOG 2>&1
node $S/trace-scroll.cjs 15000 6 0 >> $LOG 2>&1
echo "=== done $(uptime)" >> $LOG
