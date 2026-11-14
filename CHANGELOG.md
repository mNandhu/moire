# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Single-port mode: `pnpm build` writes the UI into the backend, which then serves it, so Moiré runs as one process on one port (http://localhost:8000).
- `moire` command: install with `uv tool install "moire-studio[cpu]"` (or `[gpu]`), then `moire run` starts Moiré and `moire paths` shows where its data lives. An installed copy keeps its data in the OS app-data folder; set `MOIRE_HOME` to move it. A source checkout still uses `<repo>/data`.
- Update notice: once a day Moiré asks PyPI whether a newer version is out, and shows "Update available" in the sidebar (with the upgrade command and a link to what's new) and in the terminal. Settings has a new About tab with the version and a switch to turn the check off; `UPDATE_CHECK=false` turns it off for good. A source checkout never checks.
- Release tooling: one version across `pyproject.toml`, `uv.lock` and both `package.json` files (`pnpm version:set`, `pnpm version:check`), and a release workflow that builds the app wheel for a `vX.Y.Z` tag. The workflow stays off until the `RELEASE_ENABLED` repository variable is `true`.

### Changed

- The backend's Python package is now `moire` (`packages/backend/src/moire`), so run it with `uvicorn moire.main:app` or `moire run` instead of `uvicorn src.main:app`. The distribution is `moire-studio`.
- Renamed the project from Tagify to Moiré. Code identifiers, paths and settings use `moire`: the database defaults to `data/moire.db`, the model cache to `.cache/moire/models`, logs to `moire.log`, the Docker volume is `moire_data`, and environment variables are `MOIRE_*` (formerly `TAGIFY_*`). There is no automatic migration; move an existing `tagify.db` (with its `-wal`/`-shm` files) to the new name by hand.
- New design tokens and a polish pass over the gallery and image view; new Moiré logo and favicon.
