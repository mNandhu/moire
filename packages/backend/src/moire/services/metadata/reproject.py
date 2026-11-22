"""Reprojection: (re)derive structured ``gen.*`` on image rows from the raw
generation data captured at scan time.

Decoupled from disk scanning. It reads ``image_gen_raw`` (the cold table) and
writes the small structured subdoc (plus the promoted ``gen_*`` filter columns and
the derived ``image_gen_terms`` rows) onto ``images``. Because raw is retained, this
can re-run any time (e.g. after extraction rules change) without re-reading a file.

Sync (SQLAlchemy core) by design: the only callers are scan/manual threads, which
are sync. Writes go through small per-batch transactions to keep the SQLite write
lock held briefly (see :mod:`database.db` writer discipline).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from contextlib import contextmanager
from collections.abc import Callable, Iterable, Iterator

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ...database.db import checkpoint_wal, sync_conn, sync_tx
from ...database import schema as t
from .. import activity
from . import derive_worker, extraction_settings, gen_metadata
from ..tags import image_tags
from ..tags import index as tag_index
from ..tags.kinds import to_prompt

logger = logging.getLogger("moire.reproject")

_BATCH = 200
# Raw rows read per query (each page its own short read, see _raw_pages).
_PAGE = 500


def _load_rulesets() -> dict[str, dict]:
    """All user rulesets keyed by workflow signature."""
    with sync_conn() as conn:
        rows = (
            conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return {r.sig: (r.doc or {}) for r in rows}


# --- Skip stamps ----------------------------------------------------------------
#
# `gen_metadata.derive(raw, ruleset, config)` is pure, so a row whose raw,
# ruleset and config are what its stored `gen` was derived from comes out the
# same: a library, by-signature or full run skips it in SQL, before its raw is
# read. Each derived row is stamped (`image_gen_derived.derive_key`) with the
# fingerprint of those inputs; the scanner's raw writes clear the stamp and
# give `raw_rev` a value it never had (`gen_raw_revision`, even across a row
# deleted and written again), and a stamp only lands while `raw_rev` is still
# the one the run read with the raw, so a raw rewritten mid-run is derived
# again next run.
# Id-targeted runs (watcher, deferred, rule changes, resumed libraries) and
# forced runs never skip; they stamp what they derive.


def _fingerprint(
    ruleset: dict | None, config: extraction_settings.ExtractionConfig
) -> str:
    doc = {
        "v": gen_metadata.DERIVE_VERSION,
        "ruleset": ruleset or None,
        "positive_only": config.positive_only,
        "keywords": [
            sorted(config.keywords.positive),
            sorted(config.keywords.negative),
        ],
        # In the key on purpose: a stamp then always names every input, so no
        # missed or cut-off rule reprojection can hide behind a matching one.
        "rules": config.rules,
    }
    blob = json.dumps(doc, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:20]


class _Keys:
    """One run's expected stamp per workflow signature: the rulesets and
    config it derives with, so a setting saved mid-run can't be stamped onto
    a row derived with the old one."""

    def __init__(self, rulesets: dict[str, dict], config) -> None:
        self.default = _fingerprint(None, config)
        self.by_sig = {
            sig: _fingerprint(doc, config) for sig, doc in rulesets.items() if doc
        }

    def of(self, sig: str | None) -> str:
        return self.by_sig.get(sig, self.default) if sig is not None else self.default

    def stale(self):
        """SQL: the raw row's stamp is not this run's key for its signature."""
        expected = (
            sa.case(
                self.by_sig, value=t.image_gen_raw.c.workflow_sig, else_=self.default
            )
            if self.by_sig
            else sa.literal(self.default)
        )
        return t.image_gen_derived.c.derive_key.is_distinct_from(expected)


_STAMP = sa.text(
    "INSERT INTO image_gen_derived (_id, raw_rev, derive_key) "
    "SELECT _id, :rev, :key FROM image_gen_raw WHERE _id = :id "
    "ON CONFLICT(_id) DO UPDATE SET derive_key = excluded.derive_key "
    "WHERE image_gen_derived.raw_rev = excluded.raw_rev"
)


def _stamp(conn, stamps: list[tuple[str, int, str]]) -> None:
    """Stamp ``(image_id, raw_rev read, key)`` rows, each only while its raw
    is still the revision that was read (and still exists)."""
    if stamps:
        conn.execute(
            _STAMP, [{"id": i, "rev": rev, "key": key} for i, rev, key in stamps]
        )


# One raw row's result: its id, the derived gen as stored (a JSON round trip,
# :func:`derive_worker.derive_rows`; None: nothing derivable), and the stamp
# to write with it.
_Item = tuple[str, "dict | None", int, str]


def _flush_batch(batch: list[_Item], *, force: bool = False) -> bool:
    """Persist one batch of derived results and stamp every row of it, in
    short write transactions (:func:`_chunks`: tens of milliseconds each).
    Rows whose stored ``gen`` and tags already match are not written (most
    of a full reprojection after a settings change), unless ``force``: a
    migration that added a derived table needs every row rebuilt even when
    ``gen`` is unchanged. Returns whether it wrote anything besides stamps.

    ``batch`` holds gens as stored (:func:`derive_worker.derive_rows`).
    What can happen outside the write lock does: a read of the stored
    ``gen`` and tags, and planning each write against them. Each write
    transaction reads them again for the rows it writes and re-plans any
    whose tags changed meanwhile (a concurrent AI or manual tag write), so
    reprojection never writes over one."""
    with sync_conn() as conn:
        before = {
            r._id: r
            for r in conn.execute(
                sa.select(t.images.c._id, t.images.c.gen, t.images.c.tags).where(
                    t.images.c._id.in_([i for i, *_ in batch])
                )
            )
        }
    writes: list[_Write] = []
    # Nothing derivable: stamped as is, so the row isn't read again until an
    # input changes.
    underivable: list[tuple[str, int, str]] = []
    # Nothing to write against ``before``: stamped too, after a re-check.
    unchanged: list[_Write] = []
    for image_id, g, rev, key in batch:
        row = before.get(image_id)
        if row is None:
            continue  # deleted since the raws were read
        stamp = (image_id, rev, key)
        if g is None:
            underivable.append(stamp)
        elif (planned := _plan(image_id, g, row, force=force)) is None:
            unchanged.append(_Write(stamp, g, list(row.tags or []), None, 0))
        else:
            writes.append(_Write(stamp, *planned))
    wrote = False
    first = True
    chunks = list(_chunks(writes))
    if not chunks and (underivable or unchanged):
        chunks = [[]]  # one transaction for the stamps alone
    for chunk in chunks:
        with sync_tx() as conn:
            chunk_wrote = bool(chunk) and _write_chunk(conn, chunk, force=force)
            if first:
                _stamp(conn, underivable)
                chunk_wrote |= _stamp_unchanged(conn, unchanged)
                first = False
        # Each commit owns the post-commit dirtying of the derived tag
        # aggregation. Soft, like the AI job's writes: a hard invalidate per
        # commit would rebuild every view each time. The run ends its writes
        # with one hard invalidate (:func:`_run_writes`).
        if chunk_wrote:
            tag_index.invalidate_soft()
            wrote = True
    return wrote


def _stamp_unchanged(conn, unchanged: list[_Write]) -> bool:
    """Stamp rows planned as nothing to write, on the caller's write
    transaction, once their ``gen`` and tags are checked again: a tag write
    since the plan (one that dropped prompt tags) would otherwise be stamped
    over, and no later non-forced run would read the row. A changed row is
    written (:func:`_write_chunk` re-plans it). Returns whether it wrote."""
    if not unchanged:
        return False
    current = {
        r._id: r
        for r in conn.execute(
            sa.select(t.images.c._id, t.images.c.gen, t.images.c.tags).where(
                t.images.c._id.in_([w.stamp[0] for w in unchanged])
            )
        )
    }
    stamps: list[tuple[str, int, str]] = []
    changed: list[_Write] = []
    for w in unchanged:
        row = current.get(w.stamp[0])
        if row is None:
            continue  # deleted since it was planned
        if row.gen == w.gen and list(row.tags or []) == w.tags:
            stamps.append(w.stamp)
        else:
            changed.append(w)
    _stamp(conn, stamps)
    return bool(changed) and _write_chunk(conn, changed, force=False)


# One write transaction's size: at most this many images, and it closes once
# their planned row operations (join rows dropped or added, about 10 us each
# with their indexes) reach the budget. The AI job's per-image write waits
# behind each one, so it is kept to tens of milliseconds: an image's first
# derive with ~120 prompt terms and ~40 AI tags is ~300 operations.
_WRITE = 50
_WRITE_OPS = 3000


def _chunks(writes: list[_Write]) -> Iterator[list[_Write]]:
    chunk: list[_Write] = []
    ops = 0
    for w in writes:
        chunk.append(w)
        ops += w.ops
        if len(chunk) >= _WRITE or ops >= _WRITE_OPS:
            yield chunk
            chunk, ops = [], 0
    if chunk:
        yield chunk


def _prompt_tags(g: dict) -> list[str]:
    # Mirror the extracted terms into prompt: tags (keeping AI + manual).
    return [to_prompt(term) for term in (g.get("prompt_terms") or [])]


def _plan(image_id: str, g: dict, row, *, force: bool):
    """``(gen, tags planned against, tag write, row operations)`` for a row whose stored
    ``gen`` and tags are ``row``'s, or None when nothing is to be written."""
    tags = list(row.tags or [])
    tag_write = image_tags.plan_prompt_write(
        image_id, tags, _prompt_tags(g), force=force
    )
    gen_changed = force or g != row.gen
    if not gen_changed and tag_write is None:
        return None
    ops = 1
    if tag_write is not None:
        ops += (
            len(tag_write.drop) + len(tag_write.add)
            if not force
            else 2 * len(tag_write.rows)
        )
    if gen_changed:
        new_w = _term_weights(g)
        if force or not isinstance(row.gen, dict):
            ops += 2 * len(new_w)
        else:
            old_w = _term_weights(row.gen)
            ops += sum(1 for k, v in new_w.items() if old_w.get(k) != v)
            ops += sum(1 for k, v in old_w.items() if new_w.get(k) != v)
    return g, tags, tag_write, ops


class _Write:
    """One row's planned write: its stamp, derived ``gen``, the tags its tag
    write was planned against, that write (None: tags already match), and
    about how many row operations it costs."""

    __slots__ = ("stamp", "gen", "tags", "tag_write", "ops")

    def __init__(self, stamp, gen, tags, tag_write, ops):
        self.stamp, self.gen, self.tags = stamp, gen, tags
        self.tag_write, self.ops = tag_write, ops


def _write_chunk(conn, chunk: list[_Write], *, force: bool) -> bool:
    """Write and stamp ``chunk`` on the caller's write transaction, against
    the ``gen`` and tags stored now. Returns whether it wrote."""
    current = {
        r._id: r
        for r in conn.execute(
            sa.select(t.images.c._id, t.images.c.gen, t.images.c.tags).where(
                t.images.c._id.in_([w.stamp[0] for w in chunk])
            )
        )
    }
    gens: list[tuple[str, dict, dict | None]] = []
    tag_writes: list[image_tags.PromptWrite] = []
    stamps: list[tuple[str, int, str]] = []
    for w in chunk:
        image_id = w.stamp[0]
        row = current.get(image_id)
        if row is None:
            continue  # deleted since it was planned
        stamps.append(w.stamp)
        if force or w.gen != row.gen:
            gens.append((image_id, w.gen, row.gen))
        tag_write = w.tag_write
        stored = list(row.tags or [])
        if stored != w.tags:  # a tag write landed since the plan: plan again
            tag_write = image_tags.plan_prompt_write(
                image_id, stored, _prompt_tags(w.gen), force=force
            )
        if tag_write is not None:
            tag_writes.append(tag_write)
    if gens:
        _write_gens(conn, gens, force=force)
    tagged = image_tags.write_prompt_plans_sync(conn, tag_writes, force=force)
    _stamp(conn, stamps)
    return bool(gens or tagged)


def _term_weights(g: dict | None) -> dict[str, float]:
    """``image_gen_terms`` for a stored gen: ``{term: weight}``."""
    g = g if isinstance(g, dict) else {}
    weights = g.get("prompt_weights") or {}
    return {
        term: weights.get(term, 1.0)
        for term in dict.fromkeys(g.get("prompt_terms") or [])
    }


def _same_list(g: dict, old: dict | None, key: str) -> bool:
    return isinstance(old, dict) and (old.get(key) or []) == (g.get(key) or [])


def _write_gens(
    conn, gens: list[tuple[str, dict, dict | None]], *, force: bool = False
) -> None:
    """``gen``, its promoted columns and its derived rows (prompt terms,
    loras, embeddings) for ``(image_id, gen, stored gen)`` items. Only the
    derived rows that differ from the stored gen's are touched, unless
    ``force`` rebuilds them all (a migration that added a derived table)."""
    conn.execute(
        sa.update(t.images)
        .where(t.images.c._id == sa.bindparam("b_id"))
        .values(
            gen=sa.bindparam("b_gen", type_=t.images.c.gen.type),
            gen_model=sa.bindparam("b_model"),
            gen_workflow_sig=sa.bindparam("b_sig"),
            gen_group_id=sa.bindparam("b_group"),
            gen_prompt=sa.bindparam("b_prompt"),
        ),
        [
            {
                "b_id": image_id,
                "b_gen": g,
                "b_model": g.get("model"),
                "b_sig": g.get("workflow_sig"),
                "b_group": g.get("group_id"),
                "b_prompt": g.get("prompt"),
            }
            for image_id, g, _ in gens
        ],
    )
    # Prompt terms: only the changed ones (a settings change renames a few
    # terms of each image; rewriting all of them is most of the cost). An
    # image never derived before (no stored gen) is rebuilt whole.
    rebuild: list[str] = []
    drop_terms: list[dict] = []
    terms: list[dict] = []
    for image_id, g, old in gens:
        new_w = _term_weights(g)
        if force or not isinstance(old, dict):
            rebuild.append(image_id)
            old_w = {}
        else:
            old_w = _term_weights(old)
        drop_terms += [
            {"b_id": image_id, "b_term": term}
            for term, w in old_w.items()
            if new_w.get(term) != w
        ]
        terms += [
            {"image_id": image_id, "term": term, "weight": w}
            for term, w in new_w.items()
            if old_w.get(term) != w
        ]
    if rebuild:
        conn.execute(
            sa.delete(t.image_gen_terms).where(
                t.image_gen_terms.c.image_id.in_(rebuild)
            )
        )
    if drop_terms:
        conn.execute(
            sa.delete(t.image_gen_terms).where(
                t.image_gen_terms.c.image_id == sa.bindparam("b_id"),
                t.image_gen_terms.c.term == sa.bindparam("b_term"),
            ),
            drop_terms,
        )
    # LoRAs and embeddings: few per image, rebuilt where they differ.
    by_id = {i: g for i, g, _ in gens}
    lora_ids = [i for i, g, old in gens if force or not _same_list(g, old, "loras")]
    emb_ids = [i for i, g, old in gens if force or not _same_list(g, old, "embeddings")]
    for table, ids in ((t.image_loras, lora_ids), (t.image_embeddings, emb_ids)):
        if ids:
            conn.execute(sa.delete(table).where(table.c.image_id.in_(ids)))
    loras = [
        {"image_id": i, "name": lo["name"], "strength": lo.get("strength")}
        for i in lora_ids
        for lo in by_id[i].get("loras") or []
    ]
    embeddings = [
        {"image_id": i, "name": e["name"], "negative": bool(e.get("negative"))}
        for i in emb_ids
        for e in by_id[i].get("embeddings") or []
    ]
    if terms:
        # The diff comes from the stored gen: a term row it lacks (drift)
        # takes the new weight, not a failed insert that rolls the chunk
        # back on every run. LoRAs and embeddings are rebuilt per image.
        stmt = sqlite_insert(t.image_gen_terms)
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.image_gen_terms.c.image_id, t.image_gen_terms.c.term],
                set_={"weight": stmt.excluded.weight},
            ),
            terms,
        )
    for table, rows in ((t.image_loras, loras), (t.image_embeddings, embeddings)):
        if rows:
            conn.execute(sa.insert(table), rows)


# One reprojection at a time, whatever started it. Each run holds this for
# its whole length and reads its settings only while holding it (a chunked
# run re-reads them per chunk, still inside), so runs write in the order they
# read: one that read older rules or keywords can't overwrite a later run's
# rows, and no other run slips in between a run's chunks. Not reentrant: take
# it only at a run's entry points below.
_run_lock = threading.Lock()

# reproject_ids derives this many ids per raw-table read.
_ID_CHUNK = 500


class _Run:
    """One run's writes: whether any batch wrote gen or tags, and whether any
    stamped (the first run after an upgrade stamps every row)."""

    wrote = False
    stamped = False


@contextmanager
def _run_writes(*, checkpoint: bool = True) -> Iterator[_Run]:
    """One run's batches dirty the tag views softly; the run ends them with
    one hard invalidate, on error and cancel too, if any batch wrote, and
    (``checkpoint``) truncates the WAL its writes (stamps too) grew."""
    run = _Run()
    try:
        yield run
    finally:
        if run.wrote:
            image_tags.end_bulk_writes()
        if checkpoint and (run.wrote or run.stamped):
            checkpoint_wal()


def busy() -> bool:
    """Whether a reprojection is running now. A hint only: callers that must
    not wait take the lock without blocking instead (the ``try_`` paths)."""
    return _run_lock.locked()


def _raws_from():
    """``image_gen_raw`` with each row's skip stamp (none: revision 0)."""
    return t.image_gen_raw.outerjoin(
        t.image_gen_derived, t.image_gen_derived.c._id == t.image_gen_raw.c._id
    )


def _raw_pages(where) -> Iterator[sa.Row]:
    """Every raw row matching ``where`` (:func:`_raw_page_lists`, flat)."""
    for page in _raw_page_lists(where):
        yield from page


def _raw_page_lists(where) -> Iterator[list[sa.Row]]:
    """Every raw row matching ``where``, read a page at a time: a full run
    never holds them all (several GB at 30k images), and each page is its own
    short read, so no read transaction spans the run and pins the WAL. Keyset
    on ``rowid``: every raw index ends in it, so each page is an index range
    with no sort (``_id`` order would sort the whole match per page), and the
    scanner's upsert keeps a row's rowid. ``where`` may test the stamp
    (:meth:`_Keys.stale`): a skipped row's raw is never read. ``raw`` is
    the JSON text, decoded where it is derived (:mod:`derive_worker`), so a
    page read costs the API process no Python work per byte."""
    rowid = sa.literal_column("image_gen_raw.rowid")
    last = 0
    while True:
        with sync_conn() as conn:
            page = conn.execute(
                sa.select(
                    rowid.label("rid"),
                    t.image_gen_raw.c._id,
                    t.image_gen_raw.c.library_id,
                    t.image_gen_raw.c.workflow_sig,
                    sa.func.coalesce(t.image_gen_derived.c.raw_rev, 0).label("rev"),
                    sa.type_coerce(t.image_gen_raw.c.raw, sa.Text).label("raw"),
                )
                .select_from(_raws_from())
                .where(where, rowid > last)
                .order_by(rowid)
                .limit(_PAGE)
            ).fetchall()
        if page:
            yield page
        if len(page) < _PAGE:
            return
        last = page[-1].rid


def _reproject_where(
    where,
    *,
    force: bool = False,
    task: activity.Task | None = None,
    count_total: bool = True,
) -> int:
    """Recompute ``gen.*`` for every raw row matching ``where`` whose stamp
    is stale (every row when ``force``). Returns how many were derived
    (written or already up to date). ``task`` shows the progress. Waits for
    any other run to finish first."""
    with _run_lock, _run_writes() as run:
        return _derive_where(
            where,
            force=force,
            skip=not force,
            task=task,
            count_total=count_total,
            run=run,
        )


def _derive_where(
    where,
    *,
    force: bool,
    skip: bool,
    task: activity.Task | None,
    count_total: bool,
    run: _Run,
) -> int:
    """Derive the raw rows matching ``where``; ``skip``: only those whose
    stamp is not this run's key (in SQL, before any raw is read)."""
    rulesets = _load_rulesets()
    config = extraction_settings.load_sync()
    keys = _Keys(rulesets, config)
    if skip:
        where = sa.and_(where, keys.stale())

    if task is not None and count_total:
        # Through the same filter as the pages, so the bar counts what is read.
        with sync_conn() as conn:
            task.add_total(
                conn.execute(
                    sa.select(sa.func.count()).select_from(_raws_from()).where(where)
                ).scalar_one()
            )

    # Each page is derived while the previous one is written: sent to the
    # worker process (:mod:`derive_worker`), then the page before it flushed
    # while the worker works. A page the worker can't take (small, or the
    # worker failed) is derived here.
    state = _Derive(rulesets, config, keys, task, count_total, force, run)
    pending: _Page | None = None
    derive_worker.run_started()
    try:
        for rows in _raw_page_lists(where):
            page = state.submit(rows)
            if pending is not None:
                state.collect(pending)
            pending = page
        if pending is not None:
            state.collect(pending)
        state.flush()
    finally:
        derive_worker.run_ended()
    return state.updated


class _Page:
    """One raw page on its way: its rows and the worker's answer (None:
    derive it here)."""

    __slots__ = ("rows", "future")

    def __init__(self, rows: list[derive_worker.Row], future) -> None:
        self.rows, self.future = rows, future


class _Derive:
    """One :func:`_derive_where` pass: derives pages (in the worker or
    here), and batches the results into :func:`_flush`."""

    def __init__(self, rulesets, config, keys, task, count_total, force, run):
        self.rulesets, self.config, self.keys = rulesets, config, keys
        self.task, self.count_total = task, count_total
        self.force, self.run = force, run
        self.stamps: dict[str, tuple[int, str]] = {}
        self.batch: list[_Item] = []
        self.updated = 0
        # Set once the worker fails: the rest of this pass derives here.
        self.in_thread = False

    def submit(self, page: list[sa.Row]) -> _Page:
        rows = [(r._id, r.library_id, r.workflow_sig, r.raw) for r in page]
        for r in page:
            self.stamps[r._id] = (r.rev, self.keys.of(r.workflow_sig))
        future = None
        if not self.in_thread and derive_worker.use(len(rows)):
            try:
                future = derive_worker.submit(rows, self.rulesets, self.config)
            except derive_worker.Unavailable:
                self.in_thread = True
        return _Page(rows, future)

    def collect(self, page: _Page) -> None:
        results = None
        if page.future is not None:
            try:
                results = page.future.result()
            except Exception as e:
                # The worker died or the page didn't make the trip. One
                # failure per pass: a page sent before it fails with it.
                if not self.in_thread:
                    derive_worker.broken(e)
                self.in_thread = True
        if results is None:
            results = derive_worker.derive_rows(page.rows, self.rulesets, self.config)
        task = self.task
        for image_id, g, err in results:
            if task is not None:
                if (
                    self.count_total
                    and task.total is not None
                    and task.done >= task.total
                ):
                    # A row written after the count (the pages read past
                    # it): grow the total so the bar never passes 100%.
                    task.add_total(1)
                task.advance()
            rev, key = self.stamps.pop(image_id)
            if err is not None:
                # Not stamped: it is tried again next run.
                logger.warning("Reprojection skipped %s: %s", image_id, err)
                continue
            self.batch.append((image_id, g, rev, key))
            if len(self.batch) >= _BATCH:
                self.flush()

    def flush(self) -> None:
        if self.batch:
            self.updated += _flush(self.batch, force=self.force, run=self.run)
            self.batch = []


def _flush(batch: list[_Item], *, force: bool, run: _Run) -> int:
    """:func:`_flush_batch` for a run; returns how many rows derived a gen."""
    run.wrote |= _flush_batch(batch, force=force)
    run.stamped = True
    return sum(1 for _, g, *_ in batch if g is not None)


def reproject_library(
    library_id: str,
    *,
    workflow_sig: str | None = None,
    force: bool = False,
    task: activity.Task | None = None,
) -> int:
    """Recompute ``gen.*`` for one library's images (optionally scoped to a single
    workflow signature). ``force``: every row, current stamps too (the manual
    endpoint, a repair)."""
    where = t.image_gen_raw.c.library_id == library_id
    if workflow_sig is not None:
        where = sa.and_(where, t.image_gen_raw.c.workflow_sig == workflow_sig)
    return _reproject_where(where, force=force, task=task)


def reproject_image(image_id: str) -> int:
    """Recompute ``gen.*`` for a single image (watcher single-file ingest).
    Never waits: while another run holds the lock, the image is queued for
    the background (:func:`_defer`), which derives it after that run. Returns
    how many were derived now (0 when deferred)."""
    if not _run_lock.acquire(blocking=False):
        _defer([image_id])
        return 0
    try:
        # One image's write: no checkpoint per watcher event.
        with _run_writes(checkpoint=False) as run:
            return _derive_where(
                t.image_gen_raw.c._id == image_id,
                force=False,
                skip=False,
                task=None,
                count_total=True,
                run=run,
            )
    finally:
        _run_lock.release()


def reproject_ids(
    image_ids: list[str],
    *,
    task: activity.Task | None = None,
    recheck: Callable[[], Iterable[str]] | None = None,
) -> int:
    """Recompute ``gen.*`` for specific images (after a merge-rule change),
    holding the run lock for the whole list. ``recheck``: see
    :func:`_with_recheck`."""
    with _run_lock, _run_writes() as run:
        return _derive_ids(_with_recheck(image_ids, recheck), task, run)


def _with_recheck(
    image_ids: list[str], recheck: Callable[[], Iterable[str]] | None
) -> list[str]:
    """``image_ids`` plus what ``recheck`` finds now; the caller holds
    :data:`_run_lock`. A rule change picks its images before it gets the
    lock, while a run that read the old rules may still be writing the old
    names onto others; by the time the lock is ours that run is done, so
    asking again here catches them."""
    if recheck is None:
        return image_ids
    return sorted(set(image_ids).union(recheck()))


def _derive_ids(image_ids: list[str], task: activity.Task | None, run: _Run) -> int:
    """:func:`reproject_ids`' work; the caller holds :data:`_run_lock`.
    Settings are re-read per chunk (:func:`_derive_where`), inside the lock."""
    # The whole run's size up front, so the bar never jumps back a chunk at
    # a time; ids with nothing to derive count as done with their chunk.
    if task is not None:
        task.add_total(len(image_ids))
    updated = 0
    for i in range(0, len(image_ids), _ID_CHUNK):
        chunk = image_ids[i : i + _ID_CHUNK]
        before = task.done if task is not None else 0
        updated += _derive_where(
            t.image_gen_raw.c._id.in_(chunk),
            force=False,
            skip=False,
            task=task,
            count_total=False,
            run=run,
        )
        if task is not None:
            task.advance(len(chunk) - (task.done - before))
    return updated


def reproject_all(*, force: bool = False, task: activity.Task | None = None) -> int:
    """Recompute ``gen.*`` for every image with captured generation data.
    ``force`` rewrites rows that come out unchanged too (migrations)."""
    return _reproject_where(sa.true(), force=force, task=task)


def reproject_by_sig(workflow_sig: str, *, task: activity.Task | None = None) -> int:
    """Recompute ``gen.*`` for every image of a signature across all libraries.
    Used when a ruleset is created/edited/deleted (rulesets are sig-global)."""
    return _reproject_where(t.image_gen_raw.c.workflow_sig == workflow_sig, task=task)


def _tracked(work, *args, library_id: str | None = None, **kwargs) -> None:
    """Run a reprojection as visible background work; a failure is logged."""
    try:
        with activity.track("reproject", library_id=library_id) as task:
            work(*args, task=task, **kwargs)
    except Exception:
        logger.exception("Reprojection failed")


def try_reproject_ids_tracked(
    image_ids: list[str], *, recheck: Callable[[], Iterable[str]] | None = None
) -> int | None:
    """:func:`reproject_ids` inline, shown as activity like the background
    runs, but only if no other run holds the lock: ``None`` (nothing done,
    no activity) instead of waiting. A failure propagates to the caller.
    Nothing to derive (after ``recheck``) shows no activity."""
    if not _run_lock.acquire(blocking=False):
        return None
    try:
        image_ids = _with_recheck(image_ids, recheck)
        if not image_ids:
            return 0
        # Inline in a request (a rename): never a WAL checkpoint here, which
        # could copy other writers' frames while the user waits.
        with _run_writes(checkpoint=False) as run, activity.track("reproject") as task:
            return _derive_ids(image_ids, task, run)
    finally:
        _run_lock.release()


def _spawn(
    name: str, work, *args, library_id: str | None = None, **kwargs
) -> threading.Thread:
    """Start ``work`` as tracked background reprojection in a daemon thread.
    Runs still execute one at a time (:data:`_run_lock`)."""
    th = threading.Thread(
        target=_tracked,
        args=(work, *args),
        kwargs={"library_id": library_id, **kwargs},
        name=name,
        daemon=True,
    )
    th.start()
    return th


def reproject_library_async(
    library_id: str, *, workflow_sig: str | None = None, force: bool = False
) -> threading.Thread:
    """Fire-and-forget reprojection of a library (manual endpoint, post-scan)."""
    return _spawn(
        f"reproject-{library_id}",
        reproject_library,
        library_id,
        workflow_sig=workflow_sig,
        force=force,
        library_id=library_id,
    )


_all_lock = threading.Lock()
_all_running = False
_all_again = False


def reproject_all_async() -> None:
    """Fire-and-forget full reprojection (an extraction-settings save, the
    positive-only switch). Coalesced: requests during a run queue one more
    run after it, not one each, since a full run started later reads every
    setting saved meanwhile."""
    global _all_running, _all_again
    with _all_lock:
        if _all_running:
            _all_again = True
            return
        _all_running = True

    def _run() -> None:
        global _all_running, _all_again
        while True:
            _tracked(reproject_all)
            with _all_lock:
                if not _all_again:
                    _all_running = False
                    return
                _all_again = False

    threading.Thread(target=_run, name="reproject-all", daemon=True).start()


def underived_ids(library_id: str) -> list[str]:
    """Images of a library with captured generation data but no derived
    ``gen``: what a reprojection cut off by a restart left behind (and raws
    extraction can't read, which stay few)."""
    with sync_conn() as conn:
        return list(
            conn.execute(
                sa.select(t.image_gen_raw.c._id)
                .join(t.images, t.images.c._id == t.image_gen_raw.c._id)
                .where(
                    t.image_gen_raw.c.library_id == library_id,
                    # SQL NULL or a JSON null: never derived.
                    sa.func.coalesce(sa.func.json_type(t.images.c.gen), "null")
                    == "null",
                )
            ).scalars()
        )


def unstamped_ids(library_id: str) -> list[str]:
    """Raws of a library with no skip stamp: rewritten (which clears it) and
    not derived since. A post-scan run cut off by a restart, a cancelled
    scan's committed batches or lost deferred ids leave them, and only a run
    that names them (or a library run) would derive them again. One index
    range on the library plus a primary-key probe per row."""
    with sync_conn() as conn:
        return list(
            conn.execute(
                sa.select(t.image_gen_raw.c._id)
                .select_from(_raws_from())
                .where(
                    t.image_gen_raw.c.library_id == library_id,
                    t.image_gen_derived.c.derive_key.is_(None),
                )
            ).scalars()
        )


_deferred_lock = threading.Lock()
_deferred: set[str] = set()
_deferred_running = False


def _defer(image_ids: list[str]) -> None:
    """Queue images for one background drainer that reprojects them after
    whatever run holds the lock now. Ids queued while it runs join its next
    pass, so a burst of watcher events costs one thread, not one each."""
    global _deferred_running
    with _deferred_lock:
        _deferred.update(image_ids)
        if _deferred_running:
            return
        _deferred_running = True

    def _drain() -> None:
        global _deferred_running
        while True:
            with _deferred_lock:
                if not _deferred:
                    _deferred_running = False
                    return
                ids = sorted(_deferred)
                _deferred.clear()
            _tracked(reproject_ids, ids)

    threading.Thread(target=_drain, name="reproject-deferred", daemon=True).start()


def reproject_ids_async(
    image_ids: list[str], *, recheck: Callable[[], Iterable[str]] | None = None
) -> threading.Thread:
    """Fire-and-forget reprojection of specific images (a big rule change,
    resuming a library a restart cut off). ``recheck``: see
    :func:`_with_recheck`."""
    return _spawn("reproject-ids", reproject_ids, image_ids, recheck=recheck)


def reproject_by_sig_async(workflow_sig: str) -> threading.Thread:
    """Fire-and-forget by-sig reprojection (triggered on ruleset save/delete)."""
    return _spawn(f"reproject-sig-{workflow_sig[:8]}", reproject_by_sig, workflow_sig)
