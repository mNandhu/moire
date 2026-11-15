#!/usr/bin/env bash
# First-scan matrix. Fresh DB per run. Output: $B/results/first-*.json
# BENCH_LIBS: space-separated source image folders (read only, never written).
# Each is also copied to $B/lib/<name> (once) to compare against a local copy.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" scan
cd "$B"
: "${BENCH_LIBS:?set BENCH_LIBS to one or more image folders}"
read -ra LIBS <<< "$BENCH_LIBS"
mkdir -p lib work/e2e
for d in "${LIBS[@]}"; do n=$(basename "$d"); [ -d "lib/$n" ] || cp -a "$d" "lib/$n"; done
run() { name=$1; shift; echo "== $name  $(cat /proc/loadavg)"; capped \
  $PY $S/scan_e2e.py "$name" --db work/e2e/$name.db --thumbs work/e2e/$name-thumbs --fresh "$@" 2>&1 | grep -v "^INFO\|WARNING\|^   "; rm -rf work/e2e/$name.db* work/e2e/$name-thumbs; }
ALL=(); for d in "${LIBS[@]}"; do ALL+=(--lib "$d"); done
for d in "${LIBS[@]}"; do
  n=$(basename "$d")
  run "first-$n-src-cold" --lib "$d" --cold
  run "first-$n-src-warm" --lib "$d"
  run "first-$n-copy-cold" --lib "lib/$n" --cold
done
run first-all-src-cold "${ALL[@]}" --cold
run first-all-src-warm "${ALL[@]}"
for w in 1 2 4 6 8 12 16; do run "first-$(basename "${LIBS[0]}")-warm-w$w" --lib "${LIBS[0]}" --workers $w; done
