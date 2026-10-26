import pytest

from moire.services import storage_fs


def test_put_thumb_writes_under_the_one_key_formula():
    image_id = "libA:dir/a b.png"
    assert storage_fs.put_thumb("libA", image_id, b"x") == storage_fs.thumb_key(
        image_id
    )
    assert storage_fs.thumb_path(storage_fs.thumb_key(image_id)) is not None


def test_put_thumb_refuses_an_image_from_another_library():
    with pytest.raises(ValueError):
        storage_fs.put_thumb("libA", "libB:a.png", b"x")
