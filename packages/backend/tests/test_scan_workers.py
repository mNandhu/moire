from moire.services.ai import jobs as ai_jobs
from moire.services.ai.face_worker import get_face_worker
from moire.services.library import scanner


def _cores(monkeypatch, n, cap=0):
    monkeypatch.setattr(scanner, "cpu_count", lambda: n)
    monkeypatch.setattr(scanner.settings, "scanner_max_workers", cap)


def test_full_pool_when_no_ai_job(monkeypatch):
    _cores(monkeypatch, 12)
    monkeypatch.setattr(scanner, "_ai_job_active", lambda: False)
    assert scanner.scan_workers() == 12


def test_half_the_cores_while_an_ai_job_runs(monkeypatch):
    _cores(monkeypatch, 12)
    monkeypatch.setattr(scanner, "_ai_job_active", lambda: True)
    assert scanner.scan_workers() == 6


def test_cap_keeps_the_lower_bound_and_the_user_cap(monkeypatch):
    monkeypatch.setattr(scanner, "_ai_job_active", lambda: True)
    _cores(monkeypatch, 2)
    assert scanner.scan_workers() == 2
    _cores(monkeypatch, 12, cap=3)
    assert scanner.scan_workers() == 3


def test_heavy_active_sees_running_batch_not_single_retag(monkeypatch):
    mgr = ai_jobs.AIJobManager()
    monkeypatch.setattr(ai_jobs, "_ai_job_manager", mgr)
    monkeypatch.setattr(get_face_worker(), "_pending", set())

    class J:
        def __init__(self, status, total):
            self.status, self.total = status, total

    assert not ai_jobs.heavy_active()
    mgr._jobs = {"a": J("queued", 500), "b": J("running", 1)}
    assert not ai_jobs.heavy_active()
    mgr._jobs["c"] = J("running", 500)
    assert ai_jobs.heavy_active()


def test_heavy_active_while_faces_are_pending(monkeypatch):
    monkeypatch.setattr(ai_jobs, "_ai_job_manager", None)
    monkeypatch.setattr(get_face_worker(), "_pending", {"x"})
    assert ai_jobs.heavy_active()
