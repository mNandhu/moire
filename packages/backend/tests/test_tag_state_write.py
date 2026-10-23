"""The bulk prompt-tag write (reprojection) and the single-image write must
leave identical rows: same ``images`` columns, same ``image_tags`` rows. A
column added to one path and not the other fails here."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import image_tags


def _row(image_id: str) -> tuple[dict, list[tuple]]:
    with db.sync_conn() as conn:
        row = dict(
            conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
            .one()
            ._mapping
        )
        joins = conn.execute(
            sa.select(t.image_tags.c.tag, t.image_tags.c.base).where(
                t.image_tags.c.image_id == image_id
            )
        ).fetchall()
    row.pop("_id")
    return row, sorted(tuple(j) for j in joins)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "start, prompt",
    [
        # Flags flip: the old prompt tag goes, nothing replaces it.
        (("1girl", "prompt:old"), []),
        # Prompt-only image gains prompt tags, keeps no curatable tag.
        (("prompt:old",), ["prompt:a", "prompt:b"]),
        # Manual + AI kept, prompt tags swapped, a duplicate collapses in joins.
        (("manual:fav", "1girl", "prompt:x"), ["prompt:y", "prompt:y"]),
        # Empty to something.
        ((), ["prompt:z"]),
    ],
)
async def test_bulk_and_single_writes_leave_identical_rows(seed, start, prompt):
    seed("L1:single", tags=start)
    seed("L1:bulk", tags=start)
    with db.sync_tx() as conn:
        image_tags.rewrite_tags_sync(
            conn, "L1:single", image_tags.with_replaced_prompt(list(start), prompt)
        )
        written = image_tags.replace_prompt_many_sync(
            conn, [("L1:bulk", list(start), prompt)], force=True
        )
    assert written == 1
    assert _row("L1:bulk") == _row("L1:single")


def test_initial_tag_fields_match_an_empty_tag_state():
    fields = image_tags.initial_tag_fields()
    assert fields["tags"] == []
    for key, value in image_tags.recompute_flags([]).items():
        assert fields[key] == value
