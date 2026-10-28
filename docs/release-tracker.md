# Before the first release

What has to happen before Moiré is published (PyPI `moire-studio`, first `vX.Y.Z` tag). Same legend as `refactor-pass/TRACKER.md`: `[ ]` open, `[x]` done (commit hash), `[-]` dropped (reason). Update the line in the same commit as the work.

## Code

- [ ] **R1** Prune one-off data migrations only the dev DB needed. Keep the mechanism (`tag_migrations.run_pending`, the `migrations` app_settings row, one-line reprojection-only entries): installs still need it for parser changes after release. Remove the step functions and their tests: `tag_underscores`, `tag_meta_base`, `image_faces_mtime`, `tag_rules`, `gen_term_weights` (~120 lines). Fold the reprojection-only names into nothing (a new install's first scan derives everything). Do it last, just before tagging, so later dev-DB changes don't need it redone.
- [ ] **R2** Sweep dev-only leftovers: `docs/*-plan.md` and `refactor-pass/` stay or move under `docs/dev/`; nothing in the wheel points at them.

## Tests

- [ ] **R3** E2E suite: pick a runner (Playwright, already used for screenshots), seed a small library of fixture images, and cover `docs/e2e-scenarios.md` plus the main paths: onboarding, add library and scan, gallery filter and paging, image view tags and weights, tag panel, AI tagging a few images, Generate prompt keys (Ctrl+Up/Down), against the fake ComfyUI (never the public one). Started 08f412e: harness in `packages/e2e`, onboarding, gallery paging + search, Generate Clear/Undo; the rest listed in `docs/e2e-scenarios.md` "Still to cover".
- [ ] **R4** Performance testing: a repeatable run of `tests/perf_benchmark.py` (`pnpm perf`) on a generated large library (e.g. 50k images) with budgets for feed paging, tag browse, tag detail and a full reprojection; record a baseline in `docs/perf-findings.md` and fail CI (or flag) on a big regression.
- [ ] **R5** Fix flaky tests first so CI is trustworthy: F26 (LibrariesPage delete test under load), F27 (pytest asyncio marks, done f6b9dd2), and the one-off backend failure seen 2026-10-27 under a slow run (not captured).

## CI

- [x] **R6** Proper CI on every push and PR: today `ci.yml` is only a Docker compose smoke test. Add jobs for `uv run pytest`, `ruff check` + `ruff format --check`, frontend `pnpm test`, `tsc -b`, `eslint`, and `pnpm version:check`; cache uv and pnpm. E2E (R3) as its own job. (1ada532, dfd154b; first green run 2026-10-28, run 40633622992)
- [ ] **R7** Release workflow end to end: `release.yml` builds the wheel and a GitHub Release but stays off until `RELEASE_ENABLED` is `true`. Dry-run it on a test tag; check the wheel carries the built UI and installs with `uv tool install "moire-studio[cpu]"` on Linux, Windows and macOS.

## Versioning and publishing

- [ ] **R8** Versioning: semver from `0.1.0`, one version across `pyproject.toml`, `uv.lock` and both `package.json` (`pnpm version:set` / `version:check`, the `moire-release` skill). Decide what the first public version is and turn `[Unreleased]` in `CHANGELOG.md` into it.
- [ ] **R9** Publish to PyPI: reserve `moire-studio`, set up trusted publishing (OIDC) from `release.yml`, try TestPyPI first, then the real upload from a tag.

## Docs

- [x] **R10** Update the README for users, not contributors: what Moiré is, screenshots, install (`uv tool install`, Docker), first run, where data lives (`moire paths`), AI tagging model download, ComfyUI hookup, upgrade notes. Contributor setup moves to a CONTRIBUTING section or file. (4f1a4e2)
