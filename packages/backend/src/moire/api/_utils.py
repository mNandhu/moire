from __future__ import annotations

from fastapi import HTTPException


def validate_tags(tags: list[str], *, max_count: int = 100) -> list[str]:
    if len(tags) > max_count:
        raise HTTPException(status_code=422, detail=f"too many tags (max {max_count})")
    cleaned: list[str] = []
    for t in tags:
        if not isinstance(t, str) or not t.strip():
            raise HTTPException(status_code=422, detail="tags must be non-empty")
        tt = t.strip()
        if len(tt) > 128:
            raise HTTPException(status_code=422, detail="tag too long (max 128)")
        cleaned.append(tt)
    return cleaned
