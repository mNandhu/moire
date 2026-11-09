"""Reading a prompt's ComfyUI ``/history`` entry: its outputs, how it ended,
whether it loaded its checkpoint and how long it ran. Pure."""

from __future__ import annotations

from typing import Any


def outputs_from_history(entry: dict[str, Any]) -> list[tuple[str, str]]:
    """(subfolder, filename) of every saved output image, in node order."""
    files: list[tuple[str, str]] = []
    for node_id in sorted(
        (entry.get("outputs") or {}).keys(), key=lambda k: (len(k), k)
    ):
        for img in entry["outputs"][node_id].get("images") or []:
            if img.get("type", "output") == "output" and img.get("filename"):
                files.append((img.get("subfolder") or "", img["filename"]))
    return files


def history_result(entry: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Final state of a prompt from its history entry: done / failed /
    cancelled, plus the error doc for failed."""
    status = entry.get("status") or {}
    messages = status.get("messages") or []
    for item in messages:
        if (
            isinstance(item, list)
            and len(item) == 2
            and item[0] == "execution_interrupted"
        ):
            return "cancelled", None
    for item in messages:
        if isinstance(item, list) and len(item) == 2 and item[0] == "execution_error":
            d = item[1] or {}
            return "failed", {
                "node": str(d.get("node_id") or ""),
                "class_type": d.get("node_type"),
                "type": d.get("exception_type"),
                "message": d.get("exception_message") or "",
            }
    if status.get("status_str") == "error":
        return "failed", {
            "node": "",
            "class_type": None,
            "type": None,
            "message": "ComfyUI reported an error",
        }
    return "done", None


_ENDS = ("execution_success", "execution_error", "execution_interrupted")


def model_loaded(entry: dict[str, Any], node_id: str | None) -> bool | None:
    """Whether a prompt had to load its checkpoint: ComfyUI's history lists
    the nodes it reused from cache (``execution_cached``), so a checkpoint
    loader that isn't among them ran, and read the model from disk. ``None``
    when that can't be told (no checkpoint node, no such message)."""
    if not node_id:
        return None
    for item in (entry.get("status") or {}).get("messages") or []:
        if (
            isinstance(item, list)
            and len(item) == 2
            and item[0] == "execution_cached"
            and isinstance(item[1], dict)
        ):
            nodes = item[1].get("nodes") or []
            return str(node_id) not in {str(n) for n in nodes}
    return None


def run_seconds(entry: dict[str, Any]) -> float | None:
    """How long ComfyUI ran a prompt: its history's ``execution_start`` to
    the message that ended it (timestamps in ms). None when either is missing."""
    start = end = None
    for item in (entry.get("status") or {}).get("messages") or []:
        if not (
            isinstance(item, list) and len(item) == 2 and isinstance(item[1], dict)
        ):
            continue
        ts = item[1].get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        if item[0] == "execution_start":
            start = ts
        elif item[0] in _ENDS:
            end = ts
    if start is None or end is None or end < start:
        return None
    return round((end - start) / 1000, 2)
