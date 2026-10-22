# E2E scenarios to cover

No e2e suite exists yet. This file collects scenarios worth testing end to end once it does. Add one entry per scenario: where, steps, expected.

## Generate: Tags by part, Clear and Undo

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
