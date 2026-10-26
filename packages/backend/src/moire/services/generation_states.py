"""The states a generation request moves through, named once for the
manager, the read side and the estimate.

A request is ``pending`` (waiting here), ``queued`` / ``running`` (in
ComfyUI), then ``done``, ``failed``, ``cancelled`` or ``lost`` (ComfyUI
forgot it). ``replaced`` is one split by "Retry one at a time" into singles:
kept for the record, never shown."""

from __future__ import annotations

# Still to finish: a batch with one of these is running (or paused).
UNFINISHED = ("pending", "queued", "running")
# Sent to ComfyUI and not ended there yet.
IN_COMFY = ("queued", "running")
# Ended without its images: shown as failed.
FAILED = ("failed", "lost")
# Ended, so it can be retried (a done one only when it returned no images).
RETRYABLE = ("done", "cancelled", *FAILED)
# Split into singles by a retry; hidden from views.
REPLACED = "replaced"
