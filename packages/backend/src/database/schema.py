"""Single source of truth for the SQLite schema: table + index definitions.

Both the async (:mod:`database.db`) and sync (scanner) engines import the shared
:data:`metadata` from here, so the schema is defined exactly once and created via
``metadata.create_all`` on startup.

Design notes:

- ``images.tags`` stays a JSON array (ordered, the authoritative tag list that the
  API returns). The derived ``image_tags`` and ``image_gen_terms`` tables are
  *rebuilt transactionally* from that array on every tag write (see
  :mod:`services.image_tags`); they exist only to serve ``GROUP BY`` / ``$in`` /
  ``$all`` style queries the JSON array can't index.
- ``gen.*`` scalars filtered in the feed (model / workflow_sig / group_id / prompt)
  are promoted to indexed columns; the full ``gen`` subdoc is kept as JSON for the
  workflow endpoint and reprojection.
- ``_id`` columns are ``COLLATE BINARY`` (SQLite's default, made explicit): cursor
  pagination is ``_id < :cursor`` over ``{library_id}:{relpath}`` strings and must
  match Mongo's byte-order sort. ``NOCASE`` would silently diverge pagination.
"""

from __future__ import annotations

import sqlalchemy as sa

metadata = sa.MetaData()

# COLLATE BINARY is the SQLite default; declaring it documents the pagination
# invariant and guards against an accidental NOCASE change.
_BINARY = sa.Text(collation="BINARY")


images = sa.Table(
    "images",
    metadata,
    sa.Column("_id", _BINARY, primary_key=True),
    sa.Column("library_id", sa.Text, nullable=False),
    sa.Column("path", sa.Text),
    sa.Column("size", sa.Integer),
    sa.Column("width", sa.Integer),
    sa.Column("height", sa.Integer),
    sa.Column("ctime", sa.Float),
    sa.Column("mtime", sa.Float),
    sa.Column("thumb_key", sa.Text),
    sa.Column("blurhash", sa.Text),
    sa.Column("score", sa.Float, server_default="0"),
    sa.Column("rating", sa.Text),
    sa.Column("quarantined", sa.Boolean, server_default=sa.text("0")),
    # Tag-state summary flags (derived from `tags`, recomputed on every tag write).
    sa.Column("has_tags", sa.Boolean, server_default=sa.text("0")),
    sa.Column("has_ai_tags", sa.Boolean, server_default=sa.text("0")),
    sa.Column("has_prompt_tags", sa.Boolean, server_default=sa.text("0")),
    # Authoritative, ordered tag list (AI unprefixed, manual:, prompt:).
    sa.Column("tags", sa.JSON, server_default="[]"),
    # AI tagger metadata subdoc (model, thresholds, raw tag scores).
    sa.Column("ai", sa.JSON),
    # Full structured generation subdoc (reprojection-owned).
    sa.Column("gen", sa.JSON),
    # Promoted gen.* scalars for indexed feed filters.
    sa.Column("gen_model", sa.Text),
    sa.Column("gen_workflow_sig", sa.Text),
    sa.Column("gen_group_id", sa.Text),
    sa.Column("gen_prompt", sa.Text),
)

# Derived from images.tags. `base` is the prefix-stripped form used by the
# cross-source `any:<base>` merged counts.
image_tags = sa.Table(
    "image_tags",
    metadata,
    sa.Column(
        "image_id",
        _BINARY,
        sa.ForeignKey("images._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("tag", sa.Text, primary_key=True),
    sa.Column("base", sa.Text, nullable=False),
)

# Derived from images.gen.prompt_terms.
image_gen_terms = sa.Table(
    "image_gen_terms",
    metadata,
    sa.Column(
        "image_id",
        _BINARY,
        sa.ForeignKey("images._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("term", sa.Text, primary_key=True),
)

libraries = sa.Table(
    "libraries",
    metadata,
    sa.Column("_id", _BINARY, primary_key=True),  # uuid4().hex (was ObjectId)
    sa.Column("path", sa.Text),
    sa.Column("name", sa.Text),
    sa.Column("indexed_count", sa.Integer, server_default="0"),
    # ISO-8601 string (preserves the shape the API returned under Mongo).
    sa.Column("last_scanned", sa.Text),
    sa.Column("scanning", sa.Boolean, server_default=sa.text("0")),
    sa.Column("scan_total", sa.Integer, server_default="0"),
    sa.Column("scan_done", sa.Integer, server_default="0"),
    sa.Column("scan_error", sa.Text),
    sa.Column("scan_failed_count", sa.Integer, server_default="0"),
    sa.Column("scan_failed_samples", sa.JSON, server_default="[]"),
    # Filesystem watcher: on by default per library. `last_event_at` bumps on
    # every watcher-driven add/modify/delete so pollers (the gallery feed poll)
    # can detect out-of-band changes without a dedicated push channel.
    sa.Column("watch_enabled", sa.Boolean, server_default=sa.text("1")),
    sa.Column("last_event_at", sa.Text),
)

# Cold collection: raw embedded generation metadata captured at scan time. The
# variable per-source payload (`source`, `prompt`, ...) lives in the `raw` JSON.
image_gen_raw = sa.Table(
    "image_gen_raw",
    metadata,
    sa.Column("_id", _BINARY, primary_key=True),
    sa.Column("library_id", sa.Text, nullable=False),
    sa.Column("workflow_sig", sa.Text),
    sa.Column("raw", sa.JSON),
)

# Per-tag display overrides (pinned mosaic thumbnail). Keyed by the tag id.
tag_meta = sa.Table(
    "tag_meta",
    metadata,
    sa.Column("tag", sa.Text, primary_key=True),
    sa.Column("thumb_image_id", sa.Text),
    sa.Column("updated_at", sa.Float),
)

# What the user set on a character page, keyed like tag_meta (the tag's base
# name). Every column is an override; NULL keeps what Moiré works out. The
# avatar image itself is the tag_meta cover pin; this only holds its framing.
characters = sa.Table(
    "characters",
    metadata,
    sa.Column("tag", sa.Text, primary_key=True),
    sa.Column("name", sa.Text),
    sa.Column("series", sa.Text),
    # "character" or "general": overrides the tagger's word list.
    sa.Column("kind", sa.Text),
    sa.Column("color", sa.Text),  # "#rrggbb"
    # The avatar's focus point, 0..1 from the left / top.
    sa.Column("focus_x", sa.Float),
    sa.Column("focus_y", sa.Float),
    sa.Column("updated_at", sa.Float),
)

# The face found in an image's thumbnail by the face detector, as fractions
# of the image (centre x / y, width / height), for centring character
# avatars. A row with a NULL conf means the model ran and found no face; no
# row means it hasn't run. `model` names the detector that wrote it; `mtime`
# is the image's file time it looked at, so a re-rendered file is looked at
# again (the scanner rewrites rows in place, so no cascade fires).
image_faces = sa.Table(
    "image_faces",
    metadata,
    sa.Column(
        "image_id",
        _BINARY,
        sa.ForeignKey("images._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("cx", sa.Float),
    sa.Column("cy", sa.Float),
    sa.Column("w", sa.Float),
    sa.Column("h", sa.Float),
    sa.Column("conf", sa.Float),
    sa.Column("model", sa.Text, nullable=False),
    sa.Column("mtime", sa.Float),
)

# Derived from images.gen.loras: one row per lora an image used, for the LoRA
# feed filter and its counts. Rebuilt with the gen subdoc on reprojection.
image_loras = sa.Table(
    "image_loras",
    metadata,
    sa.Column(
        "image_id",
        _BINARY,
        sa.ForeignKey("images._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("name", sa.Text, primary_key=True),
    sa.Column("strength", sa.Float),
)

# Derived from images.gen.embeddings: one row per embedding (textual
# inversion) per prompt side an image used, for the embedding feed filter and
# its counts. Rebuilt with the gen subdoc on reprojection.
image_embeddings = sa.Table(
    "image_embeddings",
    metadata,
    sa.Column(
        "image_id",
        _BINARY,
        sa.ForeignKey("images._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("name", sa.Text, primary_key=True),
    sa.Column("negative", sa.Boolean, primary_key=True),
)

# Prompt-tag merge rules (Tags page): `from_name` -> `to_name`, canonical bare
# names. Applied to `gen.prompt_terms` on every reprojection, so a merge survives
# re-extraction. Kept resolved (no chains) by services/tag_rename.py.
tag_aliases = sa.Table(
    "tag_aliases",
    metadata,
    sa.Column("from_name", sa.Text, primary_key=True),
    sa.Column("to_name", sa.Text, nullable=False),
    sa.Column("created_at", sa.Float),
)

# User prompt-extraction rulesets, keyed by workflow signature.
gen_rulesets = sa.Table(
    "gen_rulesets",
    metadata,
    sa.Column("sig", sa.Text, primary_key=True),
    sa.Column("doc", sa.JSON),
)

# Names for ComfyUI workflow families. A family is every image whose embedded
# editor graph carries the same top-level `id`; ComfyUI keeps that id when a
# file is copied or saved under a new name, so one id spans many versions.
workflow_names = sa.Table(
    "workflow_names",
    metadata,
    sa.Column("workflow_id", sa.Text, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("updated_at", sa.Float),
)

# Saved ComfyUI workflow files the user imported (only their id, filename and
# editor node types; the file itself stays on the user's machine). Used to put
# a real filename on each workflow version by matching node types.
workflow_files = sa.Table(
    "workflow_files",
    metadata,
    sa.Column("workflow_id", sa.Text, primary_key=True),
    sa.Column("filename", sa.Text, primary_key=True),
    sa.Column("node_types", sa.JSON, nullable=False),
    sa.Column("imported_at", sa.Float),
)

# Singleton key/value store for app settings (currently only the "ai" row).
app_settings = sa.Table(
    "app_settings",
    metadata,
    sa.Column("_id", sa.Text, primary_key=True),
    sa.Column("doc", sa.JSON),
)

# --- Generation (ComfyUI) -----------------------------------------------------
# All new state lives in new tables: `ensure_schema` is `create_all` only, so
# columns added to existing tables would never reach old databases.

# Models installed in ComfyUI, refreshed from /object_info and /embeddings on
# connect and Refresh. `name` is ComfyUI's own value (folder + file, sent back
# as-is); `stem` is the file name without folder or extension, the key that
# matches `image_loras.name` / `gen.loras`.
comfy_models = sa.Table(
    "comfy_models",
    metadata,
    sa.Column("kind", sa.Text, primary_key=True),  # checkpoint / lora / embedding
    sa.Column("name", sa.Text, primary_key=True),
    sa.Column("stem", sa.Text, nullable=False),
)

# The file the user picked when two installed LoRAs share a stem.
lora_choices = sa.Table(
    "lora_choices",
    metadata,
    sa.Column("stem", sa.Text, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
)

# What the user changed in a character's computed recipe, keyed by the
# character's page key. `dropped` is a JSON list of identity tags left out;
# `lora` NULL keeps the computed pick, "" means no LoRA, else a LoRA stem;
# `strength` NULL keeps the computed one.
recipe_edits = sa.Table(
    "recipe_edits",
    metadata,
    sa.Column("tag", sa.Text, primary_key=True),
    sa.Column("dropped", sa.JSON),
    sa.Column("lora", sa.Text),
    sa.Column("strength", sa.Float),
    sa.Column("updated_at", sa.Float),
)

# Saved prompt snippets for the composer's Prefix (kind "positive") and
# Negative (kind "negative") layers. String ids; a batch records the text it
# sent, so editing or deleting a preset never changes an old batch.
prompt_presets = sa.Table(
    "prompt_presets",
    metadata,
    sa.Column("_id", sa.Text, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("text", sa.Text, nullable=False, server_default=""),
    sa.Column("updated_at", sa.Float),
)

# A ComfyUI API-format graph plus slots (slot -> path into the graph). `ready`
# flips once a test run's image is found in the library.
generators = sa.Table(
    "generators",
    metadata,
    sa.Column("_id", sa.Text, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),  # builtin / custom
    sa.Column("source", sa.JSON),
    sa.Column("graph", sa.JSON, nullable=False),
    sa.Column("slots", sa.JSON, nullable=False),
    sa.Column("ready", sa.Boolean, server_default=sa.text("0")),
    sa.Column("test", sa.JSON),  # last test run: request state, error, image id
    sa.Column("created_at", sa.Float),
    sa.Column("updated_at", sa.Float),
)

# One press of Queue. `inputs` keeps everything needed to re-queue it (blocks,
# checkpoint, style LoRAs, size, seed mode, count, per request).
generation_batches = sa.Table(
    "generation_batches",
    metadata,
    sa.Column("_id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("auto_name", sa.Boolean, server_default=sa.text("1")),
    sa.Column("generator_id", sa.Text, nullable=False),
    sa.Column("inputs", sa.JSON, nullable=False),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("created_at", sa.Float),
)

# One ComfyUI prompt. state: pending / queued / running / done / failed /
# cancelled / lost.
generation_requests = sa.Table(
    "generation_requests",
    metadata,
    sa.Column("_id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column(
        "batch_id",
        sa.Integer,
        sa.ForeignKey("generation_batches._id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("idx", sa.Integer, nullable=False),
    sa.Column("prompt_id", sa.Text),
    sa.Column("seed", sa.Integer),
    sa.Column("images", sa.Integer),  # asked for; None when batch_size unknown
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("error", sa.JSON),
    sa.Column("progress", sa.JSON),
    sa.Column("queued_at", sa.Float),
    sa.Column("finished_at", sa.Float),
)

# Images a request returned, from /history. `image_id` is the expected
# `{output_library_id}:{subfolder/filename}`; it is joined to `images` on read,
# so "waiting for scan" is just "no row yet".
generation_outputs = sa.Table(
    "generation_outputs",
    metadata,
    sa.Column(
        "request_id",
        sa.Integer,
        sa.ForeignKey("generation_requests._id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("idx", sa.Integer, primary_key=True),
    sa.Column("filename", sa.Text, nullable=False),
    sa.Column("subfolder", sa.Text, nullable=False, server_default=""),
    sa.Column("image_id", _BINARY, nullable=False),
)


# --- Indexes ------------------------------------------------------------------
# Feed orders (services/image_feed.SORTS). Each expression must match the
# feed's SORT_KEY / SCORE_KEY exactly for SQLite to use it, and every index a
# feed filter can lead with ends in the same keys, so a filtered or scoped page
# walks one index in order instead of sorting all matches. "Oldest" walks the
# newest-first indexes backwards.
_recent = sa.func.coalesce(images.c.mtime, sa.literal_column("0"))
_score = sa.func.coalesce(images.c.score, sa.literal_column("0"))
_newest = (_recent.desc(), images.c._id.desc())
_top = (_score.desc(), *_newest)

sa.Index("ix_images_recent", *_newest)
sa.Index("ix_images_top", *_top)
sa.Index("ix_images_lib_recent", images.c.library_id, *_newest)
sa.Index("ix_images_lib_top", images.c.library_id, *_top)
sa.Index("ix_images_has_tags_recent", images.c.has_tags, *_newest)
sa.Index("ix_images_has_ai_tags_recent", images.c.has_ai_tags, *_newest)
sa.Index(
    "ix_images_lib_has_tags_recent", images.c.library_id, images.c.has_tags, *_newest
)
sa.Index(
    "ix_images_lib_has_ai_tags_recent",
    images.c.library_id,
    images.c.has_ai_tags,
    *_newest,
)
sa.Index("ix_images_model_recent", images.c.gen_model, *_newest)
# The quarantine count on Overview (and the quarantined view's lookup).
sa.Index("ix_images_quarantined", images.c.quarantined)
# Also serves the Rules page's per-signature GROUP BY.
sa.Index("ix_images_sig_recent", images.c.gen_workflow_sig, *_newest)

# Superseded by the indexes above (they ended in `_id`, the old feed order).
# ensure_schema drops them from existing databases.
RETIRED_INDEXES = (
    "ix_images_lib_id",
    "ix_images_lib_has_tags",
    "ix_images_lib_has_ai_tags",
    "ix_images_gen_model",
    "ix_images_gen_workflow_sig",
    "ix_image_tags_tag",
    "ix_image_tags_base",
)

sa.Index("ix_images_gen_group_id", images.c.gen_group_id)
# Covering (x, image_id): tag counts and `$in` lookups read the index alone.
sa.Index("ix_image_tags_tag_img", image_tags.c.tag, image_tags.c.image_id)
sa.Index("ix_image_tags_base_img", image_tags.c.base, image_tags.c.image_id)
sa.Index("ix_image_gen_terms_term", image_gen_terms.c.term)
sa.Index("ix_image_loras_name", image_loras.c.name)
sa.Index("ix_image_embeddings_name", image_embeddings.c.name)
sa.Index("ix_gen_raw_lib", image_gen_raw.c.library_id)
sa.Index("ix_gen_raw_lib_sig", image_gen_raw.c.library_id, image_gen_raw.c.workflow_sig)
sa.Index("ix_gen_raw_sig", image_gen_raw.c.workflow_sig)
sa.Index(
    "ix_generation_requests_batch",
    generation_requests.c.batch_id,
    generation_requests.c.idx,
)
sa.Index("ix_generation_requests_state", generation_requests.c.state)
