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
