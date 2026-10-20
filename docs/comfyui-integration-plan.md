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
2. **Outfits.** Swap a character's default outfit for a saved one.
3. **Remix / re-queue** a past batch or an image's settings.
4. **Batch review.** Keep (default) / reject (quarantine) / score.
5. **Autocomplete** from the tagger's vocabulary (`selected_tags.csv`).

Later, if there is bandwidth: **weak-recipe warning** ("Prompted 60×,
tagger confirmed 38% without LoRA, 91% with `hu_tao_v2`"; deferred by the
user 2026-10-20, still drawn in the Generate mock as the target), prompt adherence stats per tag and LoRA, settings recall (best
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
- Default outfit = the character's attire signature tags (computed). Saved
  outfits are made only from the viewer (they need an image for the
  thumbnail) and managed on the Outfits page or the character page. The
  composer only picks; chip edits there apply to that batch only.
- **Save outfit dialog** (from the full image view): prefilled with the
  image's attire tags plus the character's usual attire tags, each marked by
  source; remove any, add custom ones (autocomplete prefers attire tags; free
  text allowed, marked "tagger can't check it" and left out of adherence
  stats). Name required; the image becomes the outfit's thumbnail.
- Outfits belong to a character by default; **"Available for all
  characters"** shares one (shown marked shared in every character's list).
  One owner or shared with all; no multi-character select.
- **Outfits page** (sidebar, Create group): all outfits as cards, search,
  character filter, All / Shared / One character; a card opens the save
  dialog in edit mode (with Delete).
- **Character page** gains an Outfits strip between Best of and Images:
  Default (computed) first, own outfits, shared ones (hideable per
  character), "All outfits" link to the page filtered to that character.
- **Open in gallery** (outfit card hover): expands to an ordinary all-of tag
  filter (outfit's tagger-checkable tags, plus the character when opened
  from a character page). No new Gallery filter kind; chips can be dropped
  to loosen.

### Character recipe

- Character tag (full name) + **identity tags** (signature tags minus attire
  tags) + **default outfit** (attire signature tags) + **LoRA** (most used
  where the character was prompted and the tagger confirmed it, score
  weighted, with its typical strength).
- **Computed, with user edits stored on top** (drop a tag, force a LoRA or
  strength); the edit wins, like the `characters` overrides.
- Weak-recipe warning (deferred, see Use cases): tagger confirmation rate on images that prompted the
  character, with and without the LoRA.

### Generator

- A ComfyUI API-format graph plus **slots** (slot → path into the graph).
- **Built-in Generator**: a simple txt2img graph Moiré ships.
- **Custom Generator**: from an image of a workflow family (its embedded
  API graph) or an uploaded *Export (API)* JSON. Editor-format workflow files
  are rejected with a hint (only the ComfyUI frontend can convert them).
- **Snapshot**: frozen at creation; "update from latest" is explicit.
- **v1 slots**: positive, negative (required), seed, width/height, images
  per request (`batch_size`), LoRA insertion point, checkpoint (built-in
  only). Sampler/steps/CFG stay as the graph has them.
- **Positive / negative slot** = where Moiré writes the composed text each
  job. The text the source image had there becomes the Generator's **default
  Base**; recognised character and attire tags are offered for removal
  ("Remove from Base", not moved anywhere: the blocks add them at queue time).
- **Slot discovery**, in order: the sampler walk that already extracts
  `gen.prompt` (when it ends at one literal input), a ruleset pin pointing at a
  literal input, else the user picks a node. Runtime-built prompts always need
  a pick. Without positive and negative it can't be saved.
- **Seed**: every literal `seed` / `noise_seed` (following links to seed nodes)
  is listed, grouped by equal value; the user ticks which ones Moiré
  randomizes (all ticked get the same value per job).
- **Batch count is Moiré's; batch_size is per request** (user's call,
  2026-10-20). The Generator's `batch_size` slot ("Images per request",
  found on the latent node, editable in setup) caps images per ComfyUI
  prompt: 8 images at 2 = 4 requests, the last one smaller if uneven.
  ComfyUI runs prompts one at a time, so at most that many images share the
  GPU. One seed per request; each image also records its index in the
  request so Remix can rerun the request and keep the right image. Failure,
  retry and cancel are per request ("Retry one at a time" splits a failed
  request into requests of 1).
- Batch size not mapped: the count becomes Requests, not Images. If the
  graph has a literal batch_size (say 4), show "8 × 4 = 32 images" and never
  rewrite it; if it's built at run time, "8 × ?". In every mode Moiré keeps
  all images a request returns (extras join that request; totals update);
  a request that finishes without error but with no image is "Returned 0
  images" with Retry.
- **Must have a `SaveImage` writing into the output folder**, else it can't be
  saved (outputs would never reach the library).
- **Test-run gate**: unusable until one test job succeeds and its image is
  found in the library. The test chains in one installed LoRA at strength 0
  so a bad insertion point fails at setup, not on the first real batch.
- "Update from latest" lives on the Generator's own page, shown only when the
  family has a newer image with a different graph (not in setup).

### LoRAs

- Three sources: **character LoRA** (recipe, swaps with the character),
  **style LoRAs** (user-picked list beside Checkpoint, kept across character
  changes, saved with the batch), and the **Generator's own** (in its graph).
  A LoRA in several is added once; strength precedence Character > Style >
  Generator.
- **Insertion point** (a Generator slot, auto-detected, user can pick another
  node): start at the model loader (Load Checkpoint, or UNET + CLIP loaders),
  walk past stock `LoraLoader`s already chained after it, insert Moiré's
  `LoraLoader` chain there, and rewire every consumer of the old MODEL/CLIP
  output to the chain's end, so hires passes and detailers get the LoRAs too.
  `LoraLoaderModelOnly` when there is no CLIP on that path. The slot is two
  picks, "Model from" and "CLIP from" (each a node picker filtered to that
  output type; usually the same node, different with UNET + CLIP loaders).
  No downstream pick: consumers are rewired automatically.
- A LoRA the Generator already loads through a stock loader gets its strength
  overridden; one inside a custom loader node can't be edited and is flagged.
- Installed LoRAs are indexed from `/object_info` (`LoraLoader` `lora_name`
  combo) on connect and on refresh. Matched to `gen.loras` names by stem
  (no folder, no extension); a stem in two folders asks once and remembers;
  no match shows "not installed".

### Composer: prompt blocks

- Positive = **Base** (Generator's text, editable) + **Character** (recipe
  chips) + **Outfit** (chips) + **Extra** (free tags, autocomplete), joined
  in that order on queue. Negative = Base + Extra.
- Creating a Generator from an image that prompted a character *offers* to
  remove those tags from its default Base.
- **Embeddings** are prompt words (`embedding:name`), not a separate control:
  installed ones (ComfyUI `GET /embeddings`, read on connect and Refresh)
  join the Extra autocomplete for positive and negative, marked as
  embeddings, and show as their own chip style. No weights in v1.

### Outputs and batches

- ComfyUI's **output folder is a Library** (path set once on the ComfyUI page;
  registers it, or reuses an existing library). Outputs arrive by the normal
  scan / watch.
- Output → job match is exact: `/history/<prompt_id>` gives filename +
  subfolder → image `_id`.
- **Generation batch**: one press of Queue; kept permanently with its slot
  values, picked character / outfit / recipe / style LoRAs; re-queueable.
- **Batch name**: auto "Character, Outfit", or "Generator, first two Extra
  tags" without a character, else "Batch <n>". Built from the structured
  picks, never parsed from prompt text. Not unique (batches are identified by
  number + time). Editable above Queue (typing stops the auto name) and
  renamable on the batch page; no naming-template setting.
- Review: keep (default), reject = quarantine (reversible), score. No file
  deletion from review.
- One batch = one Size, so its review grid uses that ratio for every tile
  (no cropping, no mixed layout). Mixed ratios appear only across batches:
  history thumbnails, and "Open in gallery" (existing masonry).

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
Implementation detail: "busy" is global (ws `status` `queue_remaining` > 0,
whoever queued it); no internal/external distinction in the UI. ComfyUI has
one FIFO queue, so prompts started in ComfyUI itself delay Moiré's jobs.
Moiré never cancels or reorders a job it didn't send.

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
2. **Character recipe**: Character block, identity tags, LoRA splice
   (character + style LoRAs), recipe edits. (Weak-recipe warning deferred.)
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

Revision 2 (2026-10-20), from the user's canvas comments:
- Generate: "Character LoRA" label; Style LoRAs list under Checkpoint; Outfit
  block source line, "2 saved outfits / Manage on Hu Tao's page / Save these
  as an outfit"; Batch name field above Queue.
- Batch review: rename button by the title; LoRAs split character / style.
- Setup: Positive card reframed (slot = write target, text = default Base,
  "Remove from Base"); "LoRAs in this workflow" replaced by a "LoRA insertion
  point" card showing the chain; snapshot card removed; checklist gained
  "LoRA insertion point found"; test note mentions the strength-0 LoRA.

Revision 2.1 (same day, second comment round):
- Generate: compact queue card atop the right column (running batch, n / N,
  per-image segment bar, what's queued after); header status "busy".
- Batch review: shortcuts moved to a "Review" row above the tiles; rejected
  tile's "Undo" renamed "Restore"; running tile names its node
  ("KSampler #40 18 / 28", since ws `progress` restarts per sampler).
- Setup: "Images per job" card removed (batch_size no longer a slot); Size
  one line; test note cut to "Confirm the negative first."
- All boards: sidebar "All Images" shown as "Gallery" (user's suggestion;
  mock only, the real app's nav is unchanged).

Source files live only in the artifact (scratchpad copies may be gone): to
revise, `read` the canvas's `project/*.dc.html` first.

### Next session

- New boards in revision 2.1: `Outfit.dc.html` ("Viewer: save outfit") and
  `Picker.dc.html` ("Generator setup: node picker": popover, search, groups
  "reach the sampler's positive" / dimmed "other text inputs" with reasons;
  picking swaps at once and resets the test-run gate, no auto re-run),
  `Outfits.dc.html` (Outfits page) and `CharOutfits.dc.html` (character
  page outfits strip). Sidebar gained "Outfits" under Create on all boards.
- Later in 2.1: Negative slot uses the node picker (search and select, the
  walk's candidates first) instead of radios; batch "What was asked" panel
  renamed "Prompt"; "All kept unless you reject them" removed; new board
  `Naming.dc.html` ("Batch naming: states": auto / typed / batch page idle /
  editing).
- Last 2.1 round: batch name shown as text + pencil (not a field); Fixed seed
  shows a seed field + dice (request 1 uses it, the rest count up); Size is a
  dropdown in the Gallery Size filter style (shape icon, ratio, pixels,
  library counts, one pick); explanatory subtexts removed from every board,
  kept as tooltips where needed (UI rule: no helper captions).
- Outfit dropdown: thumbnail in the closed button; open list (search,
  Default, the character's own, Shared; thumbnail, name, tag count; "No
  outfit") on the states board, now "Generate: picker and naming states".
  Default's thumbnail is the best-scored image wearing it. Settings shows an
  Embeddings count.
- New board `Generations.dc.html` ("Generations: all batches"): batches by
  day, search, character filter, All / Running / Failed; each row a strip of
  its first images at the batch's ratio (fixed 72px height), name, counts,
  Generator, time, status. Sidebar and breadcrumb now link to it.
- Review revision 2; still untouched: block layout and how much room the
  Character block takes.
- Not drawn yet: character picker, Remix entry in the viewer,
  connection-down and submit-rejected states, phone width.
- The mocks need several revisions before implementation starts (user's
  call: "well made, properly designed").
