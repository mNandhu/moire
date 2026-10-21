"""Character names from the tagger's word list, bare names included."""

from moire.services import tag_categories
from moire.services.tag_categories import Candidate


def test_bare_names_are_candidates_only_when_unambiguous():
    v = tag_categories.vocab(
        {
            "furina_(genshin_impact)",
            "white_rabbit_(alice_in_wonderland)",
            "amber_(genshin_impact)",
            "link_(zelda)",
            "link_(other)",
            "holo",
            "holo_(spice_and_wolf)",
            "jeanne_d'arc_(swimsuit_archer)_(first_ascension)",
        },
        {"amber", "1girl"},
    )
    assert v.candidates == {
        "furina": Candidate("genshin_impact", "furina_(genshin_impact)"),
        "white_rabbit": Candidate(
            "alice_in_wonderland", "white_rabbit_(alice_in_wonderland)"
        ),
    }
    # a bare name is never a character by itself, only after the library check
    assert "furina" not in v.names
    # amber is a tag of its own, link two characters, holo listed as is, and
    # outfit variants (two qualifiers) aren't bare names
    assert not {"amber", "link", "holo", "jeanne_d'arc"} & set(v.candidates)


def test_reads_the_word_list(tmp_path):
    csv_path = tmp_path / "labels.csv"
    csv_path.write_text(
        "tag_id,name,category,count\n"
        "1,general,9,10\n"
        "2,Furina_(Genshin_Impact),4,5\n"
        "3,1girl,0,9\n"
        "4,,4,1\n"
    )
    v = tag_categories._read(str(csv_path))
    assert v.names == frozenset({"furina_(genshin_impact)"})
    assert set(v.candidates) == {"furina"}


def test_confirmed():
    assert tag_categories.confirmed(4, 2)
    assert not tag_categories.confirmed(4, 1)
    assert not tag_categories.confirmed(0, 0)
