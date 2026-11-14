from fastapi import APIRouter
from pydantic import BaseModel

from ..services import update_check

router = APIRouter()


class VersionSettingsIn(BaseModel):
    enabled: bool


@router.get("")
async def get_version():
    """This version, and the newest on PyPI when it is newer."""
    return await update_check.status()


@router.put("")
async def set_version_settings(body: VersionSettingsIn):
    """Switch the daily update check on or off."""
    await update_check.set_enabled(body.enabled)
    return await update_check.status()


@router.post("/check")
async def check_now():
    """Ask PyPI now (Settings' Check now)."""
    await update_check.check(force=True)
    return await update_check.status()
