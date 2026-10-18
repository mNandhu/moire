"""Generation-metadata extraction: pure parsers turning embedded AI-art data
(Automatic1111 parameter strings, ComfyUI node graphs) into the structured
``gen.*`` fields the gallery searches and displays.

Two steps, both owned here. :func:`read_gen_raw` captures the *raw* embedded
data from an open image and is the only part that touches PIL; everything else
is pure (no I/O), so it is unit-testable without a database or image files. The
scanner stores that raw verbatim and :func:`extract` (re)derives structured
fields from it, which is why reprojection never needs to touch disk again.

The format knowledge (which chunk wins, PNG text vs EXIF, charset decoding)
lives behind :func:`gen_raw_from_embedded`, which takes the two embedded sources
as plain values so every branch is reachable from a table test.

Two source formats, two strategies:

- **a1111**: the ``parameters`` text blob: positive prompt, an optional
  ``Negative prompt:`` block, then a trailing ``key: value, ...`` settings line.
- **comfyui**: the ``prompt`` (API-format) JSON: a ``{node_id: {class_type,
  inputs}}`` graph. There is no flat "prompt" field, so we walk from the sampler
  node's ``positive``/``negative`` input links back to their source text nodes
  (the structural fallback). IDs are never trusted; they renumber on edit.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


# --- Resilient JSON parsing (pure) -------------------------------------------
#
# Embedded ComfyUI metadata is hand-assembled by a zoo of custom nodes and is
# routinely not strictly valid JSON. The two malformations seen in the wild are
# recoverable and worth recovering, since a dropped `prompt` chunk loses the
# whole signature + extraction for every image of that workflow:
#
#   - literal control characters inside string values (a real newline pasted
#     into a text-encode widget): ``strict=False`` accepts them;
#   - trailing bytes after the JSON document (NUL padding, a second
#     concatenated blob): ``raw_decode`` stops at the document's close.
#
# Truncated JSON (a clipped chunk) stays unrecoverable and returns ``None``.

_LENIENT = json.JSONDecoder(strict=False)


def loads_lenient(text: Any) -> Any | None:
    """Parse embedded metadata JSON, tolerating control chars + trailing bytes.

    Tries strict parsing first (the common case), then a lenient
    control-char-tolerant decode that ignores anything after the first complete
    value. Returns ``None`` when no leading JSON value can be salvaged; callers
    treat that the same as an absent chunk.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    try:
        obj, _ = _LENIENT.raw_decode(text.lstrip())
        return obj
    except (ValueError, TypeError):
        return None


def sanitize_json(obj: Any) -> Any:
    """Recursively replace non-finite floats (NaN/Infinity) with ``None``.

    ComfyUI commonly stores ``is_changed: NaN`` in the embedded graph, which
    ``json.loads`` parses into ``float('nan')``. That value is fine in BSON but
    poisons strict JSON serialization (Starlette renders with ``allow_nan=False``
    and raises), so any endpoint returning a raw graph must sanitize on the way
    out. Pure and total: leaves all finite/non-float values untouched.
    """
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(v) for v in obj]
    return obj


# Canonical empty structured result. Callers fill what they can; nulls mean the
# heuristic couldn't find it (which is fine; raw is always retained).
_EMPTY: dict[str, Any] = {
    "source": None,
    "workflow_sig": None,
    "prompt": None,
    "negative": None,
    "seed": None,
    "model": None,
    "sampler": None,
    "steps": None,
    "cfg": None,
    "prompt_terms": [],
    "group_id": None,
}


# --- Raw capture: how generation data is embedded in an image file ------------
#
# The one place that knows where AI-art tools hide their metadata. ComfyUI and
# Automatic1111 each write it differently, and A1111 writes it differently again
# depending on the container (PNG text chunk vs EXIF UserComment), so all three
# sniffs and the charset handling belong together rather than beside whatever
# happens to hold an open image.

_EXIF_USER_COMMENT = 0x9286


def decode_user_comment(uc: Any) -> str:
    """Decode an EXIF ``UserComment`` value to text.

    The value is an 8-byte charset prefix followed by the payload. Anything that
    is neither a declared UNICODE/ASCII payload nor already ``str`` is decoded
    leniently as utf-8. A1111 forks in the wild write the bare string.
    """
    if isinstance(uc, str):
        return uc
    if not isinstance(uc, bytes):
        return ""
    if uc[:8] == b"UNICODE\x00":
        return uc[8:].decode("utf-16-be", errors="ignore")
    if uc[:8] == b"ASCII\x00\x00\x00":
        return uc[8:].decode("ascii", errors="ignore")
    return uc.decode("utf-8", errors="ignore")


def gen_raw_from_embedded(info: Any, user_comment: Any = None) -> dict | None:
    """Build the ``image_gen_raw`` doc from an image's embedded sources.

    ``info`` is the PNG/format text dict (PIL's ``img.info``); ``user_comment``
    is the raw EXIF ``UserComment`` value if the container carries one. Returns
    ``None`` when nothing recognisable is embedded.

    Pure: the branch that reads A1111 data out of JPEG/WebP EXIF is only
    reachable from a test because it takes these as values.
    """
    info = info or {}

    # ComfyUI embeds the API-format `prompt` graph and the UI `workflow` graph as
    # PNG text chunks (JSON strings). Keep both: `prompt` drives extraction, and
    # `workflow` is needed for canvas-paste in copy-workflow.
    if info.get("prompt") or info.get("workflow"):
        # Lenient parse per chunk: a malformed `prompt` must not also discard an
        # intact `workflow` (and vice versa), and the common control-char/trailing
        # -byte malformations are recovered rather than dropped.
        return {
            "source": "comfyui",
            "prompt": loads_lenient(info.get("prompt")),
            "workflow": loads_lenient(info.get("workflow")),
        }

    # Automatic1111 PNG: a single `parameters` text chunk.
    params = info.get("parameters")
    if isinstance(params, str) and params.strip():
        return {"source": "a1111", "parameters": params}

    # Automatic1111 JPEG/WebP: the parameter string lives in EXIF UserComment.
    # `Steps:` is the marker that separates real A1111 output from any other
    # comment a camera or editor may have left there.
    text = decode_user_comment(user_comment)
    if text and "Steps:" in text:
        return {"source": "a1111", "parameters": text}
    return None


def read_gen_raw(img: Any) -> dict | None:
    """Capture the ``image_gen_raw`` doc from an open PIL image.

    The only PIL-touching step in this module. Call it while the file handle is
    open; the scanner captures at open time, inside the same ``with`` block that
    later renders the thumbnail, so the ordering cannot be got wrong.
    """
    try:
        exif = img.getexif()
        user_comment = exif.get(_EXIF_USER_COMMENT)
    except Exception:
        user_comment = None
    return gen_raw_from_embedded(getattr(img, "info", None), user_comment)


def _empty(**over: Any) -> dict[str, Any]:
    g = dict(_EMPTY)
    g["prompt_terms"] = []
    g.update(over)
    return g


def _to_int(v: Any) -> int | None:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(str(v).strip())
        return int(f) if math.isfinite(f) else None
    except (ValueError, TypeError):
        return None


def _to_float(v: Any) -> float | None:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(str(v).strip())
        # NaN/Infinity (e.g. a ComfyUI `cfg` widget that round-tripped a non-
        # finite value) must never enter gen.*; strict JSON serialization of the
        # feed (Starlette uses allow_nan=False) would 500 on it.
        return f if math.isfinite(f) else None
    except (ValueError, TypeError):
        return None


# --- Tokenisation & grouping (pure) ------------------------------------------

# Trailing prompt-weight suffix on a token, e.g. ``tag:1.1`` or ``tag:0.8``.
# Stripped only from non-lora tokens (lora tokens carry their own ``:weight``
# inside ``<...>`` and must survive intact).
_WEIGHT_RE = re.compile(r":\d+(?:\.\d+)?$")

_OPEN = "([{"
_CLOSE = ")]}"
_CLOSE_FOR = dict(zip(_OPEN, _CLOSE))
_OPEN_FOR = dict(zip(_CLOSE, _OPEN))


def _strip_emphasis_brackets(s: str) -> str:
    """Remove A1111/ComfyUI emphasis brackets while preserving balanced in-token
    parens, e.g. danbooru qualifiers like ``hatsune_miku_(vocaloid)``.

    Two moves, repeated until stable:
      * peel a fully-wrapping balanced pair: ``(masterpiece)`` -> ``masterpiece``;
      * drop an *unbalanced* edge bracket left over from comma-splitting a weighted
        group: ``(tag1`` -> ``tag1``, ``tag2)`` -> ``tag2``.
    A balanced pair already inside the token (``foo_(bar)``) is left untouched, so
    real tags are never corrupted.
    """
    changed = True
    while changed and s:
        changed = False
        # Peel a fully-wrapping balanced pair.
        if len(s) > 1 and s[0] in _OPEN and s[-1] == _CLOSE_FOR[s[0]]:
            inner = s[1:-1]
            if inner.count(s[0]) == inner.count(s[-1]):
                s = inner
                changed = True
                continue
        # Drop an unbalanced leading opener (more openers than matching closers).
        if s and s[0] in _OPEN and s.count(s[0]) > s.count(_CLOSE_FOR[s[0]]):
            s = s[1:]
            changed = True
            continue
        # Drop an unbalanced trailing closer.
        if s and s[-1] in _CLOSE and s.count(s[-1]) > s.count(_OPEN_FOR[s[-1]]):
            s = s[:-1]
            changed = True
            continue
    return s


# A1111 escapes literal parens in danbooru tags as ``\(`` / ``\)`` (also ``\[`` /
# ``\]``). Unescape them so the tag reads naturally and the bracket logic sees the
# real, balanced parens.
_ESCAPED_BRACKET_RE = re.compile(r"\\([()\[\]])")


def _sanitize_term(part: str) -> str:
    """Sanitize one comma-separated prompt tag into a clean search term.

    Unescapes ``\\(``-style literal parens, collapses internal whitespace, strips
    emphasis brackets (:func:`_strip_emphasis_brackets`) and any trailing
    ``:<number>`` weight. So ``(tag1:1.1`` and ``tag2)`` reduce to ``tag1``/``tag2``,
    a bare ``:1.1)`` collapses to empty (and is dropped), and multi-word danbooru
    tags keep their spaces and balanced parens (``hu tao (genshin impact)``). Lora
    tokens (``<lora:foo:0.8>``) start with ``<`` and are left untouched so their
    internal ``:weight`` survives.
    """
    p = _ESCAPED_BRACKET_RE.sub(r"\1", part)
    p = re.sub(r"\s+", " ", p).strip()
    p = _strip_emphasis_brackets(p).strip()
    if not p or p.startswith("<"):
        return p
    return _WEIGHT_RE.sub("", p)


def tokenize_prompt(*texts: str | None) -> list[str]:
    """Split prompt text into lowercased search terms.

    Splits on **commas only**, the tag separator in danbooru/wd-tagger and A1111
    prompts, so multi-word tags survive intact (``hu tao (genshin impact)`` is one
    term, not ``hu`` + ``tao``). Each tag is sanitized of prompt-weight syntax
    (emphasis brackets, escaped parens, trailing ``:weight``) via
    :func:`_sanitize_term`. Returns a sorted, de-duplicated list for stable storage
    + ``$in`` matching.
    """
    terms: set[str] = set()
    for text in texts:
        if not text:
            continue
        for part in text.lower().split(","):
            p = _sanitize_term(part)
            if p:
                terms.add(p)
    return sorted(terms)


def group_id(sig: str | None, positive: str | None) -> str | None:
    """Stable id for a batch of variations: images sharing a workflow signature
    AND identical positive prompt. ``None`` when there is no positive prompt, so
    prompt-less images never collapse into one giant pile."""
    pos = (positive or "").strip()
    if not pos:
        return None
    basis = f"{sig or ''}\x00{pos}"
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


# --- ComfyUI ------------------------------------------------------------------


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


def _node(prompt_json: dict[str, Any], ref: Any) -> dict[str, Any] | None:
    """Resolve a ComfyUI input link ``[node_id, slot]`` to its node dict."""
    if not isinstance(ref, list) or not ref:
        return None
    node = prompt_json.get(str(ref[0]))
    return node if isinstance(node, dict) else None


def _resolve_text(
    prompt_json: dict[str, Any], ref: Any, _seen: set[str] | None = None
) -> str | None:
    """Follow a link to a text-encode node and return its ``text`` widget.

    Recurses through pass-through nodes (e.g. a primitive feeding ``text``),
    guarding against cycles.
    """
    node = _node(prompt_json, ref)
    if node is None:
        return None
    seen = _seen or set()
    key = str(ref[0])
    if key in seen:
        return None
    seen.add(key)

    text = node.get("inputs", {}).get("text")
    if isinstance(text, str):
        return text
    if isinstance(text, list):  # text itself is a link
        return _resolve_text(prompt_json, text, seen)
    return None


def _resolve_ckpt(
    prompt_json: dict[str, Any], ref: Any, _seen: set[str] | None = None
) -> str | None:
    """Walk the ``model`` link upstream to a checkpoint loader's name widget."""
    node = _node(prompt_json, ref)
    if node is None:
        return None
    seen = _seen or set()
    key = str(ref[0])
    if key in seen:
        return None
    seen.add(key)

    inputs = node.get("inputs", {})
    for name_key in ("ckpt_name", "base_ckpt_name", "model_name", "unet_name"):
        v = inputs.get(name_key)
        if isinstance(v, str) and v:
            return v
    # Keep walking upstream through model-patch nodes (LoRA loaders etc.).
    return _resolve_ckpt(prompt_json, inputs.get("model"), seen)


def _find_sampler(prompt_json: dict[str, Any]) -> dict[str, Any] | None:
    for node in prompt_json.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", ""))
        if "Sampler" in ct or "sampler" in ct.lower():
            inp = node.get("inputs", {})
            # Prefer a node that actually carries conditioning links.
            if "positive" in inp or "latent_image" in inp or "seed" in inp:
                return node
    return None


def parse_comfyui(prompt_json: dict[str, Any] | None) -> dict[str, Any]:
    """Best-effort structural extraction from a ComfyUI ``prompt`` graph."""
    g = _empty(source="comfyui")
    if not isinstance(prompt_json, dict) or not prompt_json:
        return g

    sampler = _find_sampler(prompt_json)
    if sampler is not None:
        inp = sampler.get("inputs", {})
        g["seed"] = _to_int(inp.get("seed", inp.get("noise_seed")))
        g["steps"] = _to_int(inp.get("steps"))
        g["cfg"] = _to_float(inp.get("cfg"))
        sn = inp.get("sampler_name")
        if isinstance(sn, str):
            g["sampler"] = sn
        g["prompt"] = _resolve_text(prompt_json, inp.get("positive"))
        g["negative"] = _resolve_text(prompt_json, inp.get("negative"))
        g["model"] = _resolve_ckpt(prompt_json, inp.get("model"))

    # Class fallback for the checkpoint when the sampler walk missed it.
    if not g["model"]:
        for node in prompt_json.values():
            if isinstance(node, dict) and "Checkpoint" in str(
                node.get("class_type", "")
            ):
                ck = node.get("inputs", {}).get("ckpt_name")
                if isinstance(ck, str) and ck:
                    g["model"] = ck
                    break
    return g


# --- Automatic1111 ------------------------------------------------------------

_NEG_MARKER = "Negative prompt:"
_PARAM_RE = re.compile(r"([A-Za-z][A-Za-z0-9 ]*?):\s*([^,\n]+)")


def parse_a1111(text: str | None) -> dict[str, Any]:
    """Parse the A1111 ``parameters`` blob into structured fields."""
    g = _empty(source="a1111")
    if not text or not text.strip():
        return g
    s = text.strip()

    # The settings live on the line containing "Steps:"; everything before that
    # line is the prompt section (positive + optional negative).
    idx = s.rfind("Steps:")
    if idx != -1:
        line_start = s.rfind("\n", 0, idx) + 1
        params = s[line_start:]
        head = s[:line_start].strip()
    else:
        params, head = "", s

    if _NEG_MARKER in head:
        pos, _, neg = head.partition(_NEG_MARKER)
        g["prompt"] = pos.strip() or None
        g["negative"] = neg.strip() or None
    else:
        g["prompt"] = head.strip() or None

    for key, val in _PARAM_RE.findall(params):
        k = key.strip().lower()
        v = val.strip()
        if k == "seed":
            g["seed"] = _to_int(v)
        elif k == "model":
            g["model"] = v or None
        elif k == "sampler":
            g["sampler"] = v or None
        elif k == "steps":
            g["steps"] = _to_int(v)
        elif k == "cfg scale":
            g["cfg"] = _to_float(v)
    return g


# --- User extraction rules (pure) --------------------------------------------
#
# A ruleset (one per workflow_sig) pins dot-paths into the raw doc for specific
# fields. Pins are tried first; a resolving pin overrides the structural/class
# baseline. The fallback chain is therefore pinned -> structural -> class, and
# structural is never removed; only overridden when a pin actually resolves.

# Fields a user may pin, and their coercion. Derived fields (workflow_sig,
# prompt_terms, group_id, source) are computed, never pinned.
_INT_FIELDS = frozenset({"seed", "steps"})
_FLOAT_FIELDS = frozenset({"cfg"})
_RULE_FIELDS = frozenset(
    {"prompt", "negative", "seed", "model", "sampler", "steps", "cfg"}
)


def resolve_path(raw: Any, path: str) -> Any:
    """Walk a dot-path into the raw doc (``prompt.32.inputs.text0``).

    Segments index dict keys or, when the current value is a list, integer
    positions. Returns ``None`` on any miss (missing key, bad index, walking
    through a scalar). Never raises.
    """
    if not path or not isinstance(raw, (dict, list)):
        return None
    cur: Any = raw
    for seg in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(seg)
        elif isinstance(cur, list):
            try:
                cur = cur[int(seg)]
            except (ValueError, IndexError):
                return None
        else:
            return None
        if cur is None:
            return None
    return cur


def _coerce_field(field: str, value: Any) -> Any:
    """Coerce a pin's resolved value to the field's type, matching the structural
    parser's coercion. A non-scalar resolution (link/dict/list) is a miss."""
    if value is None:
        return None
    if field in _INT_FIELDS:
        return _to_int(value)
    if field in _FLOAT_FIELDS:
        return _to_float(value)
    # String fields accept only strings; a link (list) or node (dict) is a miss
    # so the structural fallback handles it instead of storing garbage.
    if isinstance(value, str):
        return value or None
    return None


def resolve_ruleset_paths(
    raw: dict[str, Any], fields: dict[str, list[str]]
) -> dict[str, list[dict[str, Any]]]:
    """Per-path resolution for the authoring preview: for each field, each pinned
    path with its raw resolved value and coerced result. Lets the UI show whether
    a specific pin fired, distinct from the final field value."""
    out: dict[str, list[dict[str, Any]]] = {}
    for field, paths in (fields or {}).items():
        if field not in _RULE_FIELDS:
            continue
        rows: list[dict[str, Any]] = []
        for path in paths or []:
            resolved = resolve_path(raw, path)
            rows.append(
                {
                    "path": path,
                    "raw": resolved
                    if isinstance(resolved, (str, int, float, bool))
                    else None,
                    "coerced": _coerce_field(field, resolved),
                }
            )
        out[field] = rows
    return out


def clean_rule_fields(fields: Any) -> dict[str, list[str]]:
    """Validate/normalise a ruleset's ``fields`` for storage: keep only known
    fields, coerce each to a list of non-empty path strings, drop empties."""
    out: dict[str, list[str]] = {}
    if not isinstance(fields, dict):
        return out
    for field in _RULE_FIELDS:
        raw_paths = fields.get(field)
        if not isinstance(raw_paths, list):
            continue
        paths = [p.strip() for p in raw_paths if isinstance(p, str) and p.strip()]
        if paths:
            out[field] = paths
    return out


def _apply_ruleset(
    g: dict[str, Any], raw: dict[str, Any], ruleset: dict[str, Any]
) -> None:
    """Override structural baseline ``g`` with the first resolving pin per field."""
    fields = ruleset.get("fields") or {}
    for field, paths in fields.items():
        if field not in _RULE_FIELDS:
            continue
        for path in paths or []:
            coerced = _coerce_field(field, resolve_path(raw, path))
            if coerced is not None:
                g[field] = coerced
                break


# --- Top-level dispatcher -----------------------------------------------------


def extract(
    raw: dict[str, Any] | None,
    ruleset: dict[str, Any] | None = None,
    *,
    prompt_positive_only: bool = True,
) -> dict[str, Any] | None:
    """Derive structured ``gen.*`` from a stored raw doc.

    ``raw`` is the ``image_gen_raw`` document shape:
        ``{"source": "comfyui", "prompt": {...}, "workflow": {...}}`` or
        ``{"source": "a1111", "parameters": "<text>"}``.

    ``ruleset`` (optional) pins dot-paths per field; a resolving pin overrides the
    structural/class baseline. Returns ``None`` for an unrecognised/empty source.
    ``workflow_sig``, ``prompt_terms`` and ``group_id`` are always derived here
    (the single place), never by the scanner.

    ``prompt_positive_only`` (default ``True``) restricts ``prompt_terms`` to the
    positive prompt, so negative-prompt words (``blurry``, ``lowres``) don't leak
    into searchable ``prompt:`` tags. Set ``False`` to index both.
    """
    if not isinstance(raw, dict):
        return None
    source = raw.get("source")

    if source == "comfyui":
        prompt_json = raw.get("prompt") if isinstance(raw.get("prompt"), dict) else {}
        g = parse_comfyui(prompt_json)
        g["workflow_sig"] = workflow_sig(prompt_json)
    elif source == "a1111":
        g = parse_a1111(raw.get("parameters"))
    else:
        return None

    if ruleset:
        _apply_ruleset(g, raw, ruleset)

    if prompt_positive_only:
        g["prompt_terms"] = tokenize_prompt(g.get("prompt"))
    else:
        g["prompt_terms"] = tokenize_prompt(g.get("prompt"), g.get("negative"))
    g["group_id"] = group_id(g.get("workflow_sig"), g.get("prompt"))
    return g
