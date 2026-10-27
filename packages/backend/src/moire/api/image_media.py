"""Media delivery for one image: the original file and its thumbnail (GET
and HEAD each), streamed from the local filesystem, plus the versioned
thumbnail URL. Mounted inside :mod:`api.images` (its catch-all route order)."""

import logging
import mimetypes
import os
from pathlib import Path
from typing import Literal

import anyio  # type: ignore[import-not-found]
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from ..services import thumb_version
from ..services.image_tags import find_image as _find_image_doc  # type: ignore
from ..services.storage_fs import small_thumb_path, thumb_path

logger = logging.getLogger(__name__)

router = APIRouter()


async def _original_path(image_id: str) -> str:
    """The original file of ``image_id`` on disk, or the 404 that says why
    it can't be served (unknown image, no path, file gone)."""
    img = await _find_image_doc(image_id, ("path",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    path = img.get("path")
    if not path:
        raise HTTPException(status_code=404, detail="File path not available")

    # Verify the file still exists on disk
    if not await anyio.to_thread.run_sync(lambda: os.path.isfile(path)):  # type: ignore[attr-defined]
        raise HTTPException(status_code=404, detail="Original file not found on disk")
    return path


# A URL without a version (an original, or a thumbnail URL built before they
# had one) is checked again on every use: its file may have changed under it.
_REVALIDATE = {"Cache-Control": "no-cache"}


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    """`If-None-Match` names this ETag (or `*`). Weak tags compare equal."""
    if not if_none_match:
        return False
    tags = [x.strip().removeprefix("W/") for x in if_none_match.split(",")]
    return "*" in tags or etag.removeprefix("W/") in tags


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
    path = await _original_path(image_id)

    media_type, _ = mimetypes.guess_type(path)
    try:
        st = await anyio.to_thread.run_sync(lambda: os.stat(path))  # type: ignore[attr-defined]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Original file not found on disk")
    # FileResponse handles Range headers, ETag, Content-Length natively
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


@router.head("/{image_id:path}/file")
async def head_image_file(image_id: str):
    """HEAD for the original image file: stat from the local filesystem."""
    path = await _original_path(image_id)

    media_type, _ = mimetypes.guess_type(path)
    st = await anyio.to_thread.run_sync(lambda: os.stat(path))  # type: ignore[attr-defined]
    headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(st.st_size),
    }
    return Response(
        status_code=200,
        headers=headers,
        media_type=media_type or "application/octet-stream",
    )


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
    img = await _find_image_doc(image_id, ("thumb_key",))
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key")
    if not thumb_key:
        raise HTTPException(status_code=404, detail="Thumbnail not available")

    path, cacheable = await _thumb_file(thumb_key, size)
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
