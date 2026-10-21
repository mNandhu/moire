#!/usr/bin/env bash
# Release scan: current version, last tag, commits since, and which parts of
# Moiré's user-facing surface they touched. Read-only.
#
# `[!]` means "read the diff", not "this is breaking".

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== Version files"
node scripts/version.mjs check || echo "[!] version files disagree; fix before releasing"

echo
echo "== Working tree"
if [ -n "$(git status --porcelain)" ]; then
  echo "[!] uncommitted changes:"; git status --short
else
  echo "clean"
fi
echo "branch: $(git branch --show-current)"

LAST_TAG="$(git tag --list 'v*.*.*' --sort=-v:refname | head -1)"
if [ -n "$LAST_TAG" ]; then
  RANGE="$LAST_TAG..HEAD"
  echo "last tag: $LAST_TAG"
else
  # No tag yet: everything since the repo started counts.
  RANGE="HEAD"
  echo "last tag: none (first tagged release; CHANGELOG.md's newest heading is the previous version)"
fi

echo
echo "== Commits ($RANGE)"
COMMITS="$(git log --oneline --no-merges "$RANGE")"
if [ -z "$COMMITS" ]; then
  echo "none: nothing to release"; exit 0
fi
echo "$COMMITS" | head -200
echo "($(echo "$COMMITS" | wc -l) commits)"

echo
echo "== Surface touched"
# name|pathspec... : areas where a change can make a user act or notice.
SURFACES=(
  "Settings and env vars (renames, new required values)|packages/backend/src/moire/core/config.py packages/backend/.env.example"
  "Database schema (tables, columns, indexes)|packages/backend/src/moire/database/schema.py"
  "Data migrations (run once on startup)|packages/backend/src/moire/services/tag_migrations.py"
  "On-disk layout (thumbs, model cache, data dir)|packages/backend/src/moire/services/storage_fs.py packages/backend/src/moire/services/ai_tagger_download.py"
  "HTTP API (/api/v1)|packages/backend/src/moire/api"
  "ComfyUI integration (workflows, generators)|packages/backend/src/moire/services/comfy* packages/backend/src/moire/services/generat* packages/backend/src/moire/services/generator*"
  "Dependencies|packages/backend/pyproject.toml packages/backend/uv.lock packages/frontend/package.json pnpm-lock.yaml"
  "Deployment (Docker, nginx, CI)|docker-compose*.yml packages/*/Dockerfile deploy .github/workflows"
)
for entry in "${SURFACES[@]}"; do
  name="${entry%%|*}"; paths="${entry#*|}"
  # shellcheck disable=SC2086
  files="$(git diff --name-only "${LAST_TAG:-$(git rev-list --max-parents=0 HEAD | tail -1)}" HEAD -- $paths 2>/dev/null || true)"
  if [ -n "$files" ]; then
    echo "[!] $name"; echo "$files" | sed 's/^/      /' | head -15
  else
    echo "    $name: untouched"
  fi
done

echo
echo "== CHANGELOG [Unreleased]"
awk '/^## \[Unreleased\]/{on=1; next} on && /^## \[/{exit} on{print}' CHANGELOG.md
