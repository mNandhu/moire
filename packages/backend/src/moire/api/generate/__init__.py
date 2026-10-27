"""Generation (ComfyUI): settings, status, Generators, batches.

The browser never talks to ComfyUI; everything goes through here. Progress
is polled (``GET /status``, ``GET /batches/{id}``) like the AI job status.
One router (mounted at ``/generate``) includes each part's, in this order.
"""

from fastapi import APIRouter

from . import batches, comfyui, generators, outfits, presets, recipes

router = APIRouter()
router.include_router(comfyui.router)
router.include_router(generators.router)
router.include_router(recipes.router)
router.include_router(outfits.router)
router.include_router(presets.router)
router.include_router(batches.router)
