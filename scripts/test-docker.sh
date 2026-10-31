#!/bin/bash

# Moiré Docker smoke test: builds the CI stack, indexes ./test_images, and
# checks the API + media endpoints. Mirrors .github/workflows/ci.yml.

set -euo pipefail

# Override the host port to run alongside a dev backend on :8000.
export MOIRE_BACKEND_PORT="${MOIRE_BACKEND_PORT:-8000}"
BASE="http://localhost:${MOIRE_BACKEND_PORT}"
COMPOSE="docker compose -f docker-compose.ci.yml"
API="$BASE/api/v1"

cleanup() {
    echo "🧹 Tearing down CI stack..."
    $COMPOSE down -v > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🐳 Building and starting the CI stack..."
$COMPOSE up --build -d

echo "⏳ Waiting for backend health..."
for i in {1..60}; do
    if curl -sf "$BASE/health" > /dev/null; then break; fi
    if [ "$i" = 60 ]; then echo "❌ Backend never became healthy"; $COMPOSE logs backend; exit 1; fi
    sleep 2
done
echo "  ✅ Backend healthy"

echo "📚 Adding /data/test_images as a library..."
LIB_ID=$(curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{"path":"/data/test_images","name":"docker-test"}' "$API/libraries" | jq -r '._id // empty')
if [ -z "$LIB_ID" ]; then echo "❌ Adding the library returned no _id"; exit 1; fi

scan_done=false
for _ in {1..120}; do
    SCANNING=$(curl -sf "$API/libraries" | jq -r --arg id "$LIB_ID" '.[] | select(._id == $id) | .scanning')
    if [ "$SCANNING" = "false" ]; then scan_done=true; break; fi
    sleep 2
done
if [ "$scan_done" != true ]; then echo "❌ Scan did not finish in time"; $COMPOSE logs backend; exit 1; fi
INDEXED=$(curl -sf "$API/libraries" | jq -r --arg id "$LIB_ID" '.[] | select(._id == $id) | .indexed_count')
if [ "$INDEXED" = "0" ]; then echo "❌ Nothing indexed"; $COMPOSE logs backend; exit 1; fi
echo "  ✅ Indexed $INDEXED images"

IMG_ID=$(curl -sf "$API/images?limit=1&library_id=$LIB_ID" | jq -r '.[0]._id // empty')
if [ -z "$IMG_ID" ]; then echo "❌ Image feed is empty"; exit 1; fi
if ! curl -sf -o /dev/null "$API/images/$IMG_ID/thumb"; then echo "❌ Thumbnail request failed"; exit 1; fi
echo "  ✅ Thumbnail served"
if ! curl -sf -o /dev/null "$API/images/$IMG_ID/file"; then echo "❌ Original request failed"; exit 1; fi
echo "  ✅ Original served"

echo "🎉 Docker smoke test passed"
