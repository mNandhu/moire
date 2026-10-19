# Moiré: ComfyUI Integration Plan

Date started: 2026-10-19
Status: design (grilling in progress; open questions at the end)
Glossary: the terms below (Generator, Character recipe, Prompt blocks, Outfit,
Attire tag, Generation batch, ComfyUI connection) are defined in `CONTEXT.md`.

## Why

Prompting ComfyUI directly means remembering which tags make a character,
which LoRA and strength worked, and where in a messy graph the seed lives.
Moiré already knows most of that from the library: the full graph of every
image, what was prompted (prompt tags) next to what the tagger saw (AI tags),
scores and quarantine, LoRAs with strengths, and character pages. The
integration turns that knowledge into a composer that queues on ComfyUI and
learns from what comes back.

## Assumptions

- **ComfyUI runs on the same machine.** Remote boxes are a rare case; not
  engineered for until there is demand.
- **One ComfyUI connection** (URL plus optional headers, kept server-side).
- **Moiré queues jobs itself** (`POST /prompt`), not copy/paste.
- Only stock ComfyUI nodes are relied on for anything Moiré writes into a
  graph (`LoraLoader`, `LoraLoaderModelOnly`). User graphs may contain any
  custom nodes; Moiré just doesn't depend on them.

## Use cases (v1)

1. **Character selection.** Pick a character; its recipe fills the prompt.
2. **Weak-recipe warning.** "Prompted 60×, tagger confirmed 38% without
   LoRA, 91% with `hu_tao_v2`."
3. **Outfits.** Swap a character's default outfit for a saved one.
4. **Remix / re-queue** a past batch or an image's settings.
5. **Batch review.** Keep (default) / reject (quarantine) / score.
6. **Autocomplete** from the tagger's vocabulary (`selected_tags.csv`).

Later: prompt adherence stats per tag and LoRA, settings recall (best
sampler/CFG/steps/strength per character or LoRA), learned negatives (tags
over-represented in quarantined / low-score images), X/Y batches and
library-built wildcards, coverage gaps on character pages.
Deferred: reference images (ControlNet / IPAdapter, face crops).

## Decisions

### Attire list and outfits

- The WD tagger has no clothing category, so Moiré ships an **attire list**
  built from Danbooru's `tag_group:attire` wiki hub, walked recursively over
  its sub-groups (headwear, legwear, ...), each tag keeping its group.
- Built by a **one-off dev script**, output committed as JSON and hand-editable.
  Danbooru sits behind Cloudflare (a plain fetch got a challenge page), so the
  script runs from a session that passes (logged-in API key). Not a runtime
  fetch.
- Filtered to the tagger's vocabulary; tags it can't produce are dropped.
- Previews come from the library's own tag samples, not external images.
- **Outfits are user-made** (save an image's attire tags as an outfit for a
  character). Auto-clustered suggestions come later.

### Character recipe

- Character tag (full name) + **identity tags** (signature tags minus attire
  tags) + **default outfit** (attire signature tags) + **LoRA** (most used
  where the character was prompted and the tagger confirmed it, score
  weighted, with its typical strength).
- **Computed, with user edits stored on top** (drop a tag, force a LoRA or
  strength); the edit wins, like the `characters` overrides.
- Weak-recipe warning: tagger confirmation rate on images that prompted the
  character, with and without the LoRA.

### Generator

- A ComfyUI API-format graph plus **slots** (slot → path into the graph).
- **Built-in Generator**: a simple txt2img graph Moiré ships.
- **Custom Generator**: from an image of a workflow family (its embedded
  API graph) or an uploaded *Export (API)* JSON. Editor-format workflow files
  are rejected with a hint (only the ComfyUI frontend can convert them).
- **Snapshot**: frozen at creation; "update from latest" is explicit.
- **v1 slots**: positive, negative (required), seed, width/height, batch_size
  (optional), checkpoint (built-in only). Sampler/steps/CFG stay in the graph.
- **Slot discovery**, in order: the sampler walk that already extracts
  `gen.prompt` (when it ends at one literal input), a ruleset pin pointing at a
  literal input, else the user picks a node. Runtime-built prompts always need
  a pick. Without positive and negative it can't be saved.
- **Seed**: every literal `seed` / `noise_seed` (following links to seed nodes)
  is listed, grouped by equal value; the user ticks which ones Moiré
  randomizes (all ticked get the same value per job).
- **Batch count is Moiré's** (N jobs); `batch_size` is per-job images.
- **Must have a `SaveImage` writing into the output folder**, else it can't be
  saved (outputs would never reach the library).
- **Test-run gate**: unusable until one test job succeeds and its image is
  found in the library.

### LoRAs

- Recipe LoRAs are **spliced** in as stock `LoraLoader` nodes on the
  MODEL/CLIP path feeding each sampler (every sampler path from the same
  checkpoint loader). `LoraLoaderModelOnly` when there is no CLIP.
- The Generator's own LoRAs stay; a recipe LoRA already present overrides its
  strength.
- Installed LoRAs are indexed from `/object_info` (`LoraLoader` `lora_name`
  combo) on connect and on refresh. Matched to `gen.loras` names by stem
  (no folder, no extension); a stem in two folders asks once and remembers;
  no match shows "not installed".

### Composer: prompt blocks

- Positive = **Base** (Generator's text, editable) + **Character** (recipe
  chips) + **Outfit** (chips) + **Extra** (free tags, autocomplete), joined
  in that order on queue. Negative = Base + Extra.
- Creating a Generator from an image that prompted a character *offers* to
  move those tags from Base to the Character block.

### Outputs and batches

- ComfyUI's **output folder is a Library** (path set once on the ComfyUI page;
  registers it, or reuses an existing library). Outputs arrive by the normal
  scan / watch.
- Output → job match is exact: `/history/<prompt_id>` gives filename +
  subfolder → image `_id`.
- **Generation batch**: one press of Queue; kept permanently with its slot
  values, picked character / outfit / recipe; re-queueable.
- Review: keep (default), reject = quarantine (reversible), score. No file
  deletion from review.

### Failures

Job states: pending → queued → running → done / failed / cancelled / lost.

| Failure | Detected by | Result |
|---|---|---|
| ComfyUI down | connect error | Queue disabled, badge red; nothing persisted |
| Rejected on submit | `/prompt` `node_errors` | Job failed, errors mapped to slot cards |
| Error mid-run (OOM, node) | ws `execution_error` / `/history` | Job failed with node + message; "Retry failed" |
| Cancelled | ws `execution_interrupted` | cancelled |
| Moiré restarts | startup reconcile via `/queue` + `/history` | resumes tracking |
| ComfyUI restarts | job in neither queue nor history | lost (retryable) |
| Done but no image | history outputs never scanned | "finished, images not in library" |

Websocket for progress; `/history` is the source of truth for final state.

### Remix

- From the viewer. The image's prompt is split into blocks (recognised
  character tags into Character, the rest into Base); seed filled, with a
  same / new seed toggle.
- Family has a ready Generator: compose with it.
- Family has none: primary **Remix with built-in** (prompt, size, LoRAs carry
  over; graph does not), secondary **Set up this workflow** (goes through the
  gate).
- A1111 images and images without a graph: built-in only.

## Phases

Each phase is usable end to end.

0. **Attire list**: dev script, committed JSON, loader. Independent.
1. **Tracer**: ComfyUI page (URL, output folder as library, checkpoint and
   LoRA index from `/object_info`), built-in Generator, composer (Base +
   Extra, autocomplete), Queue, job tracking and failures, batch review,
   Generations history.
2. **Character recipe**: Character block, identity tags, LoRA pick + splice,
   weak-recipe warning, recipe edits.
3. **Custom Generators**: setup flow (slot discovery, seed grouping,
   SaveImage check, test-run gate), update from latest, Remix.
4. **Outfits**: save from image, Outfit block, default outfit from recipe.

Later: adherence stats, settings recall, learned negatives, X/Y batches,
coverage gaps. Deferred: reference images.

## Facts checked while planning

- Each image's stored raw (`image_gen_raw.raw`) holds both `prompt` (the
  runnable API-format graph) and `workflow` (editor graph). Ruleset pins are
  dot-paths into that raw (`prompt.12.inputs.text`), so a pin on a literal
  input is reversible into a write slot.
- `POST /api/v1/rules/workflow-files` only records filename + node types; no
  graph is stored from workflow files, hence the Export (API) requirement.
- ComfyUI stock: `LoraLoader` (model + clip, two strengths) and
  `LoraLoaderModelOnly`; `lora_name` is a COMBO whose options come from
  `GET /object_info` (`LoraLoader.input.required.lora_name[0]`), with
  folder-relative paths. Checkpoints likewise via `CheckpointLoaderSimple`.
- ComfyUI's API does not report its output directory: the user sets it.
- `/history/<prompt_id>` lists outputs (filename, subfolder, type
  output|temp). "Batch count" is a ComfyUI frontend concept, not in the graph.
- Danbooru `/wiki_pages/<title>.json` returned a Cloudflare challenge from
  this machine (2026-10-19).

## UI

Mock canvas (Design artifact, private):
https://claude.ai/artifact/9NuwckDfNaD4wXqGn46h8a

Revision 1 (2026-10-19), four static screens styled on Moiré's tokens
(canvas `#0d0c12`, surface/raised, brand violet `#6e52d6`, Instrument Sans,
JetBrains Mono for values, Caveat Brush for scores), placeholder striped
tiles instead of images:

1. **Generate** (`Main.dc.html`): prompt blocks in join order (Base, +,
   Character, +, Outfit, +, Extra), Negative (Base + Extra), "Prompt as sent";
   Character block with identity chips (a dropped one struck through), LoRA
   picker + strength + Installed badge, weak-recipe callout with 38% vs 91%
   bars; Outfit chips labelled by attire group; Extra autocomplete open with
   library counts. Right column: checkpoint, size presets, seed
   random/fixed, image count, Queue, recent batches.
2. **Batch review** (`Batch.dc.html`): per-job segmented progress, tiles in
   every state (in library with score, hover controls, rejected + Undo,
   waiting for scan, running 18/28 + Cancel, failed with node + error +
   Retry), K / X / 1-5 shortcuts, "What was asked" panel.
3. **Generator setup** (`Setup.dc.html`): stepper Source / Slots / Test run;
   slot cards: Positive found from sampler with the move-to-Character offer,
   Negative in "pick a node" state (runtime-joined), Seed grouped by shared
   value with checkboxes, Size, Images per job (optional), Output (SaveImage
   ok, PreviewImage ignored), own LoRAs; readiness checklist with the test
   gate blocked.
4. **Settings › ComfyUI** (`ComfyUI.dc.html`): address + Test, optional
   headers, output folder (already a library), model counts, LoRA matching
   table (matched / two files share a name / not installed).

Sidebar gained a "Create" group (Generate, Generations); Settings gained a
"Generation" group (ComfyUI).

Source files live only in the artifact (scratchpad copies may be gone): to
revise, `read` the canvas's `project/*.dc.html` first.

### Next session

- Review revision 1 with the user; likely first topics: block layout and how
  much room the Character block takes.
- Not drawn yet: character picker, outfit picker / save-outfit-from-image,
  Remix entry in the viewer, Generations history list, connection-down and
  submit-rejected states, phone width.
- The mocks need several revisions before implementation starts (user's
  call: "well made, properly designed").
