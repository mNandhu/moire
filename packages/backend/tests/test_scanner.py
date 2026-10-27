"""Unit tests for the pure, high-risk parts of the library scan: id construction,
the upsert op's insert-only tag seeding, and stale reconciliation (which deletes
images that vanished from disk).

Raw generation-metadata capture used to live here; it moved to
``gen_metadata.read_gen_raw``, see ``test_gen_raw_capture.py``."""

import os
from pathlib import Path


from moire.services import scan_reconcile, scanner


def test_image_id_for_is_library_prefixed_relative_path():
    root = Path("/data/lib")
    assert scanner.image_id_for("L1", root, root / "a" / "b.jpg") == "L1:a/b.jpg"


def test_image_upsert_values_merges_initial_tag_state():
    vals = scanner.image_upsert_values({"_id": "L1:x.jpg", "path": "/data/lib/x.jpg"})
    # Scanner file-metadata is carried through.
    assert vals["_id"] == "L1:x.jpg"
    assert vals["path"] == "/data/lib/x.jpg"
    # Initial tag-state is seeded into the insert payload (the ON CONFLICT clause
    # leaves these columns untouched on update, verified by an integration test).
    assert vals["tags"] == []
    assert vals["has_tags"] is False
    assert vals["has_ai_tags"] is False
    assert vals["has_prompt_tags"] is False
    assert vals["quarantined"] is False
    assert vals["score"] == 0


def test_gen_raw_values_splits_into_row_shape():
    row = scanner.gen_raw_values(
        {
            "_id": "L1:x.jpg",
            "library_id": "L1",
            "workflow_sig": "sig1",
            "source": "comfyui",
            "prompt": {"a": 1},
        }
    )
    assert row["_id"] == "L1:x.jpg"
    assert row["library_id"] == "L1"
    assert row["workflow_sig"] == "sig1"
    # The variable per-source payload lands in `raw`, sans the promoted keys.
    assert row["raw"] == {"source": "comfyui", "prompt": {"a": 1}}


def test_reconcile_stale_flags_only_undiscovered_images():
    existing = [
        {"_id": "L1:keep.jpg", "thumb_key": "L1/keep.webp"},
        {"_id": "L1:gone.jpg", "thumb_key": "L1/gone.webp"},
        {"_id": "L1:gone_nothumb.jpg"},
    ]
    discovered = {"L1:keep.jpg"}
    stale_ids, stale_thumbs = scan_reconcile.reconcile_stale(discovered, existing)
    assert set(stale_ids) == {"L1:gone.jpg", "L1:gone_nothumb.jpg"}
    # Only the thumb key that exists is queued for cleanup
    assert stale_thumbs == ["L1/gone.webp"]


def test_reconcile_stale_keeps_everything_when_all_discovered():
    existing = [{"_id": "L1:a.jpg"}, {"_id": "L1:b.jpg"}]
    discovered = {"L1:a.jpg", "L1:b.jpg"}
    assert scan_reconcile.reconcile_stale(discovered, existing) == ([], [])


def test_reconcile_stale_never_flags_images_in_unread_folders():
    existing = [{"_id": "L1:gone.jpg"}, {"_id": f"L1:locked{os.sep}a.jpg"}]
    stale_ids, _ = scan_reconcile.reconcile_stale(
        set(), existing, [f"L1:locked{os.sep}"]
    )
    assert stale_ids == ["L1:gone.jpg"]


def test_unread_prefixes_scope_errors_to_their_folder(tmp_path):
    err = PermissionError(13, "denied", str(tmp_path / "locked"))
    assert scan_reconcile.unread_prefixes("L1", tmp_path, [err]) == [
        f"L1:locked{os.sep}"
    ]
    # An error with no usable path (or on the root itself) covers the library.
    assert scan_reconcile.unread_prefixes("L1", tmp_path, [OSError("odd")]) == ["L1:"]
    root_err = OSError(5, "io", str(tmp_path))
    assert scan_reconcile.unread_prefixes("L1", tmp_path, [root_err]) == ["L1:"]


def test_stale_guard_blocks_deletes_on_untrusted_discovery(tmp_path):
    assert scan_reconcile.stale_guard(tmp_path, discovered=3, existing=5) is None
    # A gone root, or an empty one while the library has images: keep everything.
    assert scan_reconcile.stale_guard(tmp_path / "missing", 0, 5)
    assert scan_reconcile.stale_guard(tmp_path, discovered=0, existing=5)
    # A library that was already empty may stay empty.
    assert scan_reconcile.stale_guard(tmp_path, discovered=0, existing=0) is None
