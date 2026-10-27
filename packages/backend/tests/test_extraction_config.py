"""The rules preview and reprojection read one extraction config, so the
preview's ``gen`` is what reprojection writes: same positive-only switch, same
merge/split rules, same keywords."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import extraction_settings, image_tags, reproject

pytestmark = pytest.mark.asyncio

_PARAMS = "masterpiece, blue eyes\nNegative prompt: lowres, blurry\nSteps: 20"


def _setup(*, positive_only: bool | None, rules: dict[str, list[str]]) -> None:
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id="L1:a",
                library_id="L1",
                workflow_sig=None,
                raw={"source": "a1111", "parameters": _PARAMS},
            )
        )
        if positive_only is not None:
            conn.execute(
                sa.insert(t.app_settings).values(
                    _id="ai", doc={"prompt_positive_only": positive_only}
                )
            )
        for name, to in rules.items():
            conn.execute(
                sa.insert(t.tag_rules).values(
                    from_name=name, to_names=to, created_at=1.0
                )
            )


def _stored() -> tuple[list[str], list[str]]:
    with db.sync_conn() as conn:
        row = conn.execute(
            sa.select(t.images.c.gen, t.images.c.tags).where(t.images.c._id == "L1:a")
        ).one()
    return row.gen["prompt_terms"], row.tags


@pytest.mark.parametrize(
    "positive_only, rules",
    [
        (False, {"blue_eyes": ["aqua_eyes"]}),
        (True, {"blue_eyes": ["aqua_eyes", "eyes"]}),
        (None, {}),
    ],
)
async def test_preview_derives_what_reprojection_writes(
    client, seed, positive_only, rules
):
    seed("L1:a")
    _setup(positive_only=positive_only, rules=rules)
    reproject.reproject_ids(["L1:a"])
    terms, tags = _stored()

    resp = await client.post("/rules/preview", json={"sample_image_id": "L1:a"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["gen"]["prompt_terms"] == terms
    assert tags == [image_tags.to_prompt(x) for x in terms]


async def test_config_reads_positive_only_default_and_rules(temp_db):
    config = extraction_settings.load_sync()
    assert config.positive_only is True
    assert config.rules == {}
    _setup(positive_only=False, rules={"a": ["b"]})
    for config in (extraction_settings.load_sync(), await extraction_settings.load()):
        assert config.positive_only is False
        assert config.rules == {"a": ["b"]}
