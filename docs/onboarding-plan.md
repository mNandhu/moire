# Onboarding Plan

What Moiré shows the first time it opens, and the work to build it. This file
is the tracker: tick items as they land, and add new ones under the phase they
belong to.

Mockup: [`docs/onboarding-mockup.html`](onboarding-mockup.html) (open it in a
browser; the pale bar at the top toggles ComfyUI, GPU and remote-server states).

## The flow

1. **Landing.** Logo and "Moiré" centred, one line ("A library for the images
   you generate"), and two buttons: **Set up Moiré** and **Skip for now**. The
   ring pattern sits behind it, shaded pink to blue, and leans toward the
   pointer.
2. **Setup.** A step list on the left (each step shows a one-line summary of
   what's set, and any reached step can be reopened), a plain form on the
   right, and a footer with scan progress and Back / Continue.
   1. **Image folders** (required). Type or paste a full path, press Add. A
      path is checked before it goes in the list; a bad one stays in the field
      with the reason under it. "One library per subfolder" switch. The scan
      starts when the user continues.
   2. **ComfyUI** (optional). Address with Connect, and a "Choose folder…"
      picker (or drop) for the saved workflows folder, used to name workflow
      groups for extraction rules.
   3. **AI tagging** (optional, off by default). Explains that prompt tags
      already cover most features, shows CPU vs GPU time for this library, and
      recommends the GPU build when an NVIDIA GPU is found.
3. **Gallery.** Scan progress in the sidebar, a one-time "Press ? for
   shortcuts" hint.

Skipping at any point lands in the gallery, with whatever was done so far.

## Decisions

| Decision | Outcome |
|---|---|
| Find image folders automatically | No. Paths are typed or pasted. |
| Workflow import | Manual: the user picks ComfyUI's workflows folder. |
| AI tagging default | Off. Prompt tags are enough for most features. |
| When tagging is turned on | Tag every existing image, and keep tagging new images as they arrive (auto-tag). |
| GPU | Recommend the GPU build in onboarding itself, with the measured numbers. |
| Look | No cards, no hero. Plain forms in an app-like layout; the ring background is the one flourish. |

## Phase 1: First run and folders

- [ ] `onboarding` value in `app_settings` (not started / done / skipped), read and written through a small settings service like the others.
- [ ] Route guard in `RootRoutes.tsx`: a fresh install (no libraries, onboarding not done) opens the landing page. Existing databases never see it.
- [ ] Landing page: logo lockup, line, Set up / Skip buttons, footer with version and data folder.
- [ ] Ring background component (canvas, pointer lean, colour wash with grain), shared by landing and setup. Static under reduced motion.
- [ ] Setup shell: step list with summaries, form pane, footer with scan progress and Back / Continue / Open Moiré.
- [ ] Image folders step. Pull the path checking and preview out of `AddLibraryDialog` so the dialog and onboarding share it (`lib/libraryPlan.ts`, `POST /libraries/discover`).
  - [ ] Validate before adding: full path (accept `/` and `\`), not already listed, reachable. Errors inline under the field.
  - [ ] Paste of several lines adds each valid path.
  - [ ] Show image counts from `discover` ("5,000+" when capped).
  - [ ] "One library per subfolder" switch.
  - [ ] Remote server: the hint names the machine the paths are on.
- [ ] Continue creates the libraries and starts the scans.
- [ ] Skip setup from any step marks onboarding skipped and opens the gallery.
- [ ] Gallery hand-off: the "?" shortcuts hint, shown once.

## Phase 2: ComfyUI step

- [ ] Address field with Connect / Disconnect, reusing the ComfyUI settings service (`services/comfy_settings.py`). States: checking, connected, nothing answered.
- [ ] Saved workflows: folder picker (`<input webkitdirectory>`) and drop zone, reusing `parseWorkflowFile` and `importWorkflowFiles` from `lib/workflows.ts` and `POST /rules/workflow-files`.
- [ ] Show what was read: workflow names and node counts, files skipped, or "no workflows in that folder".
- [ ] Step summary in the rail ("Connected · 7 workflows").

## Phase 3: AI tagging and auto-tag

- [ ] Setting `auto_tag` (default off) in `DEFAULT_AI_SETTINGS` (`services/ai_settings.py`). Turning it on in onboarding or Settings › AI Tagging sets it.
- [ ] Turning it on queues **every** untagged image. `enqueue_untagged` caps at `limit=200` today; the backlog needs to run in batches until nothing is left.
- [ ] Auto-tag new images: after the scanner or the folder watcher indexes new images, queue them for tagging when `auto_tag` is on.
- [ ] Survive restarts: AI jobs live only in memory (`AIJobManager._jobs`). On startup, if `auto_tag` is on, queue the untagged images again.
- [ ] Don't loop on images the tagger can't tag (unreadable, or no tags above the thresholds): `has_ai_tags` stays false for them, so a resume or batch would pick them up forever. Record a "tagged, nothing found" or failed state.
- [ ] Order: newest first by file `mtime` (what the user looks at first). `enqueue_untagged` orders by `_id` today.
- [ ] Onboarding step UI: switch (off by default), CPU vs GPU time for this library, GPU callout.
- [ ] Time estimate: start from the documented rates (CPU ~0.6 images/s in a real job, GPU ~0.1 s an image on a GTX 1650, see `docs/perf-findings.md`); later, measure a few images on this machine once the model is loaded.
- [ ] GPU detection:
  - [ ] Which build is running: `session.get_providers()` / installed `onnxruntime-gpu`.
  - [ ] Whether an NVIDIA GPU is present when the CPU build is running (for example `nvidia-smi` on PATH). Without this, show the recommendation without claiming a GPU was found.
  - [ ] Install command by install type, from `IS_CHECKOUT`: `uv tool install --reinstall "moire-studio[gpu]"` for an installed copy, the `UV_NO_GROUP=cpu … --group gpu` command from the README for a checkout.
- [ ] Sidebar activity shows tagging progress after the scan.

## Open questions

- Should the AI tagging step stay in onboarding, or live only in Settings? Kept in for now, off by default.
- Does onboarding need a way back in later (for example "Run setup again" in Settings), or is each step's own Settings page enough?

## Tests

- [ ] Backend: `onboarding` setting round trip; auto-tag queues new images only when on; startup resume; no requeue loop on untaggable images.
- [ ] Frontend: path validation (pure function in `lib/` with a colocated test); route guard sends a fresh install to the landing page and an existing one to the gallery.
