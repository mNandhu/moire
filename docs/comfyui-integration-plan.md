# Moiré: ComfyUI Integration Plan

Date started: 2026-10-19
Status: design done (mock revision 2.1), implementation planned; no code yet
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
  only). Sampler / scheduler / steps / CFG are slots too: the built-in has
  them (added 2026-10-20, phase 2); a custom Generator keeps the graph's own
  unless setup maps them.
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

**Superseded 2026-10-20 (composer rework, option A on the canvas board
"Generate: composer rework options").** Base turned out to hold the whole
prompt, so: the positive prompt is an ordered list of layers, Prefix (a
saved preset, not a text box) + Character (one line, expands to the full
block) + Prompt (the big main field, free text with tag / embedding
autocomplete: Tab takes a suggestion, Enter only after arrowing into the
list) + any the user adds with the "+" between layers (Text, Preset,
Embedding). Negative = a preset + text. Presets live in `prompt_presets`
(defaults added once); a layer keeps a snapshot of the preset's text, and the
batch records the text sent, so editing or deleting a preset never changes
an old batch. The batch auto name without a character takes the Prompt's
first two terms (`prompt_terms`). Results of the newest batch show under
Queue (below it, so the button never moves); Base / Extra survive only for
batches queued before the rework (requeue and Edit and queue still read
them). The text below is the original design.


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
  tags" (since the composer rework: the Prompt's first two terms) without a character, else "Batch <n>". Built from the structured
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
| ComfyUI down | connect error | Status red with Retry and a link to settings; Queue disabled; running batches show Paused and resume tracking on reconnect; model pickers keep the last known list |
| Rejected on submit | `/prompt` `node_errors` | First request rejected: nothing is queued and no batch is kept; the composer stays as it was, the errors list node + message, and fields they map to (checkpoint, a LoRA) turn red. A later request rejected: that request fails on the batch page |
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

0. **Attire list**: dev script, committed JSON, loader. Independent. Needs a
   Danbooru session that passes Cloudflare, so it can run after phase 1.
1. **Tracer**: ComfyUI settings page (address, headers, output folder as
   library, checkpoint / LoRA / embedding index, LoRA matching table, built-in
   images per request), built-in Generator with its test run, composer (Base
   + Extra with tag and embedding autocomplete, negative), run panel
   (checkpoint, Style LoRAs list, size dropdown, seed random / fixed, count
   with requests split, batch name), Queue, request tracking and failures
   (connection down, rejected, OOM, lost), queue card + global busy, batch
   review (requests, keep / reject / score, retry, cancel), Generations
   list, sidebar "Create" group, LoRA splice at the built-in's model / CLIP
   (needed by Style LoRAs; decided 2026-10-20).
2. **Character recipe**: character picker, Character block, identity tags,
   character LoRA (through phase 1's splice), recipe edits. (Weak-recipe warning deferred.)
3. **Custom Generators**: setup flow (slot discovery, Base from the image
   minus character / outfit tags, node picker, seed grouping, images per
   request, LoRA insertion point model / CLIP picks, SaveImage check,
   test-run gate), update from latest on the Generator page, Remix from the
   viewer.
4. **Outfits**: default outfit from the recipe, Outfit block + picker with
   thumbnails, save-outfit dialog in the viewer, sharing / hide per
   character, Outfits page, character page strip, Open in gallery.

Later: adherence stats, settings recall, learned negatives, X/Y batches,
coverage gaps. Deferred: reference images.

## Implementation

Planned 2026-10-20 against the code as of `9879823`. Phase 1 is detailed to
the file; later phases list what they add.

### Dependencies

- **Backend**: `httpx` (already a dependency) for ComfyUI's REST API.
  `websockets` (v15, today only a transitive dependency of uvicorn[standard])
  becomes a declared dependency for the ComfyUI websocket client
  (`websockets.asyncio.client.connect`, used as an async iterator for
  automatic reconnect, `additional_headers` for the optional headers).
  Nothing else.
- **Frontend**: none. Existing pieces cover it: `Picker` (single select when
  `value` is a string; `icon` takes any node, so it can hold a thumbnail),
  `TagSuggestList`, `SizeFilter`'s presets endpoint and `ShapeIcon`,
  `Dialog`, TanStack Query polling as in `useAiStatus`.
- **Data**: the attire list JSON (phase 0) under `packages/backend/data/` or
  next to the tagger vocab, loaded once.

### Backend

**Schema.** `ensure_schema` only runs `create_all`: new tables appear on
existing databases, new columns on old tables don't. So everything new is a
new table in `database/schema.py`; nothing is added to `images` or
`characters`.

| Table | Holds | Phase |
|---|---|---|
| `app_settings` row `"comfyui"` | address, headers (server-side only), output library id, built-in images per request | 1 |
| `comfy_models` | installed checkpoints, LoRAs, embeddings from ComfyUI (kind, name, folder path, stem), refreshed on connect / Refresh | 1 |
| `lora_choices` | stem → chosen file when two files share a name | 1 |
| `generators` | id, name, kind (builtin / custom), source (family id + image id, or upload), API graph JSON, slots JSON, ready flag, test (last test run's batch id), created / updated | 1 (builtin), 3 |
| `generation_batches` | id, number, name, auto-name flag, generator id, inputs doc (blocks, character, outfit, LoRAs, size, seed mode, count, per request), state, created | 1 |
| `generation_requests` | id, batch id, index, ComfyUI prompt_id, seed, image count, state (pending / queued / running / done / failed / cancelled / lost), error doc (node, type, message), progress, timestamps | 1 |
| `generation_outputs` | request id, index in request, filename, subfolder, expected image `_id` | 1 |
| `recipe_edits` | character tag → dropped tags, forced LoRA / strength | 2 |
| `outfits` | id, name, owner character tag (NULL = shared), tags JSON, thumbnail image id, created | 4 |
| `outfit_hidden` | (character tag, outfit id) for shared outfits hidden per character | 4 |

**Output matching.** A request's outputs come from `/history/<prompt_id>`
(`type: output` only). The expected image id is
`{output_library_id}:{subfolder/filename}`; the batch page joins it to
`images` when it reads, so "waiting for scan" is just "no row yet". No hook
in the scanner. Reject / score go through `image_tags.set_quarantine` /
`set_score`, the single mutator.

**Services** (`src/services/`):

- `comfy_client.py`: thin async client. REST via `httpx.AsyncClient`
  (`/system_stats` for Test, `/object_info/{class}`, `/embeddings`,
  `POST /prompt` with a fixed `client_id`, `/history/{id}`, `/queue`,
  `POST /interrupt`, `POST /queue` delete). One websocket task
  (`/ws?clientId=…`): `status` (queue_remaining, global busy), `executing`,
  `progress` (value / max per node), `execution_error`,
  `execution_interrupted`, `execution_success`. Binary preview frames
  ignored.
- `comfy_settings.py`: the `"comfyui"` row, like `ai_settings.py`. Setting
  the output folder registers a library (or reuses one at that path) via the
  existing libraries code.
- `comfy_models.py`: refresh the index from `object_info`
  (`CheckpointLoaderSimple.ckpt_name`, `LoraLoader.lora_name`) and
  `/embeddings`; stem matching against `image_loras` / `gen.loras` names;
  the LoRA matching table for Settings.
- `generator_graph.py`: **pure functions, no I/O, the most tests.**
  - slot discovery (reuse `gen_metadata._find_sampler`, `_resolve_text`,
    `text_candidates`, ruleset pins), seed grouping, latent node
    (size, `batch_size`), SaveImage check, model / CLIP pick candidates
  - `build_prompt(graph, slots, values)`: write text, seeds, size,
    batch_size; splice the LoRA chain at the model / CLIP picks and rewire
    every consumer; `LoraLoaderModelOnly` when there's no CLIP; override the
    strength of a LoRA the graph already loads through a stock loader
  - `split_requests(count, per_request)` and the seed sequence
- `builtin_generator.py`: the shipped txt2img graph + its slots.
- `generation_jobs.py`: modelled on `ai_jobs.py`, started in lifespan.
  Turns a batch into requests, submits them (one in flight per batch is
  enough; ComfyUI queues the rest), maps ws events to request state, reads
  `/history` as the final word, records outputs. On startup it reconciles
  unfinished requests against `/queue` + `/history` (missing from both =
  lost). Connection down: Queue refused, nothing persisted.
- `generation_compose.py`: blocks → positive / negative text (reuse the
  `toPromptText` escaping rules, ported or shared), embeddings as
  `embedding:name`, batch auto-name.
- Phase 2 `recipes.py` (on `characters.signature` minus attire tags, LoRA
  pick from `image_loras` + confirmed character tags, score weighted, edits
  on top). Phase 4 `outfits.py`, `attire.py` (phase 0 loader).

**API** (`src/api/generate.py`, mounted at `/api/v1/generate`):

- `GET/PUT /comfyui`, `POST /comfyui/test`, `POST /comfyui/refresh`,
  `GET /comfyui/models`, `PUT /comfyui/lora-choices`
- `GET /status`: connection, busy, and the queue card's active batches
  (name, requests finished / total, failed, current step progress), polled
- `GET /generators`, `GET /generators/{id}`; phase 3: `POST /generators`
  (from family image or upload), `POST /generators/{id}/discover`,
  `PUT /generators/{id}`, `POST /generators/{id}/test`
- `POST /batches` (queue), `GET /batches` (Generations list, filters),
  `GET /batches/{id}` (requests, outputs joined to images, progress),
  `PATCH /batches/{id}` (rename), `POST /batches/{id}/requeue`,
  `POST /batches/{id}/requests/{rid}/retry` (`single: true` = one at a
  time), `POST /batches/{id}/cancel`
- No separate autocomplete endpoint (built): the composer merges the
  existing tag suggestions with the embeddings list from
  `GET /comfyui/models`.
- A rejected first request answers 422 with `node_errors`, each carrying
  `field` (checkpoint / lora / positive / negative, or null) and for LoRAs
  `lora_name` + `added` (spliced by Moiré), which is what the composer flags.
- Phase 2 `GET/PUT /recipes/{tag}`; phase 4 `/outfits` CRUD,
  `PUT /outfits/{id}/hidden`

Progress reaches the browser by polling `GET /status` and
`GET /batches/{id}` (1s while running, off when idle), like the AI job
status. The browser never talks to ComfyUI.

### Frontend

**Routes** (`RootRoutes.tsx`): `/generate`, `/generations`,
`/generations/:id`, `/outfits` (phase 4), `/generate/generators/new`
(phase 3). Settings registry gains a "Generation" group with a `comfyui`
section. Sidebar gains the "Create" group (Generate, Generations, Outfits).

**Pure `lib/` with tests:** `compose.ts` (blocks to text, join order,
escaping via `toPromptText`), `batchName.ts`, `requests.ts` (split,
`4 × 2` label, count mode: images / requests / unknown), `seed.ts`
(fixed sequence per request).

**Hooks:** `useComfyStatus` (polled), `useBatch(id)` (polled while
running), `useGenerators`, later `useRecipe`, `useOutfits`.

**Components** (`components/generate/`):

- `PromptBlock` (Base textarea, chip blocks with `TagSuggestList`; embedding
  chips styled apart), `CharacterBlock` (phase 2), `OutfitBlock` +
  `OutfitPicker` (phase 4)
- `RunPanel`: checkpoint `Picker`, `StyleLoras`, `SizePicker` (single-select
  version of `SizeFilter`, same presets and `ShapeIcon`), `SeedControl`,
  `CountStepper` (`4 × 2` / `8 × 4` / `8 × ?`), `BatchName` (text + pencil),
  Queue button, `QueueCard`, recent batches
- `BatchReview`: request groups, tiles (score / reject / restore via the
  existing image mutations, K / X / 1-5 keys), failed and running request
  cards, Prompt panel
- `GenerationsList`, `ComfySettingsSection` (connection, output folder,
  model counts, LoRA matching table)
- Phase 3: `GeneratorSetup` + `NodePicker`; phase 4: `SaveOutfitDialog` in
  `ImageView`, `CharacterOutfits` strip on `CharacterPage`, `OutfitsPage`
- Rules that apply throughout: no native `<select>`, no helper captions
  (tooltips), no em dashes, pure logic in `lib/`.

### Per phase

0. Attire list: dev script, JSON, `attire.py` loader + tests.
1. Tracer: deps; tables `comfy_models`, `lora_choices`, `generators`,
   `generation_*`; `comfy_client`, `comfy_settings`, `comfy_models`,
   `generator_graph` (write + split + LoRA splice), `builtin_generator`,
   `generation_jobs`, `generation_compose`; router; frontend Settings
   section, `/generate` (Base + Extra, Style LoRAs, run panel),
   `/generations`, `/generations/:id`, sidebar.
2. Recipes: `recipe_edits`, `recipes.py`, `CharacterBlock`, character
   picker.
3. Custom Generators: discovery half of `generator_graph`, setup API,
   `GeneratorSetup` + `NodePicker`, test-run gate, Remix in `ImageView`.
4. Outfits: `outfits`, `outfit_hidden`, `outfits.py`, save dialog, Outfit
   block + picker, Outfits page, character page strip, Open in gallery
   (plain all-of `tags` filter).

**As built (phase 1 backend, 2026-10-20).** ComfyUI's `/queue` +
`/history` are the truth: a poll loop (1s with work in flight, 5s idle) moves
requests along and records outputs; the websocket only adds step progress and
wakes the loop. One request per batch is in ComfyUI at a time; the rest wait
as pending. Queue, retry and cancel take the loop's lock, so the loop never
double-submits a new batch or calls a just-queued prompt lost. Retrying a
done request is allowed only when it returned no images. Cancel interrupts a
running prompt only after a fresh `/queue` shows it is ours and running.

**As built (phase 2, 2026-10-20).** `recipes.py` + `recipe_edits`;
`GET/PUT /generate/recipes/{tag}`. Choices made against the real library:
- Identity = signature tags in the body groups of the tag-group list (hair,
  hair colour / styles, eyes, ears, skin colour, wings; breast sizes only);
  unlisted tags only when the name says body (`_pupils`, `halo`, ...). The
  plain "signature minus attire" let in scene, pose and nudity tags
  (`full_moon`, `couch`, `looking_at_viewer`).
- Character LoRA: a LoRA whose file name holds the character's name comes
  first; any other must have at least 3 of the character's images, be mostly
  theirs (50%), and be at least twice their share of the library (a character
  on most images otherwise owns every style LoRA). Then confirmed weight
  (images where prompted + tagger confirmed, 1 + score each), prompted
  weight, count. Picker also lists every installed LoRA; "No LoRA" stores "".
- The composer sends the block as sent (`character`: tag, label, tags, LoRA
  file); the batch keeps it and requeue replays it, not today's recipe.
  Character LoRA joins the style list once (by stem), character strength wins.
- Recipe edits apply at once (drop / restore a chip, LoRA, strength on
  release); a LoRA that isn't installed shows "Not installed" and is left out.
- Default outfit is returned (`outfit`) but not shown until phase 4.
- Identity and outfit are capped at 12 each, after filtering (near-duplicate
  images can tie dozens of scene tags at the top of the signature).
- Signature noise on small characters (2026-10-20): `characters.signature`
  reads the images the character is alone in once there are 3
  (`signature_counts`, as the palette does), so a co-star's hair and eyes
  don't leak in; a tag's share must also clear a Wilson lower bound (z = 1)
  of 0.25 (`confident`: 2 of 3 images, not 1 of 3); then
  `one_colour_per_slot` keeps the most common hair colour and eye colour (a
  second when a multicolour tag is in the signature too). The page and
  recipe return how many images it read (`signature_images` /
  `identity_images`); under 5, the UI says the look may be off.
- "Edit and queue" from a character batch picks the character again and so
  loads today's recipe, not the tags that batch recorded (Requeue replays
  the recorded ones).

**As built (phase 2, later rounds, 2026-10-20).**
- Generate layout "A2": layers on the left with the run bar pinned to the
  bottom of that column (Checkpoint, Sampling, Size, Seed, Images, Batch
  name, Queue); the right column holds other active batches, the newest
  batch's images and Recent batches. Size / Checkpoint / Sampling open
  upward.
- Style LoRAs are a layer. Each LoRA can carry an **activation preset**
  (`lora_presets`: stem, name, text, optional strength) whose words go
  where the Style layer sits. Suggested words (`GET /generate/lora-words`):
  the file's trigger phrase and frequent training tags (ComfyUI
  `/view_metadata/loras`), minus words common in library prompts made
  without that LoRA; plus library words with lift (counted per distinct
  prompt, at least 3 prompts). `describe=1` keeps common words (identity
  tags for a new character).
- Prompt autocomplete opens under the caret, shows tag covers, and offers
  characters the tagger knows that the library doesn't (no cover).
- **Hand-made characters**: a `characters` row with `kind='character'`
  for a tag no image carries (Fern before any Fern image exists). Made from
  "New character" (Tags page, the character picker; the picker's search
  becomes `Create "<query>"`): tag (autocompleted from the tagger's
  names), name, character LoRA, identity tags offered from the LoRA. It
  gets a character page with Generate in place of images; it can be
  deleted only while no image carries it. The recipe (identity tags, LoRA)
  is also editable in the Characters Edit dialog.
- **Several characters per prompt** (up to 8): `characters` list in the
  body and batch inputs (`character` kept as the first, for old readers);
  each gets its own block; each one's LoRA joins the style list. Auto name
  joins their names with " & ". Characters are added from the "+" layer
  menu; the card swaps character from its name, toggles on click.
- The page takes the picked characters' colours (several mixed).
- **Sampling**: built-in slots for sampler, scheduler, steps, CFG; the
  stored built-in row's graph and slots are replaced by the code's on load.
  Lists from ComfyUI's `KSampler` object info (kept in its order in
  `comfy_models` kinds `sampler` / `scheduler`). The form keeps only what
  the user changed; the batch stores that (`inputs.sampling`), requeue
  replays it, the batch page shows it.
- **Batch size** per batch (built-in only; custom Generators in phase 3,
  where it would also change what count means): beside Images, which stays
  the total. Only a size the user chose is stored apart
  (`inputs.per_request_asked`) and replayed by requeue and Edit and queue,
  so a changed setting still applies to batches that used it.
- **Time taken**: ComfyUI's history `execution_start` to its end message,
  per request (`generation_run_times`); the output panel shows the batch
  total, the batch page the total and per image. Batches from before have
  none.
- Wide images stack in the output column (two: one above the other).
- Generations page: a grid of batch covers (one image fills it, two split,
  more make a mosaic with "+N"); status shows only when not done.

### Testing

- Backend unit: `generator_graph` (fixtures: built-in graph, one real
  family graph from the library with hires + detailer, a UNET + CLIP graph),
  `generation_compose`, stem matching.
- Backend integration (`tests/test_generate_integration.py`, existing
  `client` / `seed` fixtures) with a fake ComfyUI: a small FastAPI app or
  `httpx.MockTransport` serving `/prompt`, `/history`, `/queue`,
  `/object_info`, `/embeddings`, plus a scripted ws feed.
- Frontend: vitest for the `lib/` modules; component tests for the count
  stepper modes and request grouping.

### Decided before phase 1 (2026-10-20)

- The built-in Generator goes through the test-run gate too (it proves the
  output folder mapping and that the checkpoint loads).
- The built-in Generator's images per request is a number on the ComfyUI
  settings page, default 1.
- The LoRA splice joins phase 1 (built-in graph only), so the Style LoRAs
  list ships as drawn; phase 2 reuses it for the character LoRA.
- "All Images" stays as is for now; the rename to "Gallery" comes later.
- Connection-down and submit-rejected states get drawn on the canvas before
  phase 1 code. Drawn: board `Errors.dc.html` ("Generate: connection down and
  rejected"); behaviour in the Failures table.

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
- ComfyUI docs (2026-10-20): `GET /embeddings` lists embedding names;
  `GET /object_info/{class}` returns one node's schema; ws messages include
  `status` (queue_remaining), `executing`, `progress` (value / max),
  `executed`, `execution_cached`, `execution_success`, `execution_error`
  (exception_type, exception_message, traceback), `execution_interrupted`.
- `websockets` 15 asyncio client: `connect()` as an async iterator
  reconnects with backoff; headers via `additional_headers`.
- `ensure_schema` is `create_all` only: new tables reach old databases, new
  columns don't.

## UI

Mock canvas (Design artifact, private):
https://claude.ai/artifact/9NuwckDfNaD4wXqGn46h8a

Revision 1 (2026-10-19), four static screens styled on Moiré's tokens
(canvas `#0d0c12`, surface/raised, brand violet `#6e52d6`, Instrument Sans,
JetBrains Mono for values, Caveat Brush for scores), placeholder striped
tiles instead of images (later revisions below change parts of this; where they disagree, the later one wins):

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

### Revision 2.1 log (2026-10-20, later rounds)


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
- `Errors.dc.html` ("Generate: connection down and rejected") added.

Canvas boards now (12): Main, Batch, Setup, ComfyUI (settings), Outfit (save
dialog), Picker (node picker), Outfits, CharOutfits, Naming (picker, naming,
size, outfit dropdown and count states), Generations, Errors, plus
`canvas.json`. Read them from the artifact before revising; the scratchpad
copies can be wiped.

### Next session

- Design is settled enough to build. Remaining undrawn: Remix entry in the viewer (phase 3), phone width. Block layout
  / Character block size was never revisited; check it when building.
- Phase 1 built on `feat/comfyui-phase1` (2026-10-20), not merged: backend
  (tables, graph writer + LoRA splice, client, jobs, API) and frontend
  (Generate, Generations, batch page, ComfyUI settings). Tested against the
  fake ComfyUI only; the UI has not been clicked through in a browser yet.
  Left out of phase 1: "Open these in Gallery" from a batch (needs an
  image-id filter), the queue card outside /generate, phone width.
- Phase 0 runs in parallel in a separate session (worktree
  `../Tagify-attire`, branch `feat/attire-list`).
- Checked against a real remote ComfyUI (2026-10-20): HTTPS through a port
  forward with a self-signed certificate (TLS certificate setting), auth via
  the comfyui-login Bearer token in the request headers. Its output folder
  is on another machine, so finished outputs are downloaded over `/view`
  ("Download images from ComfyUI", on by default)
  into the local output library (skipped when the file is already there, as
  with a local ComfyUI); the watcher indexes them with their metadata. The
  tunnel's TLS handshake can take 8s, hence 15s connect / 60s timeouts.
  Test run, 4 images at 2 per request, and a style LoRA batch all worked.
- Canvas comments: replies from the auto-reply bot are sometimes wrong
  (offered options for things already decided); read each thread and correct
  it rather than trusting the bot's reply.

### Next session (from 2026-10-20 night; phase 2 merged to main)

Phase 2 is done and fast-forwarded to main. Open:
- Not clicked through in a browser yet: preset dialog New / Edit / Delete,
  the Embedding layer, Negative expand, a running cell's progress in the
  result grid, LoRA file-word suggestions in describe mode against a real
  LoRA (ComfyUI was unreachable at the end of the session), a real batch
  with changed sampling, the output column with a real landscape batch.
- Phase 1 leftovers, kept for last: "Open these in Gallery" from a batch
  (needs an image-id filter); phone width for Generate and the batch page.
- Weak-recipe warning: still deferred.
- Next: phase 3 (custom Generators). Undrawn: Remix entry in the viewer.
  Setup should offer the sampling slots (found from the sampler walk).
- Dev helpers (fake ComfyUI, headless screenshots, sandbox ports):
  `docs/dev-tools/README.md`.
