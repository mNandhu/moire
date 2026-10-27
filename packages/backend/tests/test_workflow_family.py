"""family_key is the Python twin of the WORKFLOW_ID SQL expression."""

import sqlalchemy as sa

from moire.database import schema as t
from moire.services import workflow_family as wf


def test_family_key_agrees_with_the_sql_workflow_id():
    docs = [
        {"workflow": {"id": "a"}},
        {"workflow": {"id": "a"}, "moire": {"family": "b"}},
        {"moire": {"family": "b"}},
        {"workflow": None, "moire": {"family": "b"}},
        {"workflow": {"nodes": []}, "moire": {"family": "b"}},
        {"workflow": {"id": 5}, "moire": {"family": "b"}},
        {"workflow": {"id": ""}, "moire": {"family": "b"}},
        {"workflow": "text", "moire": {"family": "b"}},
        {"moire": {"family": 7}},
        {"moire": "x"},
        {"prompt": {}},
        {},
    ]
    engine = sa.create_engine("sqlite://")
    t.image_gen_raw.create(engine)
    with engine.begin() as conn:
        for i, d in enumerate(docs):
            conn.execute(
                sa.insert(t.image_gen_raw).values(_id=str(i), library_id="l", raw=d)
            )
        for i, d in enumerate(docs):
            sql = conn.execute(
                sa.select(wf.WORKFLOW_ID).where(t.image_gen_raw.c._id == str(i))
            ).scalar()
            assert wf.family_key(d) == (sql if isinstance(sql, str) else None), d
    assert wf.family_key({"workflow": {"id": ""}, "moire": {"family": "b"}}) == "b"
    assert wf.family_key(None) is None
