# Tag weights plan

Status: steps 1 to 4 done 2026-10-27 (cfb0aa1..9e1a9cf); step 5 (gallery) skipped by decision.

## Decisions (2026-10-27)

- **Rule by source.** `Piece.weight(gen.source)`: ComfyUI (only a closed `(` weighs, x1.1; an explicit `:w` replaces the outer weight, as `comfy/sd1_clip.py` `token_weights` does) or A1111 (every `(` multiplies, `[` divides by 1.1, closed or not). `{}` is 1.0 for both; bare `smile:1.05` outside parens is 1.0 (neither tool reads it). One shared fixture: `tests/fixtures/mirrored/prompt_terms.json` rows carry `[name, kind, comfyui, a1111]`; the frontend checks the ComfyUI column.
- **Storage.** `gen.prompt_weights` (positive prompt only, terms not at 1, a repeated term keeps the weight farthest from 1, carried through merge/split rules) plus a derived `weight` column on `image_gen_terms` (1.0 default) for aggregates and future `smile > 1.2` filters. `image_tags` and its writer are untouched. Migration `gen_term_weights` recreates the table and reprojects.
- **Image view.** The tag run shows the weight (amber number, "prompted at 1.2" in the bubble) on whichever entry lists the prompted name. The Prompt tab already shows the raw prompt, so it is unchanged. Copy tags writes `(name:w)`.
- **Tag panel.** "Prompt weight: 0.8 to 1.4, mostly 1.2" from `/tags/detail` `weights`.
- **Gallery.** Skipped: tiles have no hover tag list.
- **Ctrl+Up/Down** (`promptEdit.bumpWeight`) starts from the weight ComfyUI reads, so a member of `(a, b:1.2)` goes to 1.25, not 1.05.

Open: weights filter in the gallery (`smile > 1.2`) if wanted; A1111-syntax encode nodes inside ComfyUI graphs (smZ) are read with the ComfyUI rule.

## Goal

A prompt weight changes the image a lot: `(smile:1.4)` and `smile` produce different results. Moiré should record each image's prompt weights and show them wherever a prompt tag shows: the gallery, the image view's Prompt tab and tag lists, and tag occurrences. Generate's Prompt card (the "Master Prompt") also gets keys to change a weight.

## Why not `blue_eyes:1.2` in `tags`

Writing `blue_eyes:1.2` into the existing `tags` entry was the first idea. It would break:

- **The single spelling rule.** `canonical_tag` and `canonical_name` treat a tag as its name. `prompt:blue_eyes:1.2` and `prompt:blue_eyes` would become two tags.
- **`image_tags` joins and counts.** The Tags page, `GROUP BY` counts, `$in`/`$all` filters, the tag index cache and samples would all split one tag by weight.
- **The AI/prompt overlap.** "Prompted, not seen" adherence compares AI and prompt tags by name.
- **Every filter, rename, merge rule and tag description.** All of them key on the name.

So the weight stays out of the tag string and is stored beside it.

## Proposed shape

1. **Extraction (`services/prompt_parse.py`, used by `reproject.py`).** Read each prompt term's weight while it is being extracted. Count `(x:1.2)` as 1.2, each `(...)` layer as ×1.1 and each `[...]` layer as ÷1.1, and give a group's members the group's weight. Decide `{...}` at the start (×1.05 as in A1111, or 1.0); today the backend treats `{}` as a group and the frontend does not.
   - **Correction (refactor pass, 2026-10-22):** this rule does not exist anywhere yet. `lib/promptOutline.ts` `unwrap` / `readTerm` read only an explicit `:w` (or the enclosing group's), never ×1.1 per layer, and ignore `{}`. So there is nothing to port. Define the rule once, backend first, in `prompt_parse` (`_scan` already tracks the bracket stack, but `_clean` drops the weight, `Piece` is only `(text, kind)` and `tokenize_prompt` reduces pieces to a set of names). Then make `readTerm` compute the same thing. Put the cases in one shared JSON fixture (e.g. `packages/backend/tests/fixtures/prompt_weights.json`) read by both `test_prompt_parse.py` and a `promptOutline` vitest.
2. **Storage.** Add `prompt_weights` (JSON `{tag: weight}`, only for weights other than 1) on `images`, or as a `weight` column on `image_tags` rows with `base` set to the prompt tag. The `image_tags` column is better if we want "images where smile > 1.2" filters later. The JSON column is simpler if we only display weights. Choose one at the start of the session.
   - No migration machinery: the data isn't critical. Drop the DB, or run a reproject ("re-read prompts") after the schema change.
   - Writes go only through `services/image_tags.py` (the single-writer rule).
3. **API.** Image detail returns the weights. List and feed responses stay minimal: add weights there only if a gallery tile needs them.
4. **UI.**
   - **Image view:** the Prompt tab and the tag run show `smile 1.4` (a small amber number, as the prompt board chips already do), with a tooltip.
   - **Gallery:** show the weight in the tile's hover tag list, if there is one, or skip the gallery. Decide in the session.
   - **Tag page and panel (occurrences):** show the weight spread, for example "used at 0.8 to 1.4, mostly 1.2". This needs a per-tag aggregate over the chosen storage.
5. **Generate, Prompt card: Ctrl+Up and Ctrl+Down.** Do this first slice in the frontend only.
   - With a selection, or the caret inside a term, Ctrl+Up raises its weight and Ctrl+Down lowers it, in steps of 0.05 (ComfyUI's step).
   - It wraps the text as `(term:1.05)`, removes the wrapper when the weight returns to 1, and keeps the selection on the term.
   - Make it a pure helper in `lib/promptEdit.ts` (`bumpWeight(text, start, end, delta) -> {text, start, end}`) with tests, wired into `PromptInput.tsx`'s `onKeyDown`.
   - Add the keys to `lib/shortcuts.ts` (a "Generate" group).

## Prerequisites from the refactor pass (2026-10-22)

The refactor pass (`docs/refactor-pass/findings-wave1.json`) found these in this plan's path. Do them before, or at the start of, the weights session:

- **One bulk tag write path.** `image_tags.replace_prompt_many_sync` (the reproject path, the one that would carry weights) builds its own UPDATE with hard-coded flag bindparams, beside `_persist_statements`; `initial_tag_fields` hard-codes the flags a third time. A `prompt_weights` column added to the single-image path would silently be skipped by reproject. Derive all three from one column source, with a test that bulk and single writes produce identical rows.
- **One prompt splitter per side.** Besides `promptOutline`, the frontend splits prompts in `countTags.terms`, `promptRepeats.topTerms`, `compose.promptTerms` and `promptEdit.termAt`, each with different bracket and escape rules. The backend has a second, regex-based parser in `generation_compose.prompt_terms` (it mangles escaped parens in batch auto-names). Fold these onto `promptOutline.promptTerms` and `prompt_parse.parse_prompt` before adding weights, or `bumpWeight` becomes a fifth copy.
- **`prompt_parse._scan` (complexity 30).** Return the enclosing bracket stack instead of only `in_group: bool`, so `Piece.weight` can be computed.
- **One extraction config.** `reproject._reproject_where` and the rules preview gather extraction inputs (keywords, positive_only, aliases) separately and already disagree. Weights would add a step to both. Share a single `ExtractionConfig` and `derive()`.
- **Serialize reproject runs.** Only `reproject_all_async` coalesces. Overlapping runs can write stale `prompt:` tags, and weights would inherit the race.
- **Split `ImageView.tsx` first.** The weights UI edits `TagFlow` and the Prompt tab, both inside the 2166-line page. Move `TagFlow` and `GenPanel` out first, as a pure move.

## Order

1. Ctrl+Up/Down (frontend only, small, useful straight away).
2. Backend extraction, storage and tests.
3. Image view display.
4. Tag page occurrences and spread.
5. Gallery (optional).
