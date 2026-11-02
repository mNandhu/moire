"""Media delivery for one image: the original file and its thumbnail (GET
and HEAD each), streamed from the local filesystem, plus the versioned
thumbnail URL. Mounted inside :mod:`api.images` (its catch-all route order)."""

import logging
import mimetypes
import os
import stat
from pathlib import Path
from typing import Literal

import anyio  # type: ignore[import-not-found]
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from ..services.library import thumb_version
from ..services.tags.image_tags import find_image as _find_image_doc  # type: ignore
from ..services.library.storage_fs import (
    read_thumb,
    small_thumb_path,
    thumb_key,
    thumb_path,
)

logger = logging.getLogger(__name__)

router = APIRouter()


async def _original(image_id: str) -> tuple[str, os.stat_result]:
    """The original file of ``image_id`` on disk and its stat, or the 404
    that says why it can't be served (unknown image, no path, file gone)."""
    img = await _find_image_doc(image_id, ("path",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    path = img.get("path")
    if not path:
        raise HTTPException(status_code=404, detail="File path not available")
    try:
        st = await anyio.to_thread.run_sync(lambda: os.stat(path))  # type: ignore[attr-defined]
    except OSError:
        st = None
    if st is None or not stat.S_ISREG(st.st_mode):
        raise HTTPException(status_code=404, detail="Original file not found on disk")
    return path, st


# A URL without a version (an original, or a thumbnail URL built before they
# had one) is checked again on every use: its file may have changed under it.
_REVALIDATE = {"Cache-Control": "no-cache"}


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    """`If-None-Match` names this ETag (or `*`). Weak tags compare equal."""
    if not if_none_match:
        return False
    tags = [x.strip().removeprefix("W/") for x in if_none_match.split(",")]
    return "*" in tags or etag.removeprefix("W/") in tags


async def _original_response(image_id: str, request: Request) -> Response:
    """The original as a FileResponse (Range, ETag and Content-Length; a HEAD
    gets the same headers without the body), or a 304 when the browser's
    copy is still current."""
    path, st = await _original(image_id)
    media_type, _ = mimetypes.guess_type(path)
    resp = FileResponse(
        path,
        media_type=media_type or "application/octet-stream",
        headers={**_REVALIDATE, "Accept-Ranges": "bytes"},
        stat_result=st,
    )
    etag = resp.headers["etag"]
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers={"ETag": etag, **_REVALIDATE})
    return resp


@router.get("/{image_id:path}/file")
async def get_image_file(
    image_id: str,
    request: Request,
    range: str | None = Header(default=None, alias="Range"),
):
    """Serve the original image file directly from the local filesystem.
    Its URL has no version and the file can change under it (edited, or
    replaced at the same path), so the browser asks again on every use and
    gets a 304 while the file's ETag still matches."""
    return await _original_response(image_id, request)


@router.head("/{image_id:path}/file")
async def head_image_file(image_id: str, request: Request):
    """HEAD for the original image file: the GET's headers, no body."""
    return await _original_response(image_id, request)


ThumbSize = Literal["small"]


# Making small copies is CPU work: a cold page of previews shouldn't take
# every worker thread the other routes share.
_SMALL_LIMIT = anyio.CapacityLimiter(4)


_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


def _media_type(path: str) -> str:
    return "image/webp" if path.endswith(".webp") else "image/jpeg"


async def _thumb_file(key: str, size: ThumbSize | None) -> tuple[Path | None, bool]:
    """The file to serve, and whether it is the one asked for (cacheable)."""
    if size == "small":
        try:
            path = await anyio.to_thread.run_sync(
                lambda: small_thumb_path(key), limiter=_SMALL_LIMIT
            )
            return path, True
        except OSError:
            # Couldn't write the copy: the thumbnail stands in, uncached, so
            # the small one is asked for again.
            logger.warning("small thumbnail failed for %s", key, exc_info=True)
            path = await anyio.to_thread.run_sync(lambda: thumb_path(key))
            return path, False
    return await anyio.to_thread.run_sync(lambda: thumb_path(key)), True


# Thumbnails up to this size are read whole in one worker thread and sent as a
# plain Response, which is much cheaper under load than FileResponse's chunked
# reads. The largest today is ~370 KB; bigger ones take the route's other path.
_INLINE_LIMIT = 1 << 20


def _thumb_headers(st: os.stat_result) -> dict[str, str]:
    """FileResponse's validators for a stat, so a thumbnail has the same ETag
    whichever way it is sent."""
    r = FileResponse("", stat_result=st)
    return {"etag": r.headers["etag"], "last-modified": r.headers["last-modified"]}


async def _fast_thumb(
    image_id: str, request: Request, v: str | None
) -> Response | None:
    """The full-size thumbnail with no DB lookup: the id gives the key (the
    one formula `put_thumb` stores it under), and one thread hop stats and
    reads the file. None when it can't serve this one (nothing at the derived
    key, or too big to hold in memory); the caller then asks the DB."""
    key = thumb_key(image_id)
    inm = request.headers.get("if-none-match")
    h: dict[str, str] = {}

    def need_body(st: os.stat_result) -> bool:
        h.update(_thumb_headers(st))
        return not _etag_matches(inm, h["etag"])

    got = await anyio.to_thread.run_sync(
        lambda: read_thumb(key, _INLINE_LIMIT, need_body)
    )
    if got is None:
        return None
    body = got[1]
    cache = _IMMUTABLE if v else _REVALIDATE
    if body is None:
        return Response(status_code=304, headers={"ETag": h["etag"], **cache})
    return Response(body, media_type=_media_type(key), headers={**cache, **h})


async def _stored_key(image_id: str) -> str:
    """The thumbnail key the DB has for an image, or the 404 that says why not."""
    img = await _find_image_doc(image_id, ("thumb_key",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    key = img.get("thumb_key")
    if not key:
        raise HTTPException(status_code=404, detail="Thumbnail not available")
    return key


@router.get("/{image_id:path}/thumb")
async def get_image_thumb(
    image_id: str,
    request: Request,
    size: ThumbSize | None = None,
    v: str | None = Query(default=None, max_length=64),
):
    """The image's thumbnail; `size=small` for a copy ~256px on its short side
    (made on first ask), for previews shown postage-stamp size. `v` is the
    URL's version (`thumb_version`): with it the response is kept for a year,
    without it the browser asks again (a 304 while the file is unchanged)."""
    # A Range request needs FileResponse, which is what answers it.
    if size is None and "range" not in request.headers:
        resp = await _fast_thumb(image_id, request, v)
        if resp is not None:
            return resp
    # Small copies, Range requests, a thumbnail too big to read into memory, and
    # any id whose thumbnail is not at the derived key (a slash/backslash
    # spelling, a row with another stored key).
    key = await _stored_key(image_id)
    path, cacheable = await _thumb_file(key, size)
    if path is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    cache = _IMMUTABLE if cacheable and v else _REVALIDATE
    try:
        st = await anyio.to_thread.run_sync(lambda: os.stat(path))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    # FileResponse handles ETag/Content-Length/sendfile natively; given the
    # stat, its ETag is there to answer a revalidation with.
    resp = FileResponse(
        path, media_type=_media_type(path.name), headers=cache, stat_result=st
    )
    etag = resp.headers["etag"]
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers={"ETag": etag, **cache})
    return resp


@router.head("/{image_id:path}/thumb")
async def head_image_thumb(
    image_id: str,
    size: ThumbSize | None = None,
    v: str | None = Query(default=None, max_length=64),
):
    img = await _find_image_doc(image_id, ("thumb_key",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key", "") or ""
    exists = thumb_key and await anyio.to_thread.run_sync(lambda: thumb_path(thumb_key))
    if not exists:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    # A small copy is always WebP; it may not be made yet, so no length.
    media_type = "image/webp" if size == "small" else _media_type(thumb_key)
    headers = {"Accept-Ranges": "bytes"}
    return Response(status_code=200, headers=headers, media_type=media_type)


@router.get("/{image_id:path}/thumb-url")
async def get_thumb_url(image_id: str):
    """The image's versioned thumbnail URL, for a page holding only its id."""
    img = await _find_image_doc(image_id, ("thumb_key",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    row = {"_id": img["_id"], "thumb_key": img.get("thumb_key")}
    await thumb_version.urls_for_rows([row])
    return {"thumb_url": row["thumb_url"]}
