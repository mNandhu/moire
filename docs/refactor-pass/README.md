# Refactor pass, 2026-10-22

A read-only discovery pass over the whole codebase, ahead of a refactor / dedupe / architecture cleanup. This file collates the results into themes and a work order. Nothing here is verified beyond what the agents read: confirm each item (ideally with a failing test) before acting on it.

## Files

- `TRACKER.md`: status of every item (open, done with commit, dropped). Update it in the fixing commit.
- `README.md`: this file. Themes, priorities, work order.
- `bugs.md`: bugs found along the way, with status.
- `catalogue.md`: all 164 findings, full problem / proposal / evidence, by ID (`S2.3` = slice S2, finding 3).
- `findings-wave1.json`, `findings-wave2.json`: raw agent output.
- `slices.json`: how the code was split (13 vertical slices, 3.1k to 7.1k lines each).
- `leads.txt`, `raw-phase0/`: static-tool output (jscpd, ruff C901, radon, vulture, knip).

## How it was run

- Phase 0: static tools. Literal copy-paste is only 0.5% of lines, so the duplication below is mostly semantic (the same idea written differently).
- Wave 1 (5 agents): L4 rule audit, L1 job systems, S2 ImageView, S7 prompts, S8 generation engine.
- Wave 2 (12 agents, all Sonnet): the remaining slices plus L2 (Python/TS drift) and L3 (frontend primitives).
- No adversarial verify pass was run (Pro plan budget). Verification happens per item at fix time instead.

## Priorities

- **P0. Bugs** (`bugs.md`). Fix first, one commit each, test first.
- **P1. Tag-weights prerequisites** (theme A, and B's write path). They block the next feature; see `docs/tag-weights-plan.md` "Prerequisites".
- **P2. Shared primitives with many call sites** (themes D, E). Mechanical, low risk, high leverage: each removes a pattern repeated 5 to 25 times.
- **P3. Backend dedupe and job systems** (themes C, G).
- **P4. Big-file splits** (theme F). Pure moves, but high churn, and the frontend ones need the app running to check.
- **P5. Contracts, naming and dead code** (themes H, I). Batch them; do a few whenever nearby code is touched.

## Themes

### A. One prompt grammar (P1, tag-weights path)

The prompt is parsed by at least 6 independent implementations that disagree on `{}`, escapes, `<lora:>` and unclosed brackets.

- Backend: `prompt_parse` (canonical) and `generation_compose.prompt_terms` (regex, mangles escaped parens): S8.3.
- Frontend: `promptOutline` (the board) and `countTags`, `promptRepeats.topTerms`, `compose.promptTerms`, `promptEdit.termAt`: S2.5, S7.2.
- They already disagree visibly: an unclosed bracket makes the board see one term (L2.1, a bug).
- The weight rule the plan assumed does not exist: S7.1. `_scan` should return its bracket stack: S7.3.
- Weights in the UI paths: `tagFlow` hides the prompt twin of an AI tag and `toPromptText` strips weights (S4.8); PromptInput's suggestion list would eat Ctrl+Up/Down (S10.1).
- Fix shape: one parser per side, plus a shared JSON fixture read by both test suites (L2.5, S4.10).

### B. Tag core and the write path (P1 for the write path)

- Bulk prompt-tag write is a second hand-kept copy of the tag-state write: L4.2 (blocks weights).
- One extraction config for reproject and rules preview: S7.4. Serialize reproject runs, one spawner: L1.2. Rule changes reproject synchronously on two of three paths: S3.7.
- `tag_index.py` fuses five jobs: S3.3. `image_tags` should split vocabulary from the writer (removes an import cycle): S3.8.
- Cover pins and focus written from five modules: S3.4. Two definitions of "is a character": S3.2.
- `find_image` ignores its projection on the hottest read path: L4.3. Hand-rolled id lookups that skip slash normalisation: L4.5.
- Naming: "alias" means three things; merge rules are still "aliases" in code and routes: S3.10, S4.9.

### C. Background work (P3)

AI jobs, generation, scanning, the watcher, downloads, reproject and activity each run their own queue, cancel, progress and status logic.

- "Ended" counted four ways and the activity router reaches into each manager: L1.3. Download progress summed three ways: L1.5.
- Generation request-state vocabulary spelled five times: L1.9, S8.7 (same finding twice). Job state wording in the UI: S6.5.
- AIJob bookkeeping (never pruned, setattr ids, wrong owner for the idle loop): L1.8.
- Splits: `scan._run` 270-line closure with string-matched cancel (L1.6), `GenerationManager` (L1.7), `generation_jobs.py` with an import cycle (S8.1), `queue_batch` (S8.2).
- Bugs here: L1.1, L1.4, S6.2, S6.3.
- A shared primitive looks worthwhile for cancel and progress only; queue semantics really differ. Decide after reading L1's health note in the catalogue.

### D. Frontend data layer (P2)

- `api()` has no JSON-body form: 21 hand-written stringify blocks, 5 private post helpers, 12 raw fetches with their own error handling: L3.3, S13.3.
- Error-to-text: raw JSON in about 25 toasts, three styles: L3.2 (a visible bug).
- Query keys and invalidation bundles scattered and duplicated: L3.6. Batch-changed invalidation hand-copied four times: S11.5. Optimistic patch/undo copied three times: S2.2.
- Library scan state polled four ways: L3.1, S5.4. Library API calls scattered: S5.5, S13.4.
- Raw fetches in components or the wrong module: S1.4, S4.3, S7.8, S9.7, S10.3, S12.8, S2.3.
- `lib/queries.ts` is a 475-line grab bag: S13.3.

### E. Frontend shared UI primitives (P2)

- Tag autocomplete input written five times (L3.7), suggestion keyboard nav and ranking about 8 times (S4.6), a tag-add combobox twice (S12.4). One `useTagAutocomplete` covers all three.
- Global keyboard handling in 12 listeners with inconsistent guards, help table hand-kept: L3.4. Modifier-key bugs fall out of this: S2.6, S11.6.
- localStorage prefs hand-rolled 14 times, two unguarded: L3.5, S1.8, S2.10.
- Click-outside + Escape dismissal 8 times: L3.8. Pending-save flags 14 times: L3.9.
- URLs hand-built about a dozen times: S13.1, S2.7.
- Formatters: three time formatters (S11.8), two `formatDuration`s (S6.7).
- Copy-paste pairs: BoilerplateSection vs PromptGuessSection (S7.9), TagPanel vs CharacterPage (S2.4), two preset pickers (S10.9).

### F. Big files (P4)

Each has concrete split lines in the catalogue.

- Frontend:
  - ImageView 2166 lines (S2.1, do TagFlow/GenPanel first for weights)
  - AllImagesPage 1338 (S1.2)
  - GeneratePage (S10.2)
  - TagsPage (S4.5)
  - RulesPage (S4.4)
  - CharacterBlock (S12.5)
  - SaveOutfitDialog (S12.6)
  - WorkflowSetupPage (S9.6)
  - BatchResults (S11.6)
  - BatchPage (S11.7)
  - RunControls (S11.3)
  - generateForm.ts (S10.8)
- Backend:
  - `api/generate.py` is eight routers in one file (S8.4)
  - `api/images.py` is four, with load-bearing route order (S1.6)
  - `api/rules.py` is a service inside a router (S4.1)
  - `api/libraries.py`: library lifecycle, called route-to-route (S5.1)
  - `api/tags.py` builds service caches (S3.6)
  - route handlers call each other (S8.5)
  - `scanner.py` (S5.3)
  - `gen_metadata.py` (S7.6)
  - `characters.py` (S12.9)
  - `library_watch.py` (S5.10)
  - `lora_presets.py` (S10.6)
  - `remix_view` (S11.1)
  - `discover` (S9.10)
  - `prompt_board._section` (S10.7)
  - `feed_where` (S1.3)
  - `main.py` (S13.9)

### G. Backend duplication (P3)

- Image-row deletion (rows, raw gen, thumbs, tag index) written five times: S5.2.
- `app_settings` JSON-row read/upsert written in 8 modules: S7.7. Tagger settings defaults spelled several times: S6.1.
- Prompt presets vs LoRA presets, same CRUD twice: S10.5.
- Workflow family naming twice: S4.2, S9.1 (same finding). Graph primitives imported by private name: S9.2.
- LoRA stem rule three times: L2.7, S9.8, S11.3 (`stemOf`).
- Generation limits and sampling bounds in 3 to 4 places: L2.2, S11.2, S9.9.
- Character signature pipeline twice and uncached: S12.1, S12.2. Outfit wear rule in Python and in SQL: S12.7.
- Feed: `/images/groups` re-declares feed params and drops `group_id` (L4.4); feed_where and the rarest-tag driver re-derive groups (S1.3); filter axes hand-listed 8 times (S1.5); facet routes near-copies (S1.7); "untagged" defined twice (S6.4).
- Libraries: folder ancestry four ways (S5.6), indexable-file rule three ways (S5.8), thumbnail key two formulas (S5.9).
- Unbounded write transactions: L4.7.

### H. Python and TypeScript contracts (P5)

- No response models or generated types: L2.3. Large; decide whether it is worth it before the others.
- Mirrored vocabularies with no parity check: COLOURS (L2.4), canonicalName inlined five times (L2.6), the character name/series split (L2.8), the rating vocabulary (S2.9), `SORT_KEY` defined twice (L4.6).

### I. Dead code and housekeeping (P5)

- Dead code:
  - L1.10, L4.10, S3.9, S8.10, S9.4, S9.5, S10.4, S11.9, S12.10, S13.8, S1.9
  - knip's unused exports (in `leads.txt`)
  - `test-optimizations.js` and `@vitest/coverage-v8` in the frontend
- **CLAUDE.md is stale:** it names `nextCursorOf`, which no longer exists (L4.6).
- Rule slips:
  - native `window.confirm` reachable (L4.9)
  - originals served `immutable` at an unversioned URL (L4.8)
  - `useFilters` reads localStorage unguarded (S1.8)
- Odd ownership:
  - SettingsContext is really the AI-tagging controller (S13.10)
  - AITaggingPage borrows settings components (S6.8)
  - `/ai/faces` GET enqueues work (S6.6)

## Suggested work order

1. P0 bugs, highest damage first:
   - Data or curation loss: L1.1, S3.1, S12.3.
   - Stuck work: S6.3, then S6.2.
   - Visible UI breakage: L3.2, S13.2, S1.1, SCAN-UI.
   - Then the rest.
2. Tag-weights prerequisites, as the first part of that session: L4.2, then A (one parser per side + fixture), S7.4, L1.2, then the ImageView TagFlow/GenPanel move.
3. Frontend primitives, each one commit: the `api()` JSON body + `errorText` everywhere (L3.3, L3.2), query keys (L3.6), `useLocalPref` (L3.5), `useTagAutocomplete` (L3.7, S4.6, S12.4), the keyboard registry (L3.4).
4. Backend dedupe: S5.2, S7.7, S10.5, the generation vocabulary (L1.9), LoRA stem, the limits module.
5. Big-file splits, one file per commit, with the app open to check.
6. Dead code sweep and CLAUDE.md fixes in one commit.

Each step: commit, then `/code-review` on non-trivial ones, per the usual flow.
