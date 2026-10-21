/**
 * The one fetch-JSON helper. Six pages had each defined their own identical
 * `api<T>()`; this is that, in one place: GET (or any method via `init`),
 * throw the response body text on non-2xx, parse JSON on success.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/** FastAPI errors arrive as `{"detail": "..."}` or a 422 list; the words to show. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const d = JSON.parse(raw)?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => x?.msg ?? String(x)).join("; ");
  } catch {
    /* not JSON; use as-is */
  }
  return raw;
}
