"""The migration runner: each entry runs once, one forced reprojection covers
every pending entry that needs it, and names are recorded after it."""

from moire.services.tags import migrations as tag_migrations


def _fake(monkeypatch, entries):
    calls = []
    monkeypatch.setattr(tag_migrations, "_MIGRATIONS", entries(calls))
    monkeypatch.setattr(
        tag_migrations.reproject,
        "reproject_all",
        lambda force=False: calls.append(("reproject", force)) or 0,
    )
    return calls


def test_a_new_install_has_nothing_to_run(temp_db, monkeypatch):
    calls = _fake(monkeypatch, lambda calls: tag_migrations._MIGRATIONS)
    tag_migrations.run_pending()
    assert calls == []


def test_steps_run_once_with_one_forced_reprojection(temp_db, monkeypatch):
    calls = _fake(
        monkeypatch,
        lambda calls: (
            ("a", lambda: calls.append("a"), False),
            ("b", None, True),
            ("c", None, True),
        ),
    )
    tag_migrations.run_pending()
    assert calls == ["a", ("reproject", True)]
    assert set(tag_migrations._done()) == {"a", "b", "c"}
    tag_migrations.run_pending()
    assert calls == ["a", ("reproject", True)]


def test_a_later_entry_runs_alone(temp_db, monkeypatch):
    calls = _fake(monkeypatch, lambda calls: (("a", lambda: calls.append("a"), False),))
    tag_migrations.run_pending()
    _fake(
        monkeypatch,
        lambda _: (
            ("a", lambda: calls.append("a again"), False),
            ("b", lambda: calls.append("b"), False),
        ),
    )
    tag_migrations.run_pending()
    assert calls == ["a", "b"]  # no reprojection: neither entry asked for one


def test_an_interrupted_run_is_redone(temp_db, monkeypatch):
    def boom():
        raise RuntimeError("interrupted")

    _fake(monkeypatch, lambda calls: (("a", boom, True),))
    try:
        tag_migrations.run_pending()
    except RuntimeError:
        pass
    assert "a" not in tag_migrations._done()
