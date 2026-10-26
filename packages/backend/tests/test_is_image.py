from pathlib import Path

from moire.services import library_discover, scanner


def test_is_image_applies_the_ignore_rules_the_watcher_always_had():
    assert scanner.is_image(Path("/x/a.PNG"))
    assert not scanner.is_image(Path("/x/.cover.png"))
    assert not scanner.is_image(Path("/x/._a.png"))
    assert not scanner.is_image(Path("/x/~a.png"))
    assert not scanner.is_image(Path("/x/a.png.part"))
    assert not scanner.is_image(Path("/x/a.txt"))


def test_scan_walk_and_discover_count_agree(tmp_path):
    from PIL import Image

    for name in ("a.png", ".hidden.png", "~t.png"):
        Image.new("RGB", (2, 2)).save(tmp_path / name, "PNG")
    files, _, _ = scanner._walk("L1", tmp_path, [])
    assert [p.name for p in files] == ["a.png"]
    n, _ = library_discover._count_images(
        str(tmp_path), max_count=100, deadline=float("inf")
    )
    assert n == 1


def test_walk_keeps_ignored_images_a_past_scan_indexed(tmp_path):
    # Not indexed anew, but not reconciled away either: an older row may hold tags.
    from PIL import Image

    for name in ("a.png", ".hidden.png", "~t.png"):
        Image.new("RGB", (2, 2)).save(tmp_path / name, "PNG")
    (tmp_path / "b.png.part").write_bytes(b"x")
    (tmp_path / ".DS_Store").write_bytes(b"x")
    files, ids, _ = scanner._walk("L1", tmp_path, [])
    assert [p.name for p in files] == ["a.png"]
    assert ids == {"L1:a.png", "L1:.hidden.png", "L1:~t.png"}
