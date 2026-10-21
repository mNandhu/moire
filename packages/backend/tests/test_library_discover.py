from pathlib import Path

from moire.services.library_discover import discover, normalize_path


def _img(p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")


def _tree(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    _img(root / "loose.png")
    _img(root / "a" / "1.png")
    _img(root / "a" / "deep" / "2.jpg")
    _img(root / "b" / "3.webp")
    (root / "b" / "notes.txt").write_text("x")
    (root / "empty").mkdir()
    _img(root / ".hidden" / "4.png")
    return root


def test_single_mode_offers_the_folder_itself(tmp_path):
    root = _tree(tmp_path)
    [rep] = discover([str(root)], split_subdirs=False, existing_paths=[])
    [c] = rep.candidates
    assert c.path == str(root)
    assert c.image_count == 5
    assert c.status == "new"


def test_split_mode_one_candidate_per_subfolder(tmp_path):
    root = _tree(tmp_path)
    [rep] = discover([str(root) + "/"], split_subdirs=True, existing_paths=[])
    by_name = {c.name: c for c in rep.candidates}
    assert set(by_name) == {".hidden", "a", "b", "empty"}
    assert by_name["a"].image_count == 2
    assert by_name["b"].image_count == 1
    assert by_name["empty"].status == "empty"
    assert by_name[".hidden"].hidden
    assert rep.subdir_count == 4
    assert rep.loose_image_count == 1
    assert not rep.fell_back_to_root


def test_split_mode_without_subfolders_falls_back_to_root(tmp_path):
    flat = tmp_path / "flat"
    _img(flat / "1.png")
    _img(flat / "2.png")
    [rep] = discover([str(flat)], split_subdirs=True, existing_paths=[])
    assert rep.fell_back_to_root
    [c] = rep.candidates
    assert c.path == str(flat) and c.image_count == 2


def test_conflicts_with_registered_libraries(tmp_path):
    root = _tree(tmp_path)
    existing = [str(root / "a") + "/", str(root / "b" / "inner")]
    [rep] = discover([str(root)], split_subdirs=True, existing_paths=existing)
    by_name = {c.name: c for c in rep.candidates}
    assert by_name["a"].status == "registered"
    assert by_name["b"].status == "overlap"
    assert by_name["b"].conflict_path == normalize_path(str(root / "b" / "inner"))
    [whole] = discover([str(root)], split_subdirs=False, existing_paths=existing)[
        0
    ].candidates
    assert whole.status == "overlap"


def test_missing_folder_reports_an_error(tmp_path):
    [rep] = discover([str(tmp_path / "nope")], split_subdirs=True, existing_paths=[])
    assert not rep.ok and rep.error
    assert rep.candidates == []


def test_counting_is_capped(tmp_path):
    root = tmp_path / "many"
    for i in range(10):
        _img(root / f"{i}.png")
    [rep] = discover([str(root)], split_subdirs=False, existing_paths=[], max_count=3)
    [c] = rep.candidates
    assert c.count_capped and c.image_count == 3


def test_same_folder_listed_twice_is_offered_once(tmp_path):
    root = _tree(tmp_path)
    reps = discover([str(root), str(root / "a")], split_subdirs=True, existing_paths=[])
    paths = [c.path for r in reps for c in r.candidates]
    assert paths.count(str(root / "a")) == 1


async def test_discover_endpoint_writes_nothing(client, tmp_path):
    root = _tree(tmp_path)
    resp = await client.post(
        "/libraries/discover", json={"paths": [str(root)], "split_subdirs": True}
    )
    assert resp.status_code == 200
    [src] = resp.json()["sources"]
    assert {c["name"] for c in src["candidates"]} == {".hidden", "a", "b", "empty"}
    assert (await client.get("/libraries")).json() == []


async def test_discover_flags_a_bad_path_on_its_own_row(client, tmp_path):
    root = _tree(tmp_path)
    resp = await client.post(
        "/libraries/discover", json={"paths": ["rel/dir", str(root)]}
    )
    assert resp.status_code == 200
    bad, good = resp.json()["sources"]
    assert not bad["ok"] and bad["error"] == "Not an absolute path"
    assert good["ok"] and good["candidates"]


async def test_discover_requires_a_non_blank_path(client):
    resp = await client.post("/libraries/discover", json={"paths": ["  ", ""]})
    assert resp.status_code == 422


def test_counts_what_the_scanner_indexes(tmp_path):
    # .tiff isn't in IMAGE_EXTS but the scanner's mimetype fallback indexes it.
    _img(tmp_path / "t" / "scan.tiff")
    [rep] = discover([str(tmp_path / "t")], split_subdirs=False, existing_paths=[])
    [c] = rep.candidates
    assert c.image_count == 1 and c.status == "new"


def test_nested_folders_in_one_request_overlap(tmp_path):
    root = _tree(tmp_path)
    reps = discover(
        [str(root), str(root / "a" / "deep")], split_subdirs=False, existing_paths=[]
    )
    statuses = [c.status for r in reps for c in r.candidates]
    assert statuses == ["overlap", "overlap"]


def test_candidates_past_the_overall_deadline_are_not_counted(tmp_path):
    root = _tree(tmp_path)
    [rep] = discover(
        [str(root)], split_subdirs=True, existing_paths=[], total_budget_s=0
    )
    for c in rep.candidates:
        assert c.count_capped and c.image_count == 0
        # "Not counted" is not "no images".
        assert c.status == "new"


async def test_name_only_edit_of_unnormalized_path_does_not_rescan(
    client, tmp_path, monkeypatch
):
    # A library stored before paths were normalized (trailing slash); the edit
    # dialog re-sends its path, which now arrives normalized.
    import sqlalchemy as sa

    from moire.api import libraries as libs_api
    from moire.database import schema as t
    from moire.database.db import async_tx

    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.libraries).values(
                _id="L1", path=str(tmp_path) + "/", name="old", watch_enabled=False
            )
        )
    scans: list[str] = []
    monkeypatch.setattr(libs_api, "scan_library_async", lambda i, p: scans.append(i))

    resp = await client.patch(
        "/libraries/L1", json={"name": "new", "path": str(tmp_path) + "/"}
    )

    assert resp.status_code == 200
    assert scans == []
