import gc
import weakref

from moire.core import memory
from moire.services.ai import face_detect, tagger


def _reset(monkeypatch, value):
    monkeypatch.setattr(memory, "_malloc_trim", value)


def test_trim_is_a_noop_without_libc(monkeypatch):
    _reset(monkeypatch, memory._UNSET)
    monkeypatch.setattr(memory, "_find_malloc_trim", lambda: None)
    assert memory.trim() is False
    assert memory.trim() is False  # the miss is remembered


def test_trim_finds_no_symbol_off_glibc(monkeypatch):
    _reset(monkeypatch, memory._UNSET)
    monkeypatch.setattr(memory.ctypes.util, "find_library", lambda name: None)
    assert memory.trim() is False


def test_trim_never_raises(monkeypatch):
    def boom(_):
        raise OSError("bad")

    _reset(monkeypatch, boom)
    assert memory.trim() is False


def test_trim_calls_malloc_trim_zero(monkeypatch):
    calls = []
    _reset(monkeypatch, calls.append)
    assert memory.trim() is True
    assert calls == [0]


class _Session:
    pass


def test_tagger_unload_drops_the_session_and_trims(monkeypatch):
    trimmed = []
    monkeypatch.setattr(tagger.memory, "trim", lambda: trimmed.append(1))
    t = tagger.WDTagger()
    sess = _Session()
    ref = weakref.ref(sess)
    t._session = sess
    del sess
    t.unload()
    gc.collect()
    assert ref() is None and not t.loaded
    assert trimmed == [1]


def test_face_unload_drops_the_session_and_trims(monkeypatch):
    trimmed = []
    monkeypatch.setattr(face_detect.memory, "trim", lambda: trimmed.append(1))
    sess = _Session()
    ref = weakref.ref(sess)
    monkeypatch.setattr(face_detect, "_session", ("m", sess, 0.5))
    del sess
    face_detect.unload()
    gc.collect()
    assert ref() is None and face_detect._session is None
    assert trimmed == [1]
