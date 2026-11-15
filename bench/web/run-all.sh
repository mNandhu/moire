#!/usr/bin/env bash
# Full measurement pass. Servers: 8820 (shipped build), 8821 (profiling build), 8822 (react-router production alias).
# usage: bash run-all.sh [N]   -> logs to out/run-all-<ts>.log
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" web
W="$B"; mkdir -p "$W/out"; cd "$W"
N=${1:-5}; LOG=$W/out/run-all-$(date +%H%M%S).log
B="node $S/web-bench.cjs"
run() { echo "=== $* | $(uptime | sed 's/.*load/load/')" >> $LOG; capped env "${ENVV[@]}" $WB "$@" 2>&1 | grep -v '^RUN ' >> $LOG; }
ENVV=(BASE=http://127.0.0.1:8820)
run boot 7
run boot 7 warm=1
run boot 5 device=phone
run coverage 3
run scroll $N speed=6000
run scroll $N speed=10000
run scroll $N speed=15000
run scroll $N speed=6000 device=phone
run scroll $N speed=10000 device=phone
run scroll 3 speed=6000 gpu=0
run viewer $N
run pages $N
run typing $N
ENVV=(BASE=http://127.0.0.1:8822)
run boot 7 tag=rrprod
ENVV=(BASE=http://127.0.0.1:8821)
run scroll 2 speed=10000 react=1 tag=prof
run scroll 2 speed=10000 react=1 device=phone tag=prof
run viewer 2 react=1 tag=prof
run pages 2 react=1 tag=prof
run typing 2 react=1 tag=prof
echo "=== done $(uptime)" >> $LOG
