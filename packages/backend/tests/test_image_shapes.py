"""Size presets: every image ratio lands in exactly one shape, the nearest."""

from moire.services import image_shapes


def test_presets_classify_as_themselves():
    for s in image_shapes.SHAPES:
        assert image_shapes.shape_of(s.width, s.height) == s.name


def test_nearest_preset_wins():
    assert image_shapes.shape_of(768, 1120) == "2:3"
    assert image_shapes.shape_of(1152, 1680) == "2:3"
    assert image_shapes.shape_of(880, 1184) == "5:7"
    assert image_shapes.shape_of(1152, 2016) == "9:16"
    assert image_shapes.shape_of(900, 1180) == "3:4"
    assert image_shapes.shape_of(4000, 100) == "21:9"
    assert image_shapes.shape_of(100, 4000) == "9:21"


def test_no_size_no_shape():
    assert image_shapes.shape_of(0, 100) is None
    assert image_shapes.shape_of(None, None) is None


def test_bands_tile_without_gaps():
    bands = [image_shapes.BANDS[s.name] for s in image_shapes.SHAPES]
    assert bands[0][0] == 0
    for (_, hi), (lo, _) in zip(bands, bands[1:]):
        assert hi == lo
