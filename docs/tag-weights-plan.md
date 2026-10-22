# Tag weights plan

Status: not started. Planned as its own session, with no other work running alongside it.

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

1. **Extraction (`services/reproject.py`).** Read each prompt term's weight while it is being extracted. Count `(x:1.2)` as 1.2, each `(...)` layer as ×1.1 and each `[...]` layer as ÷1.1, and give a group's members the group's weight. This is the same rule as the frontend's `lib/promptOutline.ts` `unwrap` / `readTerm`, so port it and test both against one shared fixture list.
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

## Order

1. Ctrl+Up/Down (frontend only, small, useful straight away).
2. Backend extraction, storage and tests.
3. Image view display.
4. Tag page occurrences and spread.
5. Gallery (optional).
