"""Fetch a picture from a link someone pasted, without letting the link reach
anything but the public internet.

The server does the fetch (an image host rarely allows a browser's
cross-origin read), so a bare fetch would be server-side request forgery: a
link to ``127.0.0.1:7671``, the LAN or a cloud metadata address would make
Moire call it. So: http(s) only, the host resolved here and refused unless
every address is public, the connection made to that checked address (a DNS
answer that changes between check and connect can't redirect it), each
redirect checked the same way, a size cap and a timeout. Every refusal reads
the same, so the error doesn't map out what's listening where.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

MAX_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT_S = 15.0
# The whole fetch, redirects and a slow trickle of bytes included.
DEADLINE_S = 45.0

# IPv6 ranges that carry an IPv4 address a gateway may turn back into a
# private one (NAT64, 6to4, Teredo); Python counts some of them as global.
_EMBEDS_V4 = [
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("2002::/16"),
    ipaddress.ip_network("2001::/32"),
]


class FetchError(ValueError):
    """The link can't be fetched; the message is safe to show."""


_REFUSED = "Couldn't fetch a picture from that link"


def is_public(ip: str) -> bool:
    """A globally routable unicast address: not loopback, private, link-local
    (cloud metadata), multicast, reserved or unspecified. Pure."""
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        elif any(addr in net for net in _EMBEDS_V4):
            return False
    return addr.is_global and not addr.is_multicast


async def _resolve_public(host: str, port: int) -> str:
    """The first address ``host`` resolves to, if every one is public."""
    try:
        infos = await asyncio.to_thread(
            socket.getaddrinfo, host, port, type=socket.SOCK_STREAM
        )
    except (OSError, UnicodeError, ValueError):
        # UnicodeError: a host name IDNA can't encode ("a..b").
        raise FetchError(_REFUSED) from None
    ips = [str(info[4][0]) for info in infos]
    if not ips or not all(is_public(ip) for ip in ips):
        raise FetchError(_REFUSED)
    return ips[0]


def _check_url(url: str) -> tuple[str, str, int]:
    """``(scheme, host, port)`` of an http(s) link with a host. Pure."""
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("Give an http or https link")
    if parts.username or parts.password:
        raise FetchError(_REFUSED)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise FetchError(_REFUSED) from None
    return parts.scheme, parts.hostname, port


async def fetch_image(url: str) -> bytes:
    """The bytes at ``url`` (following up to ``MAX_REDIRECTS``), or a
    FetchError."""
    try:
        async with asyncio.timeout(DEADLINE_S):
            return await _fetch(url)
    except FetchError:
        raise
    except (TimeoutError, httpx.HTTPError, httpx.InvalidURL, ValueError):
        raise FetchError(_REFUSED) from None


async def _fetch(url: str) -> bytes:
    async with httpx.AsyncClient(
        timeout=TIMEOUT_S, follow_redirects=False, trust_env=False
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            scheme, host, port = _check_url(url)
            ip = await _resolve_public(host, port)
            parts = urlsplit(url.strip())
            netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
            pinned = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
            # An IPv6 literal keeps its brackets in the Host header.
            name = f"[{host}]" if ":" in host else host
            host_header = name if parts.port is None else f"{name}:{port}"
            async with client.stream(
                "GET",
                pinned,
                headers={"Host": host_header, "Accept": "image/*"},
                # TLS to the checked IP, but SNI and the certificate check
                # against the link's own host name.
                extensions={"sni_hostname": host} if scheme == "https" else {},
            ) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise FetchError(_REFUSED)
                    url = urljoin(url, location)
                    continue
                if resp.status_code != 200:
                    raise FetchError(_REFUSED)
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_BYTES:
                    raise FetchError("That picture is too large")
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise FetchError("That picture is too large")
                return bytes(body)
        raise FetchError(_REFUSED)
