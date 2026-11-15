#!/usr/bin/env bash
# Rescan scenarios on a local copy of one library: $B/lib/<RESCAN_LIB>
# (default: the first folder there; run_first_scans.sh makes the copies).
# touch: os.utime on every 10th file (mtime +1 s, same bytes)
# modify: append 16 bytes to every 10th file (size + mtime change; PNG still decodes)
# delete: move every 10th file to work/stash (restored at the end)
set -u
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" scan
cd "$B"
L=lib/${RESCAN_LIB:-$(ls lib | head -1)}; DB=work/rescan/r.db; T=work/rescan/thumbs
run() { name=$1; shift; echo "== $name  $(cat /proc/loadavg)"; capped \
  $PY $S/scan_e2e.py "$name" --db $DB --thumbs $T --lib $L "$@" 2>&1 | grep -v "^INFO\|WARNING"; }
mkdir -p work/rescan work/stash
run rescan-0-first --fresh
run rescan-1-unchanged
run rescan-2-unchanged --instrument
run rescan-3-unchanged
find $L -type f -name "*.png" | sort | awk "NR%10==0" > work/rescan/tenth.txt
echo "touching $(wc -l < work/rescan/tenth.txt)"
$PY -c "import os,sys
for p in open('work/rescan/tenth.txt').read().splitlines():
    st=os.stat(p); os.utime(p,(st.st_atime, st.st_mtime+1))"
run rescan-4-touch10pct --instrument
$PY -c "
for p in open('work/rescan/tenth.txt').read().splitlines():
    open(p,'ab').write(b'\0'*16)"
run rescan-5-modify10pct --instrument
$PY -c "
import os
for p in open('work/rescan/tenth.txt').read().splitlines():
    os.rename(p, 'work/stash/' + p.replace('/', '__'))"
run rescan-6-delete10pct --instrument
run rescan-7-unchanged-after
# restore the moved files to their folders, minus the 16 appended bytes
$PY -c "
import os
for p in open('work/rescan/tenth.txt').read().splitlines():
    s = 'work/stash/' + p.replace('/', '__'); d = open(s, 'rb').read()[:-16]
    open(p, 'wb').write(d); os.unlink(s)"
