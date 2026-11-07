# E2E scenarios to cover

Scenarios worth testing end to end, for the Playwright suite in `packages/e2e` (how it runs: CONTRIBUTING.md, "E2E"). Add one entry per scenario: where, steps, expected. Once a spec covers it, say which under the heading.

## Covered

- Onboarding: welcome flow adds a folder and connects the fake ComfyUI, the scan indexes every image (`onboarding.setup.ts`)
- Gallery: scrolling pages in the rest of the feed; a searched tag filters the gallery and survives a reload from the URL; selection mode from the toolbar and the phone View options menu; Edit tags adding and removing a manual tag on a whole Select all (`gallery.spec.ts`)
- Generate: every Clear and Undo scenario below (`generate-clear-undo.spec.ts`); Ctrl+Up/Down weigh the tag under the caret, a group with the caret on its own weight, and in a preset's text (`generate-prompt-keys.spec.ts`); a run on the fake ComfyUI lands its images in the output library, with the Images stepper and the batch name's rename, Escape and auto name on the way, then a rename on its batch page (`generate-run.spec.ts`); Ctrl+Z / Ctrl+Shift+Z on a board removal, Ctrl+Enter queueing from the prompt, Clear on the output column, keeping a batch still running, Clean up on the Prompt, arrow keys after a stepper's + (`generate-shortcuts.spec.ts`)
- Viewer: prompt weights on the Tags tab, a ComfyUI prompt escaped twice, adding manual tags, setting a score, arrow keys through the feed, also pressed back to back, the phone details sheet dragged up and off, quarantining the open image and stepping on past it and back (`viewer.spec.ts`)
- Tags page: a tag's panel and its Open in gallery link, closing the panel (`tag-panel.spec.ts`)
- New character: identity tags complete from the library's tags and a typed one is kept without Enter; a picture link to a private address is refused; a link pasted in the Tag field goes to the tagger; Generate's Edit tags dialog opens the character page (`new-character.spec.ts`)
- AI tagging: the real WD tagger on three images from the AI Tagging page, and on a picture in New character, filling identity and Default outfit (`tagging-ai.spec.ts`)

## Still to cover

Removing and renaming tags, quarantine from the gallery, rules, outfits page, the Generations page and the rest of the batch view, Remix, the rest of phone width (swipes on the viewer stage, the gallery), the empty gallery (Add library and Generate; the sandbox always has a library, so only the unit test covers it).

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

## Generate: keys and Clear

Covered by `generate-shortcuts.spec.ts`.

### Ctrl+Z after a board removal

Remove a tag on the Prompt board, click off the text field, press Ctrl/Cmd+Z. Expected: the tag is back in the Prompt and on the board; Ctrl/Cmd+Shift+Z takes it out again. In a text field, Ctrl+Z is the field's own.

### Ctrl+Enter queues

With Queue enabled, press Ctrl/Cmd+Enter in the Prompt. Expected: the batch is queued; the Prompt is unchanged.

### Clear the output column

Click Clear under the output batches. Expected: they leave the column (Generations still lists them), it stays empty after a reload, and the next batch queued shows there. A batch still running or queued when Clear is pressed stays, also once it's done.

### Clean up the Prompt

Write a Prompt with a tag twice and doubled or trailing commas; click Clean up in the Prompt card's header. Expected: the second copy and the stray commas go (weighted or grouped copies count too and the kept one takes the heaviest weight; a group in a chunk split by AND stays), the button goes away, and Ctrl/Cmd+Z brings the text back.

### Arrow keys after a stepper's + or -

Click + on Images (or a LoRA's strength), then press Right / Up and Left / Down. Expected: each press steps the value on.

## Generate: the viewer steps through the output column

Covered by `generate-viewer.spec.ts`.

### Arrow keys walk only what Generate shows

Clear the output column, generate one image and open it. Expected: Previous and Next are off and Left / Right stay on it. Generate two more and open the first one: Right goes on to the two new ones in the order they were made, then Next is off; Left comes back.
