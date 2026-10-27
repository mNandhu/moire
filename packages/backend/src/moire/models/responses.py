"""Response models for the hottest read routes.

They document the wire in the OpenAPI schema; they never touch it. Each route
declares its model through ``documents``, which lists it as the 200 response
without making it the ``response_model``, so FastAPI neither validates nor
re-serializes the payload: a stored value of an unexpected type is served as
before instead of turning the route into a 500, and the bytes are whatever the
service built. test_response_models_integration.py holds each model to real
route rows in strict mode instead.

- Every key the route always sends is a required field with no default.
- ``extra="allow"`` so a model validates a row carrying a key it does not
  declare yet; the payload key snapshot
  (tests/fixtures/mirrored/image_payloads.json) is what notices that key.
- JSON subdocuments (``gen``, ``ai``) are ``Any`` inside.
- ``_id`` would be a private attribute in pydantic; it is the alias of ``id``.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


def documents(model: Any) -> dict[str, Any]:
    """Route kwargs that list ``model`` as the 200 response for the OpenAPI
    schema without validating or re-serializing what the route returns."""
    return {"response_model": None, "responses": {200: {"model": model}}}


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


class GroupRow(FeedRow):
    """One grouped-view row (GET /images/groups): the batch's representative
    with the batch id (null when ungrouped) and its member count."""

    group_id: str | None
    group_count: int


class ImageDetail(FeedRow):
    """The single-image document (GET /images/{id}): image_tags.row_to_doc
    plus thumb_url."""

    library_id: str
    size: int | None
    ctime: float | None
    thumb_key: str | None
    has_tags: bool | None
    has_prompt_tags: bool | None
    tags: list[str]
    ai: dict[str, Any] | None
    gen: dict[str, Any] | None


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
