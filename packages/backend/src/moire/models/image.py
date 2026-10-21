from __future__ import annotations
from pydantic import BaseModel, Field
from typing import List, Optional


class Image(BaseModel):
    id: str = Field(..., alias="_id")
    library_id: str
    path: str
    size: int
    width: int
    height: int
    ctime: float
    mtime: float
    tags: List[str] = []

    class Config:
        populate_by_name = True


class ImageQuery(BaseModel):
    tags: Optional[list[str]] = None
    logic: str = "and"  # or "or"
