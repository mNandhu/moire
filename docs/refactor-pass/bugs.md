# Known bugs found by the refactor pass

Unverified agent claims unless struck through: confirm each with a failing test before fixing. Details in catalogue.md under the ID.

- ~~Rescan of a missing or unmounted library folder deletes every image and its curation~~ (fixed 5c1bf8d)
- **SCAN-UI** Library `scan_error` is never shown in the UI: a failed scan or one that kept images is invisible on the Libraries page (`grep -rn scan_error packages/frontend/src` is empty).

- **L1.1** Retag of an image a running AI job already passed wipes its AI tags and reports success (conf high, S)
- **L1.4** Async routes block the event loop on scan/watch thread joins (conf high, S)
- **L2.1** promptOutline (board) and prompt_parse (tags) read the same prompt differently; an unclosed bracket makes the board see one term (conf high, M)
- **L3.2** Error toasts show raw JSON in ~25 places: three different error-to-text styles, errorText used only for onboarding/library flows (conf high, M)
- **S1.1** Grouped gallery view is not refreshed or patched: flat feed always fetches, poll refetches the wrong query, removals skip groups (conf med, S)
- **S1.7** Model, LoRA and embedding filter counts include quarantined images, Size counts do not; three facet routes are near-copies (conf med, S)
- **S2.6** Global keydown ignores modifier keys: Ctrl/Cmd+1..5, Alt+Arrow hijacked (conf med, S)
- **S3.1** Renaming a source-specific tag moves the cover, focus and character settings of the shared base name (conf med, S)
- **S4.7** RenameTagDialog offers AI tags as merge targets when renaming a manual tag (conf med, S)
- **S5.7** Moving a library while it is scanning leaves the scan on the old folder and nothing rescans (conf med, S)
- **S6.2** A failed model download is swallowed: download_wd_tagger returns paths and the load fails with a bare FileNotFoundError (conf high, S)
- **S6.3** AI worker loop dies on any error outside the per-image try, leaving the job 'running' and every later job queued forever (conf med, S)
- **S7.5** One malformed graph aborts a whole reprojection: extract is not total and the loop has no per-row guard (conf med, S)
- **S8.8** Cancelled requests render as 'done' frames in the queue card (conf low, S)
- **S9.3** JsonTree branch toggle opens and closes every sibling branch at once (conf med, S)
- **S12.3** Deleting a hand-made character leaves its outfits, Default edits and hides behind (conf high, S)
- **S13.2** Escape inside a Picker or DropdownMenu in a Dialog closes the whole Dialog (conf med, S)
- **S13.7** Sidebar defines NavButton as a component inside render, remounting every link on each shell render (conf med, S)
