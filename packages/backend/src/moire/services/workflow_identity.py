"""Workflow identity: what makes two ComfyUI workflows the same one.

A *signature* (:func:`workflow_sig`) is the multiset of node kinds in an
image's API graph, so it survives id renumbering and widget tweaks. A saved
workflow *file* is matched to an image by node-type similarity of the editor
graphs (:func:`match_workflow_file`), and :func:`describe_signatures` names
what tells one signature apart from the rest. Pure: no I/O, no extraction.
"""

from __future__ import annotations

import hashlib
from typing import Any


def workflow_sig(prompt_json: dict[str, Any] | None) -> str | None:
    """Hash the sorted multiset of node ``class_type``s.

    Ignores node ids, widget values and edges, so it is stable across id
    renumbering and value tweaks; it changes only when node *kinds* are
    added/removed. Coarse by design.
    """
    if not isinstance(prompt_json, dict) or not prompt_json:
        return None
    types = sorted(
        str(n.get("class_type", ""))
        for n in prompt_json.values()
        if isinstance(n, dict)
    )
    if not any(types):
        return None
    return hashlib.sha1("\x00".join(types).encode("utf-8")).hexdigest()[:16]


def workflow_node_types(prompt_json: dict[str, Any] | None) -> list[str]:
    """The node ``class_type``s of a ComfyUI prompt graph, unsorted: exactly
    the multiset ``workflow_sig`` hashes (a node without one counts as "")."""
    if not isinstance(prompt_json, dict):
        return []
    return [
        str(n.get("class_type", ""))
        for n in prompt_json.values()
        if isinstance(n, dict)
    ]


def editor_node_types(workflow_json: dict[str, Any] | None) -> list[str]:
    """Node ``type``s of a ComfyUI *editor* graph (the ``workflow`` chunk, and
    the format of a saved ``.json`` file), unsorted. The same function reads
    both sides of a version-to-file match, so they're always comparable."""
    if not isinstance(workflow_json, dict):
        return []
    nodes = workflow_json.get("nodes")
    if not isinstance(nodes, list):
        return []
    return [
        str(n.get("type", "")) for n in nodes if isinstance(n, dict) and n.get("type")
    ]


def node_type_similarity(a: list[str], b: list[str]) -> float:
    """Multiset Jaccard similarity of two node-type lists, in [0, 1]."""
    from collections import Counter

    ca, cb = Counter(a), Counter(b)
    union = sum((ca | cb).values())
    return sum((ca & cb).values()) / union if union else 0.0


# Below this, a file is a different version rather than the one that made the
# image. Saved files keep changing after an image is made, so exact equality
# is too strict; a few added or removed nodes still identify the file.
FILE_MATCH_MIN = 0.8


def match_workflow_file(
    image_types: list[str], files: list[tuple[str, list[str]]]
) -> tuple[str, float] | None:
    """The imported file (``(filename, node_types)``) whose editor graph is
    closest to the one embedded in an image, with its similarity, or None
    when nothing clears :data:`FILE_MATCH_MIN`. Ties go to the filename that
    sorts last, which for versioned names ("V2.1" < "V2.2") is the newest."""
    if not image_types:
        return None
    best: tuple[str, float] | None = None
    for filename, types in sorted(files, key=lambda f: f[0]):
        score = node_type_similarity(image_types, types)
        if score >= FILE_MATCH_MIN and (best is None or score >= best[1]):
            best = (filename, score)
    return best


# Nodes that only display, annotate or route: they tell two workflows apart
# by accident, not by what they do, so they never name one.
_UI_ONLY_NODES = frozenset(
    {"PreviewImage", "Note", "MarkdownNote", "Reroute", "PrimitiveNode"}
)


def describe_signatures(
    types_by_sig: dict[str, list[str]], *, limit: int = 4
) -> dict[str, dict[str, Any]]:
    """Human summary per workflow signature, for a picker that would otherwise
    show bare hashes.

    A signature *is* its multiset of node types, so what tells two apart is the
    nodes one has beyond what every signature shares. For each sig returns
    ``node_count`` and ``distinct``: up to ``limit`` ``{"type", "count"}`` of
    its node types over the common baseline (min count across the sigs whose
    graph could be read; an unreadable sample contributes no types and must
    not zero the baseline for everyone). With a single readable signature
    there is no baseline to subtract.

    ``distinct`` is ordered rarest first (present in the fewest signatures),
    then by count descending, then by name, so a node every other workflow
    lacks names this one ahead of a utility node most of them carry.
    Display-only and unnamed ("") nodes are never listed.
    """
    from collections import Counter

    counters = {sig: Counter(types) for sig, types in types_by_sig.items()}
    readable = [c for c in counters.values() if c]
    if len(readable) > 1:
        all_types = set().union(*readable)
        baseline = Counter(
            {ty: min(c.get(ty, 0) for c in readable) for ty in all_types}
        )
    else:
        baseline = Counter()
    spread = Counter(ty for c in counters.values() for ty in c)
    out: dict[str, dict[str, Any]] = {}
    for sig, c in counters.items():
        extra = c - baseline
        ranked = sorted(
            ((ty, n) for ty, n in extra.items() if ty and ty not in _UI_ONLY_NODES),
            key=lambda kv: (spread[kv[0]], -kv[1], kv[0]),
        )[:limit]
        out[sig] = {
            "node_count": sum(c.values()),
            "distinct": [{"type": ty, "count": n} for ty, n in ranked],
        }
    return out
