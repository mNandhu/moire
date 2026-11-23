"""Tag mosaics read from the tag's own rows: the same images, in the same
order, as the old scan of every image with an EXISTS per row."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.images import visibility as image_visibility
from moire.services.tags import (
    covers,
    index as tag_index,
    kinds as tag_kinds,
    sensitivity_filter,
)

COLS = (t.images.c._id, t.images.c.gen_group_id, t.images.c.width)


def _match(tag):
    if tag_kinds.is_any(tag):
        return t.image_tags.c.base == covers.pin_key(tag)
    return t.image_tags.c.tag == tag


def _old(tag, limit):
    """The query this replaced: every image, an EXISTS per row."""
    return (
        sa.select(*COLS)
        .where(
            image_visibility.visible(),
            sa.exists(
                sa.select(1).where(
                    t.image_tags.c.image_id == t.images.c._id, _match(tag)
                )
            ),
        )
        .order_by(covers._shuffled(tag))
        .limit(limit)
    )


def _ids(stmt):
    with db.sync_conn() as conn:
        return [tuple(r) for r in conn.execute(stmt).fetchall()]


TAGS = ("cat", "prompt:cat", "any:cat", "dog", "any:dog", "any:rain", "nope")


def _seed_mix(seed):
    for i in range(120):
        tags = ["cat"] if i % 2 else []
        if i % 3 == 0:
            tags.append("prompt:cat")
        if i % 5 == 0:
            tags += ["dog", "manual:dog"]
        if i % 7 == 0:
            tags.append("prompt:rain")
        seed(
            f"L1:{i:03}",
            tags=tuple(tags),
            width=i,
            gen={"group_id": f"g{i % 9}"},
            # a block of hidden images, so a window can come up short
            quarantined=10 <= i < 100,
            # the sensitivity filter hides some more while it is on
            rating=("general", "explicit", None)[i % 3],
        )


@pytest.fixture(params=[None, 0], ids=["filter_off", "filter_general"])
def filt(request):
    saved = sensitivity_filter._max
    sensitivity_filter._max = request.param
    yield request.param
    sensitivity_filter._max = saved


async def test_shuffled_rows_match_the_old_scan(temp_db, seed, filt):
    _seed_mix(seed)
    short = 0
    for tag in TAGS:
        for limit in (1, 5, 10, 40, 200):
            want = _ids(_old(tag, limit))
            for window in (True, False):
                got = _ids(
                    covers._shuffled_rows(tag, _match(tag), COLS, limit, window=window)
                )
                if window:
                    # the window only ever drops rows from the end
                    assert got == want[: len(got)], (tag, limit)
                    short += len(got) < len(want)
                else:
                    assert got == want, (tag, limit)
    assert short  # some window came up short, so the fallback is exercised


async def test_samples_unchanged_with_hidden_images(client, seed, monkeypatch, filt):
    _seed_mix(seed)
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:101"})

    async def every(old: bool):
        if old:
            monkeypatch.setattr(
                covers,
                "_shuffled_rows",
                lambda tag, match, cols, limit, window: (
                    sa.select(*cols)
                    .where(
                        image_visibility.visible(),
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id, match
                            )
                        ),
                    )
                    .order_by(covers._shuffled(tag))
                    .limit(limit)
                ),
            )
        out = {}
        for tag in TAGS:
            for per in (1, 4, 12):
                tag_index.invalidate()
                out[tag, per] = await covers.samples_for_tag(tag, per)
        monkeypatch.undo()
        return out

    new = await every(False)
    assert new == await every(True)
    assert any(new.values())
    if filt is None:
        assert new["any:cat", 4][0]["_id"] == "L1:101"
        assert len(new["any:cat", 12]) == 12
