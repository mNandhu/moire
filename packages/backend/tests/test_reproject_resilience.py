"""Reprojection is total: one malformed graph skips its own row only."""

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import gen_metadata, reproject


def _raw(image_id, prompt):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={"source": "a1111", "parameters": f"{prompt}\nSteps: 20"},
            )
        )


def test_a_sampler_without_inputs_does_not_raise():
    g = gen_metadata.parse_comfyui({"3": {"class_type": "KSampler", "inputs": None}})
    assert g["source"] == "comfyui"


def test_empty_gen_docs_share_no_lists():
    a, b = gen_metadata._empty(), gen_metadata._empty()
    for k, v in a.items():
        if isinstance(v, (list, dict)):
            assert v is not b[k], k


def test_one_bad_row_does_not_stop_the_run(temp_db, seed, monkeypatch):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _raw("L1:a", "smile")
    _raw("L1:b", "smile")
    real = gen_metadata.extract

    def extract(raw_doc, *a, **k):
        if raw_doc["_id"] == "L1:a":
            raise TypeError("hostile graph")
        return real(raw_doc, *a, **k)

    monkeypatch.setattr(gen_metadata, "extract", extract)
    reproject.reproject_all()
    with db.sync_conn() as conn:
        tags = conn.execute(
            sa.select(t.images.c.tags).where(t.images.c._id == "L1:b")
        ).scalar()
    assert "prompt:smile" in tags
