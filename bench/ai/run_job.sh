#!/usr/bin/env bash
# usage: run_job.sh <name> <base.db> <port> [job_bench args...]
# fresh DB copy from base, evict originals, fresh server (lifespan on, cold model), gpumon, job_bench, stop.
set -e
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" ai
name=$1; base=$2; port=$3; shift 3
mkdir -p "$B/db"
db="$B/db/${RUNDB:-run.db}"
"$S/reset_db.sh" "$base" "$db" >/dev/null
"$PY" "$S/evict_top.py" "$db" 1500
echo "uptime: $(uptime)"; nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
pid=$("$S/start.sh" "$db" "${THUMBS:-$B/db/thumbs}" "$port" --lifespan)
"$S/gpumon.sh" "$B/results/$name.gpu.csv" & gp=$!
"$PY" "$S/job_bench.py" "$name" --port "$port" "$@" > "$B/results/$name.out" 2>&1 || true
kill $gp; kill "$pid"; sleep 2
echo "uptime: $(uptime)"
"$PY" "$S/gpusum.py" "$B/results/$name.gpu.csv"
