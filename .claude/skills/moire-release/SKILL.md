---
name: moire-release
description: Cut a Moiré release - scan what changed since the last tag, propose and justify a semver bump, confirm it with the user, bump every version file, write the CHANGELOG entry, commit and tag vX.Y.Z on main. Use when asked to cut a release, bump the version or tag Moiré.
---

# Release Moiré

One version covers the whole app: the wheel ships the backend with the built UI
inside. `packages/backend/pyproject.toml` `[project].version` is the single
source of truth. `scripts/version.mjs` mirrors it into `uv.lock`'s own entry and
both `package.json` files, and the API reports it (`/openapi.json`). Plain
`X.Y.Z` only, no prerelease suffixes.

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`: it checks the tag
against every version file, builds the wheel, and publishes a GitHub Release
whose notes are that version's CHANGELOG section verbatim. It does nothing
until the repo variable `RELEASE_ENABLED` is `true`.

## 1. Scan

```bash
git fetch origin main --tags && git checkout main && git pull --ff-only
.claude/skills/moire-release/scripts/release_scan.sh
```

Prints the version files, the working tree, the last tag, the commits since it,
which parts of the user-facing surface they touched, and the current
`[Unreleased]` section. Stop and report if the version files disagree, the tree
is dirty, you are not on `main`, or there are no commits.

## 2. Classify the bump

Moiré's surface is what a user installing the new version can notice or must
act on:

- settings and env vars (`core/config.py`, `.env.example`): renames, new
  required values, changed defaults;
- data on disk: the SQLite schema, startup data migrations, the thumbnail and
  model-cache layout, anything that needs a rescan or re-tag;
- the `/api/v1` HTTP contract (scripts and other tools call it);
- the ComfyUI integration: required custom nodes, workflow format, generator
  settings;
- install and deploy: Python/Node versions, Docker, dependencies like
  onnxruntime.

UI changes are features, not breakage. While below `1.0.0`: **minor** for
features *and* breaking changes, **patch** for fixes that leave the surface
untouched.

The scan's `[!]` markers mean "read the diff", not "this is breaking". Decide by
reading the change: a new optional field or a new table is additive; a renamed
env var or a migration that rewrites tags is not.

## 3. Confirm with the user

Ask before editing anything. Offer the recommended bump first, **justified from
the diff**: name the commits and surface areas driving it. Always offer the
adjacent bump too, since the call is theirs. State plainly whether anything is
breaking and whether users must do something by hand (move data, set an env
var, rescan); those change their answer most.

## 4. Bump

```bash
pnpm version:set X.Y.Z         # ends with a check; every line must say ok
uv --directory packages/backend lock --check
```

Never edit version numbers by hand, and never run `uv lock` or `uv version`
here: both re-resolve dependencies and turn a release into an upgrade.

## 5. Write the CHANGELOG entry

**Every release gets an entry, including a patch.**

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Move what sits under `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` (the day
you cut it), leave an empty `## [Unreleased]` above it, and keep the link
references at the bottom current (replace any placeholder ones you find):

```
[Unreleased]: https://github.com/mNandhu/moire/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/mNandhu/moire/compare/v<previous>...vX.Y.Z
```

`[Unreleased]` is usually incomplete: read the commits from the scan and fill in
what never got written down, under `Added`, `Changed`, `Fixed`, `Removed`,
`Deprecated`, `Security` (only the headings you need).

Write for someone deciding whether to update, not for whoever wrote the code.
Name the symptom before the mechanism, pull specifics out of commit bodies
rather than paraphrasing subjects, and put anything the user must do by hand
right under the change that needs it. Internal refactors that change nothing
observable stay in the git log. This section becomes the GitHub Release notes
as is, so it must stand on its own.

## 6. Verify

```bash
uv --directory packages/backend run pytest -q
pnpm -C packages/frontend test
pnpm build
uv --directory packages/backend build --out-dir /tmp/moire-dist
unzip -l /tmp/moire-dist/*.whl | grep moire/web/index.html   # the UI is inside
```

## 7. Commit and tag

One commit on `main`, `Release vX.Y.Z`, holding only the version files and
`CHANGELOG.md`; check `git diff --cached --stat` lists `pyproject.toml`,
`uv.lock`, both `package.json` files and `CHANGELOG.md`. Then an annotated tag
on that commit:

```bash
git tag -a vX.Y.Z -m "Moiré X.Y.Z"
```

## 8. Push, only after the user says go

A pushed tag publishes a release, and a pushed tag is never moved or reused (a
broken release gets the next patch). Show the user the CHANGELOG section and
the tag, then on their go:

```bash
git push origin main && git push origin vX.Y.Z
```

Push `main` first so the tagged commit is on it. If `RELEASE_ENABLED` is not
`true` yet, say so: the tag is pushed but nothing is published.
