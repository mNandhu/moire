"""The pasted-link fetch only ever reaches public addresses."""

import pytest

from moire.services import fetch_image
from moire.services.fetch_image import FetchError, is_public


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.10",
        "172.16.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
    ],
)
def test_non_public_addresses_refused(ip):
    assert not is_public(ip)


@pytest.mark.parametrize("ip", ["93.184.216.34", "2606:4700:4700::1111"])
def test_public_addresses_allowed(ip):
    assert is_public(ip)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:7671/view",
        "http://localhost/x.png",
        "http://[::1]/x.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/x.png",
        "file:///etc/passwd",
        "ftp://example.com/x.png",
        "http://user:pw@example.com/x.png",
        "not a url",
    ],
)
async def test_fetch_refuses_before_connecting(url):
    with pytest.raises(FetchError):
        await fetch_image.fetch_image(url)


async def test_redirect_to_loopback_refused(monkeypatch):
    """A public link that redirects inward is checked again at the hop."""
    calls = []

    async def fake_resolve(host, port):
        calls.append(host)
        if host == "public.example":
            return "93.184.216.34"
        raise FetchError("refused")

    monkeypatch.setattr(fetch_image, "_resolve_public", fake_resolve)

    import httpx

    def handler(request):
        return httpx.Response(302, headers={"location": "http://inside.example:7671/"})

    real_client = httpx.AsyncClient

    def client(**kw):
        return real_client(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(fetch_image.httpx, "AsyncClient", client)
    with pytest.raises(FetchError):
        await fetch_image.fetch_image("http://public.example/a.png")
    assert calls == ["public.example", "inside.example"]


async def test_tag_image_url_refuses_private_link(client):
    resp = await client.post(
        "/ai/tag-image-url", json={"url": "http://127.0.0.1:7671/"}
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Couldn't fetch a picture from that link"


async def test_connects_to_the_checked_address(monkeypatch):
    import httpx

    async def fake_resolve(host, port):
        return "93.184.216.34"

    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["host"] = request.headers["host"]
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, content=b"png bytes")

    real_client = httpx.AsyncClient
    monkeypatch.setattr(fetch_image, "_resolve_public", fake_resolve)
    monkeypatch.setattr(
        fetch_image.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    body = await fetch_image.fetch_image("https://img.example/p/a.png?w=2")
    assert body == b"png bytes"
    assert seen == {
        "url": "https://93.184.216.34/p/a.png?w=2",
        "host": "img.example",
        "sni": "img.example",
    }


@pytest.mark.parametrize(
    "ip", ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:0:4136::1"]
)
def test_ipv6_wrapping_ipv4_refused(ip):
    assert not is_public(ip)


async def test_bad_host_names_refused_not_crashed():
    for url in ("http://a..b/x.png", f"http://{'a' * 70}.example/x.png"):
        with pytest.raises(FetchError):
            await fetch_image.fetch_image(url)


async def test_ipv6_literal_keeps_brackets_in_host(monkeypatch):
    import httpx

    async def fake_resolve(host, port):
        return "2606:4700:4700::1111"

    seen = {}

    def handler(request):
        seen["host"] = request.headers["host"]
        return httpx.Response(200, content=b"x")

    real_client = httpx.AsyncClient
    monkeypatch.setattr(fetch_image, "_resolve_public", fake_resolve)
    monkeypatch.setattr(
        fetch_image.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    await fetch_image.fetch_image("http://[2606:4700:4700::1111]/a.png")
    assert seen["host"] == "[2606:4700:4700::1111]"
