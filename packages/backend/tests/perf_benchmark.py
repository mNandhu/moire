from __future__ import annotations
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Dict, List

import httpx
import threading
from pathlib import Path

# Add backend src/ to sys.path for optional in-process uvicorn start (so we can import 'moire.main')
BACKEND_ROOT = str(Path(__file__).resolve().parents[1] / "src")
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

BASE_URL = os.environ.get("MOIRE_BASE_URL", "http://127.0.0.1:8000")
API_URL = f"{BASE_URL}/api/v1"
LIBRARY_PATH = os.environ.get("MOIRE_TEST_LIBRARY", "G:/images")
CONCURRENCY = int(os.environ.get("MOIRE_CONCURRENCY", "8"))
ITERATIONS = int(os.environ.get("MOIRE_ITERATIONS", "200"))
TIMEOUT = float(os.environ.get("MOIRE_TIMEOUT", "10"))
AUTOSTART = os.environ.get("MOIRE_AUTOSTART", "0").lower() in ("1", "true", "yes")
MEASURE_SCAN = os.environ.get("MOIRE_MEASURE_SCAN", "0").lower() in (
    "1",
    "true",
    "yes",
)


@dataclass
class Stat:
    name: str
    count: int = 0
    ok: int = 0
    errs: int = 0
    latencies_ms: List[float] = None  # type: ignore

    def __post_init__(self):
        if self.latencies_ms is None:
            self.latencies_ms = []

    def add(self, ok: bool, lat_ms: float):
        self.count += 1
        if ok:
            self.ok += 1
        else:
            self.errs += 1
        self.latencies_ms.append(lat_ms)

    def summary(self) -> Dict[str, Any]:
        if self.latencies_ms and len(self.latencies_ms) > 0:
            try:
                if len(self.latencies_ms) == 1:
                    # Handle single sample case
                    p50 = p95 = p99 = self.latencies_ms[0]
                else:
                    quantiles = statistics.quantiles(self.latencies_ms, n=100)
                    p50 = quantiles[49] if len(quantiles) > 49 else self.latencies_ms[0]
                    p95 = (
                        quantiles[94] if len(quantiles) > 94 else self.latencies_ms[-1]
                    )
                    p99 = (
                        quantiles[98] if len(quantiles) > 98 else self.latencies_ms[-1]
                    )
                avg = sum(self.latencies_ms) / len(self.latencies_ms)
                mn = min(self.latencies_ms)
                mx = max(self.latencies_ms)
            except (IndexError, ValueError):
                # Fallback for edge cases
                avg = mn = mx = p50 = p95 = p99 = (
                    self.latencies_ms[0] if self.latencies_ms else 0.0
                )
        else:
            p50 = p95 = p99 = avg = mn = mx = 0.0
        return {
            "name": self.name,
            "count": self.count,
            "ok": self.ok,
            "errs": self.errs,
            "avg_ms": round(avg, 2),
            "p50_ms": round(p50, 2),
            "p95_ms": round(p95, 2),
            "p99_ms": round(p99, 2),
            "min_ms": round(mn, 2),
            "max_ms": round(mx, 2),
        }


async def find_library(client: httpx.AsyncClient, lib_path: str) -> str | None:
    r = await client.get(f"{API_URL}/libraries", timeout=TIMEOUT)
    r.raise_for_status()
    libs = r.json()
    for lib in libs:
        if lib.get("path") == lib_path:
            return lib.get("_id")
    return None


async def add_library(client: httpx.AsyncClient, lib_path: str) -> str:
    r = await client.post(
        f"{API_URL}/libraries", json={"path": lib_path}, timeout=TIMEOUT
    )
    r.raise_for_status()
    data = r.json()
    return data.get("_id")


async def wait_for_scan(
    client: httpx.AsyncClient,
    lib_id: str,
    poll_interval: float = 1.0,
    max_wait: float = 300.0,
):
    start = time.time()
    while True:
        r = await client.get(f"{API_URL}/libraries/{lib_id}/progress", timeout=TIMEOUT)
        r.raise_for_status()
        p = r.json()
        if not p.get("scanning"):
            return p
        if time.time() - start > max_wait:
            return p
        await asyncio.sleep(poll_interval)


async def wait_until_scanning(
    client: httpx.AsyncClient, lib_id: str, timeout_s: float = 5.0
) -> bool:
    start = time.time()
    while time.time() - start < timeout_s:
        r = await client.get(f"{API_URL}/libraries/{lib_id}/progress", timeout=TIMEOUT)
        r.raise_for_status()
        p = r.json()
        if p.get("scanning"):
            return True
        await asyncio.sleep(0.25)
    return False


async def fetch_some_ids(client: httpx.AsyncClient, n: int = 20) -> List[str]:
    r = await client.get(f"{API_URL}/images", params={"limit": n}, timeout=TIMEOUT)
    r.raise_for_status()
    arr = r.json()
    return [it["_id"] for it in arr]


async def bench_task(
    name: str, stat: Stat, coro_factory: Callable[[], Coroutine[Any, Any, bool]]
):
    t0 = time.perf_counter()
    ok = False
    try:
        ok = await coro_factory()
    except Exception:
        ok = False
    finally:
        dt_ms = (time.perf_counter() - t0) * 1000.0
        stat.add(ok, dt_ms)


async def run_benchmark():
    print(f"Base URL: {BASE_URL}")
    print(f"Library path: {LIBRARY_PATH}")
    print(f"Concurrency: {CONCURRENCY}, Iterations: {ITERATIONS}")

    limits = httpx.Limits(
        max_keepalive_connections=CONCURRENCY, max_connections=CONCURRENCY
    )
    async with httpx.AsyncClient(
        limits=limits, timeout=TIMEOUT, follow_redirects=True
    ) as client:
        # Health check; optionally autostart backend if unreachable
        async def _try_health() -> bool:
            try:
                r = await client.get(f"{API_URL}/health")
                if r.status_code == 200:
                    return True
            except Exception:
                return False
            return False

        ok = await _try_health()
        if not ok and AUTOSTART:
            try:
                print(
                    "Backend not reachable; attempting to start uvicorn in-process (MOIRE_AUTOSTART=1)..."
                )
                import uvicorn  # type: ignore
                import importlib

                mod = importlib.import_module("moire.main")
                app = getattr(mod, "app")

                def _run_server():
                    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")

                t = threading.Thread(
                    target=_run_server, name="uvicorn-autostart", daemon=True
                )
                t.start()
                # Wait up to 10s for health
                start_wait = time.time()
                while time.time() - start_wait < 10:
                    if await _try_health():
                        ok = True
                        break
                    await asyncio.sleep(0.5)
            except Exception as e:
                print(f"Autostart failed: {e}")
                ok = False

        if not ok:
            print(
                "ERROR: Could not reach backend /health. Ensure the server is running (pnpm dev:backend) or set MOIRE_AUTOSTART=1."
            )
            return 2
        # proceed with rest
        # Ensure library exists
        lib_id = await find_library(client, LIBRARY_PATH)
        scan_time_sec: float | None = None
        if lib_id is None:
            # Adding a new library triggers initial scan automatically
            t0 = time.perf_counter()
            lib_id = await add_library(client, LIBRARY_PATH)
            # Wait for scan completion
            progress = await wait_for_scan(client, lib_id)
            dt = time.perf_counter() - t0
            scan_time_sec = dt
            print(
                f"Initial scan status: scanning={progress.get('scanning')} done={progress.get('scan_done')} total={progress.get('scan_total')} time_sec={dt:.2f}"
            )
        else:
            # Library exists; optionally measure rescan
            if MEASURE_SCAN:
                # Trigger rescan and time it
                t0 = time.perf_counter()
                rr = await client.post(
                    f"{API_URL}/libraries/{lib_id}/rescan", timeout=TIMEOUT
                )
                rr.raise_for_status()
                # Wait until scanning starts (briefly), then until completion
                await wait_until_scanning(client, lib_id, timeout_s=5.0)
                progress = await wait_for_scan(client, lib_id)
                dt = time.perf_counter() - t0
                scan_time_sec = dt
                print(
                    f"Rescan status: scanning={progress.get('scanning')} done={progress.get('scan_done')} total={progress.get('scan_total')} time_sec={dt:.2f}"
                )
            else:
                progress = await wait_for_scan(client, lib_id)
                print(
                    f"Scan status: scanning={progress.get('scanning')} done={progress.get('scan_done')} total={progress.get('scan_total')}"
                )
        # Prepare IDs
        ids = await fetch_some_ids(client, n=min(50, ITERATIONS))
        if not ids:
            print("No images found; ensure G:/images has images and scan completed.")
            print("Attempting to proceed with minimal testing...")
            # Use a dummy ID for basic endpoint testing
            ids = ["dummy-id-for-testing"]

        # Stats containers
        s_images = Stat("GET /images")
        s_tags = Stat("GET /tags")
        s_image = Stat("GET /images/{id}")
        s_thumb_head = Stat("HEAD /images/{id}/thumb")
        s_thumb = Stat("GET /images/{id}/thumb")
        s_file_head = Stat("HEAD /images/{id}/file")
        s_file_range = Stat("GET /images/{id}/file (range)")
        s_no_tags = Stat("GET /images?no_tags=1")
        s_no_tags_lib = Stat("GET /images?library_id&no_tags=1")

        # Define coroutines
        async def get_images():
            r = await client.get(
                f"{API_URL}/images", params={"limit": 100}, timeout=TIMEOUT
            )
            if r.status_code == 200:
                _ = r.json()
                return True
            return False

        async def get_tags():
            r = await client.get(f"{API_URL}/tags", timeout=TIMEOUT)
            if r.status_code == 200:
                _ = r.json()
                return True
            return False

        async def get_no_tags():
            r = await client.get(
                f"{API_URL}/images",
                params={"no_tags": 1, "limit": 100},
                timeout=TIMEOUT,
            )
            if r.status_code == 200:
                _ = r.json()
                return True
            return False

        async def get_no_tags_by_lib(library_id: str):
            r = await client.get(
                f"{API_URL}/images",
                params={"no_tags": 1, "limit": 100, "library_id": library_id},
                timeout=TIMEOUT,
            )
            if r.status_code == 200:
                _ = r.json()
                return True
            return False

        async def get_image_details(img_id: str):
            r = await client.get(f"{API_URL}/images/{img_id}", timeout=TIMEOUT)
            return r.status_code == 200

        async def head_thumb(img_id: str):
            r = await client.head(f"{API_URL}/images/{img_id}/thumb", timeout=TIMEOUT)
            return r.status_code == 200

        async def get_thumb(img_id: str):
            r = await client.get(f"{API_URL}/images/{img_id}/thumb", timeout=TIMEOUT)
            # In URL mode, API returns JSON { url }; otherwise bytes
            if r.status_code == 200:
                ctype = r.headers.get("content-type", "")
                if "application/json" in ctype:
                    data = r.json()
                    # Fetch the presigned URL
                    url = data.get("url")
                    if url:
                        r2 = await client.get(url, timeout=TIMEOUT)
                        return r2.status_code == 200
                return True
            return False

        async def head_file(img_id: str):
            r = await client.head(f"{API_URL}/images/{img_id}/file", timeout=TIMEOUT)
            return r.status_code == 200

        async def get_file_range(img_id: str):
            headers = {"Range": "bytes=0-65535"}
            r = await client.get(
                f"{API_URL}/images/{img_id}/file", headers=headers, timeout=TIMEOUT
            )
            # Could be 206 Partial Content or redirect/JSON URL
            if r.status_code in (200, 206, 307):
                if r.status_code == 200:
                    # Might be URL mode with JSON
                    ctype = r.headers.get("content-type", "")
                    if "application/json" in ctype:
                        data = r.json()
                        url = data.get("url")
                        if url:
                            r2 = await client.get(url, headers=headers, timeout=TIMEOUT)
                            return r2.status_code in (200, 206)
                return True
            return False

        # Producer of jobs
        async def worker(stop_after: int):
            i = 0
            while i < stop_after:
                # cycle an id
                if not ids:
                    break  # Safety check for empty IDs list
                img_id = ids[i % len(ids)]
                # interleave different endpoints
                await bench_task("images", s_images, get_images)
                await bench_task("tags", s_tags, get_tags)
                await bench_task("no_tags", s_no_tags, get_no_tags)
                await bench_task(
                    "no_tags_lib",
                    s_no_tags_lib,
                    lambda library_id=lib_id: get_no_tags_by_lib(library_id),
                )
                await bench_task(
                    "image", s_image, lambda img_id=img_id: get_image_details(img_id)
                )
                await bench_task(
                    "thumb_head", s_thumb_head, lambda img_id=img_id: head_thumb(img_id)
                )
                await bench_task(
                    "thumb", s_thumb, lambda img_id=img_id: get_thumb(img_id)
                )
                await bench_task(
                    "file_head", s_file_head, lambda img_id=img_id: head_file(img_id)
                )
                await bench_task(
                    "file_range",
                    s_file_range,
                    lambda img_id=img_id: get_file_range(img_id),
                )
                i += 1

        # Launch concurrent workers
        per_worker = max(1, ITERATIONS // CONCURRENCY)
        tasks = [asyncio.create_task(worker(per_worker)) for _ in range(CONCURRENCY)]
        await asyncio.gather(*tasks)

        # Print summary
        stats = [
            s_images,
            s_tags,
            s_no_tags,
            s_no_tags_lib,
            s_image,
            s_thumb_head,
            s_thumb,
            s_file_head,
            s_file_range,
        ]
        results = [s.summary() for s in stats]
        print("\n=== Benchmark Results ===")
        if scan_time_sec is not None:
            # Try to compute throughput from latest progress
            try:
                last = await wait_for_scan(client, lib_id)
                done = int(last.get("scan_done") or 0)
                if done > 0 and scan_time_sec > 0:
                    thr = done / scan_time_sec
                    print(
                        json.dumps(
                            {
                                "name": "SCAN",
                                "images": done,
                                "seconds": round(scan_time_sec, 2),
                                "images_per_sec": round(thr, 2),
                            }
                        )
                    )
            except Exception:
                pass
        for res in results:
            print(json.dumps(res))
        # Basic pass/fail
        any_errs = any(s.errs > 0 for s in stats)
        return 1 if any_errs else 0


if __name__ == "__main__":
    try:
        code = asyncio.run(run_benchmark())
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)
