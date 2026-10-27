"""Response models for the hottest read routes.

They document the wire in the OpenAPI schema and, on the routes that return
plain data, check it on the way out. They describe the payloads as they were;
they must not change them:

- Every key the route always sends is a required field with no default, so a
  missing key fails loudly instead of turning into ``null``.
- ``extra="allow"`` passes an undeclared key through untouched, so a column
  added on the service side reaches the client as before; the payload key
  snapshot (tests/fixtures/mirrored/image_payloads.json) is what notices it.
- Fields are declared in the order the services build the dicts, so the JSON
  bytes are unchanged too. JSON subdocuments (``gen``, ``ai``) are ``Any``
  inside, never coerced.
- ``_id`` would be a private attribute in pydantic; it is the alias of ``id``,
  and FastAPI serializes response models by alias.

Routes that return a ``JSONResponse`` for speed (the feed, the tag list) skip
response validation; for them the model is documentation, and a test holds it
to real rows.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class FeedRow(_Payload):
    """One feed row (GET /images): image_feed.FEED_KEYS, its thumb_key
    swapped for the versioned thumb_url."""

    id: str = Field(alias="_id")
    path: str | None
    width: int | None
    height: int | None
    blurhash: str | None
    score: float | None
    rating: str | None
    quarantined: bool | None
    has_ai_tags: bool | None
    mtime: float | None
    thumb_url: str


class GroupRow(_Payload):
    """One grouped-view row (GET /images/groups): the batch's representative
    with the batch id (null when ungrouped) and its member count."""

    id: str = Field(alias="_id")
    path: str | None
    width: int | None
    height: int | None
    blurhash: str | None
    score: float | None
    rating: str | None
    quarantined: bool | None
    has_ai_tags: bool | None
    mtime: float | None
    group_id: str | None
    group_count: int
    thumb_url: str


class ImageDetail(_Payload):
    """The single-image document (GET /images/{id}): image_tags.row_to_doc
    plus thumb_url."""

    id: str = Field(alias="_id")
    library_id: str
    path: str | None
    size: int | None
    width: int | None
    height: int | None
    ctime: float | None
    mtime: float | None
    thumb_key: str | None
    blurhash: str | None
    score: float | None
    rating: str | None
    quarantined: bool | None
    has_tags: bool | None
    has_ai_tags: bool | None
    has_prompt_tags: bool | None
    tags: list[str]
    ai: dict[str, Any] | None
    gen: dict[str, Any] | None
    thumb_url: str


class TagCount(_Payload):
    """One tag and how many images carry it (GET /tags)."""

    id: str = Field(alias="_id")
    count: int


class LibraryRow(_Payload):
    """One library (GET /libraries): library_ops.LIST_COLS plus whether a
    delete is running for it."""

    id: str = Field(alias="_id")
    path: str | None
    name: str | None
    indexed_count: int | None
    last_scanned: str | None
    scanning: bool | None
    scan_total: int | None
    scan_done: int | None
    scan_error: str | None
    scan_failed_count: int | None
    watch_enabled: bool | None
    last_event_at: str | None
    deleting: bool
