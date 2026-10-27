You are one lane of a parallel refactor pass on Moiré (pnpm monorepo: FastAPI/SQLite backend in packages/backend, Vite/React/TS frontend in packages/frontend). You work in your own git worktree. Other lanes are editing other files at the same time, so stay inside the files your lane owns; if an item truly needs a file outside your lane, do the minimum there and say so in your final report.

Read first: CLAUDE.md and CONTEXT.md at the repo root. The findings are in docs/refactor-pass/catalogue.md (search by ID). The catalogue was written BEFORE a big refactor wave: line numbers and some function locations are stale (generation_jobs.py and tag_index.py were split; new modules include tag_kinds, image_visibility, tag_covers (pins+focus), tag_browse, character_names, tag_detail, app_settings, comfy_history, generation_outputs, generation_inputs, generators_store, generation_errors, generation_states, library_nesting, image_delete; then P3 wave 2 added preset_store, workflow_family, generator_graph, model_names, generation_limits, outfit_wear, tag_rules, ai_coverage, lib/modelNames.ts, lib/generatorRunBar.ts, lib/generationLimits.ts). Grep the current code; do not trust catalogue line refs. If an item turns out to be already fixed or wrong, skip it and say why.

Setup:
- First: `git log --oneline -1` and make sure you are at main's tip (b30d83d or later). If the worktree is behind, `git merge --ff-only main`.
- Backend: `uv --directory packages/backend sync` once. Never call `python` directly; use `uv --directory packages/backend run ...`. `uv --directory` changes cwd, so give scripts absolute paths.
- Frontend (only if your lane has frontend work): prefix every node command with
  `unset -f node npm yarn pnpm npx 2>/dev/null; export PATH="/home/mnand/.nvm/versions/node/v24.15.0/bin:/home/mnand/.local/share/pnpm:$PATH";`
  If node_modules is missing in the worktree, run `pnpm install --frozen-lockfile` (or symlink from /home/mnand/Projects/Tagify). NEVER commit node_modules or a node_modules symlink: check `git show --stat` after each commit.

Rules (project invariants):
- services/image_tags.py is the only tag mutator. A writer that owns its transaction calls tag_index.invalidate() after commit; don't clear the cache from call sites otherwise. Use async_tx/sync_tx from database/db.py.
- Tag names are canonical (underscores). No em dash characters anywhere (code, comments, strings, commits). No native <select>/<datalist>. Thumbnail URLs only via thumb_url/useThumbUrl. No UI helper subtext. Tests never touch the real data/moire.db (use the conftest fixtures).
- Match surrounding code style and comment density. Keep public response shapes unchanged unless the item says otherwise.
- This is P5: contracts, naming and dead code. Do what each item's catalogue Proposal says; small behaviour changes the Proposal calls for are fine, anything bigger or ambiguous: skip and report. Keep public response shapes and URLs unless the item says otherwise (removing a dead route the item names is fine). Tests: when you delete dead code delete its tests; when you add a parity check or fix a slip, add a test. A bug-ish item (a slip) gets a test that fails before the fix where practical.
- Import rule: update callers to import from the new home; no re-export shims. You may edit import lines (only) in files owned by the other lane.
- Monkeypatch drift: when a function moves, grep tests for `monkeypatch.setattr(`/`patch(` targets naming the old module and repoint them. A patch on the old module can keep passing while patching nothing.
- Do NOT edit CONTEXT.md (coordinator owns it). List every renamed/moved name it should mention in your final report.
- Before moving anything, check whether P3 already did part of the item (new modules above); skip what is done and say so.

Testing: run only targeted tests for the files you touch (backend: `timeout 600 uv --directory packages/backend run pytest -q -p no:cacheprovider tests/test_x.py ...`; frontend: `pnpm -C packages/frontend test src/lib/x.test.ts`), plus `uv --directory packages/backend run ruff format src tests` and `ruff check src tests`; for frontend changes also `pnpm -C packages/frontend exec tsc -b` and eslint on touched files. If you rename or move a frontend file or change a mirrored vocabulary/constant, also run backend tests/test_mirrored_vocab.py (it reads TS sources by path). The coordinator runs the full suites at merge.

Wrap every pytest run in `timeout 600`.

Commits: one commit per item (combined IDs like S4.2+S9.1 may share one), on your worktree branch. Message: imperative summary ending with the ID in parens, e.g. "Resolve image ids through resolve_image_id everywhere (L4.5)", a short body if useful, then exactly these trailer lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WFrPWuQBLjfLVu523cUaXp
Do NOT edit docs/refactor-pass/TRACKER.md. Do not push.

Final report (your last message, plain text): per item, the commit hash, what changed, any behavior change, anything skipped or left, and any file you had to touch outside your lane. Keep it compact.
