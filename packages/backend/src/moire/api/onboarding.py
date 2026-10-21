import socket
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from .. import __version__
from ..core.config import IS_CHECKOUT, MOIRE_HOME
from ..services import onboarding

router = APIRouter()


class OnboardingIn(BaseModel):
    status: Literal["pending", "done", "skipped"]


@router.get("")
async def get_onboarding():
    """What the welcome page needs: whether to show it, and the facts it
    prints (version, where data is kept, the machine paths are read on, and
    whether this is a source checkout, which changes the GPU install command)."""
    return {
        "status": await onboarding.get_status(),
        "version": __version__,
        "data_dir": str(MOIRE_HOME),
        "host": socket.gethostname(),
        "checkout": IS_CHECKOUT,
    }


@router.put("")
async def set_onboarding(body: OnboardingIn):
    await onboarding.set_status(body.status)
    return {"status": body.status}
