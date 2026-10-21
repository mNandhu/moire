# Moiré tasks. `just` lists them.

default:
    @just --list

# Compile the UI into packages/backend/src/moire/web
build:
    pnpm build

# Build the UI, then serve API + UI on one port (e.g. `just start --port 8001 --open`)
start *args: build
    uv --directory packages/backend run moire run {{args}}

# Serve the last build without rebuilding
serve *args:
    uv --directory packages/backend run moire run {{args}}

# All tests: backend pytest, then frontend vitest
test: test-backend test-frontend

# Backend tests; extra args go to pytest (e.g. `just test-backend tests/test_scanner.py -x`)
test-backend *args:
    uv --directory packages/backend run pytest {{args}}

# Frontend tests; extra args go to vitest (e.g. `just test-frontend src/lib/fuzzy.test.ts`)
test-frontend *args:
    pnpm -C packages/frontend test {{args}}

# Backend + Vite dev servers with hot reload
dev:
    pnpm dev
