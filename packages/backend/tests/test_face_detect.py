"""Face detection for character avatars: reading the model's output, picking
the avatar's face, and the background worker filling ``image_faces``. The
model itself is never loaded here."""

from pathlib import Path

import numpy as np

from moire.services import face_detect, tag_categories


def test_letterbox_fits_the_long_side():
    assert face_detect.letterbox(701, 1024) == (0.625, 438, 640, 101, 0)


def test_boxes_map_back_to_image_fractions_either_layout():
    # One face centred at (350, 256) of a 701 x 1024 image, 140 px wide.
    r, _, _, px, py = face_detect.letterbox(701, 1024)
    face = [350 * r + px, 256 * r + py, 140 * r, 150 * r, 0.9]
    weak = [100, 100, 20, 20, 0.1]
    out = np.array([face, weak], dtype=np.float32).T  # (5, N), as exported
    for layout in (out, out.T):
        ((cx, cy, w, h, conf),) = face_detect.boxes(layout, 0.3, 701, 1024)
        assert (round(cx, 3), round(cy, 3), round(w, 3), round(h, 3)) == (
            0.499,
            0.25,
            0.2,
            0.146,
        )
        assert conf == np.float32(0.9)


def test_overlapping_boxes_keep_the_most_confident():
    out = np.array(
        [[320, 320, 100, 100, 0.8], [330, 325, 100, 100, 0.9]], dtype=np.float32
    )
    got = face_detect.boxes(out, 0.3, 640, 640)
    assert len(got) == 1 and got[0][4] == np.float32(0.9)


def test_pick_prefers_the_largest_confident_face():
    small_sure = (0.5, 0.2, 0.1, 0.1, 0.95)
    big_sure = (0.3, 0.3, 0.2, 0.2, 0.8)
    big_unsure = (0.7, 0.7, 0.4, 0.4, 0.3)
    assert face_detect.pick([small_sure, big_sure, big_unsure]) == big_sure
    assert face_detect.pick([]) is None


async def test_avatars_get_their_face_in_the_background(
    client, seed, monkeypatch, tmp_path
):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a", width=700, height=1000)
    looked: list[str] = []

    def fake_detect(path, cache_dir):
        looked.append(path)
        return (0.5, 0.2, 0.25, 0.18, 0.9)

    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", fake_detect)
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )

    first = (await client.get("/tags/characters")).json()[0]
    assert first["face"] is None and round(first["aspect"], 2) == 0.7
    await face_detect.idle()
    again = (await client.get("/tags/characters")).json()[0]
    assert again["face"] == [0.5, 0.2, 0.25, 0.18]
    page = (await client.get("/tags/character", params={"tag": "frieren"})).json()
    assert page["face"] == [0.5, 0.2, 0.25, 0.18]
    assert len(looked) == 1  # looked at once, remembered after


async def test_nothing_runs_until_switched_on_and_downloaded(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a")
    monkeypatch.setattr(
        face_detect, "detect", lambda *a: (_ for _ in ()).throw(AssertionError)
    )
    await client.get("/tags/characters")  # not downloaded: nothing queued
    assert not face_detect._pending
    status = (await client.get("/ai/faces")).json()
    assert (status["enabled"], status["downloaded"]) == (True, False)

    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    saved = await client.post("/ai/settings", json={"face_detect": False})
    assert saved.json()["face_detect"] is False
    await client.get("/tags/characters")
    assert not face_detect._pending


async def test_pinning_an_avatar_finds_its_face_at_once(
    client, seed, monkeypatch, tmp_path
):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren", furina="g"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a")
    seed("L1:b", tags=("frieren",), thumb_key="k/b", width=1, height=1)
    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", lambda *a: (0.4, 0.3, 0.2, 0.2, 0.9))
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )
    got = await client.post("/tags/thumbnail/frieren", json={"image_id": "L1:b"})
    assert got.status_code == 200
    assert await face_detect.faces_for(["L1:b"]) == {"L1:b": (0.4, 0.3, 0.2, 0.2)}


def _chars(*names, **candidates):
    async def load():
        return tag_categories.Vocab(
            frozenset(names),
            {
                bare: tag_categories.Candidate(series, f"{bare}_({series})")
                for bare, series in candidates.items()
            },
        )

    return load


async def test_the_model_arriving_queues_every_avatar(
    client, seed, monkeypatch, tmp_path
):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren", "himmel"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a")
    seed("L1:b", tags=("himmel",), thumb_key="k/b")
    monkeypatch.setattr(face_detect, "_avatars_queued", False)
    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", lambda *a: (0.5, 0.3, 0.2, 0.2, 0.9))
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )
    await client.get("/ai/faces")  # the Settings page polling
    await face_detect.idle()
    assert set(await face_detect.faces_for(["L1:a", "L1:b"])) == {"L1:a", "L1:b"}


async def test_switching_off_stops_the_crops_already_found(
    client, seed, monkeypatch, tmp_path
):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a")
    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", lambda *a: (0.5, 0.3, 0.2, 0.2, 0.9))
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )
    await client.get("/tags/characters")
    await face_detect.idle()
    assert (await client.get("/tags/characters")).json()[0]["face"]
    await client.post("/ai/settings", json={"face_detect": False})
    assert (await client.get("/tags/characters")).json()[0]["face"] is None


async def test_a_changed_file_is_looked_at_again(client, seed, monkeypatch, tmp_path):
    import sqlalchemy as sa

    from moire.database import db
    from moire.database import schema as t

    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a", mtime=100)
    found = iter([(0.5, 0.3, 0.2, 0.2, 0.9), (0.2, 0.6, 0.1, 0.1, 0.9)])
    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", lambda *a: next(found))
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )
    await face_detect.queue(["L1:a"])
    await face_detect.idle()
    assert (await face_detect.faces_for(["L1:a"]))["L1:a"][0] == 0.5
    # re-rendered in place: the scanner rewrites the row, no cascade
    async with db.async_tx() as conn:
        await conn.execute(
            sa.update(t.images).where(t.images.c._id == "L1:a").values(mtime=200)
        )
    assert await face_detect.faces_for(["L1:a"]) == {}
    await face_detect.queue(["L1:a"])
    await face_detect.idle()
    assert (await face_detect.faces_for(["L1:a"]))["L1:a"][0] == 0.2


async def test_a_failing_image_is_tried_once(client, seed, monkeypatch, tmp_path):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",), thumb_key="k/a")
    calls = []

    def broken(*a):
        calls.append(1)
        raise OSError("truncated")

    monkeypatch.setattr(face_detect, "downloaded", lambda cache_dir: True)
    monkeypatch.setattr(face_detect, "detect", broken)
    monkeypatch.setattr(
        face_detect.storage_fs, "thumb_path", lambda key: Path(tmp_path / key)
    )
    # a pin answers even when detection fails
    got = await client.post("/tags/thumbnail/frieren", json={"image_id": "L1:a"})
    assert got.status_code == 200
    await face_detect.queue(["L1:a"])
    await face_detect.idle()
    assert calls == [1] and not face_detect._pending


async def test_the_mtime_migration_replaces_the_cache(client, seed):
    import sqlalchemy as sa

    from moire.database import db
    from moire.database import schema as t
    from moire.services import tag_migrations

    seed("L1:a")
    async with db.async_tx() as conn:
        await conn.execute(
            sa.insert(t.image_faces).values(image_id="L1:a", model="old", conf=None)
        )
    tag_migrations.migrate_image_faces_mtime()
    async with db.async_conn() as conn:
        assert (
            await conn.execute(sa.select(sa.func.count()).select_from(t.image_faces))
        ).scalar() == 0
        assert "mtime" in [
            c["name"]
            for c in await conn.run_sync(
                lambda c: sa.inspect(c).get_columns("image_faces")
            )
        ]
