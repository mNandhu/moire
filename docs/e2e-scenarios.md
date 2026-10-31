# E2E scenarios to cover

Scenarios worth testing end to end, for the Playwright suite in `packages/e2e` (how it runs: CONTRIBUTING.md, "E2E"). Add one entry per scenario: where, steps, expected. Once a spec covers it, say which under the heading.

## Covered

- Onboarding: welcome flow adds a folder and connects the fake ComfyUI, the scan indexes every image (`onboarding.setup.ts`)
- Gallery: scrolling pages in the rest of the feed; a searched tag filters the gallery and survives a reload from the URL; selection mode from the toolbar and the phone View options menu; Edit tags adding and removing a manual tag on a whole Select all (`gallery.spec.ts`)
- Generate: every Clear and Undo scenario below (`generate-clear-undo.spec.ts`); Ctrl+Up/Down weigh the tag under the caret (`generate-prompt-keys.spec.ts`); a run on the fake ComfyUI lands its images in the output library, with the Images stepper and the batch name's rename, Escape and auto name on the way, then a rename on its batch page (`generate-run.spec.ts`)
- Viewer: prompt weights on the Tags tab, a ComfyUI prompt escaped twice, adding manual tags, setting a score, arrow keys through the feed, also pressed back to back, the phone details sheet dragged up and off (`viewer.spec.ts`)
- Tags page: a tag's panel and its Open in gallery link, closing the panel (`tag-panel.spec.ts`)
- AI tagging: the real WD tagger on three images from the AI Tagging page (`tagging-ai.spec.ts`)

## Still to cover

Removing and renaming tags, quarantine, rules, outfits page, the Generations page and the rest of the batch view, Remix, the rest of phone width (swipes on the viewer stage, the gallery), the empty gallery (Add library and Generate; the sandbox always has a library, so only the unit test covers it).

## Generate: Tags by part, Clear and Undo

Covered by `generate-clear-undo.spec.ts`.

### Undo leaves text typed since untouched

Where: Generate page, Prompt card with "Tags by part" open.

1. Write a Prompt with tags in one box, e.g. `1girl, red hair, blue eyes`.
2. Hover the Hair box and click its eraser icon. `red hair` leaves the Prompt; a "Cleared Hair" toast shows with Undo.
3. Before pressing Undo, type more into the Prompt (e.g. append `, smile`).
4. Press Undo.

Expected: the Prompt keeps `smile` and does NOT get `red hair` back (only an untouched Prompt is restored). Any character or outfit tags struck by the same Clear are still restored.

### Undo on an untouched Prompt restores it exactly

Same setup, press Undo straight away. Expected: the Prompt text is back byte for byte, and struck character/outfit tags show un-struck.

### Clear then Undo with a character and outfit

1. Pick a character with an outfit; the Attire box shows their outfit tags.
2. Clear Attire. Expected: their outfit tags are struck, the row fades, and tags the user added to the outfit for this batch are gone.
3. Undo. Expected: struck tags worn again, this batch's additions back, tags already struck before the Clear stay struck.

### Undo after the toast expires

Expected: no Undo available, no error; Clear stays applied.
