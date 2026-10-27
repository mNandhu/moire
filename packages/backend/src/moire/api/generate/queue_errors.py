"""The HTTP reply for a failure to queue generation work, shared by every
route that queues (a batch, a requeue, a Generator test)."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from ...services.generation_errors import Invalid, Rejected, Unavailable

QUEUE_ERRORS = (Unavailable, Invalid, Rejected)


def queue_error(e: Exception) -> JSONResponse:
    """Unavailable is a 503 and Invalid a 400 (raised); Rejected is a 422
    whose body carries ComfyUI's node errors beside the detail (returned)."""
    if isinstance(e, Rejected):
        return JSONResponse(
            status_code=422,
            content={"detail": e.message, "node_errors": e.node_errors},
        )
    status = 503 if isinstance(e, Unavailable) else 400
    raise HTTPException(status_code=status, detail=str(e)) from e
