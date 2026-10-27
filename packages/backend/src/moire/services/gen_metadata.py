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
  Text resolution along those links lives in :mod:`services.comfy_text`, the
  workflow signature in :mod:`services.workflow_identity`.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from typing import TYPE_CHECKING, Any

from . import comfy_text, prompt_guess, workflow_identity
from .model_names import model_stem
from .prompt_parse import EMBEDDING_TOKEN, parse_prompt
from .tag_names import canonical_name
from .tag_rules import apply_rule_weights, apply_rules

if TYPE_CHECKING:
    from .extraction_settings import ExtractionConfig


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
    "prompt_weights": {},
    "loras": [],
    "embeddings": [],
    "group_id": None,
    "guessed": [],
    "guess_paths": {},
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
        doc = {
            "source": "comfyui",
            "prompt": loads_lenient(info.get("prompt")),
            "workflow": loads_lenient(info.get("workflow")),
        }
        # Moire's own chunk on images it queued: the family they belong to.
        moire = loads_lenient(info.get("moire"))
        if isinstance(moire, dict):
            doc["moire"] = moire
        return doc

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


# Bump when what the scanner captures changes (a new embedded format, a parser
# fix, the `workflow_sig` algorithm in workflow_identity): a rescan skips
# unchanged files without opening them, and this version is part of its skip
# stamp, so a bump makes the next scan of each library recapture everything.
CAPTURE_VERSION = 1


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
    g = copy.deepcopy(_EMPTY)
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


def tokenize_prompt(*texts: str | None) -> list[str]:
    """Prompt text -> sorted, de-duplicated tag terms in canonical spelling.

    Parsing is best effort and lives in :mod:`services.prompt_parse`: emphasis
    and weights are stripped, groups missing a comma are split, Danbooru
    qualifiers (``hu tao (genshin impact)``) and lora tokens stay whole, and
    prose fragments, leaked settings and stray weights are not terms. Sorted
    for stable storage + ``$in`` matching.
    """
    terms: set[str] = set()
    for text in texts:
        for piece in parse_prompt(text):
            if piece.kind == "tag":
                terms.add(canonical_name(piece.text))
    return sorted(terms)


def prompt_weights(text: str | None, source: str | None) -> dict[str, float]:
    """``{term: weight}`` for the tag terms of a positive prompt whose weight,
    as ``source`` reads emphasis (:meth:`Piece.weight`), is not 1. A term
    written more than once keeps the weight farthest from 1, the first on a
    tie. Only the positive prompt: a negative prompt's emphasis is not how
    strongly the image shows a tag."""
    out: dict[str, float] = {}
    for piece in parse_prompt(text):
        if piece.kind != "tag":
            continue
        term = canonical_name(piece.text)
        w = piece.weight(source)
        if abs(w - 1) > abs(out.get(term, 1.0) - 1):
            out[term] = w
    return out


def group_id(sig: str | None, positive: str | None) -> str | None:
    """Stable id for a batch of variations: images sharing a workflow signature
    AND identical positive prompt. ``None`` when there is no positive prompt, so
    prompt-less images never collapse into one giant pile."""
    pos = (positive or "").strip()
    if not pos:
        return None
    basis = f"{sig or ''}\x00{pos}"
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


# --- LoRAs -------------------------------------------------------------------
#
# Recorded as structured data (``gen.loras = [{name, strength}]``), never as
# tags. ComfyUI applies them through loader nodes; a graph only holds nodes that
# executed, so every lora node in it was used. Loader shapes in the wild:
#   - LoraLoader / LoraLoaderModelOnly: ``lora_name`` + ``strength_model``
#   - rgthree Power Lora Loader: ``lora_1`` ... dicts ``{on, lora, strength}``
#   - stackers (Efficiency, Comfyroll): ``lora_name_1`` + ``model_str_1`` /
#     ``lora_wt_1`` / ``strength_1``, often with a ``switch_1`` on/off

_LORA_TAG = r"<(?:lora|lyco|lycoris):([^:>]+)(?::([-\d.]+))?"
_LORA_TOKEN = re.compile("^" + _LORA_TAG, re.IGNORECASE)
_LORA_ANYWHERE = re.compile(_LORA_TAG, re.IGNORECASE)
# Nodes that apply `<lora:...>` tags in a ComfyUI prompt: a prompt-parsing
# encoder, or a remote queue (the remote graph may). A stock CLIPTextEncode
# reads them as plain text, so elsewhere they aren't used LoRAs.
_PROMPT_LORA_NODES = re.compile(r"WildcardEncode|RemoteQueue", re.IGNORECASE)


def lora_name(raw: str) -> str:
    """Display / filter name of a lora file: no folders, no extension."""
    return model_stem(raw)


def _add_lora(out: dict[str, float | None], raw: Any, strength: Any) -> None:
    if not isinstance(raw, str) or not raw.strip() or raw.strip().lower() == "none":
        return
    st = _to_float(strength)
    if st == 0:
        return  # loaded at zero strength: not applied
    name = lora_name(raw)
    if name and name not in out:
        out[name] = st


def comfy_loras(prompt_json: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every lora a ComfyUI graph applied, in graph order, once each."""
    out: dict[str, float | None] = {}
    if not isinstance(prompt_json, dict):
        return []
    for node in prompt_json.values():
        if (
            not isinstance(node, dict)
            or "lora" not in str(node.get("class_type", "")).lower()
        ):
            continue
        inp = node.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        if "lora_name" in inp:
            _add_lora(
                out,
                inp["lora_name"],
                next(
                    (
                        inp[k]
                        for k in ("strength_model", "strength", "lora_strength")
                        if k in inp
                    ),
                    None,
                ),
            )
        for key, val in inp.items():
            # rgthree-style dict entries.
            if isinstance(val, dict) and "lora" in val:
                if val.get("on", True) is not False:
                    _add_lora(out, val.get("lora"), val.get("strength"))
                continue
            # Numbered stacker entries.
            m = re.fullmatch(r"lora_name_(\d+)", key)
            if m:
                n = m.group(1)
                if str(inp.get(f"switch_{n}", "On")).lower() in ("off", "false"):
                    continue
                strength = next(
                    (
                        inp[k]
                        for k in (
                            f"model_str_{n}",
                            f"lora_wt_{n}",
                            f"strength_{n}",
                            f"model_weight_{n}",
                        )
                        if k in inp
                    ),
                    None,
                )
                _add_lora(out, val, strength)
    return [{"name": k, "strength": v} for k, v in out.items()]


def prompt_loras(text: str | None) -> list[dict[str, Any]]:
    """``<lora:name:0.8>`` tokens in a prompt (A1111 syntax), once each."""
    out: dict[str, float | None] = {}
    for piece in parse_prompt(text):
        m = _LORA_TOKEN.match(piece.text) if piece.kind == "network" else None
        if m:
            _add_lora(out, m.group(1), m.group(2))
    return [{"name": k, "strength": v} for k, v in out.items()]


def _raw_prompt_loras(
    text: str | None, have: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Like :func:`prompt_loras`, off the raw text so a file name keeps its
    case (as a loader node's does); each name once, ignoring case, and none
    already in ``have``."""
    seen = {lo["name"].lower() for lo in have}
    out: dict[str, float | None] = {}
    for m in _LORA_ANYWHERE.finditer(text or ""):
        name = lora_name(m.group(1))
        if name and name.lower() not in seen:
            seen.add(name.lower())
            _add_lora(out, m.group(1), m.group(2))
    return [{"name": k, "strength": v} for k, v in out.items()]


def _applies_prompt_loras(prompt_json: dict[str, Any]) -> bool:
    return any(
        isinstance(n, dict) and _PROMPT_LORA_NODES.search(str(n.get("class_type", "")))
        for n in prompt_json.values()
    )


def prompt_embeddings(prompt: str | None, negative: str | None) -> list[dict[str, Any]]:
    """Embeddings (textual inversions) named in the prompts, ComfyUI's
    ``embedding:name`` or ``<embedding:name>``: ``{name, negative}`` once per
    name and side, in prompt order. ``name`` drops folders and extension, like
    a lora's. Bare A1111 embedding names read as words, so they aren't seen."""
    out: dict[tuple[str, bool], None] = {}
    for text, neg in ((prompt, False), (negative, True)):
        # Read off the raw text, not the parsed pieces, which are lowercased:
        # a file name keeps its case. Same word-start rule as the parser.
        for m in EMBEDDING_TOKEN.finditer(text or ""):
            before = text[m.start() - 1] if m.start() else " "
            if before.isalnum() or before == "_":
                continue
            name = lora_name(m.group(1))
            if name:
                out.setdefault((name, neg), None)
    return [{"name": name, "negative": neg} for name, neg in out]


def _find_sampler(prompt_json: dict[str, Any]) -> dict[str, Any] | None:
    for node in prompt_json.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", ""))
        if "Sampler" in ct or "sampler" in ct.lower():
            inp = node.get("inputs")
            if not isinstance(inp, dict):
                continue
            # Prefer a node that actually carries conditioning links.
            if "positive" in inp or "latent_image" in inp or "seed" in inp:
                return node
    return None


def parse_comfyui(
    prompt_json: dict[str, Any] | None, workflow_json: Any = None
) -> dict[str, Any]:
    """Best-effort structural extraction from a ComfyUI ``prompt`` graph.
    ``workflow_json`` (the editor graph) only supplies display-node caches for
    prompts built at run time."""
    g = _empty(source="comfyui")
    if not isinstance(prompt_json, dict) or not prompt_json:
        return g

    sampler = _find_sampler(prompt_json)
    if sampler is not None:
        inp = sampler["inputs"]  # a dict: _find_sampler checks it
        g["seed"] = _to_int(inp.get("seed", inp.get("noise_seed")))
        g["steps"] = _to_int(inp.get("steps"))
        g["cfg"] = _to_float(inp.get("cfg"))
        sn = inp.get("sampler_name")
        if isinstance(sn, str):
            g["sampler"] = sn
        shown = comfy_text.display_cache(prompt_json, workflow_json)
        g["prompt"] = comfy_text.resolve_text(
            prompt_json, inp.get("positive"), shown=shown
        )
        g["negative"] = comfy_text.resolve_text(
            prompt_json, inp.get("negative"), shown=shown
        )
        g["model"] = comfy_text.resolve_ckpt(prompt_json, inp.get("model"))
    g["loras"] = comfy_loras(prompt_json)

    # Class fallback for the checkpoint when the sampler walk missed it.
    if not g["model"]:
        for node in prompt_json.values():
            if isinstance(node, dict) and "Checkpoint" in str(
                node.get("class_type", "")
            ):
                inp = node.get("inputs")
                ck = inp.get("ckpt_name") if isinstance(inp, dict) else None
                if isinstance(ck, str) and ck:
                    g["model"] = ck
                    break
    return g


def text_candidates(
    prompt_json: dict[str, Any], workflow_json: Any = None
) -> list[prompt_guess.Candidate]:
    """Every text in the graph, with its raw-doc path: string inputs of the
    prompt graph, then display widgets of the editor graph (what a display
    node showed when the run didn't cache it in the prompt graph). Display
    nodes' text is marked ``shown``: it actually ran. Their cached text is
    replaced by what this run computed, where the graph allows."""
    out: list[prompt_guess.Candidate] = []
    for node_id, node in prompt_json.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        shown = comfy_text.is_display(node.get("class_type"))
        ran = comfy_text.displayed_text(prompt_json, node_id) if shown else None
        out.extend(
            prompt_guess.Candidate(
                ran if ran is not None and k == "text_0" else v,
                shown,
                f"prompt.{node_id}.inputs.{k}",
            )
            for k, v in node["inputs"].items()
            if isinstance(v, str)
        )
    nodes = workflow_json.get("nodes") if isinstance(workflow_json, dict) else None
    for i, wn in enumerate(nodes if isinstance(nodes, list) else []):
        if not isinstance(wn, dict) or not comfy_text.is_display(wn.get("type")):
            continue
        path, wv = f"workflow.nodes.{i}.widgets_values", wn.get("widgets_values")
        while isinstance(wv, list) and wv:
            path, wv = f"{path}.0", wv[0]
        if isinstance(wv, str):
            ran = comfy_text.displayed_text(prompt_json, wn.get("id"))
            out.append(
                prompt_guess.Candidate(ran if ran is not None else wv, True, path)
            )
    return out


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
    g["loras"] = prompt_loras(g["prompt"])
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


_DISPLAY_PROMPT_PATH = re.compile(r"^prompt\.([^.]+)\.inputs\.text_0$")
_DISPLAY_WIDGET_PATH = re.compile(r"^workflow\.nodes\.(\d+)\.widgets_values(?:\.0)*$")


def pin_value(raw: Any, path: str) -> Any:
    """What a pinned path holds. A pin on a display node's cached text means
    "what this node showed", so it gets the text computed for this run when
    the graph allows (the cache is the previous run's); any other path is
    read as is (:func:`resolve_path`)."""
    if isinstance(raw, dict):
        prompt_json = raw.get("prompt")
        node_id: Any = None
        if m := _DISPLAY_PROMPT_PATH.match(path or ""):
            node_id = m.group(1)
        elif m := _DISPLAY_WIDGET_PATH.match(path or ""):
            nodes = resolve_path(raw, "workflow.nodes")
            idx = int(m.group(1))
            if (
                isinstance(nodes, list)
                and idx < len(nodes)
                and isinstance(nodes[idx], dict)
            ):
                node_id = nodes[idx].get("id")
        if node_id is not None:
            ran = comfy_text.displayed_text(prompt_json, node_id)
            if ran is not None:
                return ran
    return resolve_path(raw, path)


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
            resolved = pin_value(raw, path)
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
            coerced = _coerce_field(field, pin_value(raw, path))
            if coerced is not None:
                g[field] = coerced
                break


# --- Top-level dispatcher -----------------------------------------------------


def extract(
    raw: dict[str, Any] | None,
    ruleset: dict[str, Any] | None = None,
    *,
    prompt_positive_only: bool = True,
    guess_keywords: prompt_guess.Keywords = prompt_guess.DEFAULT_KEYWORDS,
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

    A ComfyUI prompt or negative still empty after both is guessed from
    ``guess_keywords`` (:mod:`services.prompt_guess`), named in ``gen.guessed``
    and located in ``gen.guess_paths`` (a pinnable path per field).
    """
    if not isinstance(raw, dict):
        return None
    source = raw.get("source")

    if source == "comfyui":
        prompt_json = raw.get("prompt") if isinstance(raw.get("prompt"), dict) else {}
        g = parse_comfyui(prompt_json, raw.get("workflow"))
        g["workflow_sig"] = workflow_identity.workflow_sig(prompt_json)
    elif source == "a1111":
        g = parse_a1111(raw.get("parameters"))
    else:
        return None

    if ruleset:
        _apply_ruleset(g, raw, ruleset)

    g["guessed"], g["guess_paths"] = [], {}
    if source == "comfyui" and not (g.get("prompt") and g.get("negative")):
        picked = prompt_guess.pick(
            text_candidates(prompt_json, raw.get("workflow")),
            guess_keywords,
            prompt=g.get("prompt"),
            negative=g.get("negative"),
        )
        for field in ("prompt", "negative"):
            if field in picked:
                g[field] = picked[field].text
                g["guessed"].append(field)
                g["guess_paths"][field] = picked[field].path

    g["embeddings"] = prompt_embeddings(g.get("prompt"), g.get("negative"))
    if source == "comfyui" and _applies_prompt_loras(prompt_json):
        # LoRAs written into the prompt as `<lora:name:w>` count too, after
        # the graph's own loaders, where something in the graph applies them.
        g["loras"] += _raw_prompt_loras(g.get("prompt"), g["loras"])

    if prompt_positive_only:
        g["prompt_terms"] = tokenize_prompt(g.get("prompt"))
    else:
        g["prompt_terms"] = tokenize_prompt(g.get("prompt"), g.get("negative"))
    g["prompt_weights"] = prompt_weights(g.get("prompt"), source)
    g["group_id"] = group_id(g.get("workflow_sig"), g.get("prompt"))
    return g


def derive(
    raw: dict[str, Any] | None,
    ruleset: dict[str, Any] | None,
    config: ExtractionConfig,
) -> dict[str, Any] | None:
    """The ``gen`` stored for ``raw``: :func:`extract` with the config's
    switches, then the merge/split rules applied to the extracted terms, so a
    merged tag never comes back on re-run. Reprojection and the rules preview
    both call this."""
    g = extract(
        raw,
        ruleset,
        prompt_positive_only=config.positive_only,
        guess_keywords=config.keywords,
    )
    if g is not None:
        g["prompt_terms"] = apply_rules(g.get("prompt_terms") or [], config.rules)
        g["prompt_weights"] = apply_rule_weights(
            g.get("prompt_weights") or {}, config.rules
        )
    return g
