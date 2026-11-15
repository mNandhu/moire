#!/usr/bin/env bash
# Final pass: invalidation tracking, scroll traces and tile pipeline with and
# without the selector fix, image-view hop timing.
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" web
W="$B"; mkdir -p "$W/out"; cd "$W"
LOG=$W/out/run-final-$(date +%H%M%S).log
run() { echo "=== $* | $(uptime | sed 's/.*load/load/')" >> $LOG; capped env BASE=http://127.0.0.1:8820 node $S/web-bench.cjs "$@" 2>&1 | grep -v '^RUN ' >> $LOG; }
run boot 5
run boot 5 fade=img
run boot 5 fade=anim
run boot 5 nofade=1
echo "=== inval traces" >> $LOG
for v in "" 1 replace; do NOSIB=$v INVAL=1 node $S/trace-scroll.cjs 10000 3 0 > /dev/null 2>&1; done
node -e '
for (const f of ["out/trace-desktop-10000-n-inval.json","out/trace-desktop-10000-n-nosib1-inval.json","out/trace-desktop-10000-n-nosibreplace-inval.json"]){
const ev=JSON.parse(require("fs").readFileSync(f)).traceEvents;
const ult=ev.filter(e=>e.name==="UpdateLayoutTree"&&e.ph==="X");const ec=ult.map(e=>e.args.elementCount).sort((a,b)=>a-b);
const sub=ev.filter(e=>e.name==="StyleInvalidatorInvalidationTracking"&&JSON.stringify(e.args).includes("allDescendantsMightBeInvalid")).length;
console.log(f,"frames(ULT)",ult.length,"elements/recalc median",ec[ec.length>>1],"recalc ms",Math.round(ult.reduce((a,e)=>a+e.dur,0)/1000),"subtree invalidations",sub)}' >> $LOG 2>&1
echo "=== busy traces (no inval)" >> $LOG
for v in "" 1 replace; do NOSIB=$v node $S/trace-scroll.cjs 10000 6 0 2>&1 | grep -E '^\{|recalcStyle|MessagePort::Accept|FunctionCall$' >> $LOG; done
run scroll 5 speed=10000 nosib=replace
run scroll 5 speed=15000 nosib=replace
echo "=== pipeline" >> $LOG
for sp in 6000 10000 15000; do node $S/tile-pipeline.cjs $sp 8 >> $LOG 2>&1; done
NOSIB=1 node $S/tile-pipeline.cjs 15000 8 >> $LOG 2>&1
echo "=== viewer hops" >> $LOG
for i in 1 2 3 4 5; do node $S/viewer-hops.cjs >> $LOG 2>&1; done
run scroll 5 speed=6000 device=phone cpu=4
run scroll 5 speed=6000 device=phone cpu=4 nosib=1
echo "=== done $(uptime)" >> $LOG
