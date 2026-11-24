# Moiré tasks. `just` lists them.

default:
    @just --list

# Compile the UI into packages/backend/src/moire/web
build:
    pnpm build

# Build the UI, then serve API + UI on one port (e.g. `just start --port 8001 --open`)
start *args: build
    node scripts/uv-backend.mjs run moire run {{args}}

# Serve the last build without rebuilding
serve *args:
    node scripts/uv-backend.mjs run moire run {{args}}

# All tests: backend pytest, then frontend vitest
test: test-backend test-frontend

# Backend tests; extra args go to pytest (e.g. `just test-backend tests/test_scanner.py -x`)
test-backend *args:
    node scripts/uv-backend.mjs run pytest {{args}}

# Frontend tests; extra args go to vitest (e.g. `just test-frontend src/lib/fuzzy.test.ts`)
test-frontend *args:
    pnpm -C packages/frontend test {{args}}

# Backend + Vite dev servers with hot reload; extra args go to Vite
# (e.g. `just dev --host` to reach it from another device)
dev *args:
    pnpm exec concurrently -c auto -n backend,frontend "pnpm dev:backend" "pnpm dev:frontend {{args}}"
