"""The built UI is served from the API process with a SPA fallback that never
shadows API routes or leaves the web folder."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from moire.core.config import API_PREFIX
from moire.web_ui import mount_web_ui


def _app(tmp_path, built=True):
    if built:
        (tmp_path / "assets").mkdir()
        (tmp_path / "index.html").write_text("<html>ui</html>")
        (tmp_path / "assets" / "index-abc.js").write_text("js")
        (tmp_path / "favicon.svg").write_text("<svg/>")
    (tmp_path.parent / "secret.txt").write_text("secret")
    app = FastAPI()
    app.get(f"{API_PREFIX}/health")(lambda: {"status": "ok"})
    app.get("/health")(lambda: {"status": "ok"})
    mounted = mount_web_ui(app, tmp_path)
    return TestClient(app), mounted


def test_serves_index_and_client_routes(tmp_path):
    c, mounted = _app(tmp_path)
    assert mounted
    for path in ("/", "/tags/blue_eyes", "/images/lib:a/b.png"):
        r = c.get(path)
        assert r.status_code == 200 and r.text == "<html>ui</html>"
        assert r.headers["cache-control"] == "no-cache"


def test_assets_are_immutable_and_missing_ones_404(tmp_path):
    c, _ = _app(tmp_path)
    r = c.get("/assets/index-abc.js")
    assert r.text == "js" and "immutable" in r.headers["cache-control"]
    assert c.get("/assets/gone.js").status_code == 404
    assert c.get("/favicon.svg").text == "<svg/>"


def test_api_paths_are_never_the_ui(tmp_path):
    c, _ = _app(tmp_path)
    assert c.get(f"{API_PREFIX}/health").json() == {"status": "ok"}
    assert c.get("/health").json() == {"status": "ok"}
    for path in (f"{API_PREFIX}/nope", "/api/nope", "/openapi.json"):
        assert c.get(path).status_code in (200, 404)
        assert "ui" not in c.get(path).text


def test_no_path_traversal(tmp_path):
    c, _ = _app(tmp_path)
    r = c.get("/..%2Fsecret.txt")
    assert "secret" not in r.text


def test_not_mounted_without_a_build(tmp_path):
    c, mounted = _app(tmp_path, built=False)
    assert not mounted
    assert c.get("/").status_code == 404
