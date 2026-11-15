# Shared shell env for bench scripts. Source it with the suite name:
#   S="$(cd "$(dirname "$0")" && pwd)"; source "$S/../env.sh" scan
# Sets REPO, PY (the backend venv's python), BENCH_WORK, B (this suite's
# scratch dir, with results/) and S (this suite's script dir), and defines
# `capped` (run a command in a 6 GB memory scope, no swap).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PY:-$REPO/packages/backend/.venv/bin/python}"
BENCH_WORK="${BENCH_WORK:-$REPO/local-setup/bench}"
B="$BENCH_WORK/$1"
mkdir -p "$B/results"
export REPO PY BENCH_WORK
capped() { systemd-run --user --scope -q -p MemoryMax="${BENCH_MEM:-6G}" -p MemorySwapMax=0 "$@"; }
