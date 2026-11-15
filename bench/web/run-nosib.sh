#!/usr/bin/env bash
# Selector-fix pass: traces and tile pipeline with the Tailwind sibling rules
# removed (NOSIB=1) or rewritten (NOSIB=replace) by nosib*.js at runtime.
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" web
W="$B"; mkdir -p "$W/out"; cd "$W"
LOG=$W/out/run-nosib-$(date +%H%M%S).log
run() { echo "=== $* | $(uptime | sed 's/.*load/load/')" >> $LOG; capped env BASE=http://127.0.0.1:8820 node $S/web-bench.cjs "$@" 2>&1 | grep -v '^RUN ' >> $LOG; }
for sp in 10000 15000 20000; do run scroll 5 speed=$sp nosib=1; done
run scroll 5 speed=15000
run viewer 5 nosib=1
echo "=== trace" >> $LOG
node $S/trace-scroll.cjs 10000 6 0 >> $LOG 2>&1
NOSIB=1 node $S/trace-scroll.cjs 10000 6 0 >> $LOG 2>&1
echo "=== pipeline" >> $LOG
for sp in 6000 10000 15000; do node $S/tile-pipeline.cjs $sp 8 >> $LOG 2>&1; done
NOSIB=1 node $S/tile-pipeline.cjs 15000 8 >> $LOG 2>&1
echo "=== done $(uptime)" >> $LOG
