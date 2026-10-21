---
name: moire-release
description: Cut a Moiré release - pick the next version, bump every version file, finalize CHANGELOG.md, commit and tag vX.Y.Z on main. Use when asked to release, cut a version or tag Moiré.
---

# Cut a Moiré release

One version covers the whole app. `packages/backend/pyproject.toml` is the
source of truth; `scripts/version.mjs` mirrors it into `uv.lock` and both
`package.json` files. Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`,
which builds the wheel (backend + built UI) and publishes a GitHub Release
whose notes are that version's CHANGELOG section. Plain `X.Y.Z` only, no
prerelease suffixes.

## Steps

1. **Start from a clean, current main.** `git status` must be clean;
   `git fetch origin main && git checkout main && git pull --ff-only`.
   Releases are cut on main, never on a feature branch.

2. **Check the current state.** `node scripts/version.mjs check` must pass.
   Find the last tag with `git tag --sort=-v:refname | head -1` and list what
   changed since: `git log --oneline <last-tag>..HEAD` (no tag yet: compare
   against the newest version in CHANGELOG.md).

3. **Pick the version** (semver, while < 1.0):
   - minor (`0.X.0`): new features or anything a user must act on (moved
     data, renamed env vars, schema changes needing a rescan).
   - patch (`0.x.Y`): fixes only.
   Tell the user the version you picked and why in one line. If the user
   named a version, use it.

4. **Finalize CHANGELOG.md.** Rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` (today) and add a fresh empty
   `## [Unreleased]` above it. Fill gaps from the git log: the
   Keep a Changelog headings (Added / Changed / Fixed / Removed), written for
   users, not commit-by-commit. Call out anything the user must do by hand
   under the change that needs it. The release notes are this section
   verbatim, so it must stand on its own.

5. **Bump the version.** `pnpm version:set X.Y.Z` (it ends by printing a
   check; every line must say `ok`). Then `uv --directory packages/backend
   lock --check` must pass.

6. **Verify before tagging.**
   - `uv --directory packages/backend run pytest`
   - `pnpm -C packages/frontend test`
   - `pnpm build`, then `uv --directory packages/backend build --out-dir
     /tmp/moire-dist` and confirm the wheel lists `src/web/index.html`.

7. **Commit and tag.** One commit, `Release vX.Y.Z`, containing only the
   version files and CHANGELOG.md. Then an annotated tag:
   `git tag -a vX.Y.Z -m "Moiré X.Y.Z"`.

8. **Push only after the user says go.** A pushed tag publishes a release.
   Show the user the CHANGELOG section and the tag, then on their go:
   `git push origin main && git push origin vX.Y.Z`.
   If the release workflow is still off (`RELEASE_ENABLED` repo variable not
   `true`), say so: the tag is pushed but nothing is published.

## Don'ts

- Don't edit version numbers by hand; always `pnpm version:set`.
- Don't move or reuse a pushed tag. A broken release gets a new patch version.
- Don't run `uv lock` (or `uv version`) as part of a release: it re-resolves
  dependencies and turns a release into a dependency upgrade.
