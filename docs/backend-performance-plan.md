# Moiré Backend Performance Plan

Audience: engineering + ops
Goal: push the backend to production-grade throughput and latency with pragmatic changes and a safe rollout path.

## Snapshot (current state)

- App: FastAPI on Uvicorn.
- Storage: MinIO (moire-thumbs, moire-originals) with server-side ETag.
- Scanner: multithreaded, generates in-memory JPEG thumb, uploads original + thumb to MinIO, upserts Mongo image docs.
- API:
  - Streams originals/thumbs from MinIO via the API (proxy).
  - Listing uses PyMongo find with offset/limit; tag filters via `$in`/`$all` and `no_tags` special.
  - Tag aggregation uses `$unwind/$group/$sort` on-demand.
- Frontend calls `/images/:id/thumb` and `/images/:id/file`.

Quick wins already in place:

- Projection and sorting for list_images to reduce payload size.
- Strong client caching for media: `Cache-Control: public, max-age=31536000, immutable` and `ETag` passthrough.

## Bottlenecks and fixes

### 1) Async illusion: sync drivers in async endpoints

- Symptom: `async def` handlers but PyMongo + MinIO SDK + PIL are synchronous; event loop still blocks.
- Fix options:
  - A) Keep synchronous handlers (done for images API) and scale with multiple workers; use threadpools tactically if needed.
  - B) Full-async: migrate to Motor (async Mongo) and wrap MinIO/file calls in threadpool. Higher effort; saves event loop stalls mainly for Mongo.
- Recommendation: Start with (A) + server worker tuning. Revisit Motor after other wins.

### 2) Mongo query performance and pagination

- Issues:
  - No explicit indexes for `tags` and `library_id`.
  - Offset-based pagination (`skip`) slows down as collection grows.
- Fixes:
  - Indexes (critical):
    - `images({ library_id: 1 })`
    - `images({ tags: 1 })` (supports `$in` and helps `$all`)
    - `images({ _id: -1 })` (if sorting by `_id`)
  - Cursor-based pagination:
    - Replace `offset/limit` with `_id`-based cursor (`after` or `before`).
    - Returns `next_cursor`; use `find({ _id: { $lt: cursor } })` + `limit`.
  - Avoid unbounded sorts; always use an index-supported sort key (e.g. `_id`).

### 3) Tag aggregation (list_tags)

- Issue: `$unwind/$group/$sort` on every request is O(n) and grows with data size.
- Fixes:
  - Denormalize: maintain a `tags` collection with counts updated on tag apply/remove.
  - Or add a 30–60s TTL in-memory cache for the aggregation result (cheap, effective).
  - Add an index on `tags` in `images` anyway.

### 4) Media proxying through API

- Issue: API streams every image/thumbnail; high concurrency = heavy CPU/socket load in app.
- Fixes:
  - Serve via pre-signed URLs:
    - Endpoints return JSON with a short-lived `url` for MinIO; frontend fetches directly.
    - Keep proxy as a fallback/feature-flag.
  - Put a CDN (Cloudflare/CloudFront) or NGINX cache in front of MinIO for thumbnails.
  - Keep strong cache headers; add support for Range (see next).

### 5) Range requests for originals (large files)

- Issue: current proxy doesn’t honor HTTP Range for partial content.
- Fix:
  - Map client `Range: bytes=start-end` to `minio.get_object(bucket, key, offset, length)` and return `206 Partial Content` with `Content-Range`/`Accept-Ranges` headers.
  - Improves seeks/scrubbing and reduces transfer for previews.

### 6) Scanner throughput

- Issues:
  - One Mongo `update_one` per image; one MinIO `put_object` per asset — many round trips.
  - Thread count based on CPU may overrun MinIO/Mongo under load.
- Fixes:
  - Batch Mongo writes with `bulk_write` (e.g., 200–500 ops per batch).
  - Cap worker threads to a fixed value (8–16) or make it configurable.
  - Consider local queue + backpressure: discover files fast, but process with a bounded worker pool.
  - Optional: Use multipart uploads (MinIO handles for larger streams); ensure sensible part size.
  - Optional: Faster image pipeline with libvips (pyvips) instead of PIL for large libraries.

### 7) Server tuning

- Uvicorn/Gunicorn (production behind reverse proxy):
  - Use multiple workers (e.g., `workers = 2 * CPU cores` when proxying media; fewer if switching to pre-signed URLs).
  - Enable `uvloop` and `httptools` (Uvicorn defaults often include these).
  - Tune keep-alive, backlog, and timeouts for your environment.
- OS/network:
  - Ensure sufficient file descriptors.
  - TCP keepalive/timewait settings per platform.

### 8) Mongo client and timeouts

- Use a single `MongoClient` instance (already in place).
- Configure reasonable timeouts/retryable reads.
- If dataset grows large, consider sharding or read replicas (longer-term).

### 9) JSON payloads and serialization

- Ensure list endpoints don’t return bulky fields unnecessarily (projection already added).
- Avoid serializing large arrays or nested structures by default.

### 10) Observability and protection

- Add minimal request timing middleware and per-endpoint metrics (Prometheus or StatsD).
- Log slow queries (>100ms) and slow MinIO calls — add timers around critical sections.
- Add basic rate limiting for non-media endpoints if needed to protect DB.

## Phased rollout plan

Phase 0 – Low-risk wins (this week)

- Add Mongo indexes: `library_id`, `tags`, `_id`.
- Keep images endpoints synchronous; keep cache headers (done).
- Add TTL cache for tag aggregation.
- Cap scanner concurrency via config; measure throughputs.

Phase 1 – Reduce load on API (next)

- Implement pre-signed URL mode for thumbs/originals and switch frontend.
- Keep proxy routes as fallback behind a config flag.
- Add CDN in front of MinIO for thumbs.

Phase 2 – Query and pagination improvements

- Switch to cursor-based pagination for All Images page.
- Add any missing compound indexes if access patterns require.

Phase 3 – Heavy hitters (optional but high value)

- Range request support mapped to MinIO partial reads for originals.
- Scanner bulk_write and multipart tuning.
- Optional: Migrate to Motor for async Mongo if keeping async handlers elsewhere.
- Optional: switch thumbnail generation to libvips for speed/memory.

## Acceptance targets (baseline -> target)

- List images (first page):
  - p50 < 50 ms, p95 < 150 ms under 250 RPS (with indexes & projection).
- Thumb delivery:
  - Cache-hit from browser/CDN ~instant; API proxy path p50 < 30 ms server-side before network.
- Original partial fetch (with Range):
  - First byte < 100 ms for typical ranges.
- Scanner throughput:
  - > = 30–60 images/sec on modest hardware with 8–16 workers and MinIO on LAN.

## Action checklist

- [ ] MongoDB indexes (images: `library_id`, `tags`, `_id`).
- [ ] TTL cache or denormalized tag counts.
- [ ] Pre-signed URL support in API + frontend switch; optional CDN.
- [ ] Range requests for originals.
- [ ] Cursor-based pagination (replace offset/limit on FE + BE).
- [ ] Scanner: cap concurrency; add bulk_write; consider multipart tuning.
- [ ] Basic timing/metrics around Mongo and MinIO calls.
- [ ] Server worker/uvloop/httptools tuning for production deploy.

## Notes on trade-offs

- Pre-signed URLs greatly reduce API CPU/socket churn and are the biggest win for scale.
- Cursor pagination removes the most common pagination scalability trap.
- Indexes + projection fix most list latency issues quickly.
- Staying synchronous and scaling workers is simpler and plenty fast once media is offloaded; a full async Mongo migration provides incremental gains later if needed.
