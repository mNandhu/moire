# Refactor pass tracker

Status of every finding from the 2026-10-22 pass. Details per ID in `catalogue.md`, themes and reasoning in `README.md`.

Legend: `[ ]` open, `[x]` done (commit hash), `[-]` dropped (reason). Tags: kind, size S/M/L, leverage L1-5, TW = tag-weights path. Update the line in the same commit as the fix.

Housekeeping, not findings:

- [ ] Fix CLAUDE.md: it names `nextCursorOf` (deleted); re-check the feed/cursor paragraph (L4.6)
- [ ] Remove `packages/frontend/test-optimizations.js` and unused devDependency `@vitest/coverage-v8` (knip)
- [ ] Sweep knip's unused exports in `leads.txt`

## P0. Bugs (verify with a failing test first)

- [x] **SCAN-UI** Library `scan_error` is never shown in the UI (bug, S), done dba7d9f
- [x] **L1.1** Retag of an image a running AI job already passed wipes its AI tags and reports success (bug, S, L4), done 369087a (review fixes: 7e913d5)
- [x] **S3.1** Renaming a source-specific tag moves the cover, focus and character settings of the shared base name (bug, S, L4), done 70c50d2
- [x] **S12.3** Deleting a hand-made character leaves its outfits, Default edits and hides behind (bug, S, L3), done 474174e (shared outfits kept: c39ea88)
- [x] **S6.3** AI worker loop dies on any error outside the per-image try, leaving the job 'running' and every later job queued forever (bug, S, L3), done 685b606
- [x] **S6.2** A failed model download is swallowed: download_wd_tagger returns paths and the load fails with a bare FileNotFoundError (bug, S, L3), done c60f8ce
- [x] **L3.2** Error toasts show raw JSON in ~25 places: three different error-to-text styles, errorText used only for onboarding/library flows (bug, M, L4), done 58a5424
- [x] **S13.2** Escape inside a Picker or DropdownMenu in a Dialog closes the whole Dialog (bug, S, L4), done 1e8f76a
- [x] **S1.1** Grouped gallery view is not refreshed or patched: flat feed always fetches, poll refetches the wrong query, removals skip groups (bug, S, L4), done 7265ec0
- [x] **L1.4** Async routes block the event loop on scan/watch thread joins (bug, S, L3), done 0818b57
- [x] **L4.1** Scan of a library whose root is missing deletes every image and its curation (bug, S, L5), done 5c1bf8d
- [x] **S1.7** Model, LoRA and embedding filter counts include quarantined images, Size counts do not; three facet routes are near-copies (bug, S, L2), done 48f2904
- [x] **S13.7** Sidebar defines NavButton as a component inside render, remounting every link on each shell render (bug, S, L2), done 9cf0d2f
- [x] **S2.6** Global keydown ignores modifier keys: Ctrl/Cmd+1..5, Alt+Arrow hijacked (bug, S, L3), done 2b2c81b
- [x] **S4.7** RenameTagDialog offers AI tags as merge targets when renaming a manual tag (bug, S, L2), done 31d89d7
- [x] **S5.7** Moving a library while it is scanning leaves the scan on the old folder and nothing rescans (bug, S, L2), done eaa8564
- [x] **S7.5** One malformed graph aborts a whole reprojection: extract is not total and the loop has no per-row guard (bug, S, L3), done a903e1d
- [x] **S8.8** Cancelled requests render as 'done' frames in the queue card (bug, S, L2), done e1b0a46
- [x] **S9.3** JsonTree branch toggle opens and closes every sibling branch at once (bug, S, L3), done fd9149b

Found later, outside the pass (in use, not by the review agents; the pass missed both):

- [x] **GRID-BLANK** Gallery grid renders no tiles while the "loaded" count climbs: when the page and grid mount in one commit (feed cached), the grid's first layout effect reads the page's scroller ref before React attaches it, bails, and never measures (bug, S, L4), done 6017a58
- [x] **TEST-DB** Backend tests could write to the real DB: `temp_db` never restored the settings and tests without it used the current path, so fixture rows (`L1:a`, ...) landed in the real gallery; now a session-wide temp DB/thumbs/logs fixture (bug, S, L3), done 91b321b (leaked rows deleted by hand)

P0 review fixes: 924e1e1 (UI batch), e86ea57 (data and library batch). Review findings left open:
- Dialog decides Escape by a selector of popup markers; the general fix (popups claim Escape, Dialog acts only on unclaimed ones) belongs with L3.4/L3.8. ChipInput and TagSearchInput comboboxes inside a dialog still lose Escape to it.
- DropdownMenu closes on Escape from both a wrapper handler and a document listener.
- JsonTree re-walks each subtree per entry for `forced` (quadratic on big graphs; predates the fix).
- Facet counts always leave quarantined images out, so the Quarantined view's filter dropdowns miss models used only there.

## P1. Tag-weights prerequisites

- [x] **L2.1** promptOutline (board) and prompt_parse (tags) read the same prompt differently; an unclosed bracket makes the board see one term (bug, M, L5, TW; moved from P0: fixed by the one-parser-per-side work), done 7e0a30d
- [x] **L4.2** Bulk prompt-tag write is a second, hand-synced copy of the tag-state write (invariant, S, L4, TW), done d2a8323
- [ ] **S7.1** Prompt weight rule exists nowhere yet; plan's premise is wrong and parsers disagree on brackets (drift, M, L5, TW), left for the tag-weights session (it is the feature)
- [x] **S7.2** Three more ad-hoc prompt splitters in the frontend duplicate promptOutline (dedupe, M, L4, TW), done f126a01, f965983
- [x] **S2.5** countTags re-implements prompt term splitting and weight stripping beside promptOutline (dedupe, M, L3, TW), done 50549a9
- [x] **S8.3** generation_compose holds a second, weaker prompt parser (prompt_terms, without_terms/_top_level_pieces) beside prompt_parse; escaped-paren auto-name bug (dedupe, S, L4, TW), done 0962a4c
- [x] **S7.3** Decompose prompt_parse._scan (complexity D30) and make it return group context (split, M, L4, TW), done 7f77697
- [x] **S7.4** Extraction inputs assembled by hand in two places; preview and reprojection can disagree; positive_only read by raw SQL (invariant, M, L4, TW), done 7036366
- [x] **L1.2** Reproject has five entry points with different guarantees; only reproject_all is serialized (invariant, M, L4, TW), done bcee4ae
- [x] **S3.7** Rule changes reproject synchronously in two of three paths while add_rules has a background threshold (invariant, S, L3), done c00be78 (frontend background note: aa26dd7)
- [x] **S2.1** Split ImageView.tsx into stage hook, details sheet and panel files (split, M, L5, TW), done 6c15b42, 44f5c28 (steps 1-3; the stepper and details-sheet hooks not extracted)
- [ ] **S4.8** tagFlow hides the prompt twin of an AI tag and toPromptText strips weights: both sit in the weights path (deepen, S, L4, TW), left for the tag-weights session (it is the feature)
- [x] **S10.1** PromptInput fuses suggestions, marked-term overlay and flash overlay; Ctrl+Up/Down would be eaten by the suggestion list (split, M, L5, TW), done 29b6951
- [x] **L2.5** Mirrored pure functions rely on comments and copy-pasted test cases instead of one fixture (drift, S, L3), done 7393a2c (auto-name cases: 146e2cb; kaomojis/compose/split_requests fixtures not done)
- [x] **S4.10** Cross-language mirrored vocabularies have no parity check (COLOURS, KAOMOJIS, canonicalName, Facet, merge KIND_ORDER) (drift, S, L2), done 7e5ffa5

P1 review fixes: frontend 8b15822, e193bb0, 76994ac (one `removeTerms` helper for every separator, bare and group weights, linear scan); backend a189140, 7e9fa71, da7316e, 13cee59, 9f8fd5e (rule changes and the watcher never wait on a running reprojection, whole-run lock, prose auto-name fallback, one column tuple, linear lookahead). Left open:
- An unclosed group ("(smile, red eyes") is never removed whole; removing all its members leaves a lone "(".
- The frontend splitter copies prompt_parse's emoticon list, PROSE_WORDS, ABBREV and JOINERS; only the shared fixture rows guard them (no kaomojis/compose/split_requests fixtures yet).
- A rule change computes its affected images before taking the reproject lock, so a run in flight with the old config can leave a stale tag outside that set.

## P2. Frontend data layer and shared UI primitives

- [x] **S2.2** Optimistic patch/undo recipe copied three times; hoist into feedCache (dedupe, S, L4), done e33b2a9
- [x] **S13.1** Gallery and image URLs are hand-built in a dozen places instead of through lib/imageFilter (dedupe, S, L4), done 9fad54d, d5f0fb6
- [x] **L3.1** Library scan state is polled four independent ways, including a hand-rolled fetch loop that duplicates fields the list already carries (dedupe, M, L4), done 51a86c7
- [x] **L3.3** api() has no JSON-body form: 21 hand-written Content-Type/JSON.stringify blocks and 5 private post/send helpers, plus 12 raw fetches with their own !ok handling (dedupe, M, L4), done 89b3797, 9ad6e39
- [x] **L3.4** Global keyboard handling is re-implemented in 12 window/document listeners with inconsistent guards; help table is a separate hand-kept copy (simplify, M, L4), done ad7a4b1 (help table still hand-kept)
- [x] **S10.3** PromptBoard: raw API fetch in a component, placement logic untested in-component, duplicated tag-cover map (boundary, M, L4, TW), done a0f734d
- [x] **S2.3** Character query hooks live in a component file imported by 10 modules (boundary, S, L3), done 97b910e
- [x] **S7.8** Same signatures query inlined in 3 components plus 2 manual fetches; ruleset API sits in lib/gen.ts with raw fetch (boundary, S, L3), done e323af0
- [x] **S5.5** Frontend library writes (create, edit, delete, rescan) are spread over four files with inconsistent cache invalidation (dedupe, S, L3), done 51a86c7
- [x] **S12.4** Tag-add combobox is written twice (AddTagInput, AttireTagInput) with a third weaker canonicalizer in NewCharacterDialog (dedupe, S, L3), done 9bf4d55
- [x] **L3.6** Query keys and invalidation bundles are scattered: bare-string keys, a duplicate of invalidateFeeds, and the same 2-3 invalidations pasted at 5+ sites (dedupe, S, L3), done 1f08d97
- [x] **S2.4** TagPanel doubles as a shared-widget module; image grid and Made-with block cloned in CharacterPage (dedupe, M, L3), done 865670f
- [x] **S1.4** imageFilter.ts mixes URL codec, API client and search-term logic; the gallery uses raw api() for tags, ids and a hand-rolled libraries poll (boundary, M, L3), done 3d1f35a
- [x] **S5.4** LibrariesPage runs its own raw-fetch progress poller beside useLibraries, which already polls the same fields (boundary, M, L3), done 51a86c7
- [x] **S4.3** /tags/samples fetched by hand in three places; Sample type lives in a component file (dedupe, M, L3), done a5bf46e
- [x] **S4.6** Suggestion-list keyboard nav and ranking copied across about 8 inputs; rankSuggestions/resourceLabel live in a component file (deepen, M, L3), done 9bf4d55
- [x] **L3.5** localStorage preferences hand-rolled in 14 places, two with no try/catch (gallery render can throw), keys use two naming schemes (dedupe, M, L3), done 1b377e8
- [x] **L3.7** Tag autocomplete text input is written five times (active index, moved flag, arrow/Tab/Enter/comma/Escape handling) (dedupe, M, L3), done 9bf4d55
- [x] **S11.5** 'Batch changed' cache invalidation and batch actions are hand-copied in four places, with inconsistent error handling (dedupe, M, L3), done a5bedc6 (backend retry-failed endpoint not done; client loop stays)
- [x] **S13.3** lib/queries.ts is a 475-line grab bag; split by domain and give api.ts a JSON-body helper (split, M, L3), done ab8a89d
- [x] **S13.4** Library API client is scattered; the Welcome wizard, AddLibraryDialog and LibrariesPage each call it raw (boundary, M, L3), done 51a86c7
- [x] **S2.7** Original-file URL built by hand five times in ImageView (dedupe, S, L2), done 9fad54d
- [x] **S2.10** Two hand-rolled localStorage external stores for view prefs (useTagMarks vs DETAIL_TAB_KEY) (dedupe, S, L2), done 1b377e8
- [x] **S7.9** BoilerplateSection and PromptGuessSection are the same chip-list editor written twice (dedupe, S, L2), done 988c006
- [x] **S1.8** useFilters reads and writes localStorage unguarded, unlike every sibling view-pref hook (invariant, S, L2), done 1b377e8
- [x] **S12.8** Outfit hooks live in component files and OutfitMenu re-implements the outfit queries inline (boundary, S, L2), done 61cda05 (OutfitMenu not split into its own file)
- [x] **S6.7** Generic formatters live in domain modules: two formatDuration with different output, formatBytes inside a React context file (naming, S, L2), done 3a354c8
- [x] **L3.8** Click-outside + Escape popover dismissal reimplemented in 8 components (dedupe, S, L2), done a20ff0a
- [x] **S11.8** Three time formatters for the same job: eta.clock, queueClock.countdown, batches.durationLabel/etaShort (dedupe, S, L2), done 3a354c8
- [x] **S9.7** Workflow-file import flow is written twice and lib/workflows.ts uses raw fetch (dedupe, S, L2), done 62b2da6
- [x] **L3.9** Pending-save handling split between 12 useMutation sites and 14 hand-rolled saving/busy flags; dialog footers and 'Saving…' buttons are copied (dedupe, M, L2), done 8603a87 (Generate area only)
- [x] **S10.9** Two parallel preset pickers and dialogs (prompt preset vs LoRA preset), plus a hand-rolled menu in AddLayer (dedupe, M, L2), done 40f3186
- [x] **S11.6** BatchResults.tsx (510 lines): review tile, running-cell view logic, failure labels and strip picker in one file; Tile keys ignore modifiers (split, M, L2), done e5d9868

P2 done 2026-10-24 (51a86c7..4f8dd84). Review fixes: wave 1 1a32926, 6fe6bd0, b05db83; wave 2 5b3b2dd, e27b994, efc3b0c. Left from finished items:
- L3.9 outside Generate: TagEditDialog, CharacterEditDialog (stuck `saving` flag), NewCharacterDialog, RenameTagDialog, BulkTagDialog and six settings sections still hand-roll save flags; use `Button pending` + `DialogFooter` from ui/Dialog.tsx.
- S11.5: one backend `POST /batches/{id}/retry-failed` would replace the client retry loop.
- S2.7 `loadImage` helper and a general `imageUrl(id, suffix)` for imageMutations' `forImage`; `useSizePresets` still in SizeFilter.tsx.
- Backend `/libraries/{id}/progress` is unused by the app; scripts/test-docker.sh and tests/perf_benchmark.py still call it. Move them to GET /libraries, then drop the route.
- `feedCache.patchImageEverywhere` is now only used by tests.
- LibrariesPage.test "drops both the flat feed and the grouped view on delete" flakes under full-suite load (passes alone).
- lib/shortcuts.ts help table is still hand-kept (L3.4); OutfitMenu not split into its own file (S12.8).

## P3. Backend dedupe, tag core, background work

**P3 status 2026-10-27.** P3 done: waves 1 and 2 merged, reviewed, fixed and pushed (..e4f00af). Next: P4 big-file splits. Open P3 tails: bulk_manual over 2000 ids can fail with earlier chunks applied (only the docstring says so); 9 eslint warnings in frontend not triaged. Wave 1 ran as 4 worktree lanes; each lane owns its files.
- Lane D (settings/AI jobs): merged on main (66743a1..966cc4a), full suites green. New: `services/app_settings.py`, `ai_tagger.TagParams`, `files_progress`, `aiJobPhaseLabel`/`cancelJobMessage`.
- Lane C (scanner/libraries): merged 552aded..b0ce609, full suite green. S5.8 behavior change: hidden/tilde/temp files are no longer indexed.
- Lane A (generation core): merged 69bf2d7..60bfd69, full suite green. New modules: comfy_history, generation_outputs, generation_inputs, generators_store, generation_errors, generation_states.
- Lane B (tag core): merged c518d20..895762f, full suite green (918 passed). S3.2 behavior change: a characters row with kind NULL is no override, so a series-backed bare name cannot be split and a colour-only row no longer makes a character. New: tag_kinds, image_visibility, tag_covers (pins+focus), tag_browse, character_names, tag_detail; tag_index is cache only.
- Code review of wave 1 (medium, 66743a1^..895762f): 10 findings. Fixed: 3af8af5 (S5.8 dropped rows of dotfile/~ images indexed before, stale-delete chunk retry), ee25e70 (add/edit library compare by path_key), d732e49 (just-ended AI job kept past prune cap, idle timeout resync per job), 143c242 (held_by -> innermost), 05c310a (one delete plan for sync/async). Left: image_delete re-SELECTs thumb_key callers already hold (minor), image_tags vocabulary re-exports (wave 2 leftover).
- Wave 2 after merge: L1.3; feed/images (L4.4, L4.5, S1.5, S12.7, S6.4); characters (S12.1, S12.2); Comfy periphery (S10.5, S4.2=S9.1, S9.2, L2.7+S9.8, L2.2+S11.2, S9.9); naming S3.10+S4.9; leftovers: L4.7 image_tags part (clear_ai_all, rename_manual), switch files still importing prefix helpers via image_tags re-exports, scanner stamp + prompt_presets still hand-roll app_settings rows.
- Wave 2 hints from lane B: S12.1/S12.2 take image sets from `tag_detail.image_ids`, character-ness from `character_names.character_names`, pins from `tag_covers.pins`; L4.5 builds on `image_tags.id_candidates`/`resolve_image_id`; switch api/images.py and ai_jobs `find_image` projections from dicts to column tuples; move the three remaining tag_meta writers (tag_migrations rekey, library_nesting repoint, characters.remove_made) into tag_covers. Lane worktrees under .claude/worktrees/ are merged and can be removed.
- Wave 2 launched 2026-10-27 as 3 worktree lanes (wave-1 worktrees removed). E background/feed (owns image_tags, scanner, ai_jobs, api/images, api/ai, activity; L4.4, L4.5 part, find_image tuples, S6.4, L1.3, L4.7 image_tags, scanner stamp, S1.5). F tags/characters, Opus (owns characters, recipes, outfits, image_feed, tag_covers, tag_index, api/tags; S12.2, S12.1, S12.7, L2.2 outfits, tag_meta writers, L4.5 set_tag_thumbnail, S3.10+S4.9). G Comfy periphery (owns presets, api/generate, workflow_family, api/rules, generator_*, remix, generation_*, comfy_*; S10.5 + prompt_presets app_settings, S4.2=S9.1 + rules preview resolve, S9.2, L2.7+S9.8 keeping lora_stem re-export, L2.2+S11.2+S9.9 via one limits module + TS parity test). Coordinator after merge: image_tags re-export cleanup, recipes lora_stem import, CONTEXT.md reconcile, full backend + frontend test/build.
- Wave 2 merged 2026-10-27 (48e2951..a976be3), full suites green. Behavior changes: /images/groups honors group_id; model/LoRA stem strips whitespace; plain tag pages skip the character look (empty palette/signature); set_pin stores the resolved id; /tags/rules is the merge-rule route (/tags/aliases kept, hidden); ExtractionConfig.aliases renamed rules. New: ai_coverage, outfit_wear, tag_rules, preset_store, model_names, generation_limits (+ lib/generationLimits.ts, lib/modelNames.ts, TS parity tests), lib/workflow.ts renamed lib/generatorRunBar.ts. Coordinator cleanup: image_tags re-exports removed, recipes imports model_stem, lora_stem alias dropped. Deviations: hasActiveFilter still counts libraryId (gallery empty state relies on it); family labels split into family_records + label because the Rules page matches files per signature. Code review of wave 2 (medium, bf0e70b..0ba849d): 7 findings. Fixed: 0ee6ea1 (rename_manual picks chunks inside the tx so mid-run tags are renamed; clear_ai_all reports rows rewritten; bulk_manual docstring), b7e485c (hasActiveFilter without URLSearchParams.size), c124712 (empty editor workflow id falls back to moire.family in SQL and Python). No change: model_stem case (old lora_stem was already case-insensitive; only whitespace trim is new), wardrobe cache keyed by raw tag (keeps a hit free of character_key). Lane G's 30-min pytest hang after 7203a7f not reproduced (55 passed in 12s), judged environmental. P3 done.
- Agent prompt preamble (shared rules) was in the scratchpad; recreate from the recipe in memory if gone.

- [x] **S8.1** Split generation_jobs.py by job and fix the jobs/estimate/batches import cycle (split, M, L5), done 69bf2d7
- [x] **L4.3** find_image ignores its projection, so every thumb/file request loads the whole image row (invariant, S, L4), done 895762f
- [x] **S8.2** Extract a pure build_batch_inputs from queue_batch (radon D24) and derive the requeue key list from it (deepen, M, L4), done 1c55b13
- [x] **S3.2** Two diverging definitions of 'is a character': tag_rename._character_names vs tag_index._characters (dedupe, M, L4), done 2d64168
- [x] **S5.2** Image-row deletion (rows, raw gen, thumbnails, tag index) is hand-written in five places (dedupe, M, L4), done 552aded
- [x] **S12.1** Character signature pipeline is written twice and recomputed uncached on every outfit request and image view (dedupe, M, L4), done 93a79c2
- [x] **S3.3** Split tag_index.py: cache primitives, cover pins, browse, character classification and the detail panel are fused (split, L, L4, TW), done 665ee8f
- [x] **L4.4** /images/groups re-declares the feed query parameters that feed_filter exists to share, and drops group_id (dedupe, S, L3), done 48e2951
- [x] **L4.5** Image id lookup by hand-rolled id_candidates loops; set_tag_thumbnail skips the slash/backslash tolerance (invariant, S, L3), done 0b4035c, 58fb8a8, 6980342
- [x] **L1.5** Model download progress is summed three ways with different rules (dedupe, S, L3), done e001445
- [x] **S1.5** Filter axes are hand-listed in eight places and the aiTagged exclusivity rule is re-applied by each (simplify, S, L3), done 1b45704
- [x] **S5.6** Folder ancestry and 'innermost library' are implemented four ways (dedupe, S, L3), done 4d54e3a, 143c242
- [x] **S12.2** characters.page computes the character-only look for every plain tag page (simplify, S, L3), done 7867045
- [x] **L2.2** Generation limits are copied into 2 to 3 files each with no link between them (drift, S, L3), done d37bb65, 30834dc
- [x] **S4.2** Workflow family id/name/file-match resolved twice with different code (rules._family vs generator_setup.load_image_source) (dedupe, S, L3), done 58fb8a8
- [x] **S11.2** Sampling bounds and MAX_CHARACTERS are each written in 3-4 places (dedupe, S, L3), done d37bb65
- [x] **L4.7** Unbounded write transactions: scanner stale delete, clear_ai_all, rename_manual (invariant, M, L3), done 552aded (scanner), 5fe095f (image_tags)
- [x] **S7.7** app_settings JSON-row read/upsert is hand-written in 8 modules; extraction_settings has it 4 times (dedupe, M, L3), done 66743a1
- [x] **L1.3** 'Ended' is counted four ways; the activity router reaches into each manager's internals (deepen, M, L3), done 23b2af0
- [x] **L1.6** scan_library_async._run is a 270-line closure; cancel is a string-matched RuntimeError checked inline four times (split, M, L3), done e6931a7
- [x] **S3.4** Cover pins and focus (tag_meta, tag_focus) are written from five modules including the router (boundary, M, L3), done eb7d53c (remaining tag_meta writers moved into tag_covers 812edbc)
- [x] **S3.8** Split image_tags into a pure tag-kinds vocabulary and the writer; this removes the tag_index import cycle (deepen, M, L3, TW), done c518d20
- [x] **S6.1** Tagger parameters and defaults are spelled in several places; SettingsPatch is a hand-synced copy of DEFAULT_AI_SETTINGS (dedupe, M, L3), done d95ce59
- [x] **S10.5** prompt_presets and lora_presets are the same CRUD service written twice, with two PresetError classes and doubled route error mapping (dedupe, M, L3), done 7203a7f
- [x] **S9.1** Workflow family naming (name, matched file) is implemented in api/rules.py and again in generator_setup.image_source (dedupe, M, L3), done 58fb8a8
- [x] **S9.2** Graph primitives are scattered and imported by private name; stock LoRA loader check is spelled six times (boundary, M, L3), done 6948dca
- [x] **L1.7** GenerationManager fuses connection, poll state machine, output placement and batch building (split, L, L3), done 1334f76
- [x] **S8.7** Request/batch state vocabulary is spelled out in five places (dedupe, S, L2), done 60bfd69
- [x] **L1.8** AIJob bookkeeping: jobs never pruned, ids stashed via setattr, tagger idle loop started by the wrong owner, no stop (simplify, S, L2), done dde99c1
- [x] **L1.9** Generation request-state vocabulary spelled five times (dedupe, S, L2), done 60bfd69
- [x] **S3.10** 'alias' names three different things; the user's merge rules are still called aliases in code and routes (naming, S, L2, TW), done 5b4a4ad
- [x] **S5.8** What counts as an indexable file is decided in three places and the rules disagree (drift, S, L2), done d6f701e
- [x] **S5.9** Thumbnail key is built by two formulas, and the thumb_format setting is half implemented (invariant, S, L2), done b0ce609
- [x] **S12.7** Outfit wear rule is implemented twice: pure `wears` and a hand-copied SQL condition in the feed (dedupe, S, L2), done ee1cf25
- [x] **L2.7** LoRA file-stem rule is implemented three times (gen_metadata.lora_name, generator_graph.lora_stem, two frontend copies) (dedupe, S, L2), done 40f4e19
- [x] **S4.9** Merge rules are called 'aliases' in the frontend (useTagAliases, TAG_ALIASES_KEY, /tags/aliases) but 'Merge rule' in CONTEXT.md (naming, S, L2), done 5b4a4ad
- [x] **S6.4** 'Untagged' and 'not quarantined' are defined in two parallel queries beside the feed's own filter (dedupe, S, L2), done 4dd199c
- [x] **S6.5** Job state wording and the cancel adapter are spelled in three UI paths that disagree (dedupe, S, L2), done 966cc4a
- [x] **S9.8** lora_stem is a model-name rule living in the graph module; workflow.ts / workflows.ts / WorkflowFamily names collide (naming, S, L2), done 40f4e19
- [x] **S9.9** ComfyUI connection save-and-test is implemented in ComfySection and ComfyStep; per-request clamp lives in four places (dedupe, S, L1), done d37bb65, 80c35ee

## P4. Big-file splits (pure moves, check in the app)

P4 status (2026-10-27, stopped at 5h limit): backend wave = 3 worktree lanes. Lane J merged on local main (54256b0..e219719, NOT pushed, full suite not yet rerun on main). Lanes H and I were stopped mid-work; branches + locked worktrees kept:
- H `worktree-agent-a26ccb254626faddc`: committed S5.1, S8.4, S8.5, S11.1, S13.9, S5.10 (2cda3e4..4f2f424); uncommitted edits in api/generate/comfyui.py, services/comfy_connection.py (was finishing up; inspect, commit or drop).
- I `worktree-agent-a47c4fb5b5b34f51e`: committed S7.6, S4.1, S9.10, S5.3 (541d4ab..8cd044e); S1.6 half done uncommitted (api/images.py, new api/image_facets.py, api/image_media.py).
Resume: finish S1.6, cherry-pick H then I (lane J edited a lora_suggestions call in old api/generate.py: expect conflict with H's package split), full suites, route diff vs scratchpad routes_before.json (regenerate at 2e3ca49 with scratchpad/routes.py if lost), CONTEXT.md renames (J: tag_views, lora_words, character_look, characters.named, attire tag_key/entries/groups_of/facet_of_entry; H, I: see their commit messages), tick, push. Then frontend wave (2 lanes: generate side S10.2 S10.8 S11.3 S11.7 S12.5 S12.6; gallery/tags/rules/setup S1.2 S4.4 S4.5 S9.6) + check pages in the app. Code review deferred until asked.

- [ ] **S8.4** api/generate.py is eight routers in one file, with service logic in put_comfyui and quadruplicated error mapping (boundary, M, L4)
- [x] **S1.3** (f1cf306) feed_where (radon F48) and _drive_by_rarest each re-derive the same tag groups and prompt-term list (dedupe, M, L4)
- [ ] **S5.1** Library lifecycle lives in api/libraries.py and is reused by calling route handlers from another router (boundary, M, L4)
- [ ] **S4.1** api/rules.py is a service layer inside a router: 170-line list_signatures, route calling route, no rulesets/workflow-names module (boundary, M, L4)
- [ ] **S10.2** Pure form logic and board-layer building live inside the 680-line GeneratePage component (boundary, M, L4)
- [ ] **S1.2** AllImagesPage (1338 lines) fuses polling, shortcuts, triage, bulk actions, filter option queries and the whole filter panel (split, L, L4)
- [ ] **S8.5** Route handlers call each other and build the full batch view just to 404; list/status do repeated queue_plan work (simplify, S, L3)
- [ ] **S7.6** gen_metadata.py (1073 lines) fuses four jobs; callers reach into a private function (split, M, L3)
- [x] **S3.6** (54256b0) api/tags.py builds service-level caches and repeats a library-bases query (boundary, M, L3)
- [ ] **S1.6** api/images.py is four routers in one file and its route order is load-bearing; original-file GET/HEAD repeat path resolution (split, M, L3)
- [ ] **S5.3** scanner.py (898 lines) fuses thumbnail rendering, scan stamp, reconcile policy, watcher entry points and the scan thread (split, M, L3)
- [ ] **S12.5** CharacterBlock.tsx (795 lines) mixes the picker, the recipe editor and the composer rows; the editor is imported across layers (split, M, L3)
- [ ] **S12.6** SaveOutfitDialog fuses four modes and its seed and save-plan logic is untestable inside the component (split, M, L3)
- [ ] **S4.4** RulesPage is one 760-line component doing picker, import, rename, collapse, rule editor, preview and graph search (split, M, L3)
- [ ] **S4.5** TagsPage (844 lines) mixes rule/rename mutations with toast copy, five card components and a sheet layout (split, M, L3)
- [x] **S10.6** (52c9588) lora_presets.py mixes CRUD with library analytics SQL and keeps its own ad-hoc TTL cache beside tag_index (split, M, L3)
- [x] **S10.7** (fbafe43) prompt_board._section is a 39-complexity if-ladder that reaches into attire's private functions (simplify, M, L3)
- [ ] **S11.1** Split remix_view (E35) into light and full reads; move the image-to-batch lookup and settings readers out (split, M, L3)
- [ ] **S11.3** RunControls.tsx is a form-widget grab bag; stemOf (LoRA/checkpoint name rule) lives in it and 5 modules import it (boundary, M, L3)
- [ ] **S5.10** library_watch.py mixes a child-process supervisor with per-library event routing; _write_loop is radon D21 (split, M, L2)
- [x] **S12.9** (726c424+e219719) characters.py (811 lines) fuses pure look statistics, character IO, the listing and the settings CRUD (split, M, L2)
- [ ] **S10.8** generateForm.ts (548 lines) fuses form model, stored-draft validation, remix conversion and sampling display labels (split, M, L2)
- [ ] **S11.7** BatchPage mixes the prompt-inputs formatter, a rename editor and the stats strip; stats are re-derived beside OutputFeed's panel header (deepen, M, L2)
- [ ] **S9.6** WorkflowSetupPage is a 769-line file with a 270-line SetupForm and shared UI parked in the wrong modules (split, M, L2)
- [ ] **S13.9** main.py mixes wiring, a BaseHTTPMiddleware on every request, an in-memory rate limiter and the startup sequence (simplify, M, L2)
- [ ] **S9.10** discover() is one 90-line function (radon D27) mixing six slot readers; text_inputs and check_slots are D21 and D23 (split, M, L1)

## P5. Contracts, naming, dead code, housekeeping

- [ ] **L4.6** SORT_KEY / SCORE_KEY are defined twice (image_feed.py and schema.py); CLAUDE.md names a deleted nextCursorOf (drift, S, L3)
- [ ] **S3.5** PUT /tags/focus runs the full 8-query detail aggregate just to learn the pin and existence (simplify, S, L3)
- [ ] **S10.4** ChipInput component is dead; the file survives only as the home of bareTagPool (dead, S, L3)
- [ ] **S11.4** 'Which batch is in front / waiting' is derived three different ways (dedupe, S, L3)
- [ ] **S13.5** Sidebar owns nav data, shortcut text and platform detection that two other modules re-derive (dedupe, S, L3, TW)
- [ ] **S8.6** The Generator test gate lives in the 'read side' module and generator_view writes on GET (boundary, M, L3)
- [ ] **L2.3** No response models or generated types: every payload and closed vocabulary is typed by hand on both sides (boundary, M, L3, TW)
- [ ] **S8.9** Rejected duplicates ComfyRejected, and non-ComfyUI failures are raised as ComfyRejected (naming, S, L2)
- [ ] **S2.8** imageMutations holds tag and character writes, contradicting its 'per-image' contract; JSON boilerplate repeated (naming, S, L2)
- [ ] **S2.9** Rating vocabulary spread over three places; ratingBadgeClass has a phantom 'safe' (drift, S, L2)
- [ ] **L4.8** Original files are served 'immutable' for a year at an unversioned URL (invariant, S, L2)
- [ ] **L4.9** Native window.confirm still reachable through useRulesetSession default in ResolvePromptDialog (invariant, S, L2)
- [ ] **S3.9** GET /tags (non-merged) computes thumbnails and pins nothing reads (dead, S, L2)
- [ ] **S1.9** Per-tile preResolved/resolveMediaUrl branch in the load slot is dead for the gallery; density clamp written four times (dead, S, L2)
- [ ] **S1.10** Grid column count is measured twice, and tile crossfade state machine lives inside ThumbnailTile (deepen, S, L2)
- [ ] **L2.4** Hair/eye colour palette is copied into tagColour.ts with only a comment tying it to characters.COLOURS (dedupe, S, L2)
- [ ] **L2.6** canonicalName exists on the frontend but five call sites inline their own whitespace-to-underscore rule (invariant, S, L2)
- [ ] **L2.8** Character name/series split is frontend-only while the backend returns overrides only (boundary, S, L2)
- [ ] **S11.9** Dead or test-only code: requestFrames fallback, fixedSeeds, optional `frames`, unused Frame/FrameState exports (dead, S, L2)
- [ ] **S9.4** Setup payload computes fields nothing reads, and the page's checklist re-derives the server's checks (dead, S, L2)
- [ ] **S13.6** App.tsx re-implements lib helpers and carries 70 lines of key-scroll logic plus a raw health fetch (boundary, S, L2)
- [ ] **S13.8** Dead backend pieces and stale Mongo-era docs: models/image.py, models.library.Library, Settings.ai_tagging_url, db.write_lock()/sync_write_lock() (dead, S, L2)
- [ ] **S13.10** SettingsContext is the AI-tagging controller under a generic name, and wraps every settings tab (naming, S, L2)
- [ ] **S6.6** GET /ai/faces enqueues every avatar; face worker state is module globals and rides the AI router and settings blob (boundary, M, L2)
- [ ] **S6.8** AITaggingPage borrows page-level components from settings/sections and mounts the whole settings controller (boundary, M, L2)
- [ ] **S8.10** Test-only wrappers in generation_estimate and an unused on_state hook in the client (dead, S, L1)
- [ ] **L4.10** Deprecated POST /tags/ai/{image_id} has no caller (dead, S, L1)
- [ ] **L1.10** Dead helpers: scanner.file_hash and ai_tagger_download._download_if_missing (dead, S, L1)
- [ ] **S12.10** CharactersSection does raw face-status fetches and hosts a Generate setting; test-only and unused exports linger (boundary, S, L1)
- [ ] **S6.9** Settings readers go through the ai_jobs re-export shim while others import ai_settings directly (simplify, S, L1)
- [ ] **S10.10** The `embedding:` word spelling is hand-built in four places beside compose.ts's EMBEDDING_PREFIX (dedupe, S, L1)
- [ ] **S9.5** newer_version has an always-false branch and a duplicated field (dead, S, L1)
