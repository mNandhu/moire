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


# --- Indexes (mirror the previous Mongo index set) ---------------------------
sa.Index("ix_images_lib_id", images.c.library_id, images.c._id.desc())
sa.Index(
    "ix_images_lib_has_tags",
    images.c.library_id,
    images.c.has_tags,
    images.c._id.desc(),
)
sa.Index(
    "ix_images_lib_has_ai_tags",
    images.c.library_id,
    images.c.has_ai_tags,
    images.c._id.desc(),
)
sa.Index("ix_images_gen_model", images.c.gen_model, images.c._id.desc())
sa.Index("ix_images_gen_workflow_sig", images.c.gen_workflow_sig)
sa.Index("ix_images_gen_group_id", images.c.gen_group_id)
sa.Index("ix_image_tags_tag", image_tags.c.tag)
sa.Index("ix_image_tags_base", image_tags.c.base)
sa.Index("ix_image_gen_terms_term", image_gen_terms.c.term)
sa.Index("ix_gen_raw_lib", image_gen_raw.c.library_id)
sa.Index("ix_gen_raw_lib_sig", image_gen_raw.c.library_id, image_gen_raw.c.workflow_sig)
sa.Index("ix_gen_raw_sig", image_gen_raw.c.workflow_sig)
