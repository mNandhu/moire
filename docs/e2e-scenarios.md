# E2E scenarios to cover

Scenarios worth testing end to end, for the Playwright suite in `packages/e2e` (how it runs: CONTRIBUTING.md, "E2E"). Add one entry per scenario: where, steps, expected. Once a spec covers it, say which under the heading.

## Covered

- Onboarding: welcome flow adds a folder and connects the fake ComfyUI, the scan indexes every image (`onboarding.setup.ts`)
- Gallery: scrolling pages in the rest of the feed; a searched tag filters the gallery and survives a reload from the URL; selection mode from the toolbar and the phone View options menu; Ctrl+K finding an image by file name and opening it; Edit tags adding and removing a manual tag on a whole Select all; an unknown address showing Page not found with a link back (`gallery.spec.ts`)
- Generate: every Clear and Undo scenario below (`generate-clear-undo.spec.ts`); Ctrl+Up/Down weigh the tag under the caret, a group with the caret on its own weight, and in a preset's text (`generate-prompt-keys.spec.ts`); a run on the fake ComfyUI lands its images in the output library, with the Images stepper and the batch name's rename, Escape and auto name on the way, then a rename on its batch page; the same prompt queued twice, the second while the first runs, is two batches: the viewer's This batch strip holds only the image's own batch and links its page, and the gallery's stack of the prompt drills in with grouping still on and comes back with Back to All Images (`generate-run.spec.ts`); Ctrl+Z / Ctrl+Shift+Z on a board removal, Ctrl+Enter queueing from the prompt, keeping a batch still running when the output column is cleared, Clean up and Use canonical tags on the Prompt, arrow keys after a stepper's + (`generate-shortcuts.spec.ts`); an image made while the tab is hidden, rejecting and Clear undone with Ctrl+Z, a cleared column still empty after a reload, clearing a batch's rejected and failed images, a switched-off style LoRA, a Danbooru alias suggesting its tag (`generate-work-output.spec.ts`)
- Viewer: prompt weights on the Tags tab, a ComfyUI prompt escaped twice, adding manual tags, setting a score, arrow keys through the feed, also pressed back to back, the phone details sheet dragged up and off, quarantining the open image and stepping on past it and back, pointing at a character to light up their identity tags in the prompt and the Tags tab, the filmstrip (click, drag scrub, F to hide, kept on reload) (`viewer.spec.ts`)
- Outfits: New outfit on the Outfits page for a picked character, shared; Generate's Outfit picker listing another character's outfit (`outfits.spec.ts`)
- Tags page: a tag's panel and its Open in gallery link, closing the panel (`tag-panel.spec.ts`)
- New character: identity tags complete from the library's tags and a typed one is kept without Enter; arrowing down the suggestions keeps the highlighted row in view; a picture link to a private address is refused; a link pasted in the Tag field goes to the tagger; Generate's Edit tags dialog opens the character page; a picked character no character has shows Not found and Queue says Character not found until it is removed (`new-character.spec.ts`)
- Sensitivity filter: the header shield hiding images above the level, the "hidden until AI-tagged" banner, its Tag them swapped for the job's progress and Cancel while it runs, the sidebar's background work list cancelling the job, a direct link to a hidden image saying so, and back to everything; adding, changing and removing a tag level in Settings (`sensitivity.spec.ts`)
- AI tagging: the real WD tagger on one library's row from the AI Tagging page, cancelled after three images, and on a picture in New character, filling identity and Default outfit (`tagging-ai.spec.ts`); the run box's count becoming the run's limit, none for every image left, and Settings saving the auto-tag switch (`ai-tagging-page.spec.ts`); the onboarding AI tagging switch turning on and off (`onboarding.setup.ts`)

## Still to cover

Removing and renaming tags, quarantine from the gallery, rules, the rest of the Outfits page (editing, deleting, hiding a shared one), the Generations page and the rest of the batch view, Remix, the rest of phone width (swipes on the viewer stage, the gallery), the empty gallery (Add library and Generate; the sandbox always has a library, so only the unit test covers it), the Tags page grid filling its last row before Show more (only `gridFill.test.ts` covers the rounding).

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

## Generate: output column and LoRA switches

Covered by `generate-work-output.spec.ts`.

### An image made while the tab is hidden

Queue one image, then hide the page (another window over it). Expected: the image shows in the output column while the page is still hidden, without coming back to it first.

### Clear rejected

Queue two images and reject one. Expected: the batch shows a "1 rejected" pill; Ctrl+Z takes the rejection back (the pill goes) and Ctrl+Shift+Z rejects it again; the pill clicked, the rejected image leaves the column (the strip goes) and stays gone on reload, while the batch still has both. Restored, it shows again.

### Ctrl+Z after Clear

With batches in the output column, click Clear output, then press Ctrl/Cmd+Z. Expected: the batches are back; Ctrl/Cmd+Shift+Z clears them again.

### Clear failed

Have the fake ComfyUI fail the next prompt and queue one image. Expected: the failure shows with a "1 failed" pill on its batch; clicking it removes it, and a batch with nothing else is deleted.

### A switched-off LoRA

Add a style LoRA and untick it. Expected: queueing sends no LoRA; after a reload it is still there, still off.

### A Danbooru alias suggests its tag

Type `smiling` in the Prompt. Expected: `smile` is offered first, and Tab puts it in.
