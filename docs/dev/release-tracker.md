# Before the first release

What has to happen before Moiré is published (PyPI `moire-studio`, first `vX.Y.Z` tag). Same legend as `refactor-pass/TRACKER.md`: `[ ]` open, `[x]` done (commit hash), `[-]` dropped (reason). Update the line in the same commit as the work.

## Code

- [x] **R1** Prune one-off data migrations only the dev DB needed. The mechanism stays (`run_pending`, the `migrations` app_settings row, entries of `(name, step, needs reprojection)`), the list starts empty, and the step functions, `covers.rekey_pins_sync` and their tests are gone. A new install records nothing; the dev DB already has every name recorded, so it skips nothing it needs.
- [x] **R2** Dev docs out of the way: plans, trackers, the refactor pass, perf reports, e2e scenarios and dev tools live in `docs/dev/`; `docs/` keeps only what users read (`docker-guide.md`, README images). Nothing in the wheel points at them (only code comments do).

## Tests

- [x] **R3** E2E suite: pick a runner (Playwright, already used for screenshots), seed a small library of fixture images, and cover `docs/dev/e2e-scenarios.md` plus the main paths: onboarding, add library and scan, gallery filter and paging, image view tags and weights, tag panel, AI tagging a few images, Generate prompt keys (Ctrl+Up/Down), against the fake ComfyUI (never the public one). Started 08f412e: harness in `packages/e2e`, onboarding, gallery paging + search, Generate Clear/Undo. Every path named here is covered as of ca74569; first green CI run 40635450671; more scenarios in `docs/dev/e2e-scenarios.md` "Still to cover".
- [ ] **R4** Performance testing: a repeatable run of the `bench/` suites (`bench/README.md`; `bench/data/make_synth.py` builds the large library, e.g. 50k images) with budgets for feed paging, tag browse, tag detail and a full reprojection; record a baseline beside `docs/dev/perf-benchmark-2026-11.md` and fail CI (or flag) on a big regression.
- [x] **R5** Fix flaky tests first so CI is trustworthy: F26 (a966aa1), F27 (f6b9dd2), the live-loop flake (71abda0). Checked 2026-11-23: the full backend suite three times in a row (1440 passed each) and the frontend suite (1188) all green, and every CI e2e run since the Python pin (11-14) passed; the late-October `generate-run` failures were the batch rework, not flakes. The 2026-10-27 one-off backend failure never came back.

## CI

- [x] **R6** Proper CI on every push and PR: today `ci.yml` is only a Docker compose smoke test. Add jobs for `uv run pytest`, `ruff check` + `ruff format --check`, frontend `pnpm test`, `tsc -b`, `eslint`, and `pnpm version:check`; cache uv and pnpm. E2E (R3) as its own job. (1ada532, dfd154b; first green run 2026-10-28, run 40633622992)
- [ ] **R7** Release workflow end to end: `release.yml` builds the wheel and a GitHub Release but stays off until `RELEASE_ENABLED` is `true`. Dry-run it on a test tag; check the wheel carries the built UI and installs with `uv tool install "moire-studio[cpu]"` on Linux, Windows and macOS. While installed, check the update notice's upgrade command on each (`services/update_check.py` `install_kind`): `uv tool` on Windows and macOS too (found by its `uv-receipt.toml`), pipx, plain pip, and Docker (`MOIRE_INSTALL=docker`). Only uv on Linux and a checkout are tested so far.

## Versioning and publishing

- [ ] **R8** Versioning (first version: 0.1.0, decided 2026-11-23): semver from `0.1.0`, one version across `pyproject.toml`, `uv.lock` and both `package.json` (`pnpm version:set` / `version:check`, the `moire-release` skill). Decide what the first public version is and turn `[Unreleased]` in `CHANGELOG.md` into it. Once the package is on PyPI, drop the README's "isn't on PyPI yet" note (and run `pnpm package-files`). The unreleased Tagify-era `0.1.0`/`0.1.1` entries are gone from the CHANGELOG, so `0.1.0` is free for the first release.
- [x] **R11** Package metadata: the wheel and sdist carry LICENSE (AGPL), PyPI's page is the root README with links pinned to the tag (`scripts/package-files.mjs`, kept in step by `version:check` and the pre-commit hook), project URLs, keywords and classifiers, `uv_build` 0.13. Install commands pin `--python 3.12` (README, CLI hint, onboarding's GPU command): uv doesn't pick an interpreter from `requires-python`, and the `[gpu]` extra has no Python 3.14 wheels.
- [ ] **R12** `[gpu]` on Python 3.14: `onnxruntime-gpu<1.24` (CUDA 12) has no cp314 wheels, so installs pin 3.12 for now. Moving to a newer onnxruntime-gpu means checking which CUDA and cuDNN it wants and testing on a GPU box. Not a release blocker.
- [ ] **R9** Publish to PyPI: reserve `moire-studio`, set up trusted publishing (OIDC) from `release.yml`, try TestPyPI first, then the real upload from a tag. `release.yml` is ready: build, then a `pypi`-environment job on a tag (PyPI first, then the GitHub Release) and a `testpypi` job on a manual run with "testpypi" chosen. Publishers: owner `mNandhu`, repo `moire`, workflow `release.yml`, environment `pypi` / `testpypi`. `RELEASE_ENABLED` is on (2026-11-23).

## Docs

- [ ] **R13** Workflow actions: `checkout`, `setup-node`, `upload-artifact`, `cache` (v4), `setup-uv` (v6) and `pnpm/action-setup` (v4) run on the deprecated Node 20 and are several majors behind. Bump them together and watch one CI and one manual release run.

- [x] **R10** Update the README for users, not contributors: what Moiré is, screenshots, install (`uv tool install`, Docker), first run, where data lives (`moire paths`), AI tagging model download, ComfyUI hookup, upgrade notes. Contributor setup moves to a CONTRIBUTING section or file. (4f1a4e2)
