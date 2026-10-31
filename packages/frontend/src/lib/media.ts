// Cache for media mode detection per session
let mediaMode: "redirect" | "url" | "off" | null = null;
let mediaHost: string | null = null;

// Deduplicate concurrent mode detection and URL extraction.
let mediaModeDetection: Promise<"redirect" | "url"> | null = null;
const resolvedUrlCache = new Map<string, string>();
const resolvedUrlInFlight = new Map<string, Promise<string>>();

async function detectMediaMode(endpoint: string): Promise<"redirect" | "url"> {
  const head = await fetch(endpoint, { method: "HEAD" });
  if (!head.ok) return "redirect";
  const ct = head.headers.get("content-type") || "";
  return ct.includes("application/json") ? "url" : "redirect";
}

async function resolveUrlMode(endpoint: string): Promise<string> {
  const cached = resolvedUrlCache.get(endpoint);
  if (cached) return cached;

  const inflight = resolvedUrlInFlight.get(endpoint);
  if (inflight) return inflight;

  const p = (async () => {
    const res = await fetch(endpoint, { method: "GET" });
    if (!res.ok) return endpoint;
    const data = (await res.json()) as { url?: string };
    const url =
      data && typeof data.url === "string" && data.url ? data.url : endpoint;

    if (url !== endpoint) {
      resolvedUrlCache.set(endpoint, url);
      // Cache media host for preconnect on first URL resolution
      if (!mediaHost && url.startsWith("http")) {
        try {
          const u = new URL(url);
          mediaHost = u.origin;
          addPreconnect(mediaHost);
        } catch {
          // Ignore URL parsing errors
        }
      }
    }

    return url;
  })()
    .catch(() => endpoint)
    .finally(() => {
      resolvedUrlInFlight.delete(endpoint);
    });

  resolvedUrlInFlight.set(endpoint, p);
  return p;
}

export async function resolveMediaUrl(endpoint: string): Promise<string> {
  try {
    // If we've already detected the mode, use it directly
    if (mediaMode === "redirect" || mediaMode === "off") {
      return endpoint;
    }

    if (mediaMode === "url") {
      // Skip HEAD probe, go directly to JSON fetch (deduped per endpoint)
      return await resolveUrlMode(endpoint);
    }

    // First time (or unknown) - probe to detect mode, but dedupe concurrent probes.
    if (!mediaModeDetection) {
      mediaModeDetection = detectMediaMode(endpoint)
        .then((m) => {
          mediaMode = m;
          return m;
        })
        .catch(() => {
          mediaMode = "redirect";
          return "redirect" as const;
        });
    }

    const detected = await mediaModeDetection;
    if (detected !== "url") {
      return endpoint;
    }

    return await resolveUrlMode(endpoint);
  } catch {
    return endpoint;
  }
}

// Add preconnect link to reduce connection latency
function addPreconnect(origin: string) {
  // Check if preconnect already exists
  if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}

/** The original file of an image, streamed from its library (Range-capable).
 * Thumbnails are not built here: use the list's `thumb_url` or useThumbUrl. */
export function imageFileUrl(id: string): string {
  return imageUrl(id, "file");
}

/** An Image's endpoint `/api/v1/images/<id>/<suffix>`. */
export function imageUrl(id: string, suffix: string): string {
  return `/api/v1/images/${encodeURIComponent(id)}/${suffix}`;
}

/** Resolve an Image's original, point `img` (a new one by default) at it and
 * wait for it to decode. A failed resolve falls back to the plain endpoint;
 * a failed decode rejects. `img` can be passed in so the caller may keep and
 * abort it while it loads. */
export async function loadImage(
  id: string,
  opts: { priority?: "low" | "high"; img?: HTMLImageElement } = {},
): Promise<{ src: string; img: HTMLImageElement }> {
  const ep = imageFileUrl(id);
  const img = opts.img ?? new Image();
  if (opts.priority) img.fetchPriority = opts.priority;
  const src = await resolveMediaUrl(ep).catch(() => ep);
  img.src = src;
  await img.decode();
  return { src, img };
}

/** A thumbnail URL's small copy (~256px short side), for previews shown
 * postage-stamp size. Not for face crops: they zoom in. */
export function smallThumb(url: string): string;
export function smallThumb(url: string | null | undefined): string | null;
export function smallThumb(url: string | null | undefined): string | null {
  if (!url) return null;
  return `${url}${url.includes("?") ? "&" : "?"}size=small`;
}
