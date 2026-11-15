#!/usr/bin/env bash
# Read hammer on a running scan/serve.py server (port $1, on the 30k copy): idle,
# during a scan of $B/lib (added as a new library), a forced reprojection and a no-change reprojection.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" scan
cd "$B"
P=${1:-8831}
c() { echo "== $1 $(cat /proc/loadavg)"; $PY $S/concurrency.py "$@" --port $P > results/$1.out 2>&1; tail -2 results/$1.out; sleep 5; }
c conc-idle --action none --idle 5 --tail 20
c conc-scan --action scan --path "$PWD/lib"
c conc-reproject-force --action reproject
c conc-reproject-noop --action reproject-noop
