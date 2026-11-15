#!/usr/bin/env bash
# Reprojection matrix on fresh copies of $B/db/real.db and $B/db/syn.db (30k, raws
# cloned with data/clone_raw.py). See bench/README.md for making them.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" scan
cd "$B"
mkdir -p work/rep
for ds in real syn; do
  rm -f work/rep/$ds.db*; cp db/$ds.db work/rep/$ds.db
  for m in noop noop force flip; do
    echo "== rep-$ds-$m $(cat /proc/loadavg)"
    capped $PY $S/reproject_bench.py rep-$ds-$m --db work/rep/$ds.db --mode $m 2>&1 \
      | $PY -c "import sys,json; s=sys.stdin.read(); i=s.find('{'); d=json.loads(s[i:]) if i>=0 else None; print(s[:i]) if i>0 else None; print(json.dumps(d) if d else s)"
  done
done
