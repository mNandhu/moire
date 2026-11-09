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
| Until "tag everything" works | The AI tagging switch ships **disabled** in onboarding, with the time comparison and GPU callout still shown. Enable it once the deferred batching item below is done. |
| GPU | Recommend the GPU build in onboarding itself, with the measured numbers. |
| Look | No cards, no hero. Plain forms in an app-like layout; the ring background is the one flourish. |

## Phase 1: First run and folders

- [x] `onboarding` value in `app_settings` (pending / done / skipped), read and written through `services/onboarding.py`, served at `GET`/`PUT /api/v1/onboarding` (with version, data folder, host name and install type for the page). No row plus existing libraries reads as done.
- [x] Route guard in `RootRoutes.tsx`: a fresh install (no libraries, onboarding not done) opens `/welcome`. Existing databases never see it; a failed check opens the app as usual.
- [x] Landing page: logo lockup, line, Set up / Skip buttons, footer with version and data folder.
- [x] Ring background component, `components/onboarding/RingBackground.tsx` (canvas, pointer lean, colour wash with grain), shared by landing and setup. Static under reduced motion.
- [x] Setup shell (`pages/WelcomePage.tsx`): step list with summaries, form pane, footer with scan progress and Back / Continue / Open Moiré.
- [x] Image folders step (`components/onboarding/FoldersStep.tsx`). Shares `discoverLibraries` and `errorText` with `AddLibraryDialog`; the path rules are pure functions in `lib/onboarding.ts`.
  - [x] Validate before adding: full path (accept `/` and `\`), not already listed, reachable. Errors inline under the field.
  - [x] Paste of several lines adds each valid path.
  - [x] Show image counts from `discover` ("5,000+" when capped).
  - [x] "One library per subfolder" switch. Recounts the list, and warns when images sit directly in a folder and so join no library.
  - [x] Remote server: the hint names the machine the paths are on.
- [x] Continue creates the libraries and starts the scans. Going back and changing the list creates or removes only the difference.
- [x] Skip setup from any step marks onboarding skipped and opens the gallery.
- [x] Gallery hand-off: the "?" shortcuts hint, shown once (a toast, flagged in `localStorage`).

## Phase 2: ComfyUI step

- [x] Address field with Connect / Disconnect, reusing the ComfyUI settings service (`services/comfy_settings.py`). States: checking, connected, nothing answered.
- [x] Saved workflows: folder picker (`<input webkitdirectory>`) and drop zone, reusing `parseWorkflowFile` and `importWorkflowFiles` from `lib/workflows.ts` and `POST /rules/workflow-files`.
- [x] Show what was read: workflow names and node counts, files skipped, or "no workflows in that folder".
- [x] Step summary in the rail ("Connected · 7 workflows").

## Phase 3: AI tagging and auto-tag

- [x] Setting `auto_tag` (default off) in `DEFAULT_AI_SETTINGS` (`services/ai_settings.py`). Turning it on in onboarding (saved on Open Moiré) or with the switch on the AI Tagging page sets it.
- [x] Turning it on queues **every** untagged image: `enqueue_untagged` takes no limit by default. Explicit-id jobs (an image's own re-tag) are `urgent` and run between the images of a long run, so they don't wait behind the backlog.
- [x] Auto-tag new images: a scan ending or a watcher ingest calls `AIJobManager.nudge()`; a few seconds later `auto_tag()` queues the untagged images no job holds (scope `auto`), once no scan is running.
- [x] Survive restarts: startup nudges auto-tag, which queues the untagged images again.
- [x] Cancel on an auto-tag run pauses auto-tag until the switch is turned on again or the process restarts (`AIJobManager._auto_paused`).
- [ ] Don't loop on images the tagger can't tag (unreadable, or no tags above the thresholds). Done for one process: auto-tag skips the ids in `AIJobManager._auto_skip`. Still open: a stored "tagged, nothing found" or failed state, so a restart (or a run by hand) doesn't try them again.
- [x] Order: newest first by file `mtime` (what the user looks at first).
- [x] Onboarding step UI: switch (off by default), CPU vs GPU time for this library, GPU callout.
- [x] Switch enabled (it shipped disabled until the backlog could run whole).
- [x] Time estimate from the documented rates (CPU ~0.6 images/s in a real job, GPU ~0.1 s an image on a GTX 1650, see `docs/perf-findings.md`), in `lib/onboarding.ts`.
- [x] Measured rate: a run of 20+ images stores its rate per device (`services/ai_estimate.py`, app_settings row `ai_rate`); `/ai/status` `estimate` serves it, else the documented rate for the device. The AI Tagging page shows it for the backlog and each library.
- [ ] GPU detection:
  - [x] Which build is running: the session's providers once loaded, else `get_available_providers()` (`WDTagger.device`). On the GPU build the step drops the CPU/GPU bars and the GPU callout.
  - [ ] Whether an NVIDIA GPU is present when the CPU build is running (for example `nvidia-smi` on PATH). Until then the step shows the recommendation to everyone ("Have an NVIDIA GPU?") without claiming one was found.
  - [x] Install command by install type, from `IS_CHECKOUT`: `uv tool install --reinstall "moire-studio[gpu]"` for an installed copy, the `UV_NO_GROUP=cpu … --group gpu` command from the README for a checkout.
- [ ] Sidebar activity shows tagging progress after the scan.

## Open questions

- Should the AI tagging step stay in onboarding, or live only in Settings? Kept in for now, off by default.
- Does onboarding need a way back in later (for example "Run setup again" in Settings), or is each step's own Settings page enough? `/welcome` opens it directly for now; nothing links there.

## Tests

- [x] Backend: `onboarding` setting round trip (`tests/test_onboarding_integration.py`).
- [ ] Backend: auto-tag queues new images only when on; startup resume; no requeue loop on untaggable images.
- [x] Frontend: path validation (`lib/onboarding.test.ts`); route guard (`RootRoutes.onboarding.test.tsx`); folder step and library creation (`pages/WelcomePage.test.tsx`).
