# E2E scenarios to cover

Scenarios worth testing end to end, for the Playwright suite in `packages/e2e` (how it runs: CONTRIBUTING.md, "E2E"). Add one entry per scenario: where, steps, expected. Once a spec covers it, say which under the heading.

## Covered

- Onboarding: welcome flow adds a folder and connects the fake ComfyUI, the scan indexes every image (`onboarding.setup.ts`)
- Gallery: scrolling pages in the rest of the feed; a searched tag filters the gallery and survives a reload from the URL (`gallery.spec.ts`)
- Generate: every Clear and Undo scenario below (`generate-clear-undo.spec.ts`)

## Still to cover

From the release tracker (R3): image view tags and weights, tag panel, AI tagging a few images (needs the tagger model cached in CI), Generate prompt keys (Ctrl+Up/Down), a Generate run on the fake ComfyUI landing in the output library.

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
